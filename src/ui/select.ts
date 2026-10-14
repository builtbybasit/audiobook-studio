// What a closed UiSelect shows for its value.
import type { UiOption } from "@/ui/types";

/** Reka forbids `''` as an item value, so the select files it under this key instead. */
const EMPTY = "__empty__";

export const optionKey = (v: string | number | null): string => (v === "" ? EMPTY : String(v));

/**
 * The label a closed select shows for `value`. A value no option has (a removed endpoint) shows
 * the placeholder marked missing, never the raw id. Matched by key, so `128` finds `"128"`.
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
