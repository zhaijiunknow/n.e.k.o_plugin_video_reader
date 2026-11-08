/**
 * wake-sheet.test.mjs — 「叫醒了，`peek` 却拿到空」的回归网（社区实报 2026-11-05）。
 *
 * 实报原文：逐场景 + dense，110 秒叫了 6 次，**多数唤醒之后 peek 拿到的是空**，
 * 模型只能干等。图确实出了（叫醒靠出图序号驱动），问题是"出图"和"取图"之间
 * 隔着 1~3 秒的唤醒延迟，这期间任何一条路径都能把队列取空。
 *
 * 要守住的三条：
 *   ① **叫醒前先占住这一张** —— 占住之后队列空着，`peek` 也必须拿得到（而且只给一次）；
 *   ② **占不到就不叫** —— 叫醒一个空手的人比不叫更糟（白跑一轮还看不见东西）；
 *   ③ **叫醒失败要放回去** —— 不能因为叫不醒就把图吞掉（那是我们自己弄丢的，最难查）。
 *
 * 用 `source:"file"` 喂合成视频，和线上同一条代码路径，只是把屏幕换成文件。
 * ffmpeg 由 test/ffmpeg.mjs 统一解析；没有就跳过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FFMPEG, ffmpegOk } from './ffmpeg.mjs';

// **必须在 import 之前**：chat.js 在模块加载时就把 DSH_HOME 定下来了
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-see-wake-'));
// 绝不能真弹窗
process.env.DSH_SEE_NO_WINDOW = '1';

const FIXTURE = join('.tmp', 'wake-clip.mp4');

function makeFixture() {
  if (existsSync(FIXTURE) && statSync(FIXTURE).size > 10_000) return FIXTURE;
  mkdirSync('.tmp', { recursive: true });
  // testsrc2 一直在动 → 积分帧持续触发，几秒就能封出一张
  execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=12', '-t', '20',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', FIXTURE], { stdio: 'inherit' });
  return FIXTURE;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = !ffmpegOk();
const { createRunner } = skip ? {} : await import('../src/runner.js');
const { startLoop } = await import('../src/loop.js');

/** 等到攒出第一张（静止/回放都靠这个，不要写死 sleep） */
async function waitPending(runner, { tries = 80, every = 250 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (runner.status().pending >= 1) return true;
    await sleep(every);
  }
  return false;
}

/** 起一条会攒图的管线，攒到一张就停采集（停掉之后断言才不会被新图搅乱） */
async function runnerWithOneSheet(opts = { maxFrames: 3, maxWaitSec: 2 }, extra = {}) {
  const runner = createRunner({ ffmpegPath: FFMPEG, ...extra });
  await runner.start({
    src: { kind: 'file', path: makeFixture(), realtime: true },
    opts,
  });
  assert.ok(await waitPending(runner), '前置条件：先攒出一张图');
  runner.stop();
  return runner;
}

test('叫醒预留：占住之后队列空着，peek 仍拿得到那一张（而且只给一次）', { skip }, async () => {
  const runner = await runnerWithOneSheet();
  try {
    const held = runner.reserveSheet();
    assert.ok(held, '队列里有图就该占得到');

    // **这是关键**：占住 = 从队列里拿走。之后谁走 watch / flushNow 都碰不到它，
    // 所以"叫醒 → 模型醒来 → peek"这 1~3 秒里队列被清空也不影响这一张。
    assert.equal(runner.status().pending, 0, '占住之后队列不该还留着 —— 留着就会被别的路径取走');
    assert.ok(runner.status().reserved, 'status 里要看得见预留（诊断"叫醒却没图"靠它）');

    const got = runner.peek();
    // peek 现在返回**数组**（超省模式一次可能给多张）；默认 wakeBatch=1 时长度必须是 1
    assert.equal(got.length, 1, '占住的那张必须能 peek 到 —— 这就是"叫醒必有图"');
    assert.equal(got[0].to, held.to, '要给的正是叫醒时那一张，不是队列里别的');
    assert.equal(got[0].frames.length, held.frames, '帧数也要对得上');

    assert.equal(runner.peek().length, 0, '同一张不许给两次（模型会以为又换画面了）');
    assert.equal(runner.status().takes.peekEmpty, 1, '空手要记账');
    assert.equal(runner.status().takes.reserved, 1, '取走的那次是预留给的');
  } finally {
    runner.stop();
  }
});

test('叫醒失败：预留的放回队列，图不会凭空消失', { skip }, async () => {
  const runner = await runnerWithOneSheet();
  try {
    const held = runner.reserveSheet();
    assert.ok(held);

    assert.equal(runner.releaseSheet(), true, '失败要把预留放回去');
    assert.equal(runner.status().reserved, null, '放回去之后手上就不该还留着');
    assert.equal(runner.status().pending, 1, '队列里要重新有一张');

    const got = runner.peek();
    assert.equal(got.length, 1, '放回去的那张要能再取出来');
    assert.equal(got[0].to, held.to, '还是原来那张（不是重新攒一张新的）');
  } finally {
    runner.stop();
  }
});

test('watch 也认预留：同一张不会被两条路径各给一次', { skip }, async () => {
  const opts = { maxFrames: 3, maxWaitSec: 2 };
  const runner = createRunner({ ffmpegPath: FFMPEG });
  try {
    await runner.start({ src: { kind: 'file', path: makeFixture(), realtime: true }, opts });
    assert.ok(await waitPending(runner), '前置条件：先攒出一张图');
    const held = runner.reserveSheet();
    assert.ok(held);

    // `watch` 要的是"最早攒好的那张"，预留的那张本来就在这个位置上 —— 所以它也该给出去。
    // 两条路径各取各的话，watch 会以为队列是空的，白等一整个窗口。
    const r = await runner.watch({ seconds: 2, minFrames: 1, opts });
    assert.equal(r.ok, true, `watch 该把预留的那张交出去，实际 ${JSON.stringify(r).slice(0, 160)}`);
    assert.equal(r.sheets.length, 1, '这一轮只该有一张');
    assert.equal(r.sheets[0].to, held.to, '交出去的正是叫醒时那一张');

    const again = runner.peek();
    assert.ok(!again.length || again[0].to !== held.to, '同一张不许再给 peek 一次（模型会以为又换画面了）');
  } finally {
    runner.stop();
  }
});

test('没人来取：预留会过期，不会一直占着内存', { skip }, async () => {
  // reserveSec 收到 0.1 秒，不用等 60 秒
  const runner = await runnerWithOneSheet(undefined, { reserveSec: 0.1 });
  try {
    assert.ok(runner.reserveSheet());
    await sleep(300);

    assert.equal(runner.peek().length, 0, '过期了就该当没有（队列也空着）');
    assert.equal(runner.status().reserved, null, '过期的那一刻就丢掉，不给下一次 peek 捡回来');
    assert.equal(runner.status().takes.peekEmpty, 1);
    assert.equal(runner.status().takes.reserved, 0, '过期的那张不该算"预留给的"');
  } finally {
    runner.stop();
  }
});

// ---------------------------------------------------------------------------
// 以下守**循环侧的协议**：占不到不叫、叫不醒放回。用假 runner，不依赖 ffmpeg。
// ---------------------------------------------------------------------------

function fakeCtx({ resolveOk = true } = {}) {
  const wakes = [];
  const services = {
    sessionController: {
      async resolveAgent() {
        if (!resolveOk) return { error: 'no-agent' };
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

/**
 * 假 runner：`canReserve=false` 模拟"图在叫醒之前就被别的路径取走了"。
 * 记账 `reserved` / `released` 次数，专门守循环有没有按协议来。
 */
function fakeRunner({ pending = 1, sheets = 3, canReserve = true } = {}) {
  const st = { pending, sheets, running: true };
  const calls = { reserved: 0, released: 0 };
  return {
    st,
    calls,
    touch: () => st.running,
    windowWasOpen: () => false,
    status: () => ({
      running: st.running, pending: st.pending, sheets: st.sheets, secondsSinceWake: 5,
    }),
    stop() { st.running = false; },
    reserveSheet() {
      calls.reserved += 1;
      if (!canReserve) return null;
      st.pending = 0;
      return { seq: st.sheets, from: 0, to: 1, frames: 1 };
    },
    releaseSheet() {
      calls.released += 1;
      st.pending = 1;
      return true;
    },
  };
}

const quietTuning = { maxAutonomousWakes: 0, idleStopMs: 0 };

test('循环：占不到图就不叫醒（叫了也是空手）', async () => {
  const { ctx, wakes } = fakeCtx();
  const runner = fakeRunner({ canReserve: false });
  const loop = startLoop({
    ctx, sessionId: 's1', runner, wakeMinGapSec: 0, tuning: quietTuning,
  });

  await sleep(600);
  loop.dispose();

  assert.equal(wakes.length, 0, '图都被取走了还叫，模型只能干等');
  assert.ok(runner.calls.reserved >= 1, '还是要试着占一次，才知道占不到');
});

test('循环：叫醒失败要把预留放回去（不能自己吞掉那一张）', async () => {
  const { ctx } = fakeCtx({ resolveOk: false });
  const runner = fakeRunner({ canReserve: true });
  const loop = startLoop({
    ctx, sessionId: 's1', runner, wakeMinGapSec: 0, tuning: quietTuning,
  });

  // `wakeWithRetry` 会重试一次（+800ms），失败之后才走 release
  await sleep(1600);
  loop.dispose();

  assert.equal(runner.calls.released, 1, `叫不醒就该放回队列，实际放了 ${runner.calls.released} 次`);
});

// ---------------------------------------------------------------------------
// 整条链：真 runner + 真循环 + 一个"被叫醒之后就 peek"的假模型
// ---------------------------------------------------------------------------

test('整条链：每次唤醒之后的 peek 都有图', { skip, timeout: 90_000 }, async () => {
  const runner = createRunner({ ffmpegPath: FFMPEG });
  const wakes = [];
  const peeks = [];
  /**
   * 循环现在要求"上一条叫醒被接住（有一次工具调用）才叫下一条"，
   * 真实链路上那一步是 index.js 的 `execute()` 调 `loop.noteActivity()`。
   * 这里用一个迟到的 peek 同时模拟那两件事：模型被叫醒 → 先 peek，再回到工具里。
   */
  let loop = null;
  const services = {
    sessionController: {
      async resolveAgent() {
        return {
          agent: {
            followup: (m) => {
              wakes.push(m.content?.[0]?.text ?? '');
              // 模拟"模型被叫醒 → 想一想 → 才 peek"：**必须晚于 wake 返回**，
              // 那个间隔正是线上图被抢走的地方
              setTimeout(() => {
                peeks.push(runner.peek());
                loop?.noteActivity?.();
              }, 120);
            },
          },
          session: { id: 's1' },
        };
      },
    },
    sessions: { async flush() { return true; } },
  };

  try {
    await runner.start({
      src: { kind: 'file', path: makeFixture(), realtime: true },
      // 逐场景那套：一张图一个画面，出图最密 —— 社区实报就是在这个组合下复现的
      opts: { maxFrames: 1, strategy: 'single', integralSeconds: 1, markMinGap: 0.2 },
    });
    loop = startLoop({
      ctx: { get: (n) => services[n] ?? undefined },
      sessionId: 's1', runner, scene: true, wakeMinGapSec: 0, tuning: quietTuning,
    });

    await sleep(8000);
    loop.dispose();
    await sleep(200);            // 让最后一次 peek 落袋

    assert.ok(wakes.length >= 2, `8 秒里该叫醒几次，实际 ${wakes.length}`);
    assert.ok(peeks.length >= 1, '被叫醒之后模型总会 peek 一次');
    const empty = peeks.filter((s) => !s?.length).length;
    assert.equal(empty, 0, `唤醒之后的 peek 不该有空手：${empty}/${peeks.length}`);

    const st = runner.status();
    assert.equal(st.takes.peekEmpty, 0, 'peek 一次都不该是空的');
    assert.ok(st.takes.reserved >= 1, `peek 拿到的应该是预留的那张，实际 ${st.takes.reserved}`);
  } finally {
    runner.stop();
  }
});
