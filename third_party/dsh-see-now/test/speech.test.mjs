/**
 * speech.test.mjs — 声音与插话的守卫。
 *
 * 这一组守的是"用户能不能听见/看见"这件事，坏起来**不报错**：
 *   - `say` 只写盘不发事件 → 窗口有字、没声音（用户第一反应就是这个）
 *   - 插话没记待回执 → 模型先去取图，回来就忘了回，用户侧等于没理他
 *   - 待回执不清 → 一轮话被念三遍
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachConfiguredVoice, attachedAdapters, detachAdapters, ensureConfiguredVoice, lastVoiceError, loadVoiceAdapter } from '../src/voice.js';

const home = mkdtempSync(join(tmpdir(), 'dsh-see-speech-'));
process.env.DSH_HOME = home;

const { onSpeech, emitSpeech, emitSpoken, speechSubscribers, __resetSpeech } =
  await import('../src/speech.js');
const { appendSpoken, appendChat, chatFile } =
  await import('../src/chat.js');
const { interjectNote, noteInterjected, clearInterjected, pendingInterjected,
  replyReminder, __resetInterject } = await import('../src/interject.js');

beforeEach(() => { __resetSpeech(); __resetInterject(); });
afterEach(async () => { await detachAdapters(); });

const fixtureKey = Symbol.for('dsh-see-now.voice-test');
function voiceFixture(attach) {
  globalThis[fixtureKey] = attach;
  return `data:text/javascript,${encodeURIComponent(`export const attach = globalThis[Symbol.for('dsh-see-now.voice-test')]; // ${voiceFixture.id++}`)}`;
}
voiceFixture.id = 0;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('没有订阅者时发事件是空操作，不抛', () => {
  assert.equal(emitSpeech({ text: 'hi' }), 0);
  assert.equal(speechSubscribers(), 0);
});

test('appendSpoken 写盘的同时一定发 due 事件（缺一个就是"有字没声"）', () => {
  const got = [];
  onSpeech((e) => got.push(e), { voice: true });

  appendSpoken('assistant', '我看看');

  assert.equal(got.length, 1, '必须发出事件，否则没有声音');
  assert.equal(got[0].state, 'due');
  assert.equal(got[0].text, '我看看');
  assert.equal(got[0].origin, 'chat', 'origin=chat 让展示层别再写一遍');
});

test('speak:false 只写盘不发事件（诊断行不该被念）', () => {
  const got = [];
  onSpeech((e) => got.push(e), { voice: true });
  appendSpoken('meta', '悬浮窗没开起来', { speak: false });
  assert.equal(got.length, 0);
});

test('speechSubscribers 只数 voice:true 的（只做展示的订阅者不算会出声）', () => {
  const offA = onSpeech(() => {}, { voice: true });
  const offB = onSpeech(() => {}, { voice: false });

  assert.equal(speechSubscribers(), 1);
  offA();
  assert.equal(speechSubscribers(), 0);
  offB();
});

test('适配器发的 spoken 能送到订阅者手里', () => {
  const got = [];
  onSpeech((e) => got.push(e.state), { voice: true });

  emitSpoken({ text: '出声了' });

  assert.equal(got.length, 1);
  assert.equal(got[0], 'spoken');
});

test('插话话术必须说清楚"只有 say 能进窗、会被念"', () => {
  const note = interjectNote('你好');
  assert.match(note, /say/, '必须点名 say 参数');
  assert.match(note, /只有/, '必须强调通道唯一');
  assert.match(note, /你好/, '必须把用户说的话带上');
});

test('插话记待回执；没带 say 时提醒一次，且只提醒一次', () => {
  noteInterjected('这个表格最后一列是啥');

  const first = replyReminder({ answered: false });
  assert.match(first, /未回应/);
  assert.match(first, /这个表格最后一列是啥/);

  const second = replyReminder({ answered: false });
  assert.equal(second, '', '同一句只提醒一次，再念就是噪音');
});

test('带了 say 就等于回过了，待回执立刻清掉', () => {
  noteInterjected('你好');
  assert.equal(replyReminder({ answered: true }), '', 'answered 不该再提醒');
  assert.equal(pendingInterjected(), null, 'answered 要清掉待回执');
});

test('同一句话重复说，不重置提醒次数（否则会无限循环）', () => {
  noteInterjected('你好');
  assert.match(replyReminder({ answered: false }), /未回应/);
  const again = noteInterjected('你好');
  const at = pendingInterjected();
  assert.equal(again.reminded, 1, '重复记录不该把 reminded 清零');
  assert.equal(replyReminder({ answered: false }), '', '还是不该再提醒');
  assert.equal(at.reminded, 1);
});

test('待回执过 3 分钟自动失效', () => {
  const now = Date.now();
  noteInterjected('很久以前', { at: now - 181_000 });
  assert.equal(pendingInterjected(now), null);
});

test('chat.jsonl 里能同时看到 assistant 的话和 user 的插话', () => {
  appendSpoken('assistant', '我先看看你的屏幕');
  appendChat('user', '上面那个报错是什么意思');
  const lines = readFileSync(chatFile(), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.role === 'assistant' && l.text.includes('先看看')));
  assert.ok(lines.some((l) => l.role === 'user' && l.text.includes('报错')));
});

test('默认挂载复用，owner/scope 卸载只影响自己的适配器', { timeout: 2000 }, async () => {
  const signals = [];
  let detached = 0;
  const spec = voiceFixture((api) => {
    signals.push(api.signal);
    api.onSpeech(() => {});
    return () => { detached += 1; };
  });
  const owner = {};
  const env = { DSH_VOICE_ADAPTER: spec };
  await Promise.all([loadVoiceAdapter(spec), loadVoiceAdapter(spec)]);
  assert.equal(speechSubscribers(), 1);
  assert.equal((await loadVoiceAdapter(spec)).cached, true);
  await attachConfiguredVoice({ env, scope: owner });
  assert.equal((await loadVoiceAdapter(spec, { owner })).cached, true);
  const unrelatedOff = onSpeech(() => {});
  await detachAdapters({ owner });
  assert.equal(detached, 1);
  assert.equal(signals[1].aborted, true);
  assert.equal(signals[0].aborted, false);
  assert.equal(speechSubscribers(), 2);
  assert.deepEqual(attachedAdapters(), [spec]);
  await detachAdapters();
  assert.equal(speechSubscribers(), 1);
  unrelatedOff();
});

test('热配置并发切换、删配置和 signal 取消只清本 owner', { timeout: 2000 }, async () => {
  const entered = deferred();
  const oldSpec = voiceFixture((api) => {
    api.onSpeech(() => {});
    entered.resolve();
    return new Promise(() => {});
  });
  const owner = {};
  const stale = ensureConfiguredVoice({ env: { DSH_HOME: home, DSH_VOICE_ADAPTER: oldSpec }, owner });
  await entered.promise;
  const freshSpec = voiceFixture((api) => { api.onSpeech(() => {}); return () => {}; });
  const env = { DSH_HOME: home, DSH_VOICE_ADAPTER: freshSpec };
  await ensureConfiguredVoice({ env, owner: {} });
  const controller = new AbortController();
  await ensureConfiguredVoice({ env, owner, signal: controller.signal });
  assert.equal((await stale).reason, 'aborted');
  assert.equal(speechSubscribers(), 2);
  const results = await Promise.all([ensureConfiguredVoice({ env, owner }), ensureConfiguredVoice({ env, owner })]);
  assert.ok(results.every((result) => result.cached));
  controller.abort();
  assert.equal(speechSubscribers(), 1);
  await ensureConfiguredVoice({ env, owner, signal: new AbortController().signal });
  assert.equal((await ensureConfiguredVoice({ env: { ...env, DSH_VOICE_ADAPTER: '' }, owner })).reason, 'not-configured');
  assert.equal(speechSubscribers(), 1);
});

test('适配器重复订阅同一 handler 仍按总线契约去重', { timeout: 2000 }, async () => {
  let calls = 0;
  const handler = () => { calls += 1; };
  await loadVoiceAdapter(voiceFixture((api) => {
    api.onSpeech(handler);
    api.onSpeech(handler);
  }));
  assert.equal(speechSubscribers(), 1);
  emitSpeech({ text: '只发一次' });
  assert.equal(calls, 1);
});

test('pending attach 卸载后可重挂，迟到订阅和回执失效，旧 detach 仍执行一次', { timeout: 2000 }, async () => {
  const entered = deferred();
  const release = deferred();
  const lateDetached = deferred();
  let calls = 0;
  let lateDelivered;
  const spec = voiceFixture(async (api) => {
    api.onSpeech(() => {});
    if (++calls === 1) {
      entered.resolve();
      await release.promise;
      api.onSpeech(() => {});
      lateDelivered = api.emitSpoken({ text: '迟到回执' });
      return () => lateDetached.resolve();
    }
    return () => {};
  });
  const owner = {};
  const controller = new AbortController();
  const loading = loadVoiceAdapter(spec, { owner, signal: controller.signal });
  await entered.promise;
  controller.abort();
  await detachAdapters({ scope: owner });
  assert.equal(speechSubscribers(), 0);
  assert.equal((await loading).reason, 'aborted');
  assert.equal((await loadVoiceAdapter(spec, { owner })).ok, true);
  release.resolve();
  await lateDetached.promise;
  assert.equal(lateDelivered, 0);
  assert.equal(speechSubscribers(), 1);
  assert.deepEqual(attachedAdapters(), [spec]);
});

test('signal 取消挂载并允许原 owner 用新 signal 再挂载', { timeout: 2000 }, async () => {
  let detached = 0;
  const spec = voiceFixture((api) => {
    api.onSpeech(() => {});
    return () => { detached += 1; };
  });
  const owner = {};
  const controller = new AbortController();
  await loadVoiceAdapter(spec, { owner });
  await loadVoiceAdapter(spec, { owner, signal: controller.signal });
  controller.abort();
  assert.equal(speechSubscribers(), 0);
  await detachAdapters({ owner });
  assert.equal(detached, 1);
  assert.equal((await loadVoiceAdapter(spec, { owner, signal: controller.signal })).reason, 'aborted');
  assert.equal((await loadVoiceAdapter(spec, { owner, signal: new AbortController().signal })).ok, true);
});

test('detach 先退订再调用，挂起的 detach 有界返回且不阻塞其他实例', { timeout: 2500 }, async () => {
  let subscribersAtDetach;
  let fastDetached = false;
  const stuck = voiceFixture((api) => {
    api.onSpeech(() => {});
    return () => {
      subscribersAtDetach = speechSubscribers();
      return new Promise(() => {});
    };
  });
  await loadVoiceAdapter(stuck);
  const fast = voiceFixture((api) => {
    api.onSpeech(() => {});
    return () => { fastDetached = true; };
  });
  await loadVoiceAdapter(fast);
  const closing = detachAdapters();
  assert.equal(speechSubscribers(), 0);
  await new Promise(setImmediate);
  assert.equal(fastDetached, true);
  assert.equal(subscribersAtDetach, 0);
  await closing;
  assert.deepEqual(attachedAdapters(), []);
});

test('attach 先订阅后抛仍退订并保留失败原因', { timeout: 2000 }, async () => {
  const spec = voiceFixture((api) => {
    api.onSpeech(() => {});
    throw new Error('broken voice');
  });
  assert.match((await loadVoiceAdapter(spec)).reason, /attach failed: broken voice/);
  assert.equal(speechSubscribers(), 0);
  assert.match(lastVoiceError(), /broken voice/);
});
