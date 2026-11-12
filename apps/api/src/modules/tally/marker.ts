const MARKER = /\[ERP:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i;

/** The ERP financial event uuid carried in a voucher narration as `[ERP:<uuid>]` (ADR-031), else null. */
export function parseErpMarker(narration: string | null | undefined): string | null {
  if (!narration) return null;
  const match = MARKER.exec(narration);
  return match?.[1] ? match[1].toLowerCase() : null;
}
