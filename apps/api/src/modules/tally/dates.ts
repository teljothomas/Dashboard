/**
 * `date` columns are typed `Date` by the generated schema but the pool parses them to `YYYY-MM-DD`
 * strings (db/client.ts, ADR-015). This narrows both to the string the API contract uses.
 */
export function dateOnly(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString().slice(0, 10);
}
