import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

const KEY = /^[a-z0-9][a-z0-9/_.-]{0,200}$/;

/**
 * Where uploaded files live. The interface is what a cluster-wide store (S3 and friends) would implement:
 *   put(key, buffer) · stream(key) → Readable · delete(prefix) · exists(key)
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
    stream: (key) => createReadStream(file(key)),
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
