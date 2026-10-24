import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const KEY = /^[a-z0-9][a-z0-9/_.-]{0,200}$/;

/**
 * Where uploaded files live. The interface is what a cluster-wide store (S3 and friends) would implement:
 *   put(key, buffer) · putStream(key, readable) → bytes · stream(key, {start?, end?}) → Readable · size(key) · delete(prefix) · exists(key)
 * `localPath(key)` exists only on adapters that keep files on this server's disk; callers that need random access to a
 * large file (the backup restore) use it, and otherwise copy the file to a temporary one first.
 * The local adapter writes under MEDIA_DIR. In a cluster that folder must be a shared volume (EFS, NFS) so every
 * server can read what any server wrote; a single server can leave it alone. Keys are validated so a caller can never
 * reach outside the folder.
 *
 * @param {string} root
 */
export function createLocalStorage(root) {
  const base = path.resolve(root);
  const file = (key) => {
    if (!KEY.test(key) || key.includes('..')) throw new Error(`Bad storage key "${key}"`);
    return path.join(base, key);
  };
  return {
    kind: 'local',
    root: base,
    async put(key, buffer) {
      const f = file(key);
      await fs.mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      await fs.writeFile(tmp, buffer);
      await fs.rename(tmp, f); // readers never see a half-written file
    },
    /** Write a stream to a key without holding it in memory. Nothing appears under the key until it is complete. */
    async putStream(key, readable) {
      const f = file(key);
      await fs.mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      let bytes = 0;
      const count = new Transform({
        transform(chunk, _enc, cb) {
          bytes += chunk.length;
          cb(null, chunk);
        },
      });
      try {
        await pipeline(readable, count, createWriteStream(tmp));
        await fs.rename(tmp, f);
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
      return bytes;
    },
    localPath: (key) => file(key),
    stream: (key, range) => createReadStream(file(key), range),
    async size(key) {
      return (await fs.stat(file(key))).size;
    },
    async exists(key) {
      try {
        await fs.access(file(key));
        return true;
      } catch {
        return false;
      }
    },
    /** Delete a key, or everything under a "folder" key. */
    async delete(key) {
      await fs.rm(file(key), { recursive: true, force: true });
    },
  };
}
