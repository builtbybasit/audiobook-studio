// Reader preferences: typography + whether the cast rail is shown. Persisted per browser (localStorage).
import { defineStore } from "pinia";

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

function load(): Partial<ReaderState> {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ReaderState>) ?? {};
  } catch {
    return {};
  }
}
export function saveReader(state: ReaderState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
}

export const useReader = defineStore("reader", {
  state: (): ReaderState => ({ ...READER_DEFAULTS, ...load() }),
  getters: {
    fontClass: (s): string =>
      ({ serif: "font-serif", sans: "font-sans", mono: "font-mono" })[s.font],
    widthClass: (s): string =>
      ({ narrow: "max-w-xl", normal: "max-w-2xl", wide: "max-w-4xl" })[s.width],
    isDefault: (s): boolean =>
      (Object.keys(READER_DEFAULTS) as (keyof ReaderState)[])
        .filter((k) => k !== "showCast")
        .every((k) => s[k] === READER_DEFAULTS[k]),
  },
  actions: {
    reset(): void {
      const keep = this.showCast;
      Object.assign(this, READER_DEFAULTS, { showCast: keep });
    },
  },
});
