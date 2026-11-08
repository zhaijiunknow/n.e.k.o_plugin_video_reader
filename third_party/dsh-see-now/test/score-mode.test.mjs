/**
 * score-mode.test.mjs — 可选打分口径（mc = 运动补偿）的守卫。
 *
 * 默认仍走 'abs'；mc 一旦打开，最怕的是"平移也被算成换画面"——那正是它要解决的问题。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bgBorderChanged, bgKeep, bgStats, contentHeightRatio, createScorer, guardHeightRatio, mcRatioScore, mcStats, SCAN_W, SCAN_H,
} from '../src/cuts.js';

const W = SCAN_W;
const H = SCAN_H;
const N = W * H;

/** 造一帧 rgb24：底色 + 可选竖条纹（offset 用来模拟整屏平移） */
function frame({ r = 30, g = 40, b = 70, stripe = false, offset = 0 } = {}) {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      const on = stripe && ((x + offset) % 2 === 0);
      buf[i] = on ? 240 : r;
      buf[i + 1] = on ? 240 : g;
      buf[i + 2] = on ? 240 : b;
    }
  }
  return buf;
}

/** 不周期性的纹理，整屏平移 off 格；用来验证 radius=4 对快速运镜的吸收。 */
function shiftedFrame(off) {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      const xx = x + off;
      buf[i] = (xx * 37 + y * 91) % 256;
      buf[i + 1] = (xx * 73 + y * 53) % 256;
      buf[i + 2] = (xx * 19 + y * 113) % 256;
    }
  }
  return buf;
}

/** 底色 + 顶部 rows 行高亮；用于数稳定背景变化格。 */
function topPatchFrame(rows) {
  const buf = frame();
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = 240;
      buf[i + 1] = 240;
      buf[i + 2] = 30;
    }
  }
  return buf;
}

/** 上下各 8 行黑边的宽银幕帧。 */
function letterboxFrame({ r = 30, g = 40, b = 70 } = {}) {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      const black = y < 8 || y >= H - 8;
      buf[i] = black ? 0 : r;
      buf[i + 1] = black ? 0 : g;
      buf[i + 2] = black ? 0 : b;
    }
  }
  return buf;
}

/** 把 rgb24 转成 cuts.js 内部使用的 HSV 网格 */
function hsvOf(buf) {
  const scorer = createScorer({ width: W, height: H });
  return Float32Array.from(scorer(buf).hsv);
}

test('mcRatioScore：同一帧 → 0', () => {
  const a = hsvOf(frame());
  assert.equal(mcRatioScore(a, hsvOf(frame())), 0);
});

test('mcRatioScore：整屏换色 → 满格 255', () => {
  const a = hsvOf(frame({ r: 240, g: 240, b: 30 }));
  const b = hsvOf(frame({ r: 20, g: 30, b: 220 }));
  assert.ok(mcRatioScore(a, b) > 240, `应接近满格，实际 ${mcRatioScore(a, b)}`);
});

test('mcRatioScore：整屏平移一格应被邻域吸收', () => {
  const a = hsvOf(frame({ stripe: true, offset: 0 }));
  const b = hsvOf(frame({ stripe: true, offset: 1 }));
  const noSearch = mcRatioScore(a, b, { radius: 0 });
  const searched = mcRatioScore(a, b, { radius: 1 });
  assert.ok(noSearch > 100, `不搜索时应大片判变，实际 ${noSearch}`);
  assert.ok(searched < 40, `半径 1 的搜索应吸收平移，实际 ${searched}`);
});

test('mcRatioScore：8 格快速平移 radius=2 误报、radius=4 吸收', () => {
  const a = hsvOf(shiftedFrame(0));
  const b = hsvOf(shiftedFrame(8));
  const r2 = mcRatioScore(a, b, { radius: 2 });
  const r4 = mcRatioScore(a, b, { radius: 4 });
  assert.ok(r2 > 100, `radius=2 应误报大片变化，实际 ${r2}`);
  assert.ok(r4 < 20, `radius=4 应吸收 8 格平移，实际 ${r4}`);
});

test('mcStats：整屏换色返回覆盖率、包围盒与填充率；同一帧全为 0', () => {
  const a = hsvOf(frame({ r: 240, g: 240, b: 30 }));
  const b = hsvOf(frame({ r: 20, g: 30, b: 220 }));
  const st = mcStats(a, b);
  assert.ok(st.score > 240, `覆盖率应接近满格，实际 ${st.score}`);
  assert.ok(st.bbox > 240, `包围盒应接近满屏，实际 ${st.bbox}`);
  assert.ok(st.fill > 0.95, `填充率应接近 1，实际 ${st.fill}`);
  const same = mcStats(a, a);
  assert.equal(same.score, 0);
  assert.equal(same.bbox, 0);
  assert.equal(same.fill, 0);
});

test('bgStats：稳定背景整片换色才 255，同一帧为 0', () => {
  const a = hsvOf(frame({ r: 30, g: 40, b: 70 }));
  const hist = [a, a, a, a, a, a];
  const same = bgStats(hist, a);
  assert.equal(same.stable, N);
  assert.equal(same.score, 0);

  const b = hsvOf(frame({ r: 240, g: 240, b: 30 }));
  const all = bgStats(hist, b);
  assert.equal(all.stable, N);
  assert.equal(all.score, 255);
});

test('bgStats：同时返回绝对变化格数，供“稳定背景很多”的真切点放行', () => {
  const a = hsvOf(frame());
  const hist = [a, a, a, a, a, a];
  const st = bgStats(hist, hsvOf(topPatchFrame(20)));
  assert.equal(st.stable, N);
  assert.equal(st.changed, W * 20);
  assert.equal(st.score, (W * 20 / N) * 255);
});

test('bgKeep：未来帧回到旧背景为 0，留在新画面为 255', () => {
  const base = hsvOf(frame());
  const model = bgStats([base, base, base, base, base, base], base, { withModel: true }).model;
  const patch = hsvOf(topPatchFrame(20));
  const returned = bgKeep(model, patch, base);
  assert.equal(returned.changed, W * 20);
  assert.equal(returned.score, 0);
  const stayed = bgKeep(model, patch, patch);
  assert.equal(stayed.score, 255);
});

test('bgBorderChanged：中间大块前景外圈不变为 0，整屏换画面为 255', () => {
  const base = frame();
  const baseHsv = hsvOf(base);
  const model = bgStats([baseHsv, baseHsv, baseHsv, baseHsv, baseHsv, baseHsv], baseHsv, { withModel: true }).model;
  const block = frame();
  for (let y = 4; y < H - 4; y += 1) {
    for (let x = 4; x < W - 4; x += 1) {
      const i = (y * W + x) * 3;
      block[i] = 240;
      block[i + 1] = 240;
      block[i + 2] = 30;
    }
  }
  assert.equal(bgBorderChanged(model, hsvOf(block), 1).score, 0);
  const full = frame({ r: 240, g: 240, b: 30 });
  assert.equal(bgBorderChanged(model, hsvOf(full), 1).score, 255);
});

test('contentHeightRatio：宽银幕只算有效画面高度，全黑为 0', () => {
  assert.equal(contentHeightRatio(hsvOf(frame())), 1);
  assert.ok(Math.abs(contentHeightRatio(hsvOf(letterboxFrame())) - 20 / H) < 1e-6);
  const black = Buffer.alloc(W * H * 3);
  assert.equal(contentHeightRatio(hsvOf(black)), 0);
});

test('guardHeightRatio：暗场中间有内容时不跳过，全黑仍为 0', () => {
  const black = Buffer.alloc(W * H * 3);
  assert.equal(guardHeightRatio(hsvOf(black)), 0);

  const darkEdge = Buffer.alloc(W * H * 3);
  for (let y = 14; y < 22; y += 1) {
    for (let x = 16; x < 48; x += 1) {
      const i = (y * W + x) * 3;
      darkEdge[i] = 90;
      darkEdge[i + 1] = 90;
      darkEdge[i + 2] = 90;
    }
  }
  const h = hsvOf(darkEdge);
  assert.ok(contentHeightRatio(h) < 0.25);
  assert.equal(guardHeightRatio(h), 1);
});

test('createScorer：默认口径不变，切到 mc 后同一对帧分数不同', () => {
  const abs = createScorer({ width: W, height: H });
  const mc = createScorer({ width: W, height: H, scoreMode: 'mc' });
  const a = frame({ stripe: true, offset: 0 });
  const b = frame({ stripe: true, offset: 1 });
  abs(a); mc(a);
  const sAbs = abs(b).score;
  const sMc = mc(b).score;
  assert.ok(sAbs > 0, 'abs 口径下平移仍有分数（这正是缺点）');
  assert.ok(sMc < sAbs, `mc 应该更安静：abs=${sAbs} mc=${sMc}`);
});

test('createScorer：默认口径也同时产出 mcScore，换镜头时 mc 覆盖高', () => {
  const scorer = createScorer({ width: W, height: H });
  const first = scorer(frame());
  assert.equal(first.mcScore, null, '第一帧没有前帧，mcScore 应为 null');
  const changed = scorer(frame({ r: 240, g: 240, b: 30 }));
  assert.ok(changed.mcScore > 240, `整屏换色应接近满格，实际 ${changed.mcScore}`);
  assert.ok(changed.score > 0, 'abs 口径也应保留');
});
