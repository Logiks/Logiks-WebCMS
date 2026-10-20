let sharpP;
const loadSharp = () => (sharpP ??= import('sharp').then((m) => m.default).catch(() => null));

/**
 * How different two screenshots look, 0..1 (the share of the page whose brightness moved noticeably), or null when the
 * image library is not installed. Both are shrunk first, so a changed pixel of anti-aliasing is not a change.
 * @param {Buffer} a @param {Buffer} b
 */
export async function compareImages(a, b) {
  const sharp = await loadSharp();
  if (!sharp) return null;
  const small = (buf) =>
    sharp(buf).resize(160, 110, { fit: 'fill' }).greyscale().blur(0.6).raw().toBuffer();
  const [x, y] = await Promise.all([small(a), small(b)]);
  let changed = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) > 40) changed++;
  return changed / x.length;
}
