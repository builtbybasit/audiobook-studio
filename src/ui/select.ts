// What a closed UiSelect shows for its value.
import type { UiOption } from "@/ui/types";

/** Reka forbids `''` as an item value, so the select files it under this key instead. */
const EMPTY = "__empty__";

/** The key a select files a value under: the item value reka is given. */
export const optionKey = (v: string | number | null): string => (v === "" ? EMPTY : String(v));

/**
 * The label a closed select shows for `value`, and whether the value is one none of the options
 * has. A value with no option — an endpoint since removed, a setting from an older file — is never
 * shown as itself: an id reads like a real choice, so the page would claim one that is not on
 * offer. The select shows its placeholder instead, marked as missing.
 *
 * Matched by key, the way the open list matches it, so `128` finds the option `"128"`.
 */
export function selectLabel(
  value: string | number | null | undefined,
  options: readonly UiOption[],
  nullValue?: string | number,
): { label: string; missing: boolean } {
  if (value == null)
    return { label: nullValue !== undefined ? String(nullValue) : "", missing: false };
  const option = options.find((o) => o.value != null && optionKey(o.value) === optionKey(value));
  return option ? { label: option.label, missing: false } : { label: "", missing: true };
}
