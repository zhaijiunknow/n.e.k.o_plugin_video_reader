/**
 * camera-cut.test.mjs — 切机位 / 相似构图的漏检回归。
 *
 * 两条漏检路径：
 *   ① 相似构图：整屏平均分只有 7.3（低于 cutAbs=12），但前后邻居是 0；
 *   ② 运动中切机位：真切点 117 分，前后帧 73/54，spike 的 2.5 倍卡掉。
 *
 * 这里用合成帧把两条路径钉住；真实素材的阈值仍应继续跑调参报告。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPipeline } from '../src/pipeline.js';

const W = 64;
const H = 36;

/** 同背景 + 一个方块。用于“相似构图”的机位/主体切换。 */
function objectAt(pos, size = 10) {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = 30;
      buf[i + 1] = 60;
      buf[i + 2] = 110;
    }
  }
  for (let y = 10; y < 10 + size; y += 1) {
    for (let x = pos; x < pos + size; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = 240;
      buf[i + 1] = 220;
      buf[i + 2] = 30;
    }
  }
  return buf;
}

/** 同背景 + 一个可移动的大块；用于前景运动/遮挡。 */
function blockAt(x, y, w, h) {
  const buf = Buffer.alloc(W * H * 3);
  for (let yy = 0; yy < H; yy += 1) {
    for (let xx = 0; xx < W; xx += 1) {
      const i = (yy * W + xx) * 3;
      buf[i] = 30;
      buf[i + 1] = 60;
      buf[i + 2] = 110;
    }
  }
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const i = (yy * W + xx) * 3;
      buf[i] = 240;
      buf[i + 1] = 220;
      buf[i + 2] = 30;
    }
  }
  return buf;
}

/** 高对比度的移动大块；用于覆盖 score ≥60 的未来帧确认边界。 */
function highBlockAt(x, y, w, h) {
  const buf = Buffer.alloc(W * H * 3);
  for (let yy = 0; yy < H; yy += 1) {
    for (let xx = 0; xx < W; xx += 1) {
      const i = (yy * W + xx) * 3;
      buf[i] = 20;
      buf[i + 1] = 40;
      buf[i + 2] = 80;
    }
  }
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const i = (yy * W + xx) * 3;
      buf[i] = 250;
      buf[i + 1] = 240;
      buf[i + 2] = 20;
    }
  }
  return buf;
}

/** 整屏单色；用于真正换到完全不同的场景。 */
function solidFrame(r, g, b) {
  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i += 1) {
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }
  return buf;
}

/** 整屏条纹，每帧平移 off；用于“运镜中切机位”。 */
function stripes(kind, off) {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      const on = ((x + off) % 8) < 4;
      buf[i] = on ? 240 : 20;
      if (kind === 'a') {
        buf[i + 1] = on ? 240 : 20;
        buf[i + 2] = on ? 240 : 20;
      } else {
        buf[i + 1] = on ? 40 : 200;
        buf[i + 2] = on ? 40 : 200;
      }
    }
  }
  return buf;
}

test('相似构图：7.3 分的孤立切点要留下', () => {
  const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
  let f = 0;
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: objectAt(10) });
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: objectAt(30) });
  p.finish();

  const cuts = p.log.filter((x) => x.via === 'cut');
  assert.equal(cuts.length, 1, `应只留一个切点，实际 ${cuts.length}`);
  assert.ok(Math.abs(cuts[0].t - 2) < 0.01, `切点应在 2.0s，实际 ${cuts[0].t}s`);
  assert.ok(cuts[0].score >= 6 && cuts[0].score < 12,
    `这应是弱切点（6~12 分），实际 ${cuts[0].score}`);
});

test('弱切点 mc 地板：同背景 UI 条（abs 10 / mc 5）不能收', () => {
  const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
  let f = 0;
  const a = objectAt(10);
  const b = uiChangeFrame();
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: a });
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: b });
  p.finish();
  assert.equal(p.log.filter((x) => x.via === 'cut').length, 0, '局部 UI 变化不应算换镜头');
});

test('前景运动（手/勺子/遮挡）不算切镜头：稳定背景还在，变化区域没盖满高度', () => {
  const feed = (opts) => {
    const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0, ...opts });
    let f = 0;
    for (let i = 0; i < 48; i += 1) {
      p.push({ t: f++ / 12, buf: blockAt(10 + (i % 8) * 5, 6, 30, 16) });
    }
    p.finish();
    return p.log.filter((x) => x.via === 'cut');
  };

  const guarded = feed({});
  assert.equal(guarded.length, 0, `前景运动不应切，实际 ${guarded.length} 刀`);

  // 关掉背景模型后同一序列会误切，证明测的是新守卫，而不是序列本身没变化。
  const raw = feed({ cutBgAbs: 0 });
  assert.ok(raw.length > 0, '关掉背景模型后应能复现旧误切');
});

test('高分前景运动：未来帧确认大面积前景离开后不切', () => {
  const feed = (opts) => {
    const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0, ...opts });
    let f = 0;
    for (let i = 0; i < 18; i += 1) p.push({ t: f++ / 12, buf: highBlockAt(0, 0, 0, 0) });
    for (let i = 0; i < 4; i += 1) p.push({ t: f++ / 12, buf: highBlockAt(4, 4, 56, 28) });
    for (let i = 0; i < 12; i += 1) p.push({ t: f++ / 12, buf: highBlockAt(0, 0, 0, 0) });
    p.finish();
    return p.log.filter((x) => x.via === 'cut');
  };

  const confirmed = feed({});
  assert.equal(confirmed.length, 0, `前景离开后的高分变化不应切，实际 ${confirmed.length} 刀`);

  const raw = feed({ cutFutureDelay: 0 });
  assert.ok(raw.length > 0, '关掉未来帧确认后应能复现旧误切');
  assert.ok(raw[0].score >= 60, `这一条要覆盖高分边界，实际 ${raw[0].score}`);
});

test('高分前景停住超过 0.5 秒：外圈还是旧背景时不切', () => {
  const feed = (opts) => {
    const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0, ...opts });
    let f = 0;
    for (let i = 0; i < 18; i += 1) p.push({ t: f++ / 12, buf: highBlockAt(0, 0, 0, 0) });
    for (let i = 0; i < 12; i += 1) p.push({ t: f++ / 12, buf: highBlockAt(4, 4, 56, 28) });
    p.finish();
    return p.log.filter((x) => x.via === 'cut');
  };

  assert.equal(feed({}).length, 0, '外圈没动的大面积前景不应切');
  assert.equal(feed({ cutFutureBorderMax: 0 }).length, 1, '关掉外圈保护后应复现误切');
});

test('前景长期占住画面后离开：参考背景没被它带跑', () => {
  const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
  let f = 0;
  for (let i = 0; i < 18; i += 1) p.push({ t: f++ / 12, buf: highBlockAt(0, 0, 0, 0) });
  for (let i = 0; i < 36; i += 1) p.push({ t: f++ / 12, buf: highBlockAt(4, 4, 56, 28) });
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: highBlockAt(0, 0, 0, 0) });
  p.finish();
  const cuts = p.log.filter((x) => x.via === 'cut');
  assert.equal(cuts.length, 0, `前景离开不是切镜头，实际 ${cuts.length} 刀`);
});

test('前景长期占住参考背景后，真正整屏换镜头仍切', () => {
  const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
  let f = 0;
  for (let i = 0; i < 18; i += 1) p.push({ t: f++ / 12, buf: highBlockAt(0, 0, 0, 0) });
  for (let i = 0; i < 36; i += 1) p.push({ t: f++ / 12, buf: highBlockAt(4, 4, 56, 28) });
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: solidFrame(20, 120, 240) });
  p.finish();
  const cuts = p.log.filter((x) => x.via === 'cut');
  assert.equal(cuts.length, 1, `长期前景后整屏换镜头应保留 1 刀，实际 ${cuts.length}`);
  assert.ok(Math.abs(cuts[0].t - 4.5) < 0.05, `切点应在 4.5s，实际 ${cuts[0].t}`);
});

test('运动中切机位：117 分、前后 73/54，不能被 2.5 倍卡掉', () => {
  const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
  let f = 0;
  for (let i = 0; i < 36; i += 1) p.push({ t: f++ / 12, buf: stripes('a', i * 4) });
  for (let i = 0; i < 36; i += 1) p.push({ t: f++ / 12, buf: stripes('b', i * 4) });

  const cuts = p.log.filter((x) => x.via === 'cut');
  assert.equal(cuts.length, 1, `应只留一个机位切换，实际 ${cuts.length}`);
  assert.ok(Math.abs(cuts[0].t - 3) < 0.01, `切点应在 3.0s，实际 ${cuts[0].t}s`);
  assert.ok(cuts[0].score >= 80, `这应是强切点，实际 ${cuts[0].score}`);
});

/** 同背景 + 底部一块低覆盖 UI 条：abs 约 10，但 mc 只有 5。 */
function uiChangeFrame() {
  const buf = objectAt(10);
  for (let y = 22; y < 34; y += 1) {
    for (let x = 20; x < 40; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = Math.min(255, 30 + 180);
      buf[i + 1] = Math.min(255, 60 + 180);
      buf[i + 2] = Math.min(255, 110 + 180);
    }
  }
  return buf;
}

/** 暗底 + 一个小白块：abs 约 13.6，但 mc 只有 16，用来模拟“低覆盖高尖峰”的过渡帧。 */
function flashFrame(size = 20) {
  const buf = Buffer.alloc(W * H * 3, 20);
  for (let y = 10; y < 10 + size; y += 1) {
    for (let x = 20; x < 20 + size; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = 255;
      buf[i + 1] = 255;
      buf[i + 2] = 255;
    }
  }
  return buf;
}

/** 低对比块状纹理：换纹理时 abs 低（约 22），但 mc 覆盖高。 */
function blockTexture(seed, block = 16) {
  const buf = Buffer.alloc(W * H * 3);
  let x = seed >>> 0;
  const rnd = () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x >>> 24;
  };
  for (let by = 0; by < H; by += block) {
    for (let bx = 0; bx < W; bx += block) {
      const v = rnd();
      for (let y = by; y < Math.min(H, by + block); y += 1) {
        for (let j = bx; j < Math.min(W, bx + block); j += 1) {
          const i = (y * W + j) * 3;
          buf[i] = v;
          buf[i + 1] = v;
          buf[i + 2] = v;
        }
      }
    }
  }
  return buf;
}

/** 平滑随机纹理，整屏平移 off 格；用于“快速运镜”。 */
function pattern(off) {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = Math.max(0, Math.min(255, 128 + 70 * Math.sin((x + off) * 0.31 + y * 0.17)));
      buf[i + 1] = Math.max(0, Math.min(255, 128 + 55 * Math.sin((x + off) * 0.23 + y * 0.41)));
      buf[i + 2] = Math.max(0, Math.min(255, 128 + 45 * Math.sin((x + off) * 0.19 - y * 0.29)));
    }
  }
  return buf;
}

test('mc 切点：低 abs（约 22）但换纹理，不能只靠 80 分台阶', () => {
  const p = createPipeline({
    width: W, height: H, fps: 12, queueDepth: 0,
    cutSpikeAbs: 999, cutJumpAbs: 0, cutIsolatedAbs: 0, cutMcAbs: 60,
  });
  let f = 0;
  const a = blockTexture(1);
  const b = blockTexture(2);
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: a });
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: b });
  p.finish();

  const cuts = p.log.filter((x) => x.via === 'cut');
  assert.equal(cuts.length, 1, `应只留一个切点，实际 ${cuts.length}`);
  assert.ok(Math.abs(cuts[0].t - 2) < 0.01, `切点应在 2.0s，实际 ${cuts[0].t}s`);
  assert.ok(cuts[0].score < 80, `这应是低 abs 切点，实际 ${cuts[0].score}`);
});

test('cutMcAbs=0 时 mc 路径完全关闭：低 abs 换纹理不会再切', () => {
  const p = createPipeline({
    width: W, height: H, fps: 12, queueDepth: 0,
    cutSpikeAbs: 999, cutJumpAbs: 0, cutIsolatedAbs: 0, cutMcAbs: 0,
  });
  let f = 0;
  const a = blockTexture(1);
  const b = blockTexture(2);
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: a });
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: b });
  p.finish();
  assert.equal(p.log.filter((x) => x.via === 'cut').length, 0);
});

test('尖峰 mc 门槛：低覆盖的过渡帧不能先切，等真正的换镜头', () => {
  const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
  let f = 0;
  const dark = Buffer.alloc(W * H * 3, 20);
  const a = blockTexture(1);
  for (let i = 0; i < 12; i += 1) p.push({ t: f++ / 12, buf: dark });
  // 两帧小面积高对比：abs 约 13.6、mc 约 16，尖峰成立但覆盖不够
  for (let i = 0; i < 2; i += 1) p.push({ t: f++ / 12, buf: flashFrame() });
  for (let i = 0; i < 36; i += 1) p.push({ t: f++ / 12, buf: a });
  p.finish();

  const cuts = p.log.filter((x) => x.via === 'cut');
  assert.equal(cuts.length, 1, `过渡帧不该单独切，实际 ${cuts.length} 刀`);
  assert.ok(cuts[0].t > 1.1, `应等到换纹理后再切，实际 ${cuts[0].t}s`);
});

test('尖峰 mc 门槛可以关掉：同一序列恢复旧行为，先切过渡帧', () => {
  const p = createPipeline({
    width: W, height: H, fps: 12, queueDepth: 0, cutSpikeMcAbs: 0,
  });
  let f = 0;
  const dark = Buffer.alloc(W * H * 3, 20);
  const a = blockTexture(1);
  for (let i = 0; i < 12; i += 1) p.push({ t: f++ / 12, buf: dark });
  for (let i = 0; i < 2; i += 1) p.push({ t: f++ / 12, buf: flashFrame() });
  for (let i = 0; i < 36; i += 1) p.push({ t: f++ / 12, buf: a });
  p.finish();

  const cuts = p.log.filter((x) => x.via === 'cut');
  assert.equal(cuts.length, 1, `应只留第一个尖峰，实际 ${cuts.length} 刀`);
  assert.ok(cuts[0].t < 1.2, `关掉门槛后应在过渡帧切，实际 ${cuts[0].t}s`);
});

test('mc 不把快速平移当切点：radius=4 吸收整屏位移', () => {
  const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
  let f = 0;
  for (let i = 0; i < 48; i += 1) p.push({ t: f++ / 12, buf: pattern(i * 4) });
  // 收尾静止一段：最后帧没有 nextScore，旧逻辑会用 null 当尖峰；这里隔离掉收尾效应
  for (let i = 0; i < 12; i += 1) p.push({ t: f++ / 12, buf: pattern(47 * 4) });
  p.finish();
  assert.equal(p.log.filter((x) => x.via === 'cut').length, 0);
});

test('只改亮度（5 分左右）仍不能当切点', () => {
  const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
  const a = objectAt(10);
  const b = Buffer.from(a);
  for (let i = 0; i < b.length; i += 3) {
    b[i] = Math.min(255, b[i] + 4);
    b[i + 1] = Math.min(255, b[i + 1] + 4);
    b[i + 2] = Math.min(255, b[i + 2] + 4);
  }
  let f = 0;
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: a });
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: b });
  p.finish();
  assert.equal(p.log.filter((x) => x.via === 'cut').length, 0);
});

/**
 * ## 低分未来帧确认的合成序列
 *
 * `lowAmbiguousFuture` 的 `highBg` 出口要求四个量同时成立，其中 `bgStable <= 300`
 * 最难造 —— 静止背景会让全部 2304 格都算稳定。
 *
 * 做法：背景在 BASE 上下**对称**摆动。
 *
 * | 量 | 比的是什么 | 摆动下的值 | 门槛 |
 * |---|---|---|---|
 * | `bgStable` | 单格在 6 帧窗里的通道极差 > 24 则不稳 | 极差 26 → 只剩中心恒定区 200 格 | <= 300 |
 * | `score` | **相邻两帧**全屏平均 HSV 差 | 17.8 | < 60（且摆动段 < `cutAbs`=12 不自己切） |
 * | `bg` | 稳定背景格被改掉的占比 | 255（前景盖住全部 200 格） | >= 220 |
 *
 * 对称是关键：参考模型取的是**中位数**，摆动中位 = BASE = 静止值，
 * 所以前景离开后画面才回得到参考背景，`bgKeep` 才判「前景走了」。
 * 单调漂移（中位 ≠ 静止值）会让 keep 虚高到 232.9，门槛 220 卡不住。
 *
 * 实测（settle=2 hold=6）：默认 1 刀；`cutFutureDelay:0` 2 刀。
 */
const DRIFT_BASE = 60;
/** 极差 2×13=26 > stableRange(24)；相邻帧差 17.8 < cutFutureMinScore(60)。 */
const DRIFT_SWING = 13;
/** 中心恒定区 10 列 × 20 行 = 200 格，落在 cutFutureLowStableTight(300) 之内。 */
const STABLE_W = 10;

/** 背景摆动/静止 + 左边 cover 列的大面积前景。 */
function swingFrame({ phase, cover, swinging }) {
  const d = swinging
    ? (phase % 2 === 0 ? DRIFT_BASE - DRIFT_SWING : DRIFT_BASE + DRIFT_SWING)
    : DRIFT_BASE;
  const x0 = Math.floor((W - STABLE_W) / 2);
  const x1 = x0 + STABLE_W;
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      let r;
      let g;
      let b;
      if (cover > 0 && x < cover) {
        [r, g, b] = [60, 90, 140];                       // 前景
      } else if (x >= x0 && x < x1 && y >= 8 && y < 28) {
        [r, g, b] = [30, 60, 110];                       // 恒定区：稳定背景格
      } else {
        [r, g, b] = [30 + d, 60 + d, 110 + d];           // 摆动区
      }
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    }
  }
  return buf;
}

/** 摆动 24 帧 → 静止 2 帧 → 前景盖住 6 帧 → 前景离开 18 帧。 */
function lowBgFeed(opts) {
  const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0, ...opts });
  let f = 0;
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: swingFrame({ phase: i, cover: 0, swinging: true }) });
  for (let i = 0; i < 2; i += 1) p.push({ t: f++ / 12, buf: swingFrame({ phase: 0, cover: 0, swinging: false }) });
  for (let i = 0; i < 6; i += 1) p.push({ t: f++ / 12, buf: swingFrame({ phase: 0, cover: 60, swinging: false }) });
  for (let i = 0; i < 18; i += 1) p.push({ t: f++ / 12, buf: swingFrame({ phase: 0, cover: 0, swinging: false }) });
  p.finish();
  return p.log.filter((x) => x.via === 'cut');
}

test('低分未来帧确认：大面积前景进场又离开时不切', () => {
  const guarded = lowBgFeed({});
  assert.equal(guarded.length, 1, `前景进场那一刀应被确认挡住，实际 ${guarded.length} 刀`);

  // 关掉未来帧确认后复现误切，证明测的是这条守卫，而不是序列本身没有候选。
  const raw = lowBgFeed({ cutFutureDelay: 0 });
  assert.equal(raw.length, 2, `关掉确认后应多出前景进场那一刀，实际 ${raw.length} 刀`);
  assert.ok(raw[0].score < 60,
    `这一条要覆盖**低分**路径（高分走 cutFutureMinScore），实际 ${raw[0].score}`);
});

test('cutFutureLowBgMax: 0 整条关闭低分未来帧确认', () => {
  // 修复前：`highBg`（bg 高但稳定背景少）排在 `bg >= cutFutureLowBgMax` 之外，
  // 设 0 只关低 bg 分支，这条序列仍被挡住 → 1 刀，与 cutFutureDelay:0 的 2 刀不符。
  const off = lowBgFeed({ cutFutureLowBgMax: 0 });
  const delayOff = lowBgFeed({ cutFutureDelay: 0 });
  assert.equal(off.length, delayOff.length,
    `cutFutureLowBgMax:0 应与 cutFutureDelay:0 在低分路径上等价，`
    + `实际 ${off.length} vs ${delayOff.length} 刀`);
  assert.equal(off.length, 2, `关闭后应复现误切，实际 ${off.length} 刀`);
});

test('cutFutureLowBgMax: 0 不影响高分未来帧确认', () => {
  // 高分路径（score >= cutFutureMinScore）由 cutFutureDelay 管，不该被这个开关带走。
  const feed = (opts) => {
    const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0, ...opts });
    let f = 0;
    for (let i = 0; i < 18; i += 1) p.push({ t: f++ / 12, buf: highBlockAt(0, 0, 0, 0) });
    for (let i = 0; i < 4; i += 1) p.push({ t: f++ / 12, buf: highBlockAt(4, 4, 56, 28) });
    for (let i = 0; i < 12; i += 1) p.push({ t: f++ / 12, buf: highBlockAt(0, 0, 0, 0) });
    p.finish();
    return p.log.filter((x) => x.via === 'cut');
  };
  assert.equal(feed({ cutFutureLowBgMax: 0 }).length, 0,
    '关掉低分确认后，高分前景离开仍应被挡住');
});
