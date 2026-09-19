// ANSI, and when not to use it.
//
// Small and local rather than a dependency: what this needs is eight escape codes and one honest
// answer about whether the thing being written to is a terminal. A log that paints colour into a
// file somebody is grepping has made the file worse.
const ESC = "\u001B[";

/**
 * Whether to colour at all.
 *
 * `NO_COLOR` is the convention every tool honours — its presence, at any value, means no. `FORCE_COLOR`
 * is the other direction, for a CI that renders ANSI but is not a TTY. Otherwise: colour when
 * stdout is a terminal and a person is looking at it.
 */
export function colourWanted(env: Record<string, string | undefined>, tty: boolean): boolean {
  if (env.NO_COLOR != null && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR != null && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return tty;
}

const code =
  (open: number, close = 39) =>
  (s: string): string =>
    `${ESC}${open}m${s}${ESC}${close}m`;

/** The palette, and the one that paints nothing. */
export interface Palette {
  dim: (s: string) => string;
  bold: (s: string) => string;
  grey: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  blue: (s: string) => string;
  magenta: (s: string) => string;
  cyan: (s: string) => string;
  white: (s: string) => string;
  onRed: (s: string) => string;
}

const plain = (s: string): string => s;

export const NO_COLOUR: Palette = {
  dim: plain,
  bold: plain,
  grey: plain,
  red: plain,
  green: plain,
  yellow: plain,
  blue: plain,
  magenta: plain,
  cyan: plain,
  white: plain,
  onRed: plain,
};

export const COLOUR: Palette = {
  dim: code(2, 22),
  bold: code(1, 22),
  grey: code(90),
  red: code(31),
  green: code(32),
  yellow: code(33),
  blue: code(34),
  magenta: code(35),
  cyan: code(36),
  white: code(97),
  onRed: (s) => `${ESC}41m${ESC}97m${s}${ESC}0m`,
};

/** Characters wide, ignoring anything the terminal will not draw. */
export const visibleWidth = (s: string): number =>
  s.replace(new RegExp(`${ESC.replace("[", "\\[")}[0-9;]*m`, "g"), "").length;
