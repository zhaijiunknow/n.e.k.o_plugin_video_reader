/**
 * 多图交付的工具结果形状（超省模式的最后一段路）。
 *
 * `takeSheets()` 攒得出 3 张、`peek()` 也一次给 3 张，但如果最后交给宿主的
 * 结果是"3 张图只用了第一张的文案"，模型看到的三张就没有各自的时间段 ——
 * 那等于白攒。
 *
 * 这里守三件事：
 *   ① `images` 有几张就交几个 ref；
 *   ② 每张的文案带「第 i/n 张」和自己的时间区间，不是三份一模一样的头；
 *   ③ 单张时 `meta` 字段和以前完全一致（`batch` 除外）—— 老调用方和测试都还在读。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import 之前：chat.js 加载时就把 DSH_HOME 定下来了
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-see-attach-'));
process.env.DSH_SEE_NO_WINDOW = '1';

const { __test } = await import('../src/index.js');
const { attachAndReturn, sheetText } = __test;

/** 假 sheet：只带 `attachAndReturn` / `sheetText` 真的会读的字段 */
function fakeSheet({ from, to, frames = 2, why = 'full' } = {}) {
  return {
    png: Buffer.alloc(120 + (from ?? 0)),
    w: 798,
    h: 450,
    from,
    to,
    fill: 0.62,
    why,
    frames: Array.from({ length: frames }, (_, i) => ({
      t: from + i, tier: 2, via: 'cut', pw: 399, ph: 225,
    })),
  };
}

/** 假宿主：`saveImage` 只回一个可数的 ref */
function fakeCtx() {
  const saved = [];
  return {
    saved,
    attachments: {
      async saveImage({ data }) {
        saved.push(data.length);
        return { uri: `mem://${saved.length}`, bytes: data.length };
      },
    },
  };
}

test('三张图：三个 ref、三段文案、各自的区间', async () => {
  const ctx = fakeCtx();
  const sheets = [
    fakeSheet({ from: 10, to: 25 }),
    fakeSheet({ from: 26, to: 40 }),
    fakeSheet({ from: 41, to: 58 }),
  ];
  const out = await attachAndReturn(ctx, sheets, { waited: 12 });

  assert.equal(out.images.length, 3, `三张就该交三个 ref，实际 ${out.images.length}`);
  assert.equal(ctx.saved.length, 3, 'saveImage 也该被调三次');
  for (const i of [1, 2, 3]) {
    assert.ok(out.text.includes(`第 ${i}/3 张`), `文案里要标出第 ${i}/3 张：${out.text.slice(0, 200)}`);
  }
  assert.ok(out.text.includes('10.0–25.0'), '第一张要带自己的区间');
  assert.ok(out.text.includes('41.0–58.0'), '最后一张要带自己的区间');

  assert.equal(out.meta.batch, 3);
  assert.equal(out.meta.sheets.length, 3, 'meta.sheets 里逐张的区间要齐');
  assert.equal(out.meta.from, 10, 'meta.from 是首张起点');
  assert.equal(out.meta.to, 58, 'meta.to 是末张终点');
  assert.equal(out.meta.frames, 6, '帧数是三张合计');
});

test('单张：meta 字段和以前一致（batch 除外）', async () => {
  const ctx = fakeCtx();
  const s = fakeSheet({ from: 5, to: 12, frames: 3 });
  const out = await attachAndReturn(ctx, [s], {});

  assert.equal(out.images.length, 1);
  assert.equal(out.meta.batch, 1);
  assert.equal(out.meta.frames, 3, '单张时 frames 就是那张的帧数');
  assert.equal(out.meta.from, 5);
  assert.equal(out.meta.to, 12);
  assert.equal(out.meta.fill, 0.62);
  assert.equal(out.meta.why, 'full');
  assert.ok(!out.text.includes('第 1/1 张'), '单张不要标序号，那是噪音');
});

test('也接受单张而不是数组（老调用点）', async () => {
  const ctx = fakeCtx();
  const out = await attachAndReturn(ctx, fakeSheet({ from: 1, to: 2 }), {});
  assert.equal(out.images.length, 1, '传单张要能兜住，不能因为不是数组就炸');
});

test('一张都没有：说清楚，不要假装有图', async () => {
  const out = await attachAndReturn(fakeCtx(), [], {});
  assert.equal(out.meta.ok, false);
  assert.equal(out.meta.batch, 0);
  assert.ok(!out.images, '没图就不该有 images 字段');
});

test('sheetText 单帧不写成区间', () => {
  const s = fakeSheet({ from: 12, to: 12, frames: 1 });
  const text = sheetText(s, {});
  assert.ok(text.includes('此刻'), `单帧该说"此刻"，实际：${text.slice(0, 80)}`);
  assert.ok(!text.includes('12.0–12.0'), '单帧写成区间读起来像出错');
});
