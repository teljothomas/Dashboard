import type { FastifyInstance } from 'fastify';
import { registerTallyAdminRoutes } from './adminRoutes.js';
import { registerConnectorRoutes } from './connectorRoutes.js';
import { onVouchersImported } from './hooks.js';

/** Internal interface of the tally module for later modules (INTERFACES section 7). */
export const tally = { onVouchersImported };

export function registerTallyRoutes(app: FastifyInstance): void {
  registerTallyAdminRoutes(app);
  registerConnectorRoutes(app);
}

export { onVouchersImported } from './hooks.js';
export type { ImportedVoucher, VouchersImportedEvent, VouchersImportedHook } from './hooks.js';
export { parseErpMarker } from './marker.js';
export { canonicalString, signCanonical, sha256Hex, verifySignature } from './signature.js';
export { companyFingerprint } from './company.js';
