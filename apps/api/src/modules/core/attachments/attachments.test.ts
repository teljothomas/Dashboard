import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.js';
import { AppError } from '../../../errors.js';
import { testConfig } from '../../../test-config.js';
import { createDummyDatabase } from '../../../../test/dummyDb.js';
import { contentDisposition } from './routes.js';
import { processUpload, sanitizeFilename, sniffType } from './sniff.js';
import { LocalFsStorage, storageKeyFor } from './storage.js';

const SHA = createHash('sha256').update('x').digest('hex');

async function streamToBuffer(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('LocalFsStorage', () => {
  let root: string;
  let storage: LocalFsStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tradex-att-'));
    storage = new LocalFsStorage(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('shards keys by sha256 prefix', () => {
    expect(storageKeyFor(SHA)).toBe(`${SHA.slice(0, 2)}/${SHA.slice(2, 4)}/${SHA}`);
    expect(() => storageKeyFor('ABC')).toThrow();
  });

  it('round-trips bytes and leaves no temp files behind', async () => {
    const key = storageKeyFor(SHA);
    await storage.put(key, Buffer.from('hello'));
    expect(await storage.exists(key)).toBe(true);
    expect((await streamToBuffer(await storage.open(key))).toString()).toBe('hello');
    expect(await readdir(join(root, '.tmp'))).toEqual([]);
  });

  it('put is idempotent and keeps the first bytes', async () => {
    const key = storageKeyFor(SHA);
    await storage.put(key, Buffer.from('first'));
    await storage.put(key, Buffer.from('second'));
    expect((await streamToBuffer(await storage.open(key))).toString()).toBe('first');
  });

  it('rejects keys that could leave the root', async () => {
    for (const key of ['../../etc/passwd', `${SHA}`, 'ab/cd/../../x', `ab/cd/${SHA}/x`, '']) {
      await expect(storage.put(key, Buffer.from('x'))).rejects.toThrow('invalid storage key');
      await expect(storage.open(key)).rejects.toThrow('invalid storage key');
    }
  });

  it('open rejects for a missing key and exists is false', async () => {
    const key = storageKeyFor(SHA);
    expect(await storage.exists(key)).toBe(false);
    await expect(storage.open(key)).rejects.toThrow();
  });
});

describe('sniffType', () => {
  it('detects by magic bytes only', () => {
    expect(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
      'image/png',
    );
    expect(sniffType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
  });

  it('rejects everything else', () => {
    expect(sniffType(Buffer.from('GIF89a'))).toBeUndefined();
    expect(sniffType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(sniffType(Buffer.from('<html><script>alert(1)</script>'))).toBeUndefined();
    expect(sniffType(Buffer.from('PK\x03\x04'))).toBeUndefined();
    expect(sniffType(Buffer.from('MZ\x90\x00'))).toBeUndefined();
    expect(sniffType(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBeUndefined();
    expect(sniffType(Buffer.alloc(0))).toBeUndefined();
    // Leading whitespace or a BOM before %PDF- is not tolerated.
    expect(sniffType(Buffer.from('  %PDF-1.7'))).toBeUndefined();
  });
});

const PDF_OK = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF\n');

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
}

describe('processUpload', () => {
  it('accepts a PDF unchanged and hashes the stored bytes', async () => {
    const out = await processUpload(PDF_OK);
    expect(out.mime).toBe('application/pdf');
    expect(out.data.equals(PDF_OK)).toBe(true);
    expect(out.sha256).toBe(createHash('sha256').update(PDF_OK).digest('hex'));
  });

  it('rejects PDFs with appended payloads or active content', async () => {
    await expectCode(
      processUpload(Buffer.concat([PDF_OK, Buffer.from('<html><script>alert(1)</script></html>')])),
      'UNSUPPORTED_MEDIA',
    );
    await expectCode(processUpload(Buffer.from('%PDF-1.4\nno end marker')), 'UNSUPPORTED_MEDIA');
    await expectCode(
      processUpload(
        Buffer.from('%PDF-1.4\n1 0 obj<</S/JavaScript/JS(app.alert(1))>>endobj\n%%EOF\n'),
      ),
      'UNSUPPORTED_MEDIA',
    );
    await expectCode(
      processUpload(Buffer.from('%PDF-1.4\n1 0 obj<</Type/EmbeddedFile>>endobj\n%%EOF')),
      'UNSUPPORTED_MEDIA',
    );
  });

  it('rejects empty, unknown and undecodable input', async () => {
    await expectCode(processUpload(Buffer.alloc(0)), 'VALIDATION_FAILED');
    await expectCode(processUpload(Buffer.from('plain text')), 'UNSUPPORTED_MEDIA');
    // JPEG magic but not an image.
    await expectCode(
      processUpload(
        Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('<script>')]),
      ),
      'UNSUPPORTED_MEDIA',
    );
  });

  it('re-encodes images, dropping appended bytes and metadata', async () => {
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#336699' },
    })
      .jpeg()
      .toBuffer();
    const polyglot = Buffer.concat([jpeg, Buffer.from('<html><script>alert(1)</script></html>')]);
    const out = await processUpload(polyglot);
    expect(out.mime).toBe('image/jpeg');
    expect(out.data.includes(Buffer.from('<script>'))).toBe(false);
    expect((await sharp(out.data).metadata()).format).toBe('jpeg');
  });
});

describe('sanitizeFilename / contentDisposition', () => {
  it('keeps only a display name', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\x\\bill.pdf')).toBe('bill.pdf');
    expect(sanitizeFilename('a\u0000b\nc.png')).toBe('abc.png');
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename(undefined)).toBe('file');
    expect(sanitizeFilename('x'.repeat(400))).toHaveLength(255);
  });

  it('builds a header-safe Content-Disposition', () => {
    const header = contentDisposition('attachment', 'Rechnung "Müller"\'s.pdf');
    expect(header).toBe(
      `attachment; filename="Rechnung _M_ller_'s.pdf"; filename*=UTF-8''Rechnung%20%22M%C3%BCller%22%27s.pdf`,
    );
    expect(header).not.toMatch(/[\r\n]/);
  });
});

describe('production wiring without a request-context provider', () => {
  it('answers 401 on both attachment routes (auth arrives in WP-04.3)', async () => {
    const app = buildApp(testConfig, { db: createDummyDatabase() });
    try {
      const get = await app.inject({
        method: 'GET',
        url: '/api/v1/attachments/01930000-0000-7000-8000-0000000000ff',
      });
      expect(get.statusCode).toBe(401);
      const post = await app.inject({
        method: 'POST',
        url: '/api/v1/attachments',
        headers: { 'content-type': 'multipart/form-data; boundary=x' },
        payload: '--x--\r\n',
      });
      expect(post.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
