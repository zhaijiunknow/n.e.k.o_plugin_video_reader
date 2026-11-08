/**
 * `src/asr-store.mjs` —— 面板里改转写服务地址的那条路。
 *
 * 重点不是"能写"，而是**写的时候别弄坏别人的东西**：`asr.json` 是两个插件共用的，
 * storyboard 在里面放 `manage`（怎么把服务拉起来），面板必须原样留着。
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { asrPath, readAsrConfig, writeAsrConfig, ASR_WRITABLE_KEYS } from '../src/asr-store.mjs';

const TUNING_PATH = '/tmp/dsh-home/see-now.json';
const FILE = asrPath(TUNING_PATH);

function memFs(seed = {}) {
  const files = { ...seed };
  return {
    files,
    readFile: (path) => {
      if (!(path in files)) {
        const err = new Error(`ENOENT: ${path}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files[path];
    },
    writeFile: (path, text) => {
      files[path] = text;
    },
    mkdir: () => {},
  };
}

test('asrPath：与 see-now.json 同目录', () => {
  // join() 会按平台规范化分隔符，所以两边都过一遍 join 再比 —— 直接比字面量
  // 在 Windows 上会因为 `/` 与 `\` 的差异假红。
  assert.equal(FILE, join(dirname(join(TUNING_PATH)), 'asr.json'));
  assert.equal(dirname(FILE), dirname(join(TUNING_PATH)));
});

test('没有任何文件时：exists 为假，api 退回默认', () => {
  const fs = memFs();
  const info = readAsrConfig(FILE, { readFile: fs.readFile });
  assert.equal(info.exists, false);
  assert.equal(info.api, 'openai-audio');
  assert.equal(info.baseUrl, '');
  assert.equal(info.hasKey, false);
});

test('非法 JSON 也当"还没配"，不抛', () => {
  const fs = memFs({ [FILE]: '{ 这不是 json' });
  const info = readAsrConfig(FILE, { readFile: fs.readFile });
  assert.equal(info.exists, false);
});

test('写一次基本的四件套', () => {
  const fs = memFs();
  const r = writeAsrConfig(
    { api: 'chat-audio', baseUrl: 'https://api.example.com/v1', model: 'mimo-v2.5-asr', language: 'auto' },
    { path: FILE, ...fs },
  );
  assert.equal(r.ok, true, JSON.stringify(r.rejected));
  const saved = JSON.parse(fs.files[FILE]);
  assert.equal(saved.api, 'chat-audio');
  assert.equal(saved.baseUrl, 'https://api.example.com/v1');
  assert.equal(saved.model, 'mimo-v2.5-asr');
  assert.equal(saved.language, 'auto');
  assert.equal(r.values.api, 'chat-audio');
  assert.equal(r.values.exists, true);
});

test('manage 必须原样保留 —— 那是另一个插件用来拉起服务的', () => {
  const fs = memFs({
    [FILE]: JSON.stringify({
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'old',
      manage: { start: ['python', 'server.py'], idleMs: 5000 },
    }),
  });
  const r = writeAsrConfig({ model: 'new' }, { path: FILE, ...fs });
  assert.equal(r.ok, true);
  const saved = JSON.parse(fs.files[FILE]);
  assert.equal(saved.model, 'new');
  assert.deepEqual(saved.manage, { start: ['python', 'server.py'], idleMs: 5000 });
  assert.equal(saved.baseUrl, 'http://127.0.0.1:8000/v1');
});

test('不认识的键留在文件里，不因为不认识就被删掉', () => {
  const fs = memFs({ [FILE]: JSON.stringify({ baseUrl: 'http://a/v1', somethingElse: [1, 2, 3] }) });
  const r = writeAsrConfig({ language: 'zh' }, { path: FILE, ...fs });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(fs.files[FILE]).somethingElse, [1, 2, 3]);
});

test('提交里出现不认识的键要整份拒', () => {
  const fs = memFs();
  const r = writeAsrConfig({ baseUrl: 'http://a/v1', 甲: '乙' }, { path: FILE, ...fs });
  assert.equal(r.ok, false);
  assert.match(r.rejected.join(), /甲/);
  assert.equal(fs.files[FILE], undefined, '拒了就不该落盘');
});

test('api 只认 ASR_APIS 里的值', () => {
  const fs = memFs();
  const r = writeAsrConfig({ api: 'grpc' }, { path: FILE, ...fs });
  assert.equal(r.ok, false);
  assert.match(r.rejected.join(), /openai-audio/);
  assert.equal(fs.files[FILE], undefined);
});

test('baseUrl 必须是 http(s)，并且拒了就一个字节都不写', () => {
  const fs = memFs({ [FILE]: JSON.stringify({ baseUrl: 'http://a/v1' }) });
  for (const bad of ['ftp://a', 'file:///c:/x', '不是地址', 'javascript:alert(1)']) {
    const r = writeAsrConfig({ baseUrl: bad, model: 'x' }, { path: FILE, ...fs });
    assert.equal(r.ok, false, `${bad} 应该被拒`);
  }
  assert.equal(JSON.parse(fs.files[FILE]).model, undefined, '被拒时 model 也不该落盘');
});

test('baseUrl 传空串 = 删掉这个键（回到"没配"）', () => {
  const fs = memFs({ [FILE]: JSON.stringify({ baseUrl: 'http://a/v1', model: 'm' }) });
  const r = writeAsrConfig({ baseUrl: '' }, { path: FILE, ...fs });
  assert.equal(r.ok, true);
  const saved = JSON.parse(fs.files[FILE]);
  assert.equal('baseUrl' in saved, false);
  assert.equal(saved.model, 'm');
  assert.equal(r.values.exists, false);
});

test('key 传空串 = 删除；有值才写', () => {
  const fs = memFs({ [FILE]: JSON.stringify({ baseUrl: 'http://a/v1', key: 'old' }) });
  assert.equal(readAsrConfig(FILE, { readFile: fs.readFile }).hasKey, true);

  writeAsrConfig({ key: '' }, { path: FILE, ...fs });
  assert.equal(readAsrConfig(FILE, { readFile: fs.readFile }).hasKey, false);

  writeAsrConfig({ key: 'sk-new' }, { path: FILE, ...fs });
  assert.equal(JSON.parse(fs.files[FILE]).key, 'sk-new');
  assert.equal(readAsrConfig(FILE, { readFile: fs.readFile }).hasKey, true);
});

test('读回来的快照里没有 key 本身', () => {
  const fs = memFs({ [FILE]: JSON.stringify({ baseUrl: 'http://a/v1', key: 'sk-secret' }) });
  const info = readAsrConfig(FILE, { readFile: fs.readFile });
  assert.equal(JSON.stringify(info).includes('sk-secret'), false);
  assert.equal(info.hasKey, true);
});

test('model / language 空串算错，不静默删', () => {
  const fs = memFs({ [FILE]: JSON.stringify({ baseUrl: 'http://a/v1', model: 'm' }) });
  const r = writeAsrConfig({ model: '   ' }, { path: FILE, ...fs });
  assert.equal(r.ok, false);
  assert.match(r.rejected.join(), /model/);
});

test('可写键清单不多不少', () => {
  assert.deepEqual([...ASR_WRITABLE_KEYS], ['api', 'baseUrl', 'model', 'language', 'key']);
  assert.equal(ASR_WRITABLE_KEYS.includes('manage'), false);
});
