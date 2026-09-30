// Shift-click ranges (`useRangeSelect`), as the chapter lists, the contents review and the script
// import use them: a run is taken over the rows on screen, from the row clicked last.
import { expect, test } from "bun:test";
import { ref } from "vue";

import { applySpan, useRangeSelect } from "@/composables/useRangeSelect";

test("a plain click covers its own row, a shift-click the run from the last one", () => {
  const { span } = useRangeSelect([10, 11, 12, 13, 14]);
  expect(span(11)).toEqual([11]);
  expect(span(14, { shiftKey: true })).toEqual([11, 12, 13, 14]);
  // backwards from the new anchor
  expect(span(12, { shiftKey: true })).toEqual([12, 13, 14]);
});

test("a run reaches only what is on screen, and a hidden anchor makes it one row", () => {
  const shown = ref([1, 2, 3, 4]);
  const { span } = useRangeSelect(shown);
  span(2);
  shown.value = [3, 4];
  expect(span(4, { shiftKey: true })).toEqual([4]);
  expect(span(3, { shiftKey: true })).toEqual([3, 4]);
});

test("a run ticks or unticks every row in it, and leaves the rest of the selection", () => {
  expect([...applySpan([1, 9], [2, 3], true)]).toEqual([1, 9, 2, 3]);
  expect([...applySpan([1, 2, 3, 9], [2, 3], false)]).toEqual([1, 9]);
});
