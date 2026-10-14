// Reader preferences: typography + whether the cast rail is shown, persisted per browser by
// `useStorage`. A setup store, so `reader.size = 18` persists.
import { useStorage } from "@vueuse/core";
import { defineStore } from "pinia";
import { computed, toRefs } from "vue";

export type ReaderFont = "serif" | "sans" | "mono";
export type ReaderWidth = "narrow" | "normal" | "wide";

export interface ReaderState {
  font: ReaderFont;
  size: number;
  lineHeight: number;
  width: ReaderWidth;
  showCast: boolean;
}

export const READER_DEFAULTS: ReaderState = {
  font: "serif",
  size: 16,
  lineHeight: 1.75,
  width: "normal",
  showCast: true,
};
const KEY = "audiobook-ui.reader";

export const useReader = defineStore("reader", () => {
  const prefs = useStorage<ReaderState>(KEY, { ...READER_DEFAULTS }, undefined, {
    mergeDefaults: true,
  });
  const fontClass = computed(
    (): string => ({ serif: "font-serif", sans: "font-sans", mono: "font-mono" })[prefs.value.font],
  );
  const widthClass = computed(
    (): string =>
      ({ narrow: "max-w-xl", normal: "max-w-2xl", wide: "max-w-4xl" })[prefs.value.width],
  );
  const isDefault = computed((): boolean =>
    (Object.keys(READER_DEFAULTS) as (keyof ReaderState)[])
      .filter((k) => k !== "showCast")
      .every((k) => prefs.value[k] === READER_DEFAULTS[k]),
  );
  function reset(): void {
    Object.assign(prefs.value, READER_DEFAULTS, { showCast: prefs.value.showCast });
  }
  return { ...toRefs(prefs.value), fontClass, widthClass, isDefault, reset };
});
