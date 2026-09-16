/** Vue Router query values can be strings, arrays, null or undefined. Keep that noise at the URL
 * boundary so workspace components can use ordinary strings and positive numeric ids. */
export function queryText(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

export function queryIds(value: unknown): number[] {
  return queryText(value)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id) && id > 0);
}

export function queryIdSet(value: unknown): Set<number> {
  return new Set(queryIds(value));
}
