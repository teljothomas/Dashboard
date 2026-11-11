import { describe, expect, it } from 'vitest';
import { isUuid, isUuidV7, uuidv7, uuidv7Timestamp } from './ids.js';

describe('uuidv7', () => {
  it('has v7 shape and variant bits', () => {
    const id = uuidv7();
    expect(isUuidV7(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19] as string);
  });

  it('embeds the supplied timestamp', () => {
    const t = Date.now() + 5_000_000; // ahead of the process clock so the monotonic guard does not bump it
    const id = uuidv7(t);
    expect(uuidv7Timestamp(id)).toBe(t);
  });

  it('is strictly increasing (string order) across 5,000 calls in the same millisecond', () => {
    const base = Date.now() + 10_000_000;
    const ids = Array.from({ length: 5_000 }, () => uuidv7(base));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(5_000);
  });

  it('is increasing when time advances', () => {
    const base = Date.now() + 20_000_000;
    const a = uuidv7(base);
    const b = uuidv7(base + 1);
    expect(a < b).toBe(true);
  });

  it('never moves backwards if the clock does', () => {
    const base = Date.now() + 30_000_000;
    const a = uuidv7(base);
    const b = uuidv7(base - 1000);
    expect(a < b).toBe(true);
  });
});

describe('validation', () => {
  it('accepts valid v7 and rejects others', () => {
    expect(isUuidV7('0192f6a0-7b3c-7abc-8def-0123456789ab')).toBe(true);
    expect(isUuidV7('0192f6a0-7b3c-4abc-8def-0123456789ab')).toBe(false);
    expect(isUuidV7('0192f6a0-7b3c-7abc-cdef-0123456789ab')).toBe(false);
    expect(isUuidV7('0192F6A0-7B3C-7ABC-8DEF-0123456789AB')).toBe(false);
    expect(isUuidV7('')).toBe(false);
    expect(isUuidV7(42)).toBe(false);
  });

  it('isUuid accepts v4 too', () => {
    expect(isUuid('0192f6a0-7b3c-4abc-8def-0123456789ab')).toBe(true);
    expect(isUuid('xyz')).toBe(false);
  });

  it('uuidv7Timestamp throws on non-v7', () => {
    expect(() => uuidv7Timestamp('0192f6a0-7b3c-4abc-8def-0123456789ab')).toThrow(TypeError);
  });
});
