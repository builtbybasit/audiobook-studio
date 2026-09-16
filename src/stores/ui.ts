// Shared presentation preferences, notifications and the application-wide undo history.
import type { ToastOptions, UndoEntry } from "@/types";
import { defineStore } from "pinia";
import type { ToastButton } from "vue-toastflow";
import { toast as tf } from "vue-toastflow";
interface UiState {
  _undo: UndoEntry[];
  notify: boolean;
  dark: boolean;
  currentBookId: string | null;
  /** the chapter each book is open on — see `openChapter` */
  currentChapter: Record<string, number>;
}
export const useUiStore = defineStore("ui", {
  state: (): UiState => ({
    _undo: [],
    notify: false,
    dark: window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true,
    currentBookId: null,
    currentChapter: {},
  }),
  getters: {
    undoPending(s): (entry: UndoEntry | null) => boolean {
      return (entry: UndoEntry | null): boolean => !!entry && s._undo.includes(entry);
    },
  },
  actions: {
    // ---------- which chapter the book is open on ----------
    // Each stage used to choose its own chapter — scripting opened the first unverified one,
    // narration the first stale one — so walking from Scripting to Narration landed you somewhere
    // else and you had to find your place again. The book remembers one chapter instead, and every
    // stage opens on it; `?ch=` in the URL still wins, and a stage only falls back to its own pick
    // when the book has no chapter yet.
    /** Remember the chapter this book is being worked on. */
    openChapter(bookId: string, chapterId: number): void {
      this.currentChapter[bookId] = chapterId;
    },
    /** That chapter, if it is still one of `chapters` — a book can lose one to a re-import. */
    chapterIn(bookId: string, chapters: { id: number }[]): number | null {
      const id = this.currentChapter[bookId];
      return id && chapters.some((c) => c.id === id) ? id : null;
    },
    // ---------- toasts & undo ----------
    // Thin wrapper over Toastflow so the rest of the app never imports it. `undo` makes the toast
    // undoable (↻, Undo button, 10 s, ⌘Z); `action` adds a second button; `timeout: 0` sticks.
    toast(msg: string, opts: ToastOptions = {}): string {
      const { kind = "info", undo = null, action = null, timeout, description = "" } = opts;
      const type = (
        {
          info: "info",
          warn: "warning",
          warning: "warning",
          error: "error",
          success: "success",
          loading: "loading",
        } as const
      )[kind];
      const buttons: ToastButton[] = [];
      const entry: UndoEntry | null = undo ? { label: msg, revert: undo, toastId: null } : null;
      if (entry)
        buttons.push({
          id: "undo",
          label: "Undo",
          ariaLabel: `Undo: ${msg}`,
          dismissAfterClick: true,
          onClick: () => this._revert(entry),
        });
      if (action)
        buttons.push({
          id: "action",
          label: action.label,
          dismissAfterClick: true,
          onClick: () => action.run(),
        });
      const id = tf.show({
        type,
        title: msg,
        description,
        theme: entry ? "undo" : undefined,
        duration: timeout ?? (entry ? 10000 : type === "error" ? 9000 : 6000),
        buttons: buttons.length ? { alignment: "bottom-left", buttons } : undefined,
      });
      if (entry) {
        entry.toastId = id;
        this._undo = [...this._undo.slice(-9), entry];
      }
      return id;
    },
    dismissToast(id: string): void {
      tf.dismiss(id);
    },
    _revert(entry: UndoEntry): void {
      if (!this._undo.includes(entry)) return;
      entry.revert();
      this._undo = this._undo.filter((u) => u !== entry);
      if (entry.toastId != null) tf.dismiss(entry.toastId);
      tf.show({ type: "success", title: "Undone", description: entry.label, duration: 3000 });
    },
    undoLast(): boolean {
      const u = this._undo.at(-1);
      if (!u) return false;
      this._revert(u);
      return true;
    },
    // long-running work: one toast that goes loading → success / error (Toastflow's promise helper)
    toastLoading<T>(
      promise: Promise<T>,
      {
        loading,
        success,
        error,
      }: {
        loading: string;
        success: string | ((r: T) => string);
        error?: string | ((e: unknown) => string);
      },
    ): Promise<T> {
      const result = tf.loading(() => promise, {
        loading: { title: loading, duration: 0, progressBar: false },
        success: (r: T) => ({
          type: "success" as const,
          title: typeof success === "function" ? success(r) : success,
          duration: 5000,
        }),
        error: (e: unknown) => ({
          type: "error" as const,
          title: typeof error === "function" ? error(e) : (error ?? "Failed"),
          description: e instanceof Error ? e.message : "",
          duration: 9000,
        }),
      });
      result.catch(() => {}); // the error toast is the handling; callers decide what else to do with `promise`
      return result;
    },
    /** Take one specific undo — the batch's own — rather than whatever is latest. */
    revertEntry(entry: UndoEntry): void {
      this._revert(entry);
    },
  },
});
