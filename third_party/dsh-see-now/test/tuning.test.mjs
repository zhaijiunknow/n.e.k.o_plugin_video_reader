/**
 * tuning.test.mjs — `~/.dsh/see-now.json` 的读取与校验（#8）。
 *
 * 这些值决定"陪你多久就自己收工"，写错一个类型就变成"永远不停"或"立刻停"，
 * 所以非法值必须退回默认并留 warning，不能静默吞掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readTuning, tuningPath, TUNING_DEFAULTS } from '../src/tuning.js';
import { shouldGoIdle } from '../src/loop.js';

const ENV = { DSH_HOME: '/tmp/dsh-home' };
const readJson = (obj) => () => JSON.stringify(obj);
const missing = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };

test('文件不存在 → 全默认，不报警告', () => {
  const t = readTuning({ env: ENV, readFile: missing });
  assert.equal(t.maxAutonomousWakes, TUNING_DEFAULTS.maxAutonomousWakes);
  assert.equal(t.idleStopMin, 3);
  assert.equal(t.idleStopMs, 180000);
  assert.equal(t.defaultPace, 'normal');
  assert.deepEqual(t.warnings, []);
  assert.equal(t.path, tuningPath(ENV));
});

test('合法覆盖生效', () => {
  const t = readTuning({
    env: ENV,
    readFile: readJson({ maxAutonomousWakes: 24, idleStopMin: 10, defaultPace: 'calm' }),
  });
  assert.equal(t.maxAutonomousWakes, 24);
  assert.equal(t.idleStopMs, 600000);
  assert.equal(t.defaultPace, 'calm');
  assert.deepEqual(t.warnings, []);
});

test('idleStopMin: 0 = 关掉空闲线（不是"立刻停"）', () => {
  const t = readTuning({ env: ENV, readFile: readJson({ idleStopMin: 0 }) });
  assert.equal(t.idleStopMin, 0);
  assert.equal(t.idleStopMs, 0);
  assert.equal(shouldGoIdle({ lastUserAt: 0, now: 10 ** 9, idleStopMs: 0 }), false);
});

test('非法值退回默认并各留一条警告', () => {
  const t = readTuning({
    env: ENV,
    readFile: readJson({ maxAutonomousWakes: 0, idleStopMin: 9999, defaultPace: 'turbo' }),
  });
  assert.equal(t.maxAutonomousWakes, 8);
  assert.equal(t.idleStopMin, 3);
  assert.equal(t.defaultPace, 'normal');
  assert.equal(t.warnings.length, 3);
});

test('JSON 坏了 → 默认 + 警告（不能把插件弄挂）', () => {
  const t = readTuning({ env: ENV, readFile: () => '{ not json' });
  assert.equal(t.maxAutonomousWakes, 8);
  assert.equal(t.warnings.length, 1);
  assert.match(t.warnings[0], /读不了/);
});

test('不是对象 → 整份忽略', () => {
  const t = readTuning({ env: ENV, readFile: readJson([1, 2, 3]) });
  assert.equal(t.maxAutonomousWakes, 8);
  assert.match(t.warnings[0], /不是 JSON 对象/);
});

test('shouldGoIdle：覆盖值真的改变判据', () => {
  const now = 10 ** 9;
  // 叫了 8 次：默认收工；放到 24 次就不收
  assert.equal(shouldGoIdle({ wakesSinceUser: 8, now, lastUserAt: now }), true);
  assert.equal(shouldGoIdle({ wakesSinceUser: 8, now, lastUserAt: now, maxWakes: 24 }), false);
  assert.equal(shouldGoIdle({ wakesSinceUser: 24, now, lastUserAt: now, maxWakes: 24 }), true);
  // 空闲线：默认 3 分钟，给 10 分钟就不收
  assert.equal(shouldGoIdle({ now, lastUserAt: now - 5 * 60_000 }), true);
  assert.equal(shouldGoIdle({ now, lastUserAt: now - 5 * 60_000, idleStopMs: 10 * 60_000 }), false);
  // 窗开着时只靠次数兜底
  assert.equal(shouldGoIdle({ now, lastUserAt: now - 5 * 60_000, windowOpen: true, maxWakes: 0 }), false);
});

test('listen：合法但非默认的值不报警告，越界的值必须报警告', () => {
  // 原来的判据是"夹回后的值 !== out[key]"，两个方向都错：
  //   silence: 0.5（合法）→ 0.5 !== 0.35 → 被报成"必须在 0.15–1.5 之间"
  //   liveStep: 9（越界）→ 夹回 1.2 === 默认 → 一条警告都不留，用户以为改生效了
  const ok = readTuning({
    env: ENV,
    readFile: readJson({ listen: { silence: 0.5, pollMs: 200, maxSeg: 5 } }),
  });
  assert.equal(ok.listen.silence, 0.5);
  assert.equal(ok.listen.pollMs, 200);
  assert.equal(ok.listen.maxSeg, 5);
  assert.deepEqual(ok.warnings, []);

  const bad = readTuning({ env: ENV, readFile: readJson({ listen: { liveStep: 9 } }) });
  assert.equal(bad.listen.liveStep, 1.2); // 越界退回默认
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0], /liveStep/);
});

// ── 档位判据 / 阈值表 / 七道阈值 ──────────────────────────────────────────────
// 这一组守"设置页改了能生效，改坏了不会把插件弄挂"。

test('tierMode / tierCurve：只认枚举，写错退回默认并报一句', () => {
  const ok = readTuning({ env: ENV, readFile: readJson({ tierMode: 'weight', tierCurve: 'perceptual' }) });
  assert.equal(ok.tierMode, 'weight');
  assert.equal(ok.tierCurve, 'perceptual');
  assert.deepEqual(ok.warnings, []);

  const bad = readTuning({ env: ENV, readFile: readJson({ tierMode: 'density2', tierCurve: 'paper' }) });
  assert.equal(bad.tierMode, TUNING_DEFAULTS.tierMode);
  assert.equal(bad.tierCurve, TUNING_DEFAULTS.tierCurve);
  assert.equal(bad.warnings.length, 2);

  // `dwell` 已经删了。昨天写进配置的用户今天必须收到一句"这个值不认了"，
  // 而不是被静默当成 density —— 静默会让"我明明设过"变成查不出来的问题。
  const gone = readTuning({ env: ENV, readFile: readJson({ tierMode: 'dwell' }) });
  assert.equal(gone.tierMode, 'density');
  assert.equal(gone.warnings.length, 1);
  assert.ok(gone.warnings[0].includes('dwell'), gone.warnings[0]);
});

test('tierThresholds：合法的七个数原样生效', () => {
  const custom = [0.3, 0.5, 0.8, 1.1, 1.7, 2.3, 3.2];
  const t = readTuning({ env: ENV, readFile: readJson({ tierCurve: 'custom', tierThresholds: custom }) });
  assert.deepEqual(t.tierThresholds, custom);
  assert.deepEqual(t.warnings, []);
});

test('tierThresholds：不递增必须整份退回默认（否则滞回带互相盖住，档位卡死）', () => {
  const t = readTuning({
    env: ENV,
    readFile: readJson({ tierThresholds: [0.26, 0.6, 0.5, 1.2, 1.8, 2.4, 3] }),
  });
  assert.deepEqual(t.tierThresholds, TUNING_DEFAULTS.tierThresholds);
  assert.ok(t.warnings.some((w) => w.includes('严格递增')), t.warnings.join('；'));
});

test('tierThresholds：单个坏值退回默认，其余照改', () => {
  const t = readTuning({
    env: ENV,
    readFile: readJson({ tierThresholds: [0.3, 'abc', 0.9, 1.2, 1.8, 2.4, 3] }),
  });
  assert.equal(t.tierThresholds[0], 0.3);
  assert.equal(t.tierThresholds[1], TUNING_DEFAULTS.tierThresholds[1]);
  assert.equal(t.tierThresholds[6], 3);
  assert.ok(t.warnings.some((w) => w.includes('tierThresholds[2]')), t.warnings.join('；'));
});

test('tierThresholds：不是数组 / 长度不对都只报一句，不抛', () => {
  const a = readTuning({ env: ENV, readFile: readJson({ tierThresholds: '0.3,0.6' }) });
  assert.deepEqual(a.tierThresholds, TUNING_DEFAULTS.tierThresholds);
  assert.ok(a.warnings.some((w) => w.includes('必须是 7 个数字的数组')));

  const b = readTuning({ env: ENV, readFile: readJson({ tierThresholds: [0.3, 0.6] }) });
  assert.ok(b.warnings.some((w) => w.includes('现在是 2 个')), b.warnings.join('；'));
});
