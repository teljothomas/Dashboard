/** Local date and time for display. Returns the input unchanged when it is not a valid date. */
export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    date,
  );
}
