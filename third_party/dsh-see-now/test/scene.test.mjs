import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPipeline } from '../src/pipeline.js';
import { applyStrategy, STRATEGIES } from '../src/tiers.js';
import { SCENE_OPTS, PACES, DEFAULT_PACE } from '../src/runner.js';

const W = 200, H = 120, FPS = 12;

/** 造一帧纯色 rgb24：换颜色 = 一次硬切，不依赖 ffmpeg。 */
function solid(r, g, b) {
  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < buf.length; i += 3) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; }
  return buf;
}

/** 三段颜色各停 24 帧（2 秒），共 3 个画面。 */
function blocks() {
  const colors = [[10, 10, 10], [240, 240, 240], [200, 40, 40]];
  const out = [];
  colors.forEach((c, bi) => {
    const buf = solid(...c);
    for (let i = 0; i < 24; i += 1) out.push({ t: (bi * 24 + i) / FPS, buf });
  });
  return out;
}

function run(opts) {
  const p = createPipeline({ width: W, height: H, fps: FPS, queueDepth: 0, ...opts });
  const sheets = [];
  for (const f of blocks()) {
    p.push(f);
    for (;;) { const s = p.take(); if (!s) break; sheets.push(s); }
  }
  sheets.push(...p.finish().sheets);
  return { sheets, stats: p.stats };
}

test('single 策略把所有档位压到 1（0 档是补位帧，原样保留）', () => {
  assert.deepEqual(applyStrategy([1, 2, 5, 8], 'single'), [1, 1, 1, 1]);
  assert.deepEqual(applyStrategy([0, 3], 'single'), [0, 1]);
  // 别的策略不受影响：'compact' 还是 +1
  assert.deepEqual(applyStrategy([1, 3], 'compact'), [2, 4]);
  assert.equal(STRATEGIES.single.fixed, 1);
});

test('逐帧模式：每张图恰好一帧，且铺满整张画布', () => {
  const { sheets, stats } = run(SCENE_OPTS);
  assert.ok(sheets.length >= 3, `三个画面至少三张图，实际 ${sheets.length}`);
  assert.ok(stats.kept >= 3, `至少留下三帧，实际 ${stats.kept}`);
  for (const s of sheets) {
    assert.equal(s.frames.length, 1, `一张图只能有一帧，实际 ${s.frames.length}`);
    assert.equal(s.cells.length, 1);
    const c = s.cells[0];
    assert.deepEqual(
      { px: c.px, py: c.py, pw: c.pw, ph: c.ph },
      { px: 0, py: 0, pw: W, ph: H },
      '这一帧必须铺满整张画布',
    );
    // 画布上不能有灰条：单帧满幅 = 100%
    assert.ok(s.fill > 0.97, `单帧应当铺满，实际 fill=${s.fill.toFixed(2)}`);
  }
});

test('常规模式不受影响：同一段素材仍然多帧拼一张', () => {
  const { sheets } = run({});
  const maxFrames = Math.max(...sheets.map((s) => s.frames.length));
  assert.ok(maxFrames >= 2, `常规模式该把多帧拼进一张，实际最多 ${maxFrames} 帧/张`);
});

test('自适应兜底：三档都带 floorGapK，越省电兜底越长，默认仍走固定 20s', () => {
  for (const k of ['calm', 'normal', 'dense', 'game-economic']) {
    assert.ok(PACES[k].pipeline?.floorGapK > 0, `${k} 必须带自适应兜底`);
    assert.ok(PACES[k].pipeline.floorMin < PACES[k].pipeline.floorMax, `${k} 的兜底上下界要合理`);
  }
  // 省电档宁可漏也不要多 → 倍率更大
  assert.ok(PACES.calm.pipeline.floorGapK > PACES.normal.pipeline.floorGapK);
  assert.ok(PACES.normal.pipeline.floorGapK > PACES.dense.pipeline.floorGapK);
  // 不经过节奏、直接建管线时保持旧行为（floorGapK=0 时退回固定 silentFloorSec）
  const c = createPipeline({}).constants;
  assert.equal(c.floorGapK, 0);
  assert.equal(c.silentFloorSec, 20);
});

test('自适应兜底真的会生效：出帧变稀之后兜底跟着缩短', () => {
  // 前 5 秒一直动（间隔约 2 秒），之后完全静止 25 秒
  const H2 = 90; const W2 = 160;
  const mk = (f, moving) => {
    const buf = Buffer.alloc(W2 * H2 * 3, 40);
    const bx = moving ? (f * 6) % (W2 - 30) : 10;
    for (let y = 10; y < 50; y += 1) {
      for (let x = bx; x < bx + 30; x += 1) {
        const i = (y * W2 + x) * 3; buf[i] = 240; buf[i + 1] = 220; buf[i + 2] = 60;
      }
    }
    return buf;
  };
  const times = (opts) => {
    const p = createPipeline({ width: W2, height: H2, fps: 12, queueDepth: 0, ...opts });
    for (let f = 0; f < 360; f += 1) p.push({ t: f / 12, buf: mk(f, f < 60) });
    const { sheets } = p.finish();
    return sheets.flatMap((s) => s.frames.map((fr) => fr.t));
  };
  const plain = times({});
  const adaptive = times({ floorGapK: 2, floorMin: 2, floorMax: 20 });
  // 静止段（t>5）里，自适应应该比固定 20 秒多留帧
  const tail = (a) => a.filter((t) => t > 5.5).length;
  assert.ok(tail(adaptive) > tail(plain),
    `静止段自适应应更密：固定 ${tail(plain)} 帧 / 自适应 ${tail(adaptive)} 帧`);
});

test('三档节奏：越省门槛越高、叫醒越稀，逐帧用的是最密那档', () => {
  // action 是"内容类型"那条轴，不参与灵敏度排序 —— 它在下一个测试里单独验
  assert.deepEqual(Object.keys(PACES).sort(), ['calm', 'dense', 'game-economic', 'normal']);
  // 门槛：calm 最高（最不敏感）→ dense 最低
  assert.ok(PACES.calm.cutAbs > PACES.normal.cutAbs, 'calm 的门槛必须比 normal 高');
  assert.ok(PACES.normal.cutAbs > PACES.dense.cutAbs, 'normal 的门槛必须比 dense 高');
  // 唤醒间隔：calm 最长
  assert.ok(PACES.calm.wakeGapSec > PACES.normal.wakeGapSec);
  assert.ok(PACES.normal.wakeGapSec > PACES.dense.wakeGapSec);
  // 默认档不能是最密那档 —— 否则"默认就很吵"这个毛病会回来
  assert.equal(DEFAULT_PACE, 'normal');
  // 逐帧模式用的是 dense 的门槛（7），且默认常量已经退到 12
  assert.equal(createPipeline({}).constants.cutAbs, PACES[DEFAULT_PACE].cutAbs);
  // mc 切点默认开；calm 刻意关掉弱切点/mc，避免省电档反而变吵
  const normal = createPipeline({}).constants;
  assert.equal(normal.cutMcAbs, 60);
  assert.equal(normal.cutMcRadius, 4);
  assert.equal(normal.cutSpikeMcAbs, 20);
  assert.equal(normal.cutIsolatedMcAbs, 8);
  assert.equal(normal.cutIsolatedMcBBox, 20);
  assert.equal(normal.cutIsolatedFill, 0.2);
  assert.equal(normal.cutBgAbs, 100);
  assert.equal(normal.cutBgMaxScore, 60);
  assert.equal(normal.cutBgMinCells, 128);
  assert.equal(normal.cutBgMaxChanged, 600);
  assert.equal(normal.cutBgMaxSpanY, 0.85);
  assert.equal(normal.cutBgWindow, 6);
  assert.equal(normal.cutFutureDelay, 0.5);
  assert.equal(normal.cutFutureMinScore, 60);
  assert.equal(normal.cutFutureKeep, 100);
  assert.equal(normal.cutFutureMinChanged, 64);
  assert.equal(normal.cutFutureRefWindow, 24);
  assert.equal(normal.cutFutureBorderMax, 10);
  assert.equal(normal.cutFutureLowBgMax, 160);
  assert.equal(normal.cutFutureLowBorderMin, 60);
  assert.equal(normal.cutFutureLowStableMax, 700);
  assert.equal(normal.cutFutureLowKeep, 210);
  assert.equal(normal.cutFutureLowStableTight, 300);
  assert.equal(normal.cutFutureLowKeepTight, 220);
  assert.equal(normal.cutFutureLowBgHigh, 220);
  assert.equal(normal.cutFutureBuildMinScore, 12);
  assert.equal(PACES.calm.pipeline.cutMcAbs, 0);
  assert.equal(PACES.calm.pipeline.cutIsolatedAbs, 0);
});

test('game-economic 档：门槛比 calm 还高，并且靠 pipeline 把出帧密度一起压下来', () => {
  // 实测反馈（全屏动作游戏）：正常切点淹没在运动里，门槛 12 等于"全是切点"
  assert.ok(PACES['game-economic'].cutAbs > PACES.calm.cutAbs, 'action 的门槛必须高于 calm');
  // 不能比最灵敏那档更吵
  assert.ok(PACES['game-economic'].wakeGapSec >= PACES.dense.wakeGapSec, 'action 不能比 dense 更吵');
  const p = PACES['game-economic'].pipeline;
  assert.ok(p && typeof p === 'object', 'action 必须带 pipeline 覆盖');
  // 这两条是关键：只抬 cutAbs 不抬积分，出帧密度不变，照样贴限速
  assert.ok(p.integralSeconds > 3, '积分阈值必须抬高');
  assert.ok(p.maxFrames < 40, '一张图的帧数要压下来，否则 40 格糊到看不清');
  assert.ok(p.cutSpike < 2.5 && p.cutSpikeAbs > 0, '动作画面凑不出 2.5 倍，必须降倍率 + 补绝对地板');
  // 高速运动里 mc / 弱切点 / 台阶都会把运动当切点，必须全关
  assert.equal(p.cutMcAbs, 0);
  assert.equal(p.cutIsolatedAbs, 0);
  assert.equal(p.cutJumpAbs, 0);
  // 覆盖要真的落进管线
  const c = createPipeline(p).constants;
  assert.equal(c.integralSeconds, p.integralSeconds);
  assert.equal(c.maxFrames, p.maxFrames);
  assert.equal(c.cutSpikeAbs, p.cutSpikeAbs);
  assert.equal(c.cutMcAbs, 0);
});
