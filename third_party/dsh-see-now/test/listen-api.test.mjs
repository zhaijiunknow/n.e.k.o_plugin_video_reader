/**
 * `httpTranscriber` 的两种协议形态。
 *
 * 存在的理由：换 baseUrl 不等于换服务。小米 MiMo 那类只提供聊天接口，端点和请求体
 * 都跟 `/audio/transcriptions` 不同 —— 选错形态不是"效果差一点"，是 404。
 *
 * 为什么起真服务而不是替换 `globalThis.fetch`：转写请求**故意不经过 fetch**
 * （见 `src/listen.js` 里 `send()` 的注释 —— 宿主里包住 fetch 的插件会把
 * 127.0.0.1:8000 当成它自己的"上游"，连不上就挂一条假告警）。所以测试也得
 * 走真 socket，否则测的是另一条路。
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';

import { httpTranscriber, ASR_APIS } from '../src/listen.js';

let server;
let base;
let last = null;
let reply = { status: 200, body: { text: '你好' } };
const sockets = new Set();

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      last = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      const status = reply.status ?? 200;
      const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      res.writeHead(status, {
        'content-type': reply.json === false ? 'text/plain' : 'application/json',
      });
      res.end(payload);
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});

after(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  last = null;
  reply = { status: 200, body: { text: '你好' } };
});

const WAV = Buffer.from('RIFFfake-wav-bytes');

test('ASR_APIS 只有两档，默认是 openai-audio', () => {
  assert.deepEqual([...ASR_APIS], ['openai-audio', 'chat-audio']);
});

test('openai-audio：打 /audio/transcriptions，multipart 带 model 与 language', async () => {
  const t = httpTranscriber({
    baseUrl: base,
    api: 'openai-audio',
    model: 'paraformer',
    language: 'zh',
    key: 'k',
  });
  const text = await t(WAV);

  assert.equal(text, '你好');
  assert.equal(last.method, 'POST');
  assert.equal(last.url, '/v1/audio/transcriptions');
  assert.equal(last.headers.authorization, 'Bearer k');
  assert.match(String(last.headers['content-type']), /^multipart\/form-data; boundary=/);
  const body = last.body.toString('latin1');
  assert.match(body, /name="file"; filename="a.wav"/);
  assert.match(body, /Content-Type: audio\/wav/);
  assert.match(body, /name="model"\r\n\r\nparaformer/);
  assert.match(body, /name="language"\r\n\r\nzh/);
  assert.match(body, /name="response_format"\r\n\r\njson/);
  assert.ok(body.includes('RIFFfake-wav-bytes'), '音频字节要原样进 multipart');
});

test('chat-audio：打 /chat/completions，音频进 input_audio.data（base64 + format）', async () => {
  reply = { status: 200, body: { choices: [{ message: { content: '  识别结果  ' } }] } };
  const t = httpTranscriber({
    baseUrl: base,
    api: 'chat-audio',
    model: 'mimo-v2.5-asr',
    language: 'zh',
    key: 'sk-1',
  });
  const text = await t(WAV);

  assert.equal(text, '识别结果');
  assert.equal(last.url, '/v1/chat/completions');
  assert.equal(last.headers.authorization, 'Bearer sk-1');
  assert.match(String(last.headers['content-type']), /^application\/json/);

  const j = JSON.parse(last.body.toString('utf8'));
  assert.equal(j.model, 'mimo-v2.5-asr');
  const part = j.messages[0].content[0];
  assert.equal(part.type, 'input_audio');
  assert.equal(part.input_audio.format, 'wav');
  // 纯 base64，不带 data: 前缀 —— 两家的文档都认这种写法
  assert.equal(part.input_audio.data.includes('data:'), false);
  assert.equal(Buffer.from(part.input_audio.data, 'base64').toString(), WAV.toString());
  assert.equal(j.asr_options.language, 'zh');
});

test('chat-audio：没有 key 就不带 Authorization 头', async () => {
  reply = { status: 200, body: { choices: [{ message: { content: 'ok' } }] } };
  const t = httpTranscriber({ baseUrl: base, api: 'chat-audio', model: 'm', language: 'auto' });
  await t(WAV);
  assert.equal('authorization' in last.headers, false);
});

test('chat-audio：content 是分段数组时也能拼成一句', async () => {
  reply = {
    status: 200,
    body: { choices: [{ message: { content: [{ type: 'text', text: '前半' }, { text: '后半' }] } }] },
  };
  const t = httpTranscriber({ baseUrl: base, api: 'chat-audio', model: 'm' });
  assert.equal(await t(WAV), '前半后半');
});

test('HTTP 非 2xx 必须抛 —— 不能装成"这段没说话"', async () => {
  reply = { status: 500, body: 'boom', json: false };
  const t = httpTranscriber({ baseUrl: base, api: 'chat-audio', model: 'm' });
  await assert.rejects(() => t(WAV), /HTTP 500/);
});

test('走的是自己的 http 通道，不经过全局 fetch', async () => {
  // 回归：宿主里包住 fetch 的插件（billion-context）会把本地转写端点登记成
  // 自己的"上游"，连不上就挂一条「上游不可用」。这里把 fetch 换成一个
  // 「一碰就炸」的版本，请求仍必须成功。
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('不应该走到全局 fetch');
  };
  try {
    reply = { status: 200, body: { text: '仍然成功' } };
    const t = httpTranscriber({ baseUrl: base, api: 'openai-audio', model: 'm' });
    assert.equal(await t(WAV), '仍然成功');
    assert.equal(last.url, '/v1/audio/transcriptions');
  } finally {
    globalThis.fetch = original;
  }
});

test('服务不回应时超时抛错，不无限等', async () => {
  // 换一个只收不回的服务，1ms 超时立刻炸
  const silent = createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  try {
    const t = httpTranscriber(
      { baseUrl: `http://127.0.0.1:${silent.address().port}/v1`, api: 'chat-audio', model: 'm' },
      { timeoutMs: 1 },
    );
    await assert.rejects(() => t(WAV), /超时|abort|socket hang up|ECONNRESET/i);
  } finally {
    silent.closeAllConnections?.();
    await new Promise((r) => silent.close(r));
  }
});
