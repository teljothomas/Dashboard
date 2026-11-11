import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { COMMON_PASSWORDS } from './common-passwords.js';

/** `Algorithm.Argon2id` in @node-rs/argon2 is an ambient const enum (unusable under verbatimModuleSyntax). */
const ARGON2ID = 2 as Algorithm;

/** ADR-051 minimums: Argon2id, m = 19456 KiB, t = 2, p = 1. */
export const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** SECURITY section 2: at least 10 characters, no composition rules, not a common password. */
export const PASSWORD_MIN_LENGTH = 10;
/** Upper bound so a hostile request cannot make hashing expensive. */
export const PASSWORD_MAX_LENGTH = 256;

export type PasswordProblem = 'TOO_SHORT' | 'TOO_LONG' | 'COMMON';

/** Returns the first policy problem, or null when the password is acceptable. */
export function checkPasswordPolicy(password: string): PasswordProblem | null {
  if ([...password].length < PASSWORD_MIN_LENGTH) return 'TOO_SHORT';
  if (password.length > PASSWORD_MAX_LENGTH) return 'TOO_LONG';
  if (COMMON_PASSWORDS.has(password.normalize('NFKC').toLowerCase())) return 'COMMON';
  return null;
}

export const PASSWORD_PROBLEM_MESSAGE: Record<PasswordProblem, string> = {
  TOO_SHORT: `Password must be at least ${String(PASSWORD_MIN_LENGTH)} characters.`,
  TOO_LONG: `Password must be at most ${String(PASSWORD_MAX_LENGTH)} characters.`,
  COMMON: 'Password is too common. Choose a different one.',
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMS);
}

/** Constant-time verify (the library compares in constant time). A malformed hash is a mismatch. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

/** True when the stored hash is not Argon2id or uses weaker parameters than ARGON2_PARAMS. */
export function needsRehash(storedHash: string): boolean {
  const match = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!match) return true;
  const [m, t, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return (
    m < ARGON2_PARAMS.memoryCost || t < ARGON2_PARAMS.timeCost || p < ARGON2_PARAMS.parallelism
  );
}
