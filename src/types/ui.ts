// Toasts and the undo stack they hand out. The store owns both; the rest of the app never imports
// the toast library directly.

export type ToastKind = "info" | "warn" | "warning" | "error" | "success" | "loading";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  kind?: ToastKind;
  /** makes the toast undoable (↻, Undo button, 10 s, ⌘Z) */
  undo?: (() => void) | null;
  action?: ToastAction | null;
  /** 0 sticks */
  timeout?: number;
  description?: string;
}

export interface UndoEntry {
  label: string;
  revert: () => void;
  toastId: string | null;
}
