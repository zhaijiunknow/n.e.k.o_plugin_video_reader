/**
 * `listen.prefer` —— 用哪个转写器。
 *
 * 核心断言只有一条：**指定了就说到做到**。`host` / `local` 找不到时返回 null，
 * 不偷偷换成另一个顶上。悄悄回落比"没有字幕"更难查 ——
 * 界面显示在听，说的却不是用户以为的那个引擎。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveTranscriber } from '../src/listen.js';
import { LISTEN_DEFAULTS, readTuning } from '../src/tuning.js';

const ROOT = mkdtempSync(join(tmpdir(), 'see-now-prefer-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** 造一个只有 `asr.json`（或什么都没有）的 DSH_HOME。 */
let seq = 0;
function home(asr) {
  seq += 1;
  const dir = join(ROOT, `h${seq}`);
  mkdirSync(dir, { recursive: true });
  if (asr) writeFileSync(join(dir, 'asr.json'), JSON.stringify(asr), 'utf8');
  return dir;
}

const LOCAL = { baseUrl: 'http://127.0.0.1:8000/v1', model: 'paraformer-zh-2024-03-09' };

const hostCtx = {
  get: (name) => (name === 'speechToText' ? {
    resolve: () => ({ audio: null }),
    transcribe: async () => ({ text: '假台词' }),
  } : null),
};
const noHostCtx = { get: () => null };

describe('resolveTranscriber：按 prefer 选', () => {
  it('auto —— 宿主能用就用宿主', () => {
    const r = resolveTranscriber(hostCtx, { env: { DSH_HOME: home(LOCAL) }, prefer: 'auto' });
    assert.equal(r.kind, 'host');
  });

  it('auto —— 没有宿主就回落本地', () => {
    const r = resolveTranscriber(noHostCtx, { env: { DSH_HOME: home(LOCAL) }, prefer: 'auto' });
    assert.equal(r.kind, 'http');
    assert.match(r.label, /127\.0\.0\.1:8000/);
  });

  it('host —— 有宿主就用，哪怕本地也配好了', () => {
    const r = resolveTranscriber(hostCtx, { env: { DSH_HOME: home(LOCAL) }, prefer: 'host' });
    assert.equal(r.kind, 'host');
  });

  it('host —— 没有宿主就认输，不回落本地', () => {
    assert.equal(resolveTranscriber(noHostCtx, { env: { DSH_HOME: home(LOCAL) }, prefer: 'host' }), null);
  });

  it('local —— 用本地，哪怕宿主可用', () => {
    const r = resolveTranscriber(hostCtx, { env: { DSH_HOME: home(LOCAL) }, prefer: 'local' });
    assert.equal(r.kind, 'http');
  });

  it('local —— 没配 asr.json 就认输，不回落宿主', () => {
    assert.equal(resolveTranscriber(hostCtx, { env: { DSH_HOME: home(null) }, prefer: 'local' }), null);
  });

  it('不认识的值当 auto（配置写错不该把听声音弄停）', () => {
    const r = resolveTranscriber(hostCtx, { env: { DSH_HOME: home(LOCAL) }, prefer: 'gpu' });
    assert.equal(r.kind, 'host');
  });
});

describe('readListen：prefer 的校验', () => {
  const read = (listen) => readTuning({
    env: { DSH_HOME: ROOT },
    readFile: () => JSON.stringify({ listen }),
  });

  it('默认是 auto', () => {
    assert.equal(LISTEN_DEFAULTS.prefer, 'auto');
    assert.equal(read({}).listen.prefer, 'auto');
  });

  it('三个合法值原样收下，不报警告', () => {
    for (const v of ['auto', 'host', 'local']) {
      const r = read({ prefer: v });
      assert.equal(r.listen.prefer, v);
      assert.deepEqual(r.warnings, []);
    }
  });

  it('非法值退回 auto，并留一条能照抄的警告', () => {
    const r = read({ prefer: 'gpu' });
    assert.equal(r.listen.prefer, 'auto');
    assert.match(r.warnings.join('\n'), /listen\.prefer 只能是 auto \/ host \/ local/);
  });
});
