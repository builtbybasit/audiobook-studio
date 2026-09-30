// Shift-click across a list of checkboxes: a click ticks one row, a shift-click the run from the
// row clicked last to this one. The run is taken over the ids the list shows now — what is on
// screen is the list, so a search or a filter narrows what a range can reach.
//
// What a tick means is the page's (a chapter chosen for a run, a chapter skipped, a chapter to
// import), so this only answers which rows a click covers and remembers where the last one was.
import { ref, toValue, type MaybeRefOrGetter } from "vue";

export function useRangeSelect(ids: MaybeRefOrGetter<readonly number[]>) {
  /** the row clicked last, which a shift-click runs from */
  const anchor = ref<number | null>(null);

  /**
   * The rows a click on `id` covers, in list order: the run from the anchor when shift is held and
   * both rows are on screen, otherwise the one row. The click becomes the next anchor either way.
   */
  function span(id: number, e?: { shiftKey?: boolean }): number[] {
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
export function applySpan(selection: Iterable<number>, run: number[], on: boolean): Set<number> {
  const next = new Set(selection);
  for (const id of run)
    if (on) next.add(id);
    else next.delete(id);
  return next;
}
