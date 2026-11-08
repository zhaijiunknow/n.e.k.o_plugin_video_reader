// 悬浮窗外观（`~/.dsh/watch-window.json` 的 `glass`）。
//
// 这一组守三件事：
//   1. 只改 `glass` 一个键 —— 同一个文件里还有 geometry / name / hidden，
//      整体覆盖会把用户摆好的窗口位置和"藏起来"的状态一起抹掉
//   2. `auto` 不落盘：窗口把"没有这个键"理解成自动
//   3. 面板那条 `/window` 路由真的能把值写进去（不是只有 UI）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-see-style-'));
process.env.DSH_HOME = home;

const { readWindowStyle, setWindowStyle, windowConfigPath } = await import('../src/window.js');
const { createSettingsApi } = await import('../src/settings-api.mjs');

const cfgPath = windowConfigPath();
const seed = (patch = {}) => writeFileSync(cfgPath, JSON.stringify({
  script: 'X/window.py', name: '大肥鱼', geometry: '700x665+1751+118', hidden: false, ...patch,
}), 'utf8');
const readCfg = () => JSON.parse(readFileSync(cfgPath, 'utf8'));

test('没有 glass 键 = auto', () => {
  seed();
  assert.equal(readWindowStyle().style, 'auto');
});

test('写样式保留其它键，auto 会删掉这个键', () => {
  seed();
  const saved = setWindowStyle('frost');
  assert.equal(saved.ok, true);
  assert.equal(saved.changed, true);
  assert.equal(readWindowStyle().style, 'frost');
  const raw = readCfg();
  assert.equal(raw.glass, 'frost');
  assert.equal(raw.geometry, '700x665+1751+118');
  assert.equal(raw.name, '大肥鱼');
  assert.equal(raw.hidden, false);

  // 已经是目标值：不写盘（少刷一次 mtime，窗口就少醒一轮）
  assert.equal(setWindowStyle('frost').changed, false);

  setWindowStyle('auto');
  assert.equal(Object.hasOwn(readCfg(), 'glass'), false);
  assert.equal(readWindowStyle().style, 'auto');
});

test('不认识的样式被拒，文件不动', () => {
  seed({ glass: 'live' });
  const result = setWindowStyle('neon');
  assert.equal(result.ok, false);
  assert.match(result.rejected[0], /auto \/ live \/ frost \/ solid/);
  assert.equal(readCfg().glass, 'live');
});

test('大写写法的旧值会被归一到小写', () => {
  seed({ glass: 'FROST' });
  assert.equal(readWindowStyle().style, 'frost');
  setWindowStyle('frost');
  assert.equal(readCfg().glass, 'frost');
});

/** 最小的 http 替身：settings-api 只用到 headers / method / url / 异步 body。 */
function reqOf(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url: '/api/see-now/window',
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() { yield* chunks; },
  };
}

function resOf() {
  const out = { status: 0, body: '' };
  return {
    out, headersSent: false,
    writeHead(status) { out.status = status; this.headersSent = true; },
    end(body = '') { out.body = String(body); },
  };
}

test('/window 路由：读到 auto，写进 frost', async () => {
  seed();
  const handle = createSettingsApi({});

  const res1 = resOf();
  await handle(reqOf('GET'), res1, undefined);
  assert.equal(res1.out.status, 200);
  const got = JSON.parse(res1.out.body);
  assert.equal(got.ok, true);
  assert.equal(got.window.style, 'auto');

  const res2 = resOf();
  await handle(reqOf('POST', { patch: { style: 'frost' } }), res2, undefined);
  assert.equal(res2.out.status, 200);
  const saved = JSON.parse(res2.out.body);
  assert.equal(saved.ok, true);
  assert.equal(saved.window.style, 'frost');
  assert.equal(readCfg().glass, 'frost');
  assert.equal(readCfg().hidden, false, '别把 hidden 抹掉');
});
