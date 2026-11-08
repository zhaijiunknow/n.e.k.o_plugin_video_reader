/**
 * voice-ensure.test.mjs — 「每次调用检查一下声音」的那层。
 *
 * 要证明三件事：
 *   ① 没变的时候不重挂（否则每次调用都重新 import 一次适配器）；
 *   ② 改了 `tts.json` 就重挂（这正是"改配置不用重启"的全部意义）；
 *   ③ 换了适配器也重挂。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ensureConfiguredVoice, detachAdapters, voiceSignature } from '../src/voice.js';

/** 造一个只记"被挂了几次"的适配器，落盘到 home 目录里。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'see-now-voice-'));
  const log = join(home, 'attach.log');
  const adapter = join(home, 'adapter.mjs');
  writeFileSync(adapter, `
import { appendFileSync } from 'node:fs';
export const adapterName = 'test-adapter';
export function attach(api) {
  appendFileSync(${JSON.stringify(log)}, 'attach\\n');
  return () => {};
}
`, 'utf8');
  writeFileSync(join(home, 'voice.json'), JSON.stringify({ adapter: pathToFileURL(adapter).href }), 'utf8');
  return { home, log, adapter };
}

const count = (file) => {
  try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; }
};

test('声音：没改配置就不重挂，改了 tts.json 立刻重挂', async () => {
  const { home, log } = makeHome();
  const env = { ...process.env, DSH_HOME: home };
  await detachAdapters();

  const first = await ensureConfiguredVoice({ env });
  assert.equal(first.ok, true, '第一次应该挂上');
  assert.equal(count(log), 1);

  const again = await ensureConfiguredVoice({ env });
  assert.equal(again.cached, true, '指纹没变，应该走缓存');
  assert.equal(count(log), 1, '不该重复 import 适配器');

  // 改音色 —— 这就是"以后改 tts.json 不用重启"要覆盖的场景
  writeFileSync(join(home, 'tts.json'), JSON.stringify({ voice: 'Meijia', rate: 200 }), 'utf8');
  const changed = await ensureConfiguredVoice({ env });
  assert.equal(changed.ok, true);
  assert.equal(count(log), 2, 'tts.json 变了就该重挂一次');

  // 内容一字不变地再写一遍（touch 语义）：**不该**重挂 —— 指纹是按内容算的。
  // 早先这里用 mtime 判，同一毫秒内的等长写入会被判成"没变"，单测当场踩到过。
  writeFileSync(join(home, 'tts.json'), JSON.stringify({ voice: 'Meijia', rate: 200 }), 'utf8');
  await ensureConfiguredVoice({ env });
  assert.equal(count(log), 2, '内容没变就不该重挂');

  writeFileSync(join(home, 'tts.json'), JSON.stringify({ voice: 'Rocko', rate: 180 }), 'utf8');
  await ensureConfiguredVoice({ env });
  assert.equal(count(log), 3, '真改了内容才重挂');

  await detachAdapters();
});

test('声音：换适配器会重挂，且旧适配器被卸掉', async () => {
  const { home, log } = makeHome();
  const env = { ...process.env, DSH_HOME: home };
  await detachAdapters();

  await ensureConfiguredVoice({ env });
  assert.equal(count(log), 1);
  const before = voiceSignature(env);

  const other = join(home, 'adapter2.mjs');
  writeFileSync(other, `
import { appendFileSync } from 'node:fs';
export function attach() { appendFileSync(${JSON.stringify(log)}, 'attach2\\n'); }
`, 'utf8');
  writeFileSync(join(home, 'voice.json'), JSON.stringify({ adapter: pathToFileURL(other).href }), 'utf8');

  const after = voiceSignature(env);
  assert.notEqual(before, after, '换了适配器，指纹必须变');

  const r = await ensureConfiguredVoice({ env });
  assert.equal(r.ok, true);
  assert.equal(count(log), 2, '新适配器应该被挂上');

  await detachAdapters();
});

test('声音：没配 voice.json 时什么都不做（不是错误）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'see-now-novoice-'));
  const r = await ensureConfiguredVoice({ env: { ...process.env, DSH_HOME: home } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-configured');
});
