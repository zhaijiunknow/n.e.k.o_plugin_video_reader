// 取框窗的**端到端**冒烟：真起一个 tkinter 全屏罩子，用 DSH_PICK_SELFTEST 假的
// 按一下拖一下，看它能不能吐出 x,y,w,h 并存下来。
//
// **默认跳过**：这会在屏幕上闪一个全屏黑罩子（约 1 秒）。自动跑测试时不该打扰人。
// 要跑：
//   DSH_PICK_SELFTEST=1 node --test test/picker.test.mjs
// 需要本机有带 tkinter 的 python（脚本自己会探）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const on = process.env.DSH_PICK_SELFTEST === '1';
const home = mkdtempSync(join(tmpdir(), 'dsh-see-picker-'));
process.env.DSH_HOME = home;

const { pickRegion, loadRegion, regionText } = await import('../src/region.js');

test('拖一下就能拿到坐标，并且落盘', { skip: !on && '没设 DSH_PICK_SELFTEST=1（会在屏幕上闪一个全屏罩子）' }, async () => {
  const r = await pickRegion({ timeoutMs: 30_000 });
  assert.equal(r.ok, true, `取框失败：${r.reason} ${r.detail ?? ''}`);
  // pick_region.py 自检固定拖 (100,120) → (500,620)
  assert.deepEqual(r.region, { x: 100, y: 120, w: 400, h: 500 });
  assert.equal(regionText(loadRegion()), '100,120,400,500', '选完必须落盘，否则下一次 watch 还是整屏');
});
