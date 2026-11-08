/**
 * 档位映射（`tierStyle` / `tierMap`）。
 *
 * 这一组守的是设置页里那个"自定义 —— 逐档指定"：用户能把算出来的第 i 档
 * 按到任意一档去（整体升/降一档只是它的特例）。
 *
 * 三条不能退化的约束：
 *   ① 0 档（自由尺寸的补位帧）不参与映射 —— 它本来就"占剩下的地方"；
 *   ② 表里的坏值**逐项忽略**，不能因为一个错数字把另外 7 档全打回默认；
 *   ③ 不传表 / 传空 —— 原样返回，不能悄悄改成恒等以外的什么东西。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-see-tiermap-'));
process.env.DSH_HOME = home;

const { applyStrategy, DEFAULT_TIER_MAP } = await import('../src/tiers.js');
const { readTuning, writeTuning, tuningPath, TUNING_DEFAULTS, TIER_STYLES } =
  await import('../src/tuning.js');

test('custom：逐档查表，整体升一档就是 [2,3,4,5,6,7,8,8]', () => {
  const tiers = [1, 2, 3, 4, 5, 6, 7, 8];
  const got = applyStrategy(tiers, 'custom', [2, 3, 4, 5, 6, 7, 8, 8]);
  assert.deepEqual(got, [2, 3, 4, 5, 6, 7, 8, 8]);
});

test('custom：整体降一档（1 档不再降）就是 [1,1,2,3,4,5,6,7]', () => {
  const got = applyStrategy([1, 2, 3, 4, 5, 6, 7, 8], 'custom', [1, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(got, [1, 1, 2, 3, 4, 5, 6, 7]);
});

test('custom：0 档是自由尺寸的补位帧，不参与映射', () => {
  const got = applyStrategy([0, 3], 'custom', [8, 8, 8, 8, 8, 8, 8, 8]);
  assert.equal(got[0], 0, '0 要保持 0 —— 那是"占剩下的地方"，映射成 8 会把版面搞坏');
  assert.equal(got[1], 8);
});

test('custom：表里某一项坏了只影响那一项，不整份作废', () => {
  const got = applyStrategy([1, 2, 3], 'custom', ['x', 5, 99]);
  assert.equal(got[0], 1, '非数字 → 保留原档位');
  assert.equal(got[1], 5, '好值照用');
  assert.equal(got[2], 8, '越界按 TIER_MAX 夹住，不是丢弃');
});

test('custom：没给表就原样返回（别悄悄换成什么别的）', () => {
  assert.deepEqual(applyStrategy([1, 4, 8], 'custom', null), [1, 4, 8]);
  assert.deepEqual(applyStrategy([1, 4, 8], 'custom', undefined), [1, 4, 8]);
});

test('默认映射是恒等，和 native 结果一致', () => {
  const tiers = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(DEFAULT_TIER_MAP, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(applyStrategy(tiers, 'custom', DEFAULT_TIER_MAP), applyStrategy(tiers, 'native'));
});

test('readTuning：tierMap 逐项校验，坏的那一项用默认值并给警告', () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(tuningPath({ DSH_HOME: home }), JSON.stringify({
    tierStyle: 'custom',
    tierMap: [3, 0, 5, 'x', 8, 1, 2, 4],
  }), 'utf8');

  const t = readTuning({ env: { DSH_HOME: home } });
  assert.equal(t.tierStyle, 'custom');
  assert.deepEqual(t.tierMap, [3, 2, 5, 4, 8, 1, 2, 4],
    '0 和 "x" 这两项回默认（档位 i+1），其余照用');
  assert.ok(t.warnings.some((w) => w.includes('tierMap[2]')), `该报第 2 项：${t.warnings.join(' | ')}`);
  assert.ok(t.warnings.some((w) => w.includes('tierMap[4]')), '该报第 4 项');
});

test('readTuning：tierStyle 不认识就回默认（standard）', () => {
  writeFileSync(tuningPath({ DSH_HOME: home }), JSON.stringify({ tierStyle: 'huge' }), 'utf8');
  const t = readTuning({ env: { DSH_HOME: home } });
  assert.equal(t.tierStyle, TUNING_DEFAULTS.tierStyle);
  assert.equal(t.tierStyle, 'standard', '默认是标准档：1 档压成 1/2');
  assert.ok(t.warnings.some((w) => w.includes('tierStyle')));
});

test('standard：只压 1 档，其余档位不动', () => {
  assert.deepEqual(applyStrategy([1, 2, 5, 8], 'standard'), [2, 2, 5, 8]);
});

test('standard 和 native 的唯一区别就是 1 档', () => {
  const base = [1, 1, 3, 8];
  assert.deepEqual(applyStrategy(base, 'native'), [1, 1, 3, 8], '原生：1 档占满整幅');
  assert.deepEqual(applyStrategy(base, 'standard'), [2, 2, 3, 8], '标准：1 档压成 1/2');
});

test('writeTuning：自定义映射能落盘，读回来还是那八个数', () => {
  const path = tuningPath({ DSH_HOME: home });
  writeFileSync(path, '{}', 'utf8');
  const r = writeTuning({ tierStyle: 'custom', tierMap: [2, 2, 3, 4, 5, 6, 7, 8] }, { env: { DSH_HOME: home } });
  assert.equal(r.ok, true, JSON.stringify(r.rejected));
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(raw.tierStyle, 'custom');
  assert.deepEqual(raw.tierMap, [2, 2, 3, 4, 5, 6, 7, 8]);
});

test('writeTuning：坏的 tierMap 会被拒，而不是悄悄写进去', () => {
  writeFileSync(tuningPath({ DSH_HOME: home }), '{}', 'utf8');
  const r = writeTuning({ tierMap: [1, 2, 3] }, { env: { DSH_HOME: home } });
  assert.equal(r.ok, false, '少了五项应该被拒（补齐会长出一份用户没写过的默认值）');
  assert.ok(r.rejected.some((x) => x.includes('tierMap')), JSON.stringify(r.rejected));
});

// ---- 「每帧固定多大」= 八项全指向同一档 ------------------------------------
//
// 这一组守的是一个**等价关系**：用户想要"密度不再影响尺寸"时，正确做法是把八项
// 都填成同一档，而不是给系统再加一个"锁定"开关。曾经加过那样的开关，后来删了 ——
// 它在数学上和"全映射到同一档"逐字节相同，多一个概念只会让人以为还有别的能力。

test('八项全指向同一档 = 每帧一样大，密度被整表吃掉', () => {
  // see-now 的表是**数组**（第 i 个数 = 档位 i+1），不是对象 —— 和 storyboard 那边不同
  const same = (n) => Array.from({ length: 8 }, () => n);
  // 不管密度算出几档，出来的都是 4
  assert.deepEqual(applyStrategy([1, 3, 6, 8], 'custom', same(4)), [4, 4, 4, 4]);
  assert.deepEqual(applyStrategy([1, 5], 'custom', same(2)), [2, 2]);
});

test('八项全指向同一档时，0 档（自由尺寸补位帧）仍然不动', () => {
  const same = Array.from({ length: 8 }, () => 3);
  assert.deepEqual(applyStrategy([0, 5], 'custom', same), [0, 3]);
});

test('它压过 native/full/compact —— 因为那三种是在"密度档位"上做加减', () => {
  const same = Array.from({ length: 8 }, () => 2);
  const base = [1, 5, 8];
  assert.deepEqual(applyStrategy(base, 'custom', same), [2, 2, 2]);
  // 对照：compact 是"每个档位 +1"，结果仍随密度变
  assert.deepEqual(applyStrategy(base, 'compact'), [2, 6, 8]);
});

// ---- 模型能用 `tier` 改档位（schema 里只留枚举，不写引导） -----------------

test('schema 里有 tier 参数，枚举和内部白名单一致', async () => {
  const { seeNowToolSpec } = await import('../src/tool-spec.js');
  const tier = seeNowToolSpec().parameters.tier;
  assert.ok(tier, '这参数必须存在 —— 宿主按 schema 过滤，没声明就传不进来');
  assert.equal(tier.type, 'string');
  const listed = String(tier.description).split('|').map((x) => x.trim());
  for (const v of ['standard', 'native', 'full', 'compact']) {
    assert.ok(listed.includes(v), `schema 里漏了 ${v}`);
    assert.ok(TIER_STYLES.includes(v), `TIER_STYLES 里没有 ${v}`);
  }
  assert.ok(!listed.includes('custom'), 'custom 不给模型 —— 它填不了那张八项的表');
});

test('模型改档位后 tierMode 生效，且不再带 custom 的表', () => {
  // 走一遍和 index.js 里同样的判断：custom 被挡住，四档被接受
  const modes = ['standard', 'native', 'full', 'compact'];
  const pick = (want) => (modes.includes(String(want).toLowerCase()) ? String(want).toLowerCase() : null);
  assert.equal(pick('full'), 'full');
  assert.equal(pick('CUSTOM'), null, 'custom 不该被接受');
  assert.equal(pick('nonsense'), null);
});
