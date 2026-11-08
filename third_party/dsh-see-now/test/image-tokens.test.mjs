/**
 * image-tokens.test.mjs — 把宿主 patch 网格口径钉死。
 *
 * 这些数不是“大概”：233/407/366 直接决定一张图比另一张贵多少。
 * 旧文里的 218、388、384 都是不同年代的口径，改这边就要一起对拍。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  imageTokens, fitCanvasToTokens, IMAGE_TOKEN_CAP,
} from '../src/tokens.js';

test('宿主 42px 网格：800×450=233，1066×600=407', () => {
  assert.equal(imageTokens(800, 450), 233);
  assert.equal(imageTokens(1066, 600), 407);   // 旧注释写 388，是错的
  assert.equal(imageTokens(1036, 583), 366);
  assert.equal(imageTokens(1280, 720), 578);
  assert.equal(imageTokens(1600, 900), 882);
});

test('384 预算：16:9 下选到 1036×583，而不是 1066×600', () => {
  const c = fitCanvasToTokens(16 / 9, { maxTokens: 384 });
  assert.ok(c, '384 预算必须能选出一块画布');
  assert.ok(c.tokens <= 384, `选出的画布超预算：${c.tokens}`);
  assert.equal(c.width, 1036);
  assert.equal(c.height, 583);
  const ratio = c.width / c.height;
  assert.ok(Math.abs(ratio - 16 / 9) < 0.02, `比例偏了：${ratio}`);
});

test('超大地图会被宿主缩到 1024 以内，估算不会失控', () => {
  assert.ok(imageTokens(5000, 5000) <= IMAGE_TOKEN_CAP);
  assert.ok(imageTokens(1600, 900) <= IMAGE_TOKEN_CAP);
});

test('无效尺寸返回 0，不返回 NaN', () => {
  assert.equal(imageTokens(0, 450), 0);
  assert.equal(imageTokens(800, 0), 0);
  assert.equal(imageTokens(-1, -1), 0);
});
