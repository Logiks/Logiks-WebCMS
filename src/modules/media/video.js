import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Video stills via the `ffmpeg` binary on PATH (optional, like sharp: without it a video still uploads, it just has
 * no thumbnail). Always `execFile` with an argument list — never a shell, and the file name is ours, not the user's.
 */
const run = (args, { binary = false } = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-nostdin', ...args],
      { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' },
      (err, stdout, stderr) =>
        err && !stderr?.length && !stdout?.length ? reject(err) : resolve({ err, stdout, stderr }),
    );
  });

let availableP;
/** Is ffmpeg installed? Checked once per process. */
export const ffmpegAvailable = () =>
  (availableP ??= run(['-version']).then(
    (r) => !r.err,
    () => false,
  ));

/** "Duration: 00:00:12.34" in ffmpeg's banner → seconds (null when it can't tell). */
export const parseDuration = (text) => {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};

/**
 * One still frame (PNG) and the clip's length. `at` is seconds; left out, it picks a moment a tenth of the way in
 * (up to 3 s), which skips the black frame most clips open on.
 * @returns {Promise<{ frame: Buffer, duration: number | null, at: number } | null>} null when ffmpeg isn't there or can't read it
 */
export async function videoStill(buffer, ext, at) {
  if (!(await ffmpegAvailable())) return null;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cms-video-'));
  try {
    const file = path.join(dir, `in.${ext}`);
    await writeFile(file, buffer);
    const info = await run(['-i', file]); // exits non-zero with no output file; the banner on stderr is the answer
    const duration = parseDuration(String(info.stderr ?? ''));
    let t = Number.isFinite(at) && at >= 0 ? at : Math.min(3, (duration ?? 0) / 10);
    if (duration != null && t >= duration) t = Math.max(0, duration - 0.1);
    const shot = (ss) =>
      run(
        [
          '-ss',
          String(ss),
          '-i',
          file,
          '-frames:v',
          '1',
          '-f',
          'image2pipe',
          '-vcodec',
          'png',
          '-',
        ],
        { binary: true },
      );
    let r = await shot(t);
    if (!r.stdout?.length && t > 0) {
      t = 0; // past the last frame or a clip with a broken index: fall back to the first frame
      r = await shot(0);
    }
    if (!r.stdout?.length) return null;
    return { frame: r.stdout, duration, at: t };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
