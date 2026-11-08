/**
 * pacing.test.mjs — 「上一句说多久，就等多久再叫下一轮」。
 *
 * 来自 2603.02655：下一次开口的时机由上一句的估计时长决定，不是写死的常数。
 * 这里只测两个纯函数；接线（spoken 事件、loop 的门）在 loop.test.mjs / speech.test.mjs。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateSpeechMs, nextProactiveAt, SPEECH_TAIL_MS, SPEECH_MS_MAX, SPEECH_MS_MIN,
  SPEECH_FOLLOW_FLOOR_MS,
} from '../src/pacing.js';

test('estimateSpeechMs: 空文本 / 纯空白 = 不算说话', () => {
  assert.equal(estimateSpeechMs(''), 0);
  assert.equal(estimateSpeechMs('   '), 0);
  assert.equal(estimateSpeechMs(null), 0);
});

test('estimateSpeechMs: 中文按字数估（20 字 ≈ 4 秒）', () => {
  const ms = estimateSpeechMs('这是一句大概二十个字的解说台词用来估算时长');
  assert.ok(ms > 3000 && ms < 5000, `20 字应该落在 3–5 秒，实际 ${ms}ms`);
});

test('estimateSpeechMs: 英文比中文快', () => {
  const zh = estimateSpeechMs('这是一句大概二十个字的解说台词用来估算时长');
  const en = estimateSpeechMs('this is a twenty character sentence');
  assert.ok(en < zh * 0.8, `英文 ${en}ms 应该明显短于中文 ${zh}ms`);
});

test('estimateSpeechMs: 地板 0.5 秒、封顶 20 秒', () => {
  assert.equal(estimateSpeechMs('嗯'), SPEECH_MS_MIN);
  assert.equal(estimateSpeechMs('啊'.repeat(500)), SPEECH_MS_MAX);
});

test('nextProactiveAt: 没说过话 = 旧的固定间隔', () => {
  assert.equal(nextProactiveAt({ lastWakeAt: 1000, minGapMs: 8000 }), 9000);
});

test('nextProactiveAt: 上一句更长时，说完再留气口', () => {
  const at = nextProactiveAt({
    lastWakeAt: 1000, minGapMs: 8000, speechAt: 5000, speechMs: 8000,
  });
  assert.equal(at, 5000 + 8000 + SPEECH_TAIL_MS);
});

test('follow: 上一句很短时，按说完+气口，但有 3 秒地板', () => {
  const at = nextProactiveAt({
    lastWakeAt: 1000, minGapMs: 8000, speechAt: 2000, speechMs: 500,
  });
  assert.equal(at, 1000 + SPEECH_FOLLOW_FLOOR_MS);
});

test('guard: 上一句很短时，维持该节奏原本的间隔', () => {
  const at = nextProactiveAt({
    lastWakeAt: 1000, minGapMs: 8000, speechAt: 2000, speechMs: 500, mode: 'guard',
  });
  assert.equal(at, 9000);
});

test('off: 忽略说话，纯固定间隔', () => {
  const at = nextProactiveAt({
    lastWakeAt: 1000, minGapMs: 8000, speechAt: 2000, speechMs: 12000, mode: 'off',
  });
  assert.equal(at, 9000);
});

test('nextProactiveAt: 非法输入不炸，返回 0', () => {
  assert.equal(nextProactiveAt(), 0);
  assert.equal(nextProactiveAt({ lastWakeAt: NaN, minGapMs: NaN, speechAt: NaN, speechMs: NaN }), 0);
});
