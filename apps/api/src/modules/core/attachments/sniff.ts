import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { AppError } from '../../../errors.js';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Decode guard against decompression bombs (a small file declaring a huge canvas). */
const MAX_INPUT_PIXELS = 50_000_000;

export type AttachmentMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

export interface ProcessedUpload {
  mime: AttachmentMime;
  /** Bytes to store: re-encoded for images, original for PDF. */
  data: Buffer;
  /** sha256 hex of `data`. */
  sha256: string;
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buf: Buffer, magic: number[]): boolean {
  return buf.length >= magic.length && magic.every((byte, i) => buf[i] === byte);
}

/** Type from the leading bytes only. The client's filename and Content-Type are never consulted. */
export function sniffType(buf: Buffer): AttachmentMime | undefined {
  if (startsWith(buf, JPEG_MAGIC)) return 'image/jpeg';
  if (startsWith(buf, PNG_MAGIC)) return 'image/png';
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return undefined;
}

function unsupported(reason: string): AppError {
  return new AppError('UNSUPPORTED_MEDIA', 'File type is not allowed', { reason });
}

/** Active-content markers. Best effort on raw bytes (compressed object streams can hide them). */
const PDF_ACTIVE_CONTENT = /\/(?:JavaScript|JS|Launch|EmbeddedFile|RichMedia)(?![A-Za-z])/;

/**
 * A PDF is stored as is (it cannot be re-encoded), so it must look like one whole PDF: header at
 * byte 0, `%%EOF` marker within the last KiB (nothing appended after it, which is how PDF/HTML or
 * PDF/ZIP polyglots are built), and no script or embedded-file markers. Downloads are additionally
 * forced to `Content-Disposition: attachment` with `nosniff`.
 */
function checkPdf(buf: Buffer): void {
  const tail = buf.subarray(Math.max(0, buf.length - 1024)).toString('latin1');
  const eof = tail.lastIndexOf('%%EOF');
  if (eof === -1 || tail.slice(eof + 5).trim().length > 0) {
    throw unsupported('pdf-structure');
  }
  if (PDF_ACTIVE_CONTENT.test(buf.toString('latin1'))) {
    throw unsupported('pdf-active-content');
  }
}

async function reencodeImage(buf: Buffer, mime: AttachmentMime): Promise<Buffer> {
  const expected = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }[
    mime as string
  ];
  try {
    const image = sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
    const meta = await image.metadata();
    if (meta.format !== expected) {
      throw unsupported('image-format-mismatch');
    }
    // rotate() applies the EXIF orientation to the pixels first. sharp then drops every metadata
    // block (EXIF incl. GPS, XMP, IPTC, ICC) unless asked to keep it; anything appended after the
    // image data is dropped because only decoded pixels are written back.
    const pipeline = image.rotate();
    if (mime === 'image/jpeg') return await pipeline.jpeg({ quality: 90 }).toBuffer();
    if (mime === 'image/png') return await pipeline.png().toBuffer();
    return await pipeline.webp({ quality: 90 }).toBuffer();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unsupported('image-decode-failed');
  }
}

/**
 * Validate an upload by content and return the bytes to store. Throws `UNSUPPORTED_MEDIA` (415)
 * for unknown, malformed or active content, `VALIDATION_FAILED` (400) for an empty file.
 */
export async function processUpload(input: Buffer): Promise<ProcessedUpload> {
  if (input.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'File is empty', { reason: 'empty-file' });
  }
  const mime = sniffType(input);
  if (!mime) {
    throw unsupported('unknown-type');
  }
  let data = input;
  if (mime === 'application/pdf') {
    checkPdf(input);
  } else {
    data = await reencodeImage(input, mime);
  }
  if (data.length > MAX_ATTACHMENT_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', 'File is too large', {
      maxBytes: MAX_ATTACHMENT_BYTES,
    });
  }
  return { mime, data, sha256: createHash('sha256').update(data).digest('hex') };
}

/** Display name only: never a path. Strips directories, control characters and over-long names. */
export function sanitizeFilename(raw: string | undefined): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.length === 0 ? 'file' : cleaned.slice(0, 255);
}
