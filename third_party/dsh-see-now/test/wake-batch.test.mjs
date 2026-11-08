/**
 * wake-batch.test.mjs — 超省模式（`wakeBatch`）。
 *
 * 动机是钱：**一张 798×450 的图只有 222 token，多带两张几乎不要钱**，
 * 真正贵的是每一轮请求都要把整个上下文重过一遍。3 张一起交比分 3 次交，
 * 输入侧按实测能省约 2/3。
 *
 * 但"攒"必须和"一次全交"配套，否则一点不省：
 * 叫醒一次只给一张，剩下两张模型还得再 `peek` 两次，等于又变回三轮。
 *
 * 要守住的三条：
 *   ① 队列要压得住 N 张（`queueDepth` 跟着 `wakeBatch` 走，否则第 3 张出来时前两张已被挤掉）；
 *   ② `peek` 一次把攒的全交出去，按**时间正序**；
 *   ③ `wakeBatch: 1`（默认）行为不变 —— 一次只给一张，那是以前所有测试的前提。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FFMPEG, ffmpegOk } from './ffmpeg.mjs';

// **必须在 import 之前**：chat.js 在模块加载时就把 DSH_HOME 定下来了
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-see-batch-'));
process.env.DSH_SEE_NO_WINDOW = '1';

const FIXTURE = join('.tmp', 'batch-clip.mp4');

function makeFixture() {
  if (existsSync(FIXTURE) && statSync(FIXTURE).size > 10_000) return FIXTURE;
  mkdirSync('.tmp', { recursive: true });
  execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=12', '-t', '30',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', FIXTURE], { stdio: 'inherit' });
  return FIXTURE;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = !ffmpegOk();
const { createRunner } = skip ? {} : await import('../src/runner.js');

/** 等队列涨到 n 张。**不要写死 sleep**：出图节奏随机器变。 */
async function waitPending(runner, n, { tries = 120, every = 250 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (runner.status().pending >= n) return true;
    await sleep(every);
  }
  return false;
}

/** 每张 1 帧、1 秒兜底 —— 先把图攒快一点，测试不用等 20 秒 */
const FAST = { maxFrames: 1, maxWaitSec: 1 };

test('wakeBatch: 3 —— 队列压得住三张，peek 一次全给', { skip }, async () => {
  const runner = createRunner({ ffmpegPath: FFMPEG, wakeBatch: 3 });
  try {
    await runner.start({ src: { kind: 'file', path: makeFixture(), realtime: true }, opts: FAST });
    assert.ok(await waitPending(runner, 3),
      `前置条件：队列该攒到 3 张，实际 ${runner.status().pending}（压不住 = queueDepth 没跟着 wakeBatch 走）`);
    runner.stop();

    const got = runner.peek();
    assert.equal(got.length, 3, `一次该交 3 张，实际 ${got.length} —— 分成几次交就等于没攒`);
    assert.ok(got[0].from <= got[1].from && got[1].from <= got[2].from,
      `要按时间正序给，实际 ${got.map((s) => s.from).join(' / ')}`);
    assert.equal(runner.peek().length, 0, '取完就该空，同一张不许给两次');
  } finally {
    runner.stop();
  }
});

test('wakeBatch: 1 —— 默认行为不变，一次只给一张', { skip }, async () => {
  const runner = createRunner({ ffmpegPath: FFMPEG });
  try {
    await runner.start({ src: { kind: 'file', path: makeFixture(), realtime: true }, opts: FAST });
    assert.ok(await waitPending(runner, 1), '前置条件：先攒出一张');
    runner.stop();

    const got = runner.peek();
    assert.equal(got.length, 1, '默认仍然是"有新图就给一张"，这是以前所有行为的前提');
  } finally {
    runner.stop();
  }
});

test('队列上限就是 wakeBatch —— 攒有上限，不会无限堆', { skip }, async () => {
  // `wakeBatch: 2` 时队列最多压 2 张：再多就该挤掉最老的那张（queueDepth 的语义）。
  // 这条守的是"攒"不会退化成"无限缓冲"—— 那会把画面越攒越旧，换来的图还是一样的钱。
  const runner = createRunner({ ffmpegPath: FFMPEG, wakeBatch: 2 });
  try {
    await runner.start({ src: { kind: 'file', path: makeFixture(), realtime: true }, opts: FAST });
    let max = 0;
    for (let i = 0; i < 24; i += 1) {
      await sleep(250);
      max = Math.max(max, runner.status().pending);
    }
    assert.ok(max >= 1, '前置条件：6 秒里该攒出至少一张');
    assert.ok(max <= 2, `队列上限必须是 wakeBatch，实际最多到 ${max} 张`);
    assert.ok(await waitPending(runner, Math.min(max, 2)), '状态与队列要一致');
  } finally {
    runner.stop();
  }
});

// ---------------------------------------------------------------------------
// 叫醒判据：攒不够就不叫（这条是超省模式的全部意义，之前只有代码没有测试）
// ---------------------------------------------------------------------------

const { startLoop } = await import('../src/loop.js');

/** 假宿主：`followup` 就是"叫醒"，记下每次的文案 */
function fakeCtx() {
  const wakes = [];
  const services = {
    sessionController: {
      async resolveAgent() {
        return {
          agent: { followup: (m) => wakes.push(m.content?.[0]?.text ?? '') },
          session: { id: 's1' },
        };
      },
    },
    sessions: { async flush() { return true; } },
  };
  return { wakes, ctx: { get: (n) => services[n] ?? undefined } };
}

/** 假 runner：`pending` 想设几张就设几张，用来直接喂判据 */
function fakeRunner({ pending = 1, sheets = 3 } = {}) {
  const st = { pending, sheets, running: true };
  return {
    st,
    touch: () => st.running,
    windowWasOpen: () => false,
    status: () => ({
      running: st.running, pending: st.pending, sheets: st.sheets, secondsSinceWake: 5,
    }),
    stop() { st.running = false; },
    reserveSheet() {
      st.pending = 0;
      return { seq: st.sheets, from: 0, to: 1, frames: 1 };
    },
    releaseSheet() { st.pending = 1; return true; },
  };
}

// 收工线全关，只留判据本身在起作用
const quiet = { maxAutonomousWakes: 0, idleStopMs: 0 };

/** 跑几拍（tick 是 2 秒一拍，等 2.6 秒保证至少判过一次） */
async function runLoopTicks({ pending, wakeBatch }) {
  const { ctx, wakes } = fakeCtx();
  const runner = fakeRunner({ pending });
  const loop = startLoop({
    ctx, sessionId: 's1', runner, wakeMinGapSec: 0, tuning: { ...quiet, wakeBatch },
  });
  await sleep(2600);
  loop.dispose();
  return wakes.length;
}

test('判据：pending=2、wakeBatch=3 时一次都不叫', async () => {
  const n = await runLoopTicks({ pending: 2, wakeBatch: 3 });
  assert.equal(n, 0, `攒不够 3 张就叫了 ${n} 次 —— 判据还是 pending > 0`);
});

test('判据：pending=3、wakeBatch=3 时该叫', async () => {
  const n = await runLoopTicks({ pending: 3, wakeBatch: 3 });
  assert.ok(n >= 1, '攒够了还不叫，那超省模式就是死的');
});

test('判据：wakeBatch=1 时 pending=1 就叫（默认行为没变）', async () => {
  const n = await runLoopTicks({ pending: 1, wakeBatch: 1 });
  assert.ok(n >= 1, '默认应当"有新图就叫"，这是以前所有行为的前提');
});

// ---------------------------------------------------------------------------
// 台词与编号：一次交 N 张时，必须和逐张交付一样能对上
// ---------------------------------------------------------------------------

const { bucketLines } = await import('../src/runner.js');
const say = (t0, text, dur = 2000) => ({ t0, t1: t0 + dur, text, partial: false });

test('台词归张：跨在边界上的那句只出现一次，且归更早那张', async () => {
  // 窗口两头留了 400/800ms 余量（迟到转写不能丢），所以跨界那句必然同时落进相邻两张的候选。
  const W = [{ from: 0, to: 15_000 }, { from: 15_000, to: 30_000 }, { from: 30_000, to: 45_000 }];
  const straddle = say(14_500, '跨在 15 秒边界上的那句', 3_000);
  const tail = say(15_400, '边界之后 0.4 秒才开口的那句');
  const cands = [
    [say(3_000, 'a'), straddle, tail],   // 第一张的候选（+800 把 15.4 也捞了回来）
    [straddle, tail, say(22_000, 'b')],
    [say(31_000, 'c')],
  ];
  const out = bucketLines(W, cands);
  const flat = out.flat().map((l) => l.t0);
  assert.equal(flat.filter((t) => t === 14_500).length, 1, '跨界那句被挂了两张 —— 模型会以为视频重播了一次');
  assert.ok(out[0].some((l) => l.t0 === 14_500), '它大半是在第一张的画面里说的，归第一张');
  assert.ok(out[1].some((l) => l.t0 === 15_400), '边界之后开口的句子归后一张（别按 +800 提前认领）');
  assert.equal(new Set(flat).size, flat.length, '任何一句都不许出现两次');
});

test('台词归张：比第一张还早的迟到句不丢', async () => {
  const W = [{ from: 10_000, to: 20_000 }];
  const early = say(9_800, '刚跨过第一张起点');
  const older = say(5_000, '更早的迟到句');
  const out = bucketLines(W, [[early, older]]);
  assert.deepEqual(out[0].map((l) => l.t0).sort((a, b) => a - b), [5_000, 9_800],
    '候选里的都要留住 —— 宁可多给一句，不能白丢');
});

test('一次交 3 张：格数与画面数一致，时间递增、格子行主序（编号 1..n 与画面同序）', { skip }, async () => {
  const runner = createRunner({ ffmpegPath: FFMPEG, wakeBatch: 3 });
  try {
    // 每张 4 帧：一格一张号，"格数和画面数对不上"才看得出来
    await runner.start({ src: { kind: 'file', path: makeFixture(), realtime: true }, opts: { maxFrames: 4, maxWaitSec: 3 } });
    assert.ok(await waitPending(runner, 3), `前置条件：该攒到 3 张，实际 ${runner.status().pending}`);
    runner.stop();
    const got = runner.peek();
    assert.equal(got.length, 3);
    got.forEach((s, i) => {
      assert.equal(s.cells.length, s.frames.length, `第 ${i + 1} 张：格子和画面数不一致，编号会错位`);
      assert.ok(s.frames.length >= 2, `第 ${i + 1} 张只有 ${s.frames.length} 帧，测不出顺序`);
      for (let k = 1; k < s.frames.length; k += 1) {
        assert.ok(s.frames[k].t >= s.frames[k - 1].t - 1e-6, `第 ${i + 1} 张的时间不是递增的`);
        // 烧号用的是格子顺序（行主序），清单用的是画面顺序（时间序）—— 两者必须同序，
        // 否则"第 3 格"在图上是另一个画面
        assert.ok(s.cells[k].py >= s.cells[k - 1].py - 1e-6, `第 ${i + 1} 张的格子不是行主序`);
      }
    });
  } finally {
    runner.stop();
  }
});

test('变化日志按窗口分张：不会整批都堆在第一张上', { skip }, async () => {
  const runner = createRunner({ ffmpegPath: FFMPEG, wakeBatch: 3, changeLog: true });
  try {
    await runner.start({ src: { kind: 'file', path: makeFixture(), realtime: true }, opts: FAST });
    assert.ok(await waitPending(runner, 3), '前置条件：该攒到 3 张');
    runner.stop();
    const got = runner.peek();
    const landed = got.filter((s) => s.changes?.length);
    assert.ok(landed.length >= 2, `变化日志只落在 ${landed.length} 张上 —— 一次 drain 全挂第一张了`);
    got.forEach((s) => {
      for (const c of s.changes ?? []) {
        assert.ok(c.to <= s.to + 1e-6, `变化日志 ${c.to}s 挂在了只到 ${s.to}s 的那张上`);
      }
    });
  } finally {
    runner.stop();
  }
});

test('linesText：台词标的是"不晚于它开始时刻的最后一格"', async () => {
  const { linesText } = await import('../src/index.js');
  const origin = 1_700_000_000_000;
  const sheet = {
    from: 10, to: 15,
    frames: [{ t: 10, wall: origin + 10_000 }, { t: 15, wall: origin + 15_000 }],
    lines: [{ t0: origin + 14_500, t1: origin + 16_000, text: '跨界的这句' }],
  };
  const txt = linesText(sheet);
  assert.match(txt, /#1\s+\d\d:\d\d:\d\d \/ 14\.5s/, '14.5s 张口时画面还停在 10s 那格');
});
