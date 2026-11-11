/**
 * UUID v7 (RFC 9562, ADR-011): 48-bit unix-ms timestamp, 12-bit monotonic counter, 62 random bits.
 * Works in Node and browsers (uses Web Crypto).
 */
const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_ANY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let lastMs = -1;
let counter = 0;

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Generate a UUID v7. Strictly increasing within one process, even in the same millisecond. */
export function uuidv7(now: number = Date.now()): string {
  let ms = Math.floor(now);
  if (ms > lastMs) {
    lastMs = ms;
    // Seed with 11 random bits so the 12-bit counter has headroom within the millisecond.
    const seed = randomBytes(2);
    counter = (((seed[0] ?? 0) << 8) | (seed[1] ?? 0)) & 0x7ff;
  } else {
    counter += 1;
    if (counter > 0xfff) {
      lastMs += 1;
      counter = 0;
    }
    ms = lastMs;
  }

  const bytes = randomBytes(16);
  // 48-bit timestamp (big-endian). Use arithmetic: bit shifts truncate at 32 bits.
  let t = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7_REGEX.test(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_ANY_REGEX.test(value);
}

/** Milliseconds since epoch encoded in a UUID v7. Throws if not v7. */
export function uuidv7Timestamp(id: string): number {
  if (!isUuidV7(id)) {
    throw new TypeError(`Not a UUID v7: ${JSON.stringify(id)}`);
  }
  return Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}
