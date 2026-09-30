// Small formatters and platform facts the views share, so a clock time or a shortcut legend reads
// the same on every page that shows one.

/** A clock time to the minute, in the reader's own locale: "14:05", or "2:05 PM". */
export const hhmm = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Whether a `navigator.platform` is Apple's, where ⌘ does what Ctrl does elsewhere. */
export const isMacPlatform = (platform: string): boolean => /Mac|iPhone/.test(platform);

/** This browser's answer. The server has no navigator, and reads it as not a Mac. */
export const isMac: boolean = isMacPlatform(globalThis.navigator?.platform ?? "");

/** The modifier key as a shortcut legend spells it. */
export const modKey: string = isMac ? "⌘" : "Ctrl";
