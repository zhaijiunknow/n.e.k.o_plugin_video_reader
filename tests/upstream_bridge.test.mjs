import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCollector } from '../upstream_bridge.mjs';
import { createPipeline, DEFAULTS } from '../third_party/dsh-see-now/src/pipeline.js';

function synthetic(index) {
  const frame = Buffer.alloc(64 * 36 * 3);
  // Motion, hard cuts, similar scenes, and dark/letterboxed frames.
  const scene = Math.floor(index / 60) % 4;
  for (let y = 0; y < 36; y++) {
    for (let x = 0; x < 64; x++) {
      const at = (y * 64 + x) * 3;
      if (y < 4 || y >= 32) continue;
      const factor = scene === 3 ? 0.2 : 1;
      frame[at] = ((x + index * 2 + scene * 50) % 255) * factor;
      frame[at + 1] = ((y * 7 + scene * 80) % 255) * factor;
      frame[at + 2] = (scene % 2 ? 220 : 40) * factor;
    }
  }
  return frame;
}

test('bridge preserves upstream defaults and every PNG/frame decision', () => {
  const options = { width: 64, height: 36, fps: 12 };
  const upstream = createPipeline({ ...options, queueDepth: 0 });
  const actual = [];
  const bridge = createCollector(options, (_, png) => actual.push(png));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (key in options || key === 'queueDepth') continue;
    assert.deepEqual(bridge.constants[key], value, key);
  }
  for (let i = 0; i < 720; i++) {
    const frame = { t: 5 + i / 12, buf: synthetic(i) };
    upstream.push(frame);
    bridge.push(frame);
  }
  upstream.finish();
  const result = bridge.finish();
  const expected = [];
  let sheet;
  while ((sheet = upstream.take()) !== null) expected.push(sheet);
  assert.ok(expected.length > 1);
  assert.equal(actual.length, expected.length);
  const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
  for (let i = 0; i < expected.length; i++) {
    assert.equal(hash(actual[i]), hash(expected[i].png), `PNG ${i}`);
    const frames = expected[i].frames.map(({ wall, ...f }) => f);
    assert.deepEqual(result.sheets[i].frames, frames);
    assert.deepEqual(result.sheets[i].cells, expected[i].cells);
  }
  assert.deepEqual(result.stats, upstream.stats);
});

test('offline bridge retains static fallback sheets instead of only the last', () => {
  const bridge = createCollector({ width: 64, height: 36, fps: 12 }, () => {});
  const buf = Buffer.alloc(64 * 36 * 3, 100);
  for (let i = 0; i < 12 * 95; i++) bridge.push({ t: i / 12, buf });
  const result = bridge.finish();
  assert.ok(result.sheets.length >= 2);
  assert.equal(result.sheets.length, result.stats.sheets);
  assert.equal(result.sheets[0].frames[0].t, 0);
  assert.ok(result.sheets.at(-1).frames.at(-1).t >= 80);
});
