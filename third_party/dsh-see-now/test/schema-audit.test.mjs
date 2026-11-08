/**
 * schema-audit.test.mjs — **宿主按 schema 过滤参数**：handler 读了、schema 没声明的参数，
 * 永远到不了 handler，而且**不报错、不告警**，只是安静地退回默认值。
 *
 * 从 `dsh-video-storyboard` 搬过来的（那个仓库被这一类 bug 咬过四次：zoom 的
 * `transcriptFile`/`detail`、watch 的 `browserPort`、locate 的 `cookies`/`allowAnonymous`）。
 * see-now 只有一个工具，但它的参数面并不小 —— 13 个参数 + 8 个 action，靠人眼对两张表挡不住。
 * 这里做静态审计：
 *
 *   1. 扫 `src/index.js` 里的 `args.X` → "它到底读哪些参数"；
 *   2. 断言这些名字都在 `seeNowToolSpec().parameters` 里（否则宿主会吞掉）；
 *   3. 断言 schema 里没有重复键（对象字面量的重复 key，后一个会静默覆盖前一个）；
 *   4. 断言 `action` 的枚举和 `route()` 里认的分支一一对应（写了没实现 / 实现了没写都算错）；
 *   5. 断言 `dsh.plugin.json` 的版本和 `package.json` 一致。
 *
 * 不需要宿主、不需要 ffmpeg、不需要网络 —— 纯文本审计，CI 里一定跑得起来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seeNowToolSpec, TOOL_NAME } from '../src/tool-spec.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
// 读进来先归一换行：这个测试做的是**文本切分**，CRLF 会让所有 `\n` 匹配失效
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/**
 * handler 由哪些模块组成。
 *
 * see-now 的 execute 就写在 `src/index.js` 的 `toolObj` 上（`execute` → `route`），
 * 所以只扫这一个文件。**以后把 route 拆出去时必须同步加到这里**，否则审计会假装全绿。
 */
const HANDLER_MODULES = ['src/index.js'];

/** 扫一个模块里所有 `args.X` / `args?.X` —— 这就是 handler 真正会读的参数名 */
function readArgNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/\bargs\??\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

test('schema 审计：handler 读的 args 都在 schema 里', () => {
  const declared = new Set(Object.keys(seeNowToolSpec().parameters ?? {}));
  const missing = new Set();
  for (const mod of HANDLER_MODULES) {
    for (const name of readArgNames(read(join(ROOT, mod)))) {
      if (!declared.has(name)) missing.add(name);
    }
  }
  assert.deepEqual([...missing].sort(), [],
    `handler 读了但 schema 没声明 [${[...missing].sort().join(', ')}]`
    + `（宿主会静默丢掉它们，见 ${HANDLER_MODULES.join(' / ')}）`);
});

test('schema 审计：parameters 里没有重复键（后者会静默覆盖前者）', () => {
  // 从 `parameters: {` 到 `output: {` 之间的 `^      name: ` 就是参数表的直接子键
  const all = read(join(ROOT, 'src', 'tool-spec.js'));
  const from = all.indexOf('parameters: {');
  const to = all.indexOf('\n    output: {');
  assert.ok(from > 0 && to > from, '找不到 parameters → output 区间（切片口径已经和代码对不上了）');
  const keys = [...all.slice(from, to).matchAll(/\n {6}([A-Za-z_$][\w$]*): /g)].map((m) => m[1]);
  assert.ok(keys.length > 0, 'parameters 一个键都没切到');
  const seen = new Set();
  const dup = [];
  for (const k of keys) {
    if (seen.has(k)) dup.push(k);
    seen.add(k);
  }
  assert.deepEqual(dup, [], `这些参数定义了两次：${dup.join(', ')}`);
});

test('schema 审计：action 的枚举和 route() 认的分支一一对应', () => {
  const desc = seeNowToolSpec().parameters.action.description;
  const listed = desc.split('|').map((s) => s.trim().replace(/\s*\(default\)$/, '')).filter(Boolean);
  const handled = new Set(
    [...read(join(ROOT, 'src', 'index.js')).matchAll(/action === '([a-z-]+)'/g)].map((m) => m[1]),
  );
  assert.ok(listed.length >= 5, `action 枚举只切到 ${listed.length} 个，切片口径可能坏了`);
  assert.deepEqual(listed.filter((a) => !handled.has(a)), [],
    '契约里写了、route() 里没实现 —— 模型调了会掉进"未知 action"');
  assert.deepEqual([...handled].filter((a) => !listed.includes(a)), [],
    'route() 实现了、契约里没写 —— 模型根本不知道有这个用法');
});

test('schema 审计：dsh.plugin.json 的版本和 package.json 一致', () => {
  const pkg = JSON.parse(read(join(ROOT, 'package.json')));
  const plugin = JSON.parse(read(join(ROOT, 'dsh.plugin.json')));
  assert.equal(plugin.version, pkg.version,
    'dsh.plugin.json 的 version 落后会让人装到"看起来是旧版"的插件');
});

test('schema 审计：工具名和注册日志用的是同一个常量', () => {
  assert.equal(seeNowToolSpec().name, TOOL_NAME);
  assert.ok(read(join(ROOT, 'src', 'index.js')).includes('seeNowToolSpec()'),
    '工具必须由 tool-spec.js 的 spec 展开出来，别在 index.js 里手写一份');
});

test('schema 审计：常驻文案有预算（契约每一轮请求都要重发）', () => {
  const spec = seeNowToolSpec();
  const head = (spec.description ?? '').length;
  const params = Object.values(spec.parameters ?? {})
    .reduce((n, v) => n + (v?.description?.length ?? 0), 0);
  // 2026-11-05 从 4732+3683=8415 砍到 3311+2725=6036（-26%），长说明搬进 action:"help"。
  // 这条预算就是防它长回去：真要写，搬进 src/help.js，别加在契约里。
  assert.ok(head <= 3800, `description ${head} 字符，超了预算 3800（长说明请搬进 help.js）`);
  assert.ok(head + params <= 6500, `常驻文案合计 ${head + params} 字符，超了预算 6500`);
});
