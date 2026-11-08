/**
 * two-frame.test.mjs — 静止画面不能把两张帧卡到 40 秒。
 *
 * 复现：第一帧在 0s，silentFloorSec=20 来第二帧；旧 checkFlush 只有
 * frames>=3 和 frames===1 两个时间出口，两帧没有出口，只能等 40s 的
 * 第三个兜底帧。README 承诺的是“静止 20 秒给一张”。
 *
 * 这里把时间参数缩到 1s，断言两帧在 maxWaitSec 到点时立刻封箱。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPipeline } from '../src/pipeline.js';

const W = 32;
const H = 18;

test('静止画面：两帧到 maxWaitSec 就出图，不再等第三个兜底帧', () => {
  const p = createPipeline({
    width: W,
    height: H,
    fps: 12,
    queueDepth: 0,
    maxWaitSec: 1,
    silentFloorSec: 1,
  });

  const buf = Buffer.alloc(W * H * 3, 40);
  let got = null;
  for (let f = 0; f < 48 && !got; f += 1) {
    p.push({ t: f / 12, buf });
    got = p.take();
  }

  assert.ok(got, '两帧必须能在 maxWaitSec 后出图，而不是一直等到第三帧');
  assert.equal(got.frames.length, 2, `首图应该是两帧，实际 ${got.frames.length}`);
  assert.equal(got.why, 'time');
  assert.ok(got.to <= 1.1, `首图不该晚于 1.1s，实际 ${got.to}s`);
});
