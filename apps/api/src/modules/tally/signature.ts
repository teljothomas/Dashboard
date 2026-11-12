import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/**
 * Connector request signature (INTERFACES section 5, SECURITY section 1).
 *
 * `X-Signature` is base64 of an ECDSA P-256 / SHA-256 signature in IEEE P1363 form (r || s, 64 bytes,
 * the default of .NET `ECDsa.SignData`), over the canonical string
 * `METHOD\nPATH\nTIMESTAMP\nNONCE\nhex(sha256(body))`. PATH is the raw request target (path and query
 * string) exactly as sent; TIMESTAMP is the Unix-seconds string from `X-Timestamp`; the body hash is
 * of the raw body bytes (empty body: sha256 of nothing).
 */

const P1363 = 'ieee-p1363' as const;

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface CanonicalParts {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
}

export function canonicalString(parts: CanonicalParts): string {
  return [
    parts.method.toUpperCase(),
    parts.path,
    parts.timestamp,
    parts.nonce,
    parts.bodySha256,
  ].join('\n');
}

/** Sign a canonical string (agent side; used by tests, tools and the shared test vector). */
export function signCanonical(privateKey: KeyObject, canonical: string): string {
  return sign('sha256', Buffer.from(canonical, 'utf8'), {
    key: privateKey,
    dsaEncoding: P1363,
  }).toString('base64');
}

/** Verify a signature against an SPKI PEM public key. Any malformed input is simply `false`. */
export function verifySignature(
  publicKeyPem: string,
  canonical: string,
  signatureB64: string,
): boolean {
  try {
    const signature = Buffer.from(signatureB64, 'base64');
    if (signature.length !== 64) return false;
    return verify(
      'sha256',
      Buffer.from(canonical, 'utf8'),
      { key: publicKeyPem, dsaEncoding: P1363 },
      signature,
    );
  } catch {
    return false;
  }
}

/**
 * Parse and normalise an agent public key: must be an SPKI PEM for an EC P-256 key. Returns the
 * canonical PEM, or null when the input is anything else.
 */
export function normalisePublicKeyPem(pem: string): string | null {
  try {
    if (!pem.trimStart().startsWith('-----BEGIN PUBLIC KEY-----')) return null;
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      return null;
    }
    return key.export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    return null;
  }
}
