// 区域（自选窗口）的**落盘**部分。
//
// 取框窗本身没法测（会真的弹一个全屏黑罩子在用户脸上），所以这里只钉三件事：
//   1. 存下来的那块能被读回来，形状对
//   2. 坏文件 / 没文件都返回 null —— 不能把 watch 一起拖死
//   3. 取消之后确实不剩东西（否则下一次 watch 又抓回那一小块）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-see-region-'));
process.env.DSH_HOME = home;

const { loadRegion, saveRegion, clearRegion, regionText, regionFile } = await import('../src/region.js');

test('没选过区域时是 null，不是假的 0,0,0,0', () => {
  assert.equal(loadRegion(), null);
  assert.equal(regionText(loadRegion()), null);
});

test('存了能读回来，并拼成 x,y,w,h', () => {
  saveRegion({ x: 1593, y: 375, w: 568, h: 1010 });
  assert.deepEqual(loadRegion(), { x: 1593, y: 375, w: 568, h: 1010 });
  assert.equal(regionText(loadRegion()), '1593,375,568,1010');
});

test('坏文件当成没选过（不能把 watch 拖死）', () => {
  writeFileSync(regionFile(), '{ 这不是 json', 'utf8');
  assert.equal(loadRegion(), null);
});

test('宽高为 0 或负数一律不认', () => {
  writeFileSync(regionFile(), JSON.stringify({ x: 1, y: 2, w: 0, h: 100 }), 'utf8');
  assert.equal(loadRegion(), null);
  writeFileSync(regionFile(), JSON.stringify({ x: -5, y: 2, w: 100, h: 100 }), 'utf8');
  assert.equal(loadRegion(), null, 'gdigrab 不接受负偏移，负坐标不能当成有效区域');
});

test('取消之后文件真的没了', () => {
  saveRegion({ x: 10, y: 20, w: 300, h: 400 });
  assert.equal(clearRegion(), true);
  assert.equal(existsSync(regionFile()), false);
  assert.equal(loadRegion(), null);
  assert.equal(clearRegion(), false, '本来就没有时返回 false，不抛');
});
