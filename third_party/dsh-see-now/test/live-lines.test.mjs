/**
 * 「长句边说边出字幕」那条链：buffer 覆盖语义 + drain 的两类文件 + settle。
 *
 * 为什么单独一个文件：这条链全是**时间与覆盖**的边界（快照 vs 整句、迟到快照、
 * 积压、同名覆盖去重），靠"起个真设备听一遍"一条都测不出来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T0 = 1_700_000_000_000;

/** 44 字节标准头的 16k/mono/pcm16 wav（drain 要求 > 1024 字节）。 */
function wav(seconds = 1) {
  const n = Math.round(16000 * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}

function fakeTranscriber(textOf) {
  let n = 0;
  return {
    kind: 'fake',
    label: '假转写',
    async transcribe() {
      n += 1;
      return textOf(n);
    },
  };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'seenow-live-'));
}

test('createLineBuffer.upsert：整句覆盖快照，迟到的快照不许改回整句', async () => {
  const { createLineBuffer } = await import('../src/listen.js');
  const b = createLineBuffer();

  b.upsert(T0, T0 + 1800, '一般来', { partial: true });
  assert.equal(b.all.length, 1);
  assert.equal(b.all[0].partial, true, '第一版是临时快照');

  b.upsert(T0, T0 + 3000, '一般来说有两个维度。', { partial: false });
  assert.equal(b.all.length, 1, '同一句（t0 相同）不能变成两条');
  assert.equal(b.all[0].text, '一般来说有两个维度。');
  assert.equal(b.all[0].partial, false);

  // 整句之后又来一版快照（时序竞态）—— 必须被丢掉
  b.upsert(T0, T0 + 2100, '一般来说有两', { partial: true });
  assert.equal(b.all[0].text, '一般来说有两个维度。', '整句不能被快照覆盖');
  assert.equal(b.all[0].partial, false);
});

test('createLineBuffer.upsert：空文本不建条目', async () => {
  const { createLineBuffer } = await import('../src/listen.js');
  const b = createLineBuffer();
  assert.equal(b.upsert(T0, T0 + 1000, '   ', { partial: true }), null);
  assert.equal(b.all.length, 0);
});

test('drain：live 快照先出 partial 台词，seg 落盘后覆盖成整句', async () => {
  const { createListener } = await import('../src/listen.js');
  const dir = tmp();
  try {
    // 第一次调用给"快照"结果，第二次给"整句"结果
    const l = createListener({
      dir,
      transcriber: fakeTranscriber((n) => (n === 1 ? '一般来' : '一般来说有两个维度。')),
      listen: { live: true, pollMs: 50 },
      log: () => {},
    });

    writeFileSync(join(dir, `live-${T0}.wav`), wav(1.8));
    await l.drain();

    let got = l.between(T0 - 1000, T0 + 5000);
    assert.equal(got.length, 1, '快照应该进台词缓冲');
    assert.equal(got[0].partial, true);
    assert.equal(got[0].text, '一般来');

    // 整句来了
    writeFileSync(join(dir, `seg-${T0}.wav`), wav(3));
    await l.drain();

    got = l.between(T0 - 1000, T0 + 5000);
    assert.equal(got.length, 1, '仍然是同一句，不能变成两条');
    assert.equal(got[0].partial, false);
    assert.equal(got[0].text, '一般来说有两个维度。');
    assert.equal(existsSync(join(dir, `seg-${T0}.wav`)), false, '整句处理完要删掉');
    assert.equal(l.state().total, 1, 'total 只数整句');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drain：同一个 live 文件没变就不重复转写（同名覆盖靠 size/mtime 判新）', async () => {
  const { createListener } = await import('../src/listen.js');
  const dir = tmp();
  try {
    let calls = 0;
    const l = createListener({
      dir,
      transcriber: {
        kind: 'fake',
        label: '计数',
        async transcribe() { calls += 1; return `第${calls}版`; },
      },
      listen: { live: true },
      log: () => {},
    });
    const p = join(dir, `live-${T0}.wav`);
    writeFileSync(p, wav(1.8));
    await l.drain();
    await l.drain();
    await l.drain();
    assert.equal(calls, 1, '内容没变不该重转');

    // 覆盖成更长的音频（模拟"又说了 1.2 秒"）
    writeFileSync(p, wav(3.0));
    await l.drain();
    assert.equal(calls, 2, '内容变了要重转');
    assert.equal(l.between(T0 - 1000, T0 + 5000)[0].text, '第2版');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drain：listen.live=false 时快照直接清掉，不转写', async () => {
  const { createListener } = await import('../src/listen.js');
  const dir = tmp();
  try {
    let calls = 0;
    const l = createListener({
      dir,
      transcriber: { kind: 'fake', label: '计数', async transcribe() { calls += 1; return 'x'; } },
      listen: { live: false },
      log: () => {},
    });
    const p = join(dir, `live-${T0}.wav`);
    writeFileSync(p, wav(1.8));
    await l.drain();
    assert.equal(calls, 0, '关掉之后一次都不该转');
    assert.equal(existsSync(p), false, '残留的快照要清掉');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drain：快照转写失败不算进连续失败（不能把主链路暂停）', async () => {
  const { createListener } = await import('../src/listen.js');
  const dir = tmp();
  try {
    const l = createListener({
      dir,
      transcriber: {
        kind: 'fake',
        label: '总失败',
        async transcribe() { throw new Error('服务没起'); },
      },
      listen: { live: true },
      log: () => {},
    });
    writeFileSync(join(dir, `live-${T0}.wav`), wav(1.8));
    await l.drain();
    await l.drain();
    await l.drain();
    await l.drain();
    const st = l.state();
    assert.equal(st.paused, false, '快照失败不该触发 30 秒暂停');
    assert.equal(st.error, null, '快照失败也不该污染 status 里的错误');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settle：有段在飞就等，清空后立刻放行；积压时不参与等待', async () => {
  const { createListener } = await import('../src/listen.js');
  const dir = tmp();
  try {
    const l = createListener({
      dir,
      transcriber: fakeTranscriber(() => 'x'),
      listen: { live: true },
      log: () => {},
    });

    assert.equal(await l.settle(200), true, '什么都没有：立刻 true');

    writeFileSync(join(dir, `seg-${T0}.wav`), wav(3));
    const t0 = Date.now();
    const ok = await l.settle(150);
    const cost = Date.now() - t0;
    assert.equal(ok, false, '有段没转：等到超时返回 false');
    assert.ok(cost >= 100, `应该真等了（实际 ${cost}ms）`);

    // 积压 5 段：直接放行，不陪着等
    for (let i = 1; i <= 5; i += 1) writeFileSync(join(dir, `seg-${T0 + i * 1000}.wav`), wav(2));
    const t1 = Date.now();
    assert.equal(await l.settle(300), false);
    assert.ok(Date.now() - t1 < 60, '积压时不该等');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tuning：listen 段越界退回默认并给 warn，liveStep 不许大于 maxSeg', async () => {
  const { readTuning, LISTEN_DEFAULTS } = await import('../src/tuning.js');
  const dir = mkdtempSync(join(tmpdir(), 'seenow-tune-'));
  try {
    const p = join(dir, 'see-now.json');
    writeFileSync(p, JSON.stringify({
      listen: { live: false, pollMs: 10, silence: 9, liveMin: 2.4, maxSeg: 1.2, liveStep: 2.0 },
    }));
    const t = readTuning({ env: { DSH_HOME: dir } });
    assert.equal(t.listen.live, false);
    assert.equal(t.listen.silence, LISTEN_DEFAULTS.silence, '9 秒越界 → 退回默认');
    assert.equal(t.listen.pollMs, LISTEN_DEFAULTS.pollMs, '10ms 太小 → 退回默认');
    assert.equal(t.listen.liveMin, 2.4, '范围内的值要生效');
    assert.ok(t.warnings.length >= 2, `应该说清楚哪里错了：${t.warnings.join('/')}`);

    // live 开着时，快照间隔不许大于强切上限（否则一遍都发不出来）
    writeFileSync(p, JSON.stringify({ listen: { live: true, maxSeg: 1.2, liveStep: 2.0 } }));
    const on = readTuning({ env: { DSH_HOME: dir } });
    assert.ok(on.listen.liveStep <= on.listen.maxSeg, 'liveStep 要被收窄到 maxSeg');
    assert.ok(on.warnings.some((w) => w.includes('liveStep')), '收窄要有 warn');

    // 整段缺省 → 全默认
    writeFileSync(p, '{}');
    const d = readTuning({ env: { DSH_HOME: dir } });
    assert.deepEqual(d.listen, LISTEN_DEFAULTS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
