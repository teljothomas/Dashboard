import { describe, expect, it } from 'vitest';
import {
  generateResetCode,
  hashResetCode,
  normalizeResetCode,
  RESET_CODE_LENGTH,
} from './adminUsers.js';

describe('reset code', () => {
  it('is 8 characters from the unambiguous alphabet and not repeated', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const code = generateResetCode();
      expect(code).toHaveLength(RESET_CODE_LENGTH);
      expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{8}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(200);
  });

  it('normalises case, spaces and hyphens', () => {
    expect(normalizeResetCode(' ab3d-ef7h ')).toBe('AB3DEF7H');
  });

  it('hashes per user: the same code for two users differs, and the hash is stable', () => {
    const a = hashResetCode('user-a', 'AB3DEF7H');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashResetCode('user-a', 'AB3DEF7H')).toBe(a);
    expect(hashResetCode('user-b', 'AB3DEF7H')).not.toBe(a);
  });
});
