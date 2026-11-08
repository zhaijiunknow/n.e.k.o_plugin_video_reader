/**
 * change-log.test.mjs — 变化日志（`changeLog`）的守卫。
 *
 * 它要解决的场景：`queueDepth: 1` 在模型思考/操作期间会把旧图挤掉，
 * 模型回来只看到"现在"。日志把"这期间变了多少、哪里变"留下来，
 * 所以这里守四件事：
 *   ① 默认关：不额外记录（不改所有人的交付体积）
 *   ② 打开后有记录，且时间/分数/方位都在合法范围
 *   ③ `drainChanges()` 取走即清：同一段变化不能在下一张图里重复出现
 *   ④ 配置项非法值不会把插件弄挂（见 tuning 段）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPipeline } from '../src/pipeline.js';
import { readTuning } from '../src/tuning.js';

const W = 160;
const H = 90;

/** 底色 + 一个随 f 移动的方块：画面在动，但不是整屏换场景 */
function frame(f) {
  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = 40; buf[i + 1] = 60; buf[i + 2] = 90;
  }
  const bx = (f * 9) % (W - 24);
  for (let y = 10; y < 40; y += 1) {
    for (let x = bx; x < bx + 24; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = 250; buf[i + 1] = 240; buf[i + 2] = 230;
    }
  }
  return buf;
}

function run(n, opts = {}) {
  const p = createPipeline({
    width: W, height: H, fps: 12, maxWaitSec: 1e9, silentFloorSec: 1e9, ...opts,
  });
  for (let i = 0; i < n; i += 1) p.push({ t: i * 0.08, buf: frame(i) });
  p.finish();
  return p;
}

test('默认不记录变化日志', () => {
  const p = run(30);
  assert.deepEqual(p.drainChanges(), [], 'changeLog 默认关，不该有任何条目');
});

test('打开后有记录，字段在合法范围', () => {
  const p = run(30, { changeLog: true });
  const changes = p.drainChanges();
  assert.ok(changes.length >= 1, '至少该有一段（30 帧足够出图）');
  for (const c of changes) {
    assert.equal(typeof c.at, 'number');
    assert.equal(typeof c.peak, 'number');
    assert.ok(c.peak >= 0 && c.peak <= 255, `peak 越界：${c.peak}`);
    assert.ok(c.from <= c.to, '时间窗方向反了');
    assert.ok(c.n >= 1, '帧数至少 1');
    if (c.box) {
      for (const k of ['x0', 'y0', 'x1', 'y1']) {
        assert.ok(c.box[k] >= 0 && c.box[k] <= 1, `box.${k} 越界：${c.box[k]}`);
      }
      assert.ok(c.box.x0 <= c.box.x1 && c.box.y0 <= c.box.y1, 'box 上下界反了');
    }
  }
});

test('drainChanges 取走即清，不会在下一张图里重复', () => {
  const p = run(30, { changeLog: true });
  const first = p.drainChanges();
  assert.ok(first.length >= 1);
  assert.deepEqual(p.drainChanges(), [], '第二次必须是空');
});

test('changeLogMax 限制条目数，丢最旧的', () => {
  // 帧数拉长到能出多张图，再把上限压到 2
  const p = run(120, { changeLog: true, changeLogMax: 2 });
  const changes = p.drainChanges();
  assert.ok(changes.length <= 2, `上限 2，实际 ${changes.length}`);
});

test('tuning 读 changeLog：布尔生效，非法值退回默认并给 warn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-see-changelog-'));
  const env = { USERPROFILE: dir, DSH_HOME: join(dir, '.dsh') };
  mkdirSync(env.DSH_HOME, { recursive: true });
  writeFileSync(join(env.DSH_HOME, 'see-now.json'), JSON.stringify({ changeLog: true }));
  assert.equal(readTuning({ env }).changeLog, true);

  writeFileSync(join(env.DSH_HOME, 'see-now.json'), JSON.stringify({ changeLog: 'yes' }));
  const bad = readTuning({ env });
  assert.equal(bad.changeLog, false, '非法值必须退回默认 false');
  assert.ok(bad.warnings.some((w) => w.includes('changeLog')), '要留一条 warn');
});
