// The finished lines a speaker's voice or effect change left behind, and what to do with them:
// redo some chapters' worth, or (effects only) keep the old sound. One ask at a time, which the
// one `ExistingLinesDialog` shows; a later ask replaces it, and an answer overtaken is dropped.
import { defineStore } from "pinia";

import { plural } from "@/lib/contents";
import { effectsService } from "@/services/effects";
import { libraryService } from "@/services/library";
import type { EffectSlot, ExistingChapter } from "@/types";
import { useCastStore } from "@/stores/cast";
import { useEffectsStore } from "@/stores/effects";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { toastFailure } from "@/stores/toastFailure";
import { useUiStore } from "@/stores/ui";

/** Which chapters the dialog starts on. */
export type ExistingOption = "all" | "from" | "pick" | "none";

export interface ExistingAsk {
  kind: "voice" | "effect";
  bookId: string;
  /** null: the whole book's old-sound lines, asked from the Re-apply bar */
  name: string | null;
  /** "Ji Ning now uses Calm Male 2" */
  title: string;
  lines: number;
  /** in reading order */
  chapters: ExistingChapter[];
  /** effect: lines no Re-apply can redo */
  unavailable: number;
  /** effect: false when effects can't run here, so only keeping is offered */
  ready: boolean;
  start: ExistingOption;
}

/** Asks out, per store, so only the latest one's answer opens the dialog. */
let asked = 0;

export const useExistingLinesStore = defineStore("existingLines", {
  state: () => ({ ask: null as ExistingAsk | null }),
  actions: {
    /** After a speaker's voice changed: ask, if they have lines made with another voice. */
    async askVoice(bookId: string, name: string): Promise<void> {
      const castStore = useCastStore();
      const endpointsStore = useEndpointsStore();
      const mine = ++asked;
      try {
        const found = await libraryService().oldVoice(bookId, name);
        if (mine !== asked || !found.lines) return;
        const voice = castStore.byName[bookId]?.get(name)?.voice;
        const label = voice
          ? endpointsStore.voiceLabel(voice)
          : castStore.fallbackLabel(bookId, name);
        this.ask = {
          kind: "voice",
          bookId,
          name,
          title: `${name} now uses ${label}`,
          lines: found.lines,
          chapters: found.chapters,
          unavailable: 0,
          ready: true,
          start: "none",
        };
      } catch (cause) {
        toastFailure("find the lines with the old voice", cause);
      }
    },
    /**
     * After a speaker's effect (`slots` say which) changed, or from the Re-apply bar for the whole
     * book (`name` null): ask, if any line has the old sound.
     */
    async askEffect(
      bookId: string,
      name: string | null,
      slots: EffectSlot[] = [],
      start: ExistingOption = "none",
    ): Promise<void> {
      const castStore = useCastStore();
      const effectsStore = useEffectsStore();
      const mine = ++asked;
      try {
        await castStore._castSettled(bookId);
        const found = await effectsService().stale(bookId, name ?? undefined);
        if (mine !== asked || !found.lines) return;
        const c = name ? castStore.byName[bookId]?.get(name) : undefined;
        const effectName = (id: string | undefined) =>
          (id && effectsStore.byId.get(id)?.name) || "no effect";
        this.ask = {
          kind: "effect",
          bookId,
          name,
          title: !name
            ? "Lines with the old sound"
            : slots.includes("effect")
              ? `${name} now uses ${effectName(c?.effect)}`
              : c?.thoughts
                ? `${name}’s thoughts now use ${effectName(c.thoughts)}`
                : `${name}’s thoughts now follow the book`,
          lines: found.lines,
          chapters: found.chapters,
          unavailable: found.unavailable,
          ready: found.ready,
          start: found.ready ? start : "none",
        };
      } catch (cause) {
        toastFailure("find the lines with the old sound", cause);
      }
    },
    /**
     * Answer the ask: redo the lines in `chosen` chapters. An effect's other chapters (all of them
     * when none is chosen) keep the old sound; a voice's are left as they are. True when done.
     */
    async answer(chosen: number[]): Promise<boolean> {
      const ask = this.ask;
      if (!ask) return true;
      const ok = ask.kind === "voice" ? await revoice(ask, chosen) : await reapply(ask, chosen);
      if (ok && this.ask === ask) this.ask = null;
      return ok;
    },
  },
});

async function revoice(ask: ExistingAsk, chosen: number[]): Promise<boolean> {
  const libraryStore = useLibraryStore();
  if (!chosen.length || !ask.name) return true;
  if (libraryStore._blocked(ask.bookId, "re-narrate")) return false;
  try {
    const { jobs, chapters } = await libraryService().revoice(ask.bookId, ask.name, chosen);
    libraryStore.chapters[ask.bookId] = chapters;
    await useJobsStore()._changed();
    const lines = linesIn(ask, chosen);
    useUiStore().toast(`Re-narrate · ${plural(lines, "line")}`, {
      kind: "info",
      description: `${ask.name} in ${plural(jobs.length, "chapter")}. Queued on the server; progress is in the Queue.`,
      timeout: 8000,
    });
    return true;
  } catch (cause) {
    toastFailure("queue the re-narration", cause);
    return false;
  }
}

async function reapply(ask: ExistingAsk, chosen: number[]): Promise<boolean> {
  const effectsStore = useEffectsStore();
  const uiStore = useUiStore();
  const speaker = ask.name ? { speaker: ask.name } : {};
  const every = chosen.length === ask.chapters.length;
  if (chosen.length) {
    const queued = await effectsStore.reapply(
      ask.bookId,
      every ? speaker : { ...speaker, chapters: chosen },
    );
    if (!queued) return false;
  }
  const picked = new Set(chosen);
  const rest = ask.chapters.filter((c) => !picked.has(c.id)).map((c) => c.id);
  const kept = rest.length
    ? await effectsStore.keep(ask.bookId, chosen.length ? { ...speaker, chapters: rest } : speaker)
    : 0;
  if (kept === null) return false;
  const redo = linesIn(ask, chosen, true);
  uiStore.toast(
    chosen.length
      ? `Re-apply · ${plural(redo, "line")}`
      : `Kept the old sound · ${plural(kept, "line")}`,
    {
      kind: "info",
      description: chosen.length
        ? `Queued; progress is in the Queue.${kept ? ` ${plural(kept, "line")} keep the old sound.` : ""}`
        : undefined,
    },
  );
  return true;
}

/** Lines in these chapters; `redoable` leaves out the ones only re-narrating changes. */
export function linesIn(ask: ExistingAsk, chosen: readonly number[], redoable = false): number {
  const picked = new Set(chosen);
  return ask.chapters
    .filter((c) => picked.has(c.id))
    .reduce((n, c) => n + c.lines - (redoable ? (c.unavailable ?? 0) : 0), 0);
}
