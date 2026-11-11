import type { FastifyInstance } from 'fastify';

/** SECURITY §4. CSP forbids inline scripts (Vite build is compatible). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' blob: data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; '),
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', (_request, reply, _payload, done) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      void reply.header(name, value);
    }
    done();
  });
}
