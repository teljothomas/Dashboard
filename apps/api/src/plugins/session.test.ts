import { describe, expect, it } from 'vitest';
import {
  csrfTokenFor,
  hashToken,
  isWellFormedToken,
  newSessionToken,
  safeEqual,
} from '../modules/identity/sessions.js';
import { SlidingWindowLimiter } from './rateLimit.js';
import { clearedSessionCookie, readCookie, sessionCookie, sessionCookieName } from './session.js';

describe('SlidingWindowLimiter', () => {
  it('allows max hits, then answers the wait until the oldest leaves the window', () => {
    let now = 1_000_000;
    const limiter = new SlidingWindowLimiter(3, 60_000, () => now);
    expect(limiter.consume('a')).toBe(0);
    now += 10_000;
    expect(limiter.consume('a')).toBe(0);
    now += 10_000;
    expect(limiter.consume('a')).toBe(0);
    now += 10_000;
    expect(limiter.consume('a')).toBe(30);
    expect(limiter.peek('a')).toBe(30);
    // The rejected hit is not recorded: after the first hit expires there is room again.
    now += 30_000;
    expect(limiter.consume('a')).toBe(0);
  });

  it('keeps keys independent and reset clears one key', () => {
    const limiter = new SlidingWindowLimiter(1, 60_000, () => 0);
    expect(limiter.consume('a')).toBe(0);
    expect(limiter.consume('b')).toBe(0);
    expect(limiter.consume('a')).toBeGreaterThan(0);
    limiter.reset('a');
    expect(limiter.consume('a')).toBe(0);
  });

  it('peek never records', () => {
    const limiter = new SlidingWindowLimiter(1, 60_000, () => 0);
    expect(limiter.peek('a')).toBe(0);
    expect(limiter.peek('a')).toBe(0);
    expect(limiter.consume('a')).toBe(0);
    expect(limiter.peek('a')).toBeGreaterThan(0);
  });
});

describe('session tokens', () => {
  it('generates 256-bit base64url tokens and stores only the sha256 hex', () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(isWellFormedToken(a.token)).toBe(true);
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.tokenHash).toBe(hashToken(a.token));
    expect(a.tokenHash).not.toContain(a.token);
  });

  it('rejects malformed tokens', () => {
    expect(isWellFormedToken('')).toBe(false);
    expect(isWellFormedToken('short')).toBe(false);
    expect(isWellFormedToken('a'.repeat(44))).toBe(false);
    expect(isWellFormedToken(`${'a'.repeat(42)}!`)).toBe(false);
  });

  it('derives a stable CSRF token per session and secret', () => {
    const secret = 'unit-test-secret-0123456789abcdef-0123';
    const hash = hashToken('x');
    expect(csrfTokenFor(secret, hash)).toBe(csrfTokenFor(secret, hash));
    expect(csrfTokenFor(secret, hash)).not.toBe(csrfTokenFor(secret, hashToken('y')));
    expect(csrfTokenFor(secret, hash)).not.toBe(
      csrfTokenFor('another-secret-0123456789abcdef-012', hash),
    );
  });

  it('safeEqual compares by value, including different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'a')).toBe(false);
  });
});

describe('session cookie', () => {
  it('uses the __Host- name and Secure only in production', () => {
    expect(sessionCookieName({ NODE_ENV: 'production' })).toBe('__Host-tradex_sid');
    expect(sessionCookieName({ NODE_ENV: 'development' })).toBe('tradex_sid');
    const prod = sessionCookie({ NODE_ENV: 'production' }, 'tok');
    expect(prod).toContain('__Host-tradex_sid=tok');
    for (const attr of ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure']) {
      expect(prod).toContain(attr);
    }
    expect(prod).not.toContain('Domain');
    expect(sessionCookie({ NODE_ENV: 'development' }, 'tok')).not.toContain('Secure');
    expect(clearedSessionCookie({ NODE_ENV: 'production' })).toContain('Max-Age=0');
  });

  it('reads a named cookie out of a Cookie header', () => {
    expect(readCookie('a=1; tradex_sid=abc; b=2', 'tradex_sid')).toBe('abc');
    expect(readCookie('a=1', 'tradex_sid')).toBeNull();
    expect(readCookie(undefined, 'tradex_sid')).toBeNull();
    expect(readCookie('xtradex_sid=nope', 'tradex_sid')).toBeNull();
  });
});
