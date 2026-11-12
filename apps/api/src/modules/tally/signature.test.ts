import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { identityMatches, companyFingerprint, normaliseName } from './company.js';
import { generateRegistrationCode, normaliseRegistrationCode } from './registration.js';
import { parseErpMarker } from './marker.js';
import {
  canonicalString,
  normalisePublicKeyPem,
  sha256Hex,
  signCanonical,
  verifySignature,
} from './signature.js';

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

const parts = {
  method: 'POST',
  path: '/connector/v1/heartbeat',
  timestamp: '1760000000',
  nonce: '4f0c4d52-1c4b-4c7e-9d58-6f0d6a3b2a11',
  bodySha256: sha256Hex('{"epoch":1}'),
};

describe('connector signature', () => {
  it('canonical string is METHOD, path, timestamp, nonce, body hash joined by newlines', () => {
    expect(canonicalString({ ...parts, method: 'post' })).toBe(
      `POST\n/connector/v1/heartbeat\n1760000000\n${parts.nonce}\n${parts.bodySha256}`,
    );
    // sha256 of the empty body, used by GET calls
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('a signature verifies, and fails for any change of the canonical string', () => {
    const { privateKey, publicPem } = keyPair();
    const canonical = canonicalString(parts);
    const signature = signCanonical(privateKey, canonical);
    expect(Buffer.from(signature, 'base64')).toHaveLength(64);
    expect(verifySignature(publicPem, canonical, signature)).toBe(true);
    for (const changed of [
      { ...parts, method: 'GET' },
      { ...parts, path: '/connector/v1/heartbeat?x=1' },
      { ...parts, timestamp: '1760000001' },
      { ...parts, nonce: randomUUID() },
      { ...parts, bodySha256: sha256Hex('{"epoch":2}') },
    ]) {
      expect(verifySignature(publicPem, canonicalString(changed), signature)).toBe(false);
    }
  });

  it('rejects a signature from another key, a wrong length and garbage', () => {
    const a = keyPair();
    const b = keyPair();
    const canonical = canonicalString(parts);
    const signature = signCanonical(a.privateKey, canonical);
    expect(verifySignature(b.publicPem, canonical, signature)).toBe(false);
    expect(verifySignature(a.publicPem, canonical, 'AAAA')).toBe(false);
    expect(verifySignature(a.publicPem, canonical, '')).toBe(false);
    expect(verifySignature('not a key', canonical, signature)).toBe(false);
  });

  it('accepts only an EC P-256 SPKI public key', () => {
    const { publicPem } = keyPair();
    expect(normalisePublicKeyPem(publicPem)).toBe(publicPem);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
      type: 'spki',
      format: 'pem',
    });
    expect(normalisePublicKeyPem(rsa.toString())).toBeNull();
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({
      type: 'spki',
      format: 'pem',
    });
    expect(normalisePublicKeyPem(p384.toString())).toBeNull();
    expect(
      normalisePublicKeyPem('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----'),
    ).toBeNull();
    expect(normalisePublicKeyPem('')).toBeNull();
  });

  it('shared test vector verifies (the .NET agent must produce the same canonical string)', () => {
    const vector = JSON.parse(
      readFileSync(
        new URL('../../../../../agent/tests/fixtures/signature-vector.json', import.meta.url),
        'utf8',
      ),
    ) as {
      publicKeyPem: string;
      method: string;
      path: string;
      timestamp: string;
      nonce: string;
      body: string;
      canonical: string;
      signature: string;
    };
    const canonical = canonicalString({
      method: vector.method,
      path: vector.path,
      timestamp: vector.timestamp,
      nonce: vector.nonce,
      bodySha256: sha256Hex(vector.body),
    });
    expect(canonical).toBe(vector.canonical);
    expect(verifySignature(vector.publicKeyPem, canonical, vector.signature)).toBe(true);
  });
});

describe('registration code', () => {
  it('has 16 characters from the unambiguous alphabet in four groups', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateRegistrationCode()).toMatch(
        /^([A-HJ-KM-NP-Z2-9]{4}-){3}[A-HJ-KM-NP-Z2-9]{4}$/,
      );
    }
    expect(new Set(Array.from({ length: 50 }, generateRegistrationCode)).size).toBe(50);
  });

  it('normalises case, spaces and dashes and rejects anything else', () => {
    expect(normaliseRegistrationCode('abcd-efgh-jkmn-pqrs')).toBe('ABCDEFGHJKMNPQRS');
    expect(normaliseRegistrationCode(' ABCD EFGH JKMN PQRS ')).toBe('ABCDEFGHJKMNPQRS');
    expect(normaliseRegistrationCode('ABCD-EFGH')).toBeNull();
    expect(normaliseRegistrationCode('ABCD-EFGH-JKMN-PQR0')).toBeNull(); // 0 is not in the alphabet
  });
});

describe('erp marker', () => {
  const id = '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b';
  it('reads the first [ERP:<uuid>] marker, lower-cased', () => {
    expect(parseErpMarker(`Cash received [ERP:${id.toUpperCase()}] ref 7`)).toBe(id);
    expect(parseErpMarker(`[ERP:${id}] [ERP:${randomUUID()}]`)).toBe(id);
  });
  it('is null without a well formed marker', () => {
    expect(parseErpMarker(null)).toBeNull();
    expect(parseErpMarker('')).toBeNull();
    expect(parseErpMarker('ERP:' + id)).toBeNull();
    expect(parseErpMarker('[ERP:not-a-uuid]')).toBeNull();
  });
});

describe('company identity', () => {
  const expected = { tallyName: 'Acme  Meats Pvt Ltd', companyNumber: '', booksFrom: '2025-04-01' };
  const observed = {
    tallyName: ' acme meats pvt ltd ',
    companyNumber: '1000042',
    booksFrom: '2025-04-01',
  };

  it('normalises names and fingerprints deterministically', () => {
    expect(normaliseName('  Acme   Meats ')).toBe('acme meats');
    expect(companyFingerprint(expected)).toBe(
      companyFingerprint({ ...expected, tallyName: 'acme meats pvt ltd' }),
    );
    expect(companyFingerprint(expected)).toMatch(/^[0-9a-f]{64}$/);
    expect(companyFingerprint(expected)).not.toBe(
      companyFingerprint({ ...expected, booksFrom: '2024-04-01' }),
    );
  });

  it('matches on name and books-from; number and guid count only when both sides have one', () => {
    expect(identityMatches(expected, observed)).toBe(true);
    expect(identityMatches({ ...expected, companyNumber: '1000042' }, observed)).toBe(true);
    expect(identityMatches({ ...expected, companyNumber: '9' }, observed)).toBe(false);
    expect(identityMatches(expected, { ...observed, tallyName: 'Other Co' })).toBe(false);
    expect(identityMatches(expected, { ...observed, booksFrom: '2024-04-01' })).toBe(false);
    expect(identityMatches({ ...expected, guid: 'AAA' }, { ...observed, guid: 'aaa' })).toBe(true);
    expect(identityMatches({ ...expected, guid: 'AAA' }, { ...observed, guid: 'bbb' })).toBe(false);
    expect(identityMatches({ ...expected, guid: 'AAA' }, observed)).toBe(true);
  });
});
