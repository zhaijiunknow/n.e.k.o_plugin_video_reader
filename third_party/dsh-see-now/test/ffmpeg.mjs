/**
 * 测试用 ffmpeg 解析：和生产共用 `resolveFfmpeg()`。
 *
 * 这样 DSH_FFMPEG_PATH / FFMPEG_PATH / DSH_FFMPEG_DIR / DSH_HOME 的优先级
 * 与插件完全一致；本地 bundled ffmpeg 不必手动塞 PATH。
 */
import { execFileSync } from 'node:child_process';
import { resolveFfmpeg } from '../src/binaries.js';

function usable(bin) {
  if (!bin) return false;
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

const resolved = resolveFfmpeg();
export const FFMPEG = usable(resolved.path) ? resolved.path : null;
// 让插件在测试里也用同一个绝对路径：测试常把 DSH_HOME 改成临时目录，
// 如果在 apply 时再 resolve，会丢掉这里找到的 bundled ffmpeg。
if (FFMPEG && !process.env.DSH_FFMPEG_PATH) process.env.DSH_FFMPEG_PATH = FFMPEG;
export function ffmpegOk() { return FFMPEG !== null; }