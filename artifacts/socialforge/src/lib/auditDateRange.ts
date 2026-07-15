/**
 * Converts an <input type="date"> value (a "YYYY-MM-DD" calendar day) into
 * ISO instants bounding that day in the BROWSER'S LOCAL timezone.
 *
 * Why: the audit table renders createdAt with toLocaleString() (local time),
 * so the From/To filters must use local-day boundaries to match what the
 * admin sees. Passing the raw string to `new Date("YYYY-MM-DD")` would parse
 * it as UTC midnight, shifting the boundary by the timezone offset and
 * causing off-by-one-day results for records written near midnight UTC.
 */
export function localDayStartISO(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

export function localDayEndISO(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}
