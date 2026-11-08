/**
 * settings-api.test.mjs — 设置页那两条路由的契约。
 *
 * 真起一个 http 服务、用真 fetch 打进去，测的是**形状**不是实现：
 * 路由、信任栅栏、"打开面板不建文件"、越界拒写、未知字段拒写、写完 status 真的变了。
 *
 * 为什么不 mock `req`/`res`：这套东西最要紧的性质恰好是端到端的 —— 前缀会不会被
 * webServer 认走、Host 头会不会被拦、body 能不能流式读完。假对象测不出这些。
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home;
let server;
let base;
let file;

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-see-api-'));
  process.env.DSH_HOME = home;
  const { createSettingsApi, ROUTE_PREFIX } = await import('../src/settings-api.mjs');
  const handle = createSettingsApi();
  server = http.createServer((req, res) => {
    handle(req, res, undefined).catch((err) => {
      res.writeHead(500);
      res.end(String(err?.message ?? err));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`;
  file = join(home, 'see-now.json');
});

after(() => {
  server?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

const stored = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);

async function status() {
  const res = await fetch(`${base}/status`);
  return { code: res.status, body: await res.json() };
}

async function post(payload) {
  const res = await fetch(`${base}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { code: res.status, body: await res.json() };
}

test('GET /status 回当前值、默认值、路径', async () => {
  const { code, body } = await status();
  assert.equal(code, 200);
  assert.equal(body.ok, true);
  assert.equal(body.path, file);
  assert.equal(body.values.maxAutonomousWakes, 8);
  assert.equal(body.values.listen.silence, 0.35);
  assert.equal(body.defaults.idleStopMs, 180000);
  assert.deepEqual(body.paces, ['calm', 'normal', 'dense', 'game-economic']);
  assert.deepEqual(body.warnings, []);
});

test('只是打开面板，不创建配置文件', async () => {
  await status();
  assert.equal(existsSync(file), false);
});

test('POST /config 只写提交过的键', async () => {
  const { code, body } = await post({ patch: { idleStopMin: 10 } });
  assert.equal(code, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(stored(), { idleStopMin: 10 });
});

test('越界值被拒，原因来自 tuning 的校验而不是这里', async () => {
  const { body } = await post({ patch: { idleStopMin: 9999 } });
  assert.equal(body.ok, false);
  assert.match((body.rejected ?? []).join(' '), /0–1440/);
  assert.deepEqual(stored(), { idleStopMin: 10 }, '拒写不该动文件');
});

test('不认识的键被拒，不是被静默丢掉', async () => {
  const { body } = await post({ patch: { bogus: 1 } });
  assert.equal(body.ok, false);
  assert.match((body.rejected ?? []).join(' '), /不认识/);
});

test('listen 段是浅合并', async () => {
  const { body } = await post({ patch: { listen: { maxSeg: 5 } } });
  assert.equal(body.ok, true);
  assert.deepEqual(stored(), { idleStopMin: 10, listen: { maxSeg: 5 } });
});

test('写完再读，拿到的是新值且没有警告', async () => {
  const { body } = await status();
  assert.equal(body.values.idleStopMin, 10);
  assert.equal(body.values.listen.maxSeg, 5);
  assert.deepEqual(body.warnings, []);
});

test('缺少 patch → 400', async () => {
  const { code } = await post({});
  assert.equal(code, 400);
});

test('GET /config → 405', async () => {
  const res = await fetch(`${base}/config`);
  assert.equal(res.status, 405);
});

test('未知路由 → 404', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});

test('非 loopback 的 Host 被信任栅栏挡在 403', async () => {
  const code = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: `${base.replace(/^http:\/\/[^/]+/, '')}/status`,
      headers: { host: 'evil.example:80' },
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.end();
  });
  assert.equal(code, 403);
});

test('POST /config 回的是写完之后的完整快照', async () => {
  // 回归：回包如果只给「这次提交的键」，前端拿它重建草稿时 `values.listen`
  // 会是 undefined —— 只改 idleStopMin 就会让整个 listen 段从界面上消失。
  const { body } = await post({ patch: { idleStopMin: 30 } });
  assert.equal(body.ok, true);
  assert.equal(body.values.idleStopMin, 30);
  assert.equal(typeof body.values.listen, 'object');
  assert.equal(body.values.listen.silence, 0.35, '没提交的段要按文件里的实际值回');
  assert.equal(body.values.idleStopMs, 1800000, '派生值一起回，前端不用自己算');
  assert.equal('defaults' in body.values, false, '契约是「值」，不夹带 defaults');
});

// ── /local：改 asr.json 那一支 ────────────────────────────────────────────────
// 这份文件是两个插件共用的，所以这里的断言重点在"别写坏别人的东西"：
// 未知键拒、manage 保留、key 只写不读。

const asrFile = () => join(home, 'asr.json');
const asrStored = () => (existsSync(asrFile()) ? JSON.parse(readFileSync(asrFile(), 'utf8')) : null);

async function postLocal(payload) {
  const res = await fetch(`${base}/local`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { code: res.status, body: await res.json() };
}

test('status 里带 asr.json 的现状；没有文件时 exists 为假', async () => {
  const { body } = await status();
  assert.equal(body.local.path, asrFile());
  assert.equal(body.local.exists, false);
  assert.equal(body.local.api, 'openai-audio');
  assert.equal(body.local.hasKey, false);
});

test('POST /local 写 asr.json，status 立刻反映新值', async () => {
  const r = await postLocal({
    patch: { api: 'chat-audio', baseUrl: 'https://api.example.com/v1', model: 'mimo-v2.5-asr', language: 'auto', key: 'sk-1' },
  });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true, JSON.stringify(r.body.rejected));

  const saved = asrStored();
  assert.equal(saved.baseUrl, 'https://api.example.com/v1');
  assert.equal(saved.api, 'chat-audio');
  assert.equal(saved.key, 'sk-1');

  const { body } = await status();
  assert.equal(body.local.exists, true);
  assert.equal(body.local.api, 'chat-audio');
  assert.equal(body.local.hasKey, true);
  assert.equal(JSON.stringify(body.local).includes('sk-1'), false, 'key 不该回传给前端');
});

test('POST /local 拒绝未知字段，且一个字节都不写', async () => {
  const before = asrStored();
  const r = await postLocal({ patch: { 乱写: 1 } });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, false);
  assert.deepEqual(asrStored(), before);
});

test('POST /local 拒绝非法 api', async () => {
  const r = await postLocal({ patch: { api: 'grpc' } });
  assert.equal(r.body.ok, false);
  assert.match(r.body.rejected.join(), /openai-audio/);
});

test('POST /local 缺 patch 回 400', async () => {
  const r = await postLocal({});
  assert.equal(r.code, 400);
});

test('GET /local 回 405', async () => {
  const res = await fetch(`${base}/local`);
  assert.equal(res.status, 405);
});

test('写 asr.json 时 manage 原样保留 —— 那是另一个插件拉起服务用的', async () => {
  writeFileSync(asrFile(), JSON.stringify({ baseUrl: 'http://127.0.0.1:8000/v1', manage: { idleMs: 5000 } }));
  const r = await postLocal({ patch: { model: 'paraformer-zh-2024-03-09' } });
  assert.equal(r.body.ok, true, JSON.stringify(r.body.rejected));
  assert.deepEqual(asrStored().manage, { idleMs: 5000 });
  assert.equal(asrStored().baseUrl, 'http://127.0.0.1:8000/v1');
});
