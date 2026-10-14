// Shift-click across checkboxes: a shift-click ticks the run from the last clicked row, over the
// ids shown now, so a filter narrows what a range can reach. What a tick means is the page's.
import { ref, toValue, type MaybeRefOrGetter } from "vue";

export function useRangeSelect<T>(ids: MaybeRefOrGetter<readonly T[]>) {
  /** the row clicked last, which a shift-click runs from */
  const anchor = ref<T | null>(null);

  /**
   * The rows a click on `id` covers, in list order: the run from the anchor when shift is held and
   * both rows are shown, otherwise the one row. The click becomes the next anchor either way.
   */
  function span(id: T, e?: { shiftKey?: boolean }): T[] {
    const list = toValue(ids);
    const from = anchor.value;
    anchor.value = id;
    if (!e?.shiftKey || from == null) return [id];
    const a = list.indexOf(from);
    const b = list.indexOf(id);
    if (a < 0 || b < 0) return [id];
    return list.slice(Math.min(a, b), Math.max(a, b) + 1);
  }

  return { span, anchor };
}

/** Tick or untick every id of a run in a copy of a selection. */
export function applySpan<T>(selection: Iterable<T>, run: T[], on: boolean): Set<T> {
  const next = new Set(selection);
  for (const id of run)
    if (on) next.add(id);
    else next.delete(id);
  return next;
}
