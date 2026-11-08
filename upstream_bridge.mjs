/** Offline host adapter. All scoring, selection and packing is upstream code. */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPipeline, DEFAULTS } from './third_party/dsh-see-now/src/pipeline.js';

export const SIZES = Object.freeze({
  low: [798, 450], standard: [1050, 600], high: [1260, 720], ultra: [1596, 900],
});

export function createCollector(options, writeSheet) {
  // Upstream explicitly defines queueDepth=0 for offline operation: no eviction.
  const pipeline = createPipeline({ ...options, queueDepth: 0 });
  const sheets = [];
  function drain() {
    let sheet;
    while ((sheet = pipeline.take()) !== null) {
      const filename = `sheet-${String(sheets.length + 1).padStart(4, '0')}.png`;
      writeSheet(filename, sheet.png);
      const { png, wallFrom, wallTo, ...metadata } = sheet;
      sheets.push({ filename, ...metadata, frames: sheet.frames.map(({ wall, ...frame }) => frame) });
    }
  }
  return {
    push(frame) { pipeline.push(frame); drain(); },
    finish() { pipeline.finish(); drain(); return { sheets, stats: pipeline.stats }; },
    get sheetCount() { return sheets.length; },
    get constants() { return pipeline.constants; },
  };
}

export async function decode(job) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js >=20 is required');
  const [width, height] = SIZES[job.quality] ?? SIZES.low;
  const fps = Number(job.fps ?? DEFAULTS.fps);
  if (!Number.isFinite(fps) || fps < 1 || fps > 30
      || !Number.isFinite(job.start) || job.start < 0
      || !Number.isFinite(job.seconds) || job.seconds <= 0 || job.seconds > 600) {
    throw new Error('Invalid video sampling parameters');
  }
  const collector = createCollector({ width, height, fps }, (name, png) => {
    writeFileSync(join(job.output, name), png);
  });
  const args = ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
    '-ss', String(job.start), '-i', job.path, '-t', String(job.seconds),
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=area,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'];
  const child = spawn(job.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Resolve errors rather than leaving a rejection unhandled during stream reads.
  const closed = new Promise((done) => {
    child.once('error', (error) => done({ error }));
    child.once('close', (code) => done({ code }));
  });
  // Drain decoder diagnostics but never leak local paths or media content.
  child.stderr?.resume();
  const frameSize = width * height * 3;
  let frame = Buffer.allocUnsafe(frameSize);
  let filled = 0;
  let scanned = 0;
  let stoppedForBudget = false;
  try {
    if (!child.stdout) throw new Error('FFmpeg could not be started');
    frames: for await (const chunk of child.stdout) {
      let offset = 0;
      while (offset < chunk.length) {
        const size = Math.min(frameSize - filled, chunk.length - offset);
        chunk.copy(frame, filled, offset, offset + size);
        offset += size;
        filled += size;
        if (filled !== frameSize) continue;
        collector.push({ t: job.start + scanned / fps, buf: frame });
        scanned += 1;
        frame = Buffer.allocUnsafe(frameSize); // Upstream retains candidate buffers.
        filled = 0;
        if (collector.sheetCount >= job.max_sheets) {
          stoppedForBudget = true;
          child.kill('SIGKILL');
          break frames;
        }
      }
    }
    const status = await closed;
    if (status.error || (!stoppedForBudget && status.code !== 0) || filled) {
      throw new Error('FFmpeg decoding failed');
    }
    if (!scanned) throw new Error('No video frames decoded');
    // Finish delayed future-frame decisions and pack all remaining frames. The
    // soft sheet budget can be exceeded by this tail; no output is discarded.
    const result = collector.finish();
    if (!result.sheets.length) throw new Error('Upstream pipeline produced no images');
    const provenance = JSON.parse(readFileSync(new URL('./third_party/dsh-see-now/UPSTREAM.json', import.meta.url), 'utf8'));
    return { ...result, frames_scanned: scanned,
      end_seconds: Math.min(job.start + job.seconds, job.start + scanned / fps),
      sheet_limit_reached: stoppedForBudget, upstream_revision: provenance.revision,
      pipeline_options: collector.constants };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const result = await decode(job);
    writeFileSync(join(job.output, 'result.json'), JSON.stringify(result));
  } catch {
    process.stderr.write('Video pipeline failed; check Node.js, FFmpeg and video input.\n');
    process.exitCode = 1;
  }
}
