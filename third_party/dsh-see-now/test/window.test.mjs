// 悬浮窗的启动逻辑：解释器要带 tkinter、pid 只在真活着时才写
//
// 这一组测试是补踩过的坑：
//   1. PATH 上的 python 是 WorkBuddy managed 的，**没有 tkinter**，spawn 之后立刻退
//   2. 老代码在 waitExit 之前就写了 pid → pid 指向死进程 → windowAlive() 永远 false
//   3. 商店版解释器在 WindowsApps 里是 App Execution Alias，**existsSync 判定不到**
//
// ⚠️ 这里**绝不能真的把窗开起来**（会弹到用户脸上、还会占住真机的 pid 锁），
// 所以每个用例都用 `DSH_SEE_NO_WINDOW=1` 或"一定失败的解释器"把路堵死。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import window.js 之前设好 DSH_HOME（chatDir() 读它）
const home = mkdtempSync(join(tmpdir(), 'dsh-see-window-'));
process.env.DSH_HOME = home;
delete process.env.DSH_SEE_WINDOW;
delete process.env.DSH_SEE_PYTHON;
delete process.env.DSH_FLOAT_PYTHON;

const { openWindow, closeWindow, windowAlive, pidPath, resolveScript, hasTkinter } =
  await import('../src/window.js');

test('DSH_SEE_NO_WINDOW=1 时直接拒绝，不 spawn', async () => {
  process.env.DSH_SEE_NO_WINDOW = '1';
  try {
    const st = await openWindow();
    assert.equal(st.ok, false);
    assert.equal(st.reason, 'disabled');
  } finally {
    delete process.env.DSH_SEE_NO_WINDOW;
  }
  assert.equal(existsSync(pidPath()), false, 'disabled 时不能留 pid');
});

test('pid 文件指向不存在的进程时，windowAlive 必须是 false', () => {
  writeFileSync(pidPath(), '2147483646', 'utf8');
  assert.equal(windowAlive(), false);
});

test('pid 文件是垃圾内容时也不能崩', () => {
  writeFileSync(pidPath(), 'not-a-pid', 'utf8');
  assert.equal(windowAlive(), false);
  writeFileSync(pidPath(), '', 'utf8');
  assert.equal(windowAlive(), false);
});

test('closeWindow 会把 pid 文件清掉', () => {
  writeFileSync(pidPath(), '2147483646', 'utf8');
  closeWindow();
  assert.equal(existsSync(pidPath()), false);
});

test('DSH_SEE_WINDOW 指向不存在的文件时，跳过它并继续往下找', () => {
  const missing = join(home, 'nope.py');
  process.env.DSH_SEE_WINDOW = missing;
  try {
    const resolved = resolveScript();
    assert.notEqual(resolved.script, missing, '不存在的路径不能当脚本');
    assert.notEqual(resolved.from, 'DSH_SEE_WINDOW');
  } finally {
    delete process.env.DSH_SEE_WINDOW;
  }
});

test('DSH_SEE_WINDOW 指向真实文件时优先用它', () => {
  const fake = join(home, 'fake-window.py');
  writeFileSync(fake, 'import sys; sys.exit(0)\n', 'utf8');
  process.env.DSH_SEE_WINDOW = fake;
  try {
    const resolved = resolveScript();
    assert.equal(resolved.script, fake);
    assert.equal(resolved.from, 'DSH_SEE_WINDOW');
  } finally {
    delete process.env.DSH_SEE_WINDOW;
    rmSync(fake, { force: true });
  }
});

test('脚本秒退时判定为失败，且绝不留下 pid', async () => {
  // 用 python 起一个 `sys.exit(0)` 的假脚本：解释器能跑、脚本跑完就退。
  // 这正是老代码出问题的那种情况 —— 它当时会返回 ok:true 并写下死 pid。
  //
  // **必须用 script: 注入**，不能靠 DSH_SEE_WINDOW：那个路径一旦不存在，
  // resolveScript() 会顺着回退链摸到真的 window.py，测试就把窗弹到用户脸上了（踩过）。
  const fake = join(home, 'instant-exit.py');
  writeFileSync(fake, 'import sys\nsys.exit(0)\n', 'utf8');
  try {
    const st = await openWindow({ script: fake, settleMs: 1500 });
    assert.equal(st.ok, false, `脚本秒退不该算成功：${JSON.stringify(st)}`);
    assert.equal(existsSync(pidPath()), false, '秒退的进程绝不能留下 pid');
    assert.equal(windowAlive(), false);
  } finally {
    rmSync(fake, { force: true });
  }
});

test('注入一个不存在的 script 时，不回落到回退链', async () => {
  // 这条守的正是"测试意外弹出真窗"那个坑：
  // 注入路径不存在 → 直接失败，绝不去摸 ~/.dsh 或兄弟仓库里的真 window.py。
  const st = await openWindow({ script: join(home, 'gone-forever.py'), settleMs: 200 });
  assert.equal(st.ok, false);
  assert.match(st.reason, /不存在/);
  assert.equal(existsSync(pidPath()), false);
});

test('不存在的解释器一定过不了 tkinter 验证', () => {
  // openWindow 的顺序是：验 tkinter → spawn → 等 settle → 才写 pid。
  // 这一步就是把"不存在的 exe"和"没装 tk 的 python"挡在 spawn 之前的地方。
  assert.equal(hasTkinter(join(home, 'not-python-1.exe')), false);
  assert.equal(hasTkinter(join(home, 'not-python-2.exe')), false);
});

test('启动失败时把 stderr 尾巴带进 reason（#45）', async (t) => {
  // 只报 `code=1` 会把人往"装 python"的方向带，而真因常常是平台专有属性或缺 _tkinter。
  // 这条守的是"死因必须可见"：脚本往 stderr 吐一句，reason 里就得有那句。
  const { pythonCandidates, pythonProbe } = await import('../src/window.js');
  // 候选里只有 PATH 上那两个（本机都是没 tkinter 的 managed 版）。带 tkinter 的解释器
  // 通常要在 `DSH_TEST_PYTHON` 里显式给一个，否则这条只能 skip（CI 就是这样）。
  const probeList = [process.env.DSH_TEST_PYTHON, ...pythonCandidates()].filter(Boolean);
  const usable = probeList.find((p) => pythonProbe(p).ok);
  if (!usable) { t.skip('本机没有带 tkinter 的解释器'); return; }

  process.env.DSH_SEE_PYTHON = usable;
  rmSync(pidPath(), { force: true });
  const fake = join(home, 'boom.py');
  writeFileSync(fake, [
    'import sys',
    'sys.stderr.write("Traceback (most recent call last):\\n")',
    'sys.stderr.write("_tkinter.TclError: bad attribute \\"-transparentcolor\\"\\n")',
    'sys.exit(1)',
  ].join('\n'), 'utf8');
  try {
    const st = await openWindow({ script: fake, settleMs: 1500 });
    assert.equal(st.ok, false, `脚本退 1 不该算成功：${JSON.stringify(st)}`);
    assert.match(st.reason, /bad attribute/, `reason 里要有 stderr 尾巴：${st.reason}`);
  } finally {
    delete process.env.DSH_SEE_PYTHON;
    rmSync(fake, { force: true });
    rmSync(pidPath(), { force: true });
  }
});

test('心跳过期时 windowAlive 判死 —— 进程还在也不行', async () => {
  // 场景就是 issue #2 第 3 条：进程活着、pid 文件也在，但窗口其实已经卡死/是张空窗。
  // 老逻辑只看 pid，于是永远"还活着"，用户点 × 之后再叫也开不出来。
  const { chatDir } = await import('../src/chat.js');
  const { utimesSync, mkdirSync } = await import('node:fs');
  mkdirSync(chatDir(), { recursive: true });
  const hb = join(chatDir(), 'window-heartbeat');

  // pid 指向当前进程（一定活着）
  writeFileSync(pidPath(), String(process.pid), 'utf8');
  writeFileSync(hb, '');
  assert.equal(windowAlive(), true, '心跳新鲜时应判定为活着');

  // 把心跳改到 30 秒前
  const old = new Date(Date.now() - 30_000);
  utimesSync(hb, old, old);
  assert.equal(windowAlive(), false, '心跳过期必须判死，否则永远不会重开窗');

  rmSync(hb, { force: true });
  rmSync(pidPath(), { force: true });
});

test('没有心跳文件时不误杀（兼容不写心跳的老窗口）', async () => {
  const { chatDir } = await import('../src/chat.js');
  const { mkdirSync, utimesSync } = await import('node:fs');
  mkdirSync(chatDir(), { recursive: true });
  const hb = join(chatDir(), 'window-heartbeat');
  rmSync(hb, { force: true });          // 老窗口：压根不写心跳

  writeFileSync(pidPath(), String(process.pid), 'utf8');
  assert.equal(windowAlive(), true, '没有心跳文件时应继续信任 pid，别把老窗口误杀');
  rmSync(pidPath(), { force: true });
});
