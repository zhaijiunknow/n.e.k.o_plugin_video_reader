/**
 * listen.test.mjs — 听声音这条链里**不依赖真设备**的部分。
 *
 * 真抓回环、真转写要一台有声卡的机器（还得有人在放视频），那是 `scripts/` 里的手工探针。
 * 这里守三件容易悄悄坏掉的事：
 *   ① WAV 头必须改成宿主认的 44 字节形式（data 在偏移 36）—— 错一个字节宿主就整段拒收；
 *   ② 台词按时间窗取，跨窗的要给、超长的要从旧往新丢；
 *   ③ 没有转写服务时**必须返回 null**，不能假装能用（否则会起一个永远转不出字的进程）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { canonicalizeWav, createLineBuffer, resolveTranscriber, asrConfig } from '../src/listen.js';

/** 拼一个 WAV：`opts.list` 模拟 ffmpeg 那个 `LIST/INFO`，`opts.stream` 模拟管道写的 0xFFFFFFFF。 */
function makeWav(pcmBytes = 320, { list = false, stream = false } = {}) {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);        // PCM
  fmt.writeUInt16LE(1, 2);        // mono
  fmt.writeUInt32LE(16_000, 4);
  fmt.writeUInt32LE(32_000, 8);   // byteRate
  fmt.writeUInt16LE(2, 12);       // blockAlign
  fmt.writeUInt16LE(16, 14);      // bits
  const pcm = Buffer.alloc(pcmBytes, 7);
  const listChunk = list ? Buffer.concat([Buffer.from('LIST', 'latin1'), Buffer.from([10, 0, 0, 0]), Buffer.alloc(10)]) : Buffer.alloc(0);
  const total = 12 + 8 + 16 + listChunk.length + 8 + pcm.length;
  const out = Buffer.alloc(total);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(stream ? 0xFFFFFFFF : total - 8, 4);
  out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(16, 16);
  fmt.copy(out, 20);
  let p = 36;
  listChunk.copy(out, p);
  p += listChunk.length;
  out.write('data', p, 'latin1');
  out.writeUInt32LE(stream ? 0xFFFFFFFF : pcm.length, p + 4);
  pcm.copy(out, p + 8);
  return out;
}

test('canonicalizeWav：ffmpeg 的 LIST 块会被削掉，data 回到偏移 36', () => {
  const src = makeWav(320, { list: true });
  assert.notEqual(src.toString('latin1', 36, 40), 'data', '前提：原文件的 data 不在 36');
  const out = canonicalizeWav(src);
  assert.equal(out.length, 44 + 320);
  assert.equal(out.toString('latin1', 0, 4), 'RIFF');
  assert.equal(out.toString('latin1', 8, 12), 'WAVE');
  assert.equal(out.toString('latin1', 36, 40), 'data');
  assert.equal(out.readUInt32LE(4), out.length - 8, 'RIFF size 必须是 len-8');
  assert.equal(out.readUInt32LE(40), 320, 'data size 必须是 payload 长度');
  assert.equal(out.readUInt32LE(16), 16, 'fmt 块固定 16 字节');
  assert.equal(out.readUInt32LE(24), 16_000, '采样率要原样保留');
});

test('canonicalizeWav：管道写的 0xFFFFFFFF 长度也能认（读到哪算哪）', () => {
  const src = makeWav(320, { stream: true });
  const out = canonicalizeWav(src);
  assert.equal(out.length, 44 + 320);
  assert.equal(out.readUInt32LE(40), 320);
});

test('canonicalizeWav：不是 WAV 就明确报错，不要静默返回空', () => {
  assert.throws(() => canonicalizeWav(Buffer.alloc(100)), /RIFF|WAVE/);
});

test('台词缓冲：窗口按相交取，跨窗的那句两头都给', () => {
  const b = createLineBuffer();
  b.add(0, 1_000, '第一句');
  b.add(1_000, 2_000, '第二句');
  b.add(2_000, 3_000, '第三句');
  // [900, 2100] 与一、二、三都相交
  assert.deepEqual(b.between(900, 2_100).map((l) => l.text), ['第一句', '第二句', '第三句']);
  // [2_100, 4_000] 只和第三句相交
  assert.deepEqual(b.between(2_100, 4_000).map((l) => l.text), ['第三句']);
  // 完全错开
  assert.deepEqual(b.between(9_000, 10_000), []);
});

test('台词缓冲：超长时从旧往新丢，最近的留下', () => {
  const b = createLineBuffer();
  for (let i = 0; i < 10; i += 1) b.add(i * 1_000, i * 1_000 + 900, `第${i}句十个字`);
  const got = b.between(0, 20_000, { maxChars: 30 });
  assert.ok(got.length >= 1);
  assert.ok(got.every((l) => l.text.startsWith('第9') || l.text.startsWith('第8') || l.text.startsWith('第7')),
    `应该只留最新的几句，实际：${got.map((l) => l.text).join('/')}`);
  assert.equal(got[got.length - 1].text, '第9句十个字', '最后一句必须是新的');
});

test('台词缓冲：reset 之后取不到上一轮的句子（#39 采集重启）', () => {
  const b = createLineBuffer();
  b.add(0, 1_000, '上一轮说的话');
  assert.equal(b.size, 1);
  b.reset();
  assert.equal(b.size, 0);
  // 新一轮的窗口往回看 20 秒，也不该把旧的捞回来
  assert.deepEqual(b.between(-20_000, 60_000), []);
});

test('台词缓冲：空文本不进缓冲（ASR 对纯静音会吐空/标点）', () => {
  const b = createLineBuffer();
  b.add(0, 1_000, '   ');
  b.add(0, 1_000, '');
  assert.equal(b.size, 0);
});

test('asrConfig / resolveTranscriber：没有配置也没有宿主就返回 null', () => {
  const home = mkdtempSync(join(tmpdir(), 'see-listen-'));
  try {
    const env = { ...process.env, DSH_HOME: home, DSH_ASR_BASE_URL: '', DSH_ASR_KEY: '' };
    delete env.DSH_ASR_BASE_URL;
    delete env.DSH_ASR_KEY;
    assert.equal(asrConfig(env), null);
    assert.equal(resolveTranscriber(null, { env }), null, '没服务时必须 null，不能造一个假的');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('asrConfig：读 ~/.dsh/asr.json（和 storyboard 共用同一份）', () => {
  const home = mkdtempSync(join(tmpdir(), 'see-listen-'));
  try {
    writeFileSync(join(home, 'asr.json'), JSON.stringify({
      baseUrl: 'http://127.0.0.1:8000/v1/', key: 'k', model: 'm1',
    }));
    const env = { ...process.env, DSH_HOME: home };
    delete env.DSH_ASR_BASE_URL;
    const cfg = asrConfig(env);
    assert.equal(cfg.baseUrl, 'http://127.0.0.1:8000/v1', '末尾斜杠要去掉');
    assert.equal(cfg.model, 'm1');
    const t = resolveTranscriber(null, { env });
    assert.equal(t?.kind, 'http');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('resolveTranscriber：宿主有 speechToText 时优先用它（社区用户零安装那条路）', () => {
  const ctx = {
    get(name) {
      if (name !== 'speechToText') return undefined;
      return {
        resolve: (a) => ({ kind: 'speech', ...a }),
        transcribe: async () => ({ text: '宿主转出来的' }),
      };
    },
  };
  const t = resolveTranscriber(ctx, { env: { ...process.env, DSH_HOME: mkdtempSync(join(tmpdir(), 'x-')) } });
  assert.equal(t?.kind, 'host');
  assert.match(t.label, /宿主/);
});

test('createListener：没有转写服务时 start() 返回失败原因，且不抛', async () => {
  const home = mkdtempSync(join(tmpdir(), 'see-listen-'));
  try {
    const { createListener } = await import('../src/listen.js');
    const env = { ...process.env, DSH_HOME: home };
    delete env.DSH_ASR_BASE_URL;
    const l = createListener({ ctx: null, env, log: () => {} });
    const r = await l.start();
    assert.equal(r.ok, false);
    assert.match(r.reason, /转写服务|speechToText/);
    assert.equal(l.state().enabled, false);
    assert.deepEqual(l.between(0, Date.now()), []);
    // 目录不该被凭空创建
    assert.equal(l.state().lines, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('createListener：DSH_SEE_AUDIO=0 直接关掉（用户手动禁用）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'see-listen-'));
  try {
    mkdirSync(join(home, 'see-now'), { recursive: true });
    writeFileSync(join(home, 'asr.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1' }));
    const { createListener } = await import('../src/listen.js');
    const l = createListener({ ctx: null, env: { ...process.env, DSH_HOME: home, DSH_SEE_AUDIO: '0' }, log: () => {} });
    const r = await l.start();
    assert.equal(r.ok, false);
    assert.match(r.reason, /DSH_SEE_AUDIO/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('linesText：台词挂到 sheet 上时用「和帧同一个坐标系」的相对秒', async () => {
  const { linesText } = await import('../src/index.js');
  // 帧 t=10.0s、wall=1_700_000_010_000 → t=0 那一刻是 1_700_000_000_000
  const sheet = {
    frames: [{ t: 10, wall: 1_700_000_010_000 }],
    lines: [
      { t0: 1_700_000_002_000, t1: 1_700_000_004_000, text: '第一句' },
      { t0: 1_700_000_012_400, t1: 1_700_000_014_000, text: '第二句' },
    ],
  };
  const t = linesText(sheet);
  assert.match(t, /台词/);
  assert.match(t, /2\.0s\s+第一句/, `实际：${t}`);
  assert.match(t, /12\.4s\s+第二句/, `实际：${t}`);
});

test('linesText：没有台词就一个字都不加（不能凭空来一行空的"台词："）', async () => {
  const { linesText } = await import('../src/index.js');
  assert.equal(linesText({ frames: [] }), '');
  assert.equal(linesText({ frames: [{ t: 1, wall: 0 }], lines: [] }), '');
});

test('markSpeaking：写静音窗口，且时长随文本变长（宁可多静音也别听见自己）', async () => {
  const { markSpeaking, quietFile } = await import('../src/listen.js');
  const home = mkdtempSync(join(tmpdir(), 'see-quiet-'));
  try {
    const env = { ...process.env, DSH_HOME: home };
    delete env.DSH_QUIET_FILE;
    const before = Date.now();
    const short = markSpeaking('嗯。', { env });
    const long = markSpeaking('这句话明显要长很多，因为模型说了一大段话，还要慢慢念完。', { env });
    assert.ok(short > before, '要在未来');
    assert.ok(long - short > 2000, `长句的窗口必须明显更长（short=${short} long=${long}）`);
    const raw = JSON.parse(readFileSync(quietFile(env), 'utf8'));
    assert.equal(raw.until, long);
    assert.equal(raw.by, 'see-now');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('markSpeaking：适配器给了真实时长就按它算，不再按字数猜（issue #33）', async () => {
  const { markSpeaking, quietFile } = await import('../src/listen.js');
  const home = mkdtempSync(join(tmpdir(), 'see-quiet-'));
  try {
    const env = { ...process.env, DSH_HOME: home };
    delete env.DSH_QUIET_FILE;
    const text = '这句话字数不少，按字数估算会被拉得很长很长很长很长很长。';

    const guessed = markSpeaking(text, { env });
    const real = markSpeaking(text, { env, durationMs: 1500 });
    assert.ok(real < guessed,
      `真实 1.5 秒就该按 2.7 秒算，不比字数估算长（guessed=${guessed - Date.now()} real=${real - Date.now()}）—— 快 TTS 多聋几秒就是这里`);

    const raw = JSON.parse(readFileSync(quietFile(env), 'utf8'));
    assert.equal(raw.durationMs, 1500, '文件里要留下这次是按真实时长算的痕迹');
    assert.equal(raw.until, real);

    // 慢 TTS：字数估的那种"短窗口"被真实时长直接顶掉 —— 正是自激的修法
    const shorter = markSpeaking('嗯。', { env });
    const longer = markSpeaking('嗯。', { env, durationMs: 30000 });
    assert.ok(longer - shorter > 20000, '慢 TTS 出声那一刻要把窗口延到它真正念完');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('markSpeaking：只有时长没有文本也能占窗口（适配器只报了音频）', async () => {
  const { markSpeaking } = await import('../src/listen.js');
  const home = mkdtempSync(join(tmpdir(), 'see-quiet-'));
  try {
    const env = { ...process.env, DSH_HOME: home };
    delete env.DSH_QUIET_FILE;
    const until = markSpeaking('', { env, durationMs: 2000 });
    assert.ok(until > Date.now(), '有真实音频就该静音，文本是给日志看的');
    assert.equal(markSpeaking('', { env }), null, '什么都没有才不占窗口');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('markSpeaking：空文本不占窗口（否则一次空 say 会白静音两秒）', async () => {
  const { markSpeaking, quietFile } = await import('../src/listen.js');
  const home = mkdtempSync(join(tmpdir(), 'see-quiet-'));
  try {
    const env = { ...process.env, DSH_HOME: home };
    delete env.DSH_QUIET_FILE;
    assert.equal(markSpeaking('   ', { env }), null);
    assert.equal(existsSync(quietFile(env)), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('quietFile：默认和陪看共用同一个路径（麦克风那条也靠它）', async () => {
  const { quietFile } = await import('../src/listen.js');
  const env = { ...process.env, DSH_HOME: 'C:/fake-home' };
  delete env.DSH_QUIET_FILE;
  assert.equal(quietFile(env).replace(/\\/g, '/'), 'C:/fake-home/watch/out/quiet-until.json');
});

test('addAudioStrip：图变高 stripH，切点刻度画在对应的 x 上', async () => {
  const { addAudioStrip, stripHeight } = await import('../src/sheet.js');
  const w = 800; const h = 450;
  const img = { buffer: Buffer.alloc(w * h * 3, 10), width: w, height: h };
  const db = Array.from({ length: 100 }, (_, i) => (i < 50 ? -60 : -20));  // 前半静音后半有声
  const out = addAudioStrip(img, {
    loudness: { step: 0.1, db }, cuts: [5], window: { from: 0, to: 10 },
  });
  const stripH = stripHeight(w, h);
  assert.equal(out.height, h + stripH);
  assert.equal(out.height, 450 + 12, '450 高只占 11 行、余 12px，条就用这 12px');
  assert.equal(out.buffer.length, w * (h + stripH) * 3);

  // 切点 5s 在窗口 [0,10] 的中点 → x ≈ 400，顶上那几行是黄的
  const x = Math.round((5 / 10) * (w - 1));
  const at = (px, py) => {
    const i = (py * w + px) * 3;
    return [out.buffer[i], out.buffer[i + 1], out.buffer[i + 2]];
  };
  assert.deepEqual(at(x, h + 2), [255, 235, 59], '切点刻度必须是黄色');
  // 没有切点的地方不能也是黄的
  assert.notDeepEqual(at(x + 20, h + 2), [255, 235, 59]);
});

test('addAudioStrip：没有响度数据也能只画刻度（不能因此不出图）', async () => {
  const { addAudioStrip } = await import('../src/sheet.js');
  const img = { buffer: Buffer.alloc(800 * 450 * 3, 10), width: 800, height: 450 };
  const out = addAudioStrip(img, { cuts: [1, 9], window: { from: 0, to: 10 } });
  assert.equal(out.height, 462);
});

test('levelsBetween：按时间窗切片，窗口外/没数据填 -120dB', async () => {
  const { createListener } = await import('../src/listen.js');
  const dir = mkdtempSync(join(tmpdir(), 'see-levels-'));
  try {
    // 10 秒、0.1 秒一格；只有前 5 秒有声音
    const db = Array.from({ length: 100 }, (_, i) => (i < 50 ? -20 : -120));
    writeFileSync(join(dir, 'levels.json'), JSON.stringify({ step: 0.1, from: 1_000_000, db }));
    const l = createListener({ dir, env: { ...process.env, DSH_HOME: dir }, log: () => {} });
    const got = l.levelsBetween(1_000_000, 1_010_000);
    assert.ok(got, '应该有数据');
    assert.equal(got.db.length, 100, '长度 = 时长 / step');
    assert.equal(got.db[0], -20);
    assert.equal(got.db[99], -120, '后半段没声音，必须是 -120 而不是断掉');
    // 完全在数据之外的窗口 → 全 -120，但不能返回 null
    const far = l.levelsBetween(1_100_000, 1_110_000);
    assert.ok(far.db.every((v) => v === -120));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('linesText：台词同时给本机时钟和相对秒', async () => {
  const { linesText } = await import('../src/index.js');
  const t0 = 1_700_000_000_000;
  const sheet = {
    frames: [{ t: 10, wall: t0 + 10_000 }],
    lines: [{ t0: t0 + 2_000, t1: t0 + 4_000, text: '第一句' }],
  };
  const out = linesText(sheet);
  assert.match(out, /\d{2}:\d{2}:\d{2}/, `要有本机时钟，实际：${out}`);
  assert.match(out, /2\.0s/, `要有相对秒，实际：${out}`);
  assert.match(out, /第一句/);
});

test('httpTranscriber：服务不在时必须抛错，不能静默返回空串', async () => {
  const { httpTranscriber } = await import('../src/listen.js');
  // 端口 9 是 discard 服务，本机不会有人监听 → 连接被拒
  const t = httpTranscriber({ baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }, { timeoutMs: 2000, log: () => {} });
  // **这是 2026-11-04 那次"看不到字幕"的根因**：以前 catch 里 return ''，
  // 于是上层只当"这段没人说话"，失败计数永远 0、status 永远显示"在听"。
  await assert.rejects(() => t(Buffer.alloc(2048)), Error);
});

test('probeService：没人监听就 false，不抛', async () => {
  const { probeService } = await import('../src/listen.js');
  assert.equal(await probeService('http://127.0.0.1:9/v1', { timeoutMs: 800 }), false);
});

test('ensureService：asr.json 没写 manage.start 就老实返回不托管', async () => {
  const { ensureService } = await import('../src/listen.js');
  const r = await ensureService({ baseUrl: 'http://127.0.0.1:9/v1' }, { log: () => {}, waitMs: 500 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /manage\.start/);
});

test('linesText：每句台词标注最接近的帧号', async () => {
  const { linesText } = await import('../src/index.js');
  const t0 = 1_700_000_000_000;
  const sheet = {
    frames: [{ t: 0, wall: t0 }, { t: 10, wall: t0 + 10_000 }, { t: 20, wall: t0 + 20_000 }],
    lines: [
      { t0: t0 + 2_000, t1: t0 + 4_000, text: '第一句' },
      { t0: t0 + 12_000, t1: t0 + 14_000, text: '第二句' },
      { t0: t0 + 25_000, t1: t0 + 26_000, text: '最后一句' },
    ],
  };
  const out = linesText(sheet);
  assert.match(out, /#1\s/, '第一句归第 1 格');
  assert.match(out, /#2\s/, '第二句归第 2 格');
  assert.match(out, /#3\s/, '超出最后一帧的归最后一格');
  assert.match(out, /#1\s+\d{2}:\d{2}:\d{2} \/ 2\.0s\s+第一句/);
  assert.match(out, /#2\s+\d{2}:\d{2}:\d{2} \/ 12\.0s\s+第二句/);
});
