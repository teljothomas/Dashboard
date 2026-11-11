import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';

/** Where attachment bytes live. The database only stores the key. */
export interface StorageAdapter {
  /** Store `data` under `key`. Idempotent: the key is the content hash, so a second put is a no-op. */
  put(key: string, data: Buffer): Promise<void>;
  /** Stream the bytes for `key`. Rejects when the key is unknown. */
  open(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
}

/** `ab/cd/<64 hex>`: two shard levels from the sha256 prefix, then the full hash. */
const KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

/** Storage key for a sha256 hex digest. */
export function storageKeyFor(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('storage key requires a lowercase sha256 hex digest');
  }
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

/**
 * Filesystem storage under one root directory (ATTACHMENTS_DIR), outside any web root. Keys are
 * validated against a fixed pattern, so a key can never address a path outside the root.
 */
export class LocalFsStorage implements StorageAdapter {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    if (!KEY_PATTERN.test(key)) {
      throw new Error('invalid storage key');
    }
    return join(this.root, ...key.split('/'));
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.pathFor(key);
    if (await this.exists(key)) {
      return;
    }
    await mkdir(dirname(target), { recursive: true });
    // Write to a temp file in the same filesystem, flush, then rename: readers see the whole
    // file or none of it, even if the process dies mid-write.
    const tmpDir = join(this.root, '.tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, randomUUID());
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(tmp, target);
      } catch (err) {
        // Two writers of the same content race on rename (EPERM/EBUSY on Windows). Same key means
        // same bytes, so if the target now exists the other writer won and that is a success.
        if (!(await this.exists(key))) {
          throw err;
        }
      }
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async open(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    // stat first so a missing file rejects here instead of as a stream error mid-response.
    await stat(path);
    return createReadStream(path);
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(key))).isFile();
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }
}
