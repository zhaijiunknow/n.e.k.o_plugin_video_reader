/**
 * capture-error.test.mjs — 采集失败要能分清"没装 ffmpeg / 没给权限 / 设备不对"。
 *
 * 判据只用 stderr 里的明文证据（#6）。以前全是一句 "ffmpeg exit 1"，
 * 用户只能摸黑重装。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CAPTURE_HINTS, captureErrorInfo } from '../src/capture.js';

const errWith = (message, extra = {}) => Object.assign(new Error(message), extra);

test('ffmpeg 不在 PATH（ENOENT / spawn ENOENT）→ dependency-missing', () => {
  assert.equal(captureErrorInfo(errWith('spawn ffmpeg ENOENT', { code: 'ENOENT' }), 'spawn').category,
    'dependency-missing');
  assert.equal(captureErrorInfo(errWith('找不到 FFmpeg'), 'spawn').category, 'dependency-missing');
});

test('errno 0 的 spawn 失败不算没装（不能只看 code）', () => {
  // Windows 上 EPERM 也可能来自安全软件，不是"找不到"
  const info = captureErrorInfo(errWith('spawn ffmpeg EPERM', { code: 'EPERM' }), 'spawn');
  assert.notEqual(info.category, 'dependency-missing');
});

test('屏幕录制权限 → permission-denied', () => {
  const info = captureErrorInfo(errWith('ffmpeg exit 1', {
    stderrTail: 'AVFoundation: Not authorized to capture screen',
  }), 'exit');
  assert.equal(info.category, 'permission-denied');
  assert.match(CAPTURE_HINTS['permission-denied'], /屏幕录制/);
});

test('设备名不对 → device-unavailable', () => {
  const info = captureErrorInfo(errWith('ffmpeg exit 1', {
    stderrTail: 'Could not find video device with name [dummy]',
  }), 'exit');
  assert.equal(info.category, 'device-unavailable');
});

test('RangeError → invalid-input，且带 stage', () => {
  const info = captureErrorInfo(new RangeError('region 必须使用物理像素整数坐标'), 'exit');
  assert.equal(info.category, 'invalid-input');
  assert.equal(info.stage, 'exit');
});

test('没有证据的失败归 capture-failed，并保留 stderrTail', () => {
  const info = captureErrorInfo(errWith('ffmpeg exit 2', { stderrTail: 'something odd' }), 'exit');
  assert.equal(info.category, 'capture-failed');
  assert.equal(info.stderrTail, 'something odd');
  assert.equal(info.code, null);
});

test('已经分类过的错误原样返回（不重复判）', () => {
  const first = captureErrorInfo(errWith('boom'), 'spawn');
  const second = captureErrorInfo(Object.assign(errWith('boom'), { errorInfo: first }), 'exit');
  assert.equal(second, first);
  assert.equal(second.stage, 'spawn');
});

test('每一类都有可照做的提示', () => {
  for (const key of ['dependency-missing', 'invalid-input', 'permission-denied', 'device-unavailable', 'capture-failed']) {
    assert.ok(CAPTURE_HINTS[key], `缺 ${key} 的提示`);
  }
});
