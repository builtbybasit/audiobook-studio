// The reader's keyboard: j/k or ↑/↓ move, Enter edit, Esc close, 1–9 assign speaker (in-chapter
// order), c toggles cast. Unmodified keys, so they only act while this pane owns the keyboard.
import { onMounted, onUnmounted, type ComputedRef, type Ref } from "vue";
import type { useReader } from "@/stores/reader";
import type { SegmentEditing } from "@/views/scripting/segmentEditing";
import type { Character, Segment } from "@/types";

export interface ReaderKeys {
  root: Ref<HTMLElement | null>;
  /** the filtered lines j/k walk */
  rows: ComputedRef<Segment[]>;
  segments: ComputedRef<Segment[]>;
  inChapter: ComputedRef<Character[]>;
  editing: SegmentEditing;
  /** the history panel is open and keeps only Escape */
  history: Ref<boolean>;
  /** steps the history panel back one state; false when it was already at its list */
  historyBack: () => boolean;
  focusMode: () => boolean;
  toggleFocus: () => void;
  reader: ReturnType<typeof useReader>;
  nudgePause: (s: Segment, step: number) => void;
  playLine: (s: Segment) => void;
  assignSpeaker: (id: number, name: string) => void;
}

export function useReaderKeys(ctx: ReaderKeys) {
  const { root, rows, segments, inChapter, editing, history, reader } = ctx;
  const { open, focus, splitting, cutAt, nextOf, doJoin, startTextEdit } = editing;
  /** Prose isn't focusable, so a click usually leaves focus on `<body>` and only the pointer says
   *  which pane is in use. Starts true so a freshly opened chapter answers j/k at once. */
  let pointerInside = true;
  const onPointerDown = (e: PointerEvent) => {
    pointerInside = !!root.value?.contains(e.target as Node);
  };
  /** Something in it has focus, or nothing does and the last click was here. */
  function owns(): boolean {
    const el = root.value;
    if (!el) return false;
    const active = document.activeElement;
    if (active && active !== document.body) return el.contains(active);
    return pointerInside;
  }
  function moveFocus(d: number) {
    const ids = rows.value.map((r) => r.id);
    const i = focus.value == null ? -1 : ids.indexOf(focus.value);
    focus.value = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + d))] ?? null;
    document
      .getElementById("seg-" + focus.value)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function onKey(e: KeyboardEvent) {
    if (!owns()) return;
    const t = e.target as HTMLElement;
    if (t.closest('[data-expression-editor], [role="dialog"]')) return;
    // edits would land on lines nobody can see
    if (history.value) {
      if (e.key !== "Escape" || ["INPUT", "TEXTAREA"].includes(t.tagName)) return;
      if (!ctx.historyBack()) history.value = false;
      return;
    }
    // inside a field the widget handles Escape; a second Escape closes the editor
    if (
      ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) ||
      t.isContentEditable ||
      t.closest?.("[role=listbox],[role=option]")
    ) {
      if (e.key === "Escape" && t.getAttribute("role") !== "combobox") t.blur();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === "Enter" && focus.value) {
      open.value = open.value === focus.value ? null : focus.value;
    } else if (e.key === "Escape") {
      if (open.value || splitting.value) {
        open.value = null;
        splitting.value = null;
        cutAt.value = null;
      } else if (ctx.focusMode()) ctx.toggleFocus();
    } else if (e.key === "s" && focus.value) {
      open.value = focus.value;
      splitting.value = splitting.value === focus.value ? null : focus.value;
      cutAt.value = null;
    } else if (e.key === "m" && focus.value) {
      const s = segments.value.find((x) => x.id === focus.value);
      if (s) doJoin(s, "next");
    } else if ((e.key === "[" || e.key === "]") && focus.value) {
      const s = segments.value.find((x) => x.id === focus.value);
      if (s && nextOf(s)) ctx.nudgePause(s, e.key === "]" ? 0.25 : -0.25);
    } else if (e.key === "e" && focus.value) {
      e.preventDefault(); // the field opens focused and would get this "e"
      const s = segments.value.find((x) => x.id === focus.value);
      if (s) startTextEdit(s);
    } else if (e.key === "p" && focus.value) {
      const s = segments.value.find((x) => x.id === focus.value);
      if (s) ctx.playLine(s);
    } else if (e.key === "c") {
      reader.showCast = !reader.showCast;
    } else if (e.key === "f") {
      ctx.toggleFocus();
    } else if (e.key === "/" && !e.shiftKey) {
      e.preventDefault();
      document.querySelector<HTMLInputElement>('input[placeholder^="Find chapter"]')?.focus();
    } else if (/^[1-9]$/.test(e.key) && focus.value) {
      const c = inChapter.value[Number(e.key) - 1];
      if (c) ctx.assignSpeaker(focus.value, c.name);
    }
  }
  onMounted(() => {
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
  });
  onUnmounted(() => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("pointerdown", onPointerDown, true);
  });
}
