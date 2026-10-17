// The finished lines a speaker's voice or effect change left behind, and what to do with them:
// redo some chapters' worth, or (effects only) keep the old sound. One ask at a time, which the
// one `ExistingLinesDialog` (a voice's speed, across books: `VoiceSpeedDialog`) shows; a later ask
// replaces it, and an answer overtaken is dropped.
import { defineStore } from "pinia";

import { plural } from "@/lib/contents";
import { staleMoved } from "@/queries/effects";
import { effectsService } from "@/services/effects";
import { endpointSettingsService } from "@/services/endpointSettings";
import { libraryService } from "@/services/library";
import type { EffectSlot, ExistingChapter, VoiceRef, VoiceSpeedLines } from "@/types";
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
  /** whose lines; none: the whole book's old-sound lines, asked from the Re-apply bar */
  names: string[];
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

/** A voice's speed changed: its lines at the old one, in every book that has any. */
export interface VoiceSpeedAsk extends VoiceSpeedLines {
  ref: VoiceRef;
  /** "Ash now reads at 1.09×" */
  title: string;
}

/** Asks out, per store, so only the latest one's answer opens the dialog. */
let asked = 0;

export const useExistingLinesStore = defineStore("existingLines", {
  state: () => ({ ask: null as ExistingAsk | null, speedAsk: null as VoiceSpeedAsk | null }),
  actions: {
    /**
     * After speakers' voices changed (one picked, auto-assign, the Character voice, a persona
     * link): ask, if they have lines made with another voice. `title` defaults to the one speaker's.
     */
    async askVoice(bookId: string, names: string[], title?: string): Promise<void> {
      const castStore = useCastStore();
      const endpointsStore = useEndpointsStore();
      if (!names.length) return;
      const mine = ++asked;
      try {
        const found = await libraryService().oldVoice(bookId, names);
        if (mine !== asked || !found.lines) return;
        const [name] = names;
        const voice = castStore.byName[bookId]?.get(name)?.voice;
        const label = voice
          ? endpointsStore.voiceLabel(voice)
          : castStore.fallbackLabel(bookId, name);
        this.speedAsk = null;
        this.ask = {
          kind: "voice",
          bookId,
          names,
          title:
            title ??
            (names.length === 1
              ? `${name} now uses ${label}`
              : `${names.length} speakers revoiced`),
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
     * book (`name` null): ask, if any line has the old sound. `title` names another change.
     */
    async askEffect(
      bookId: string,
      name: string | null,
      slots: EffectSlot[] = [],
      start: ExistingOption = "none",
      title?: string,
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
        this.speedAsk = null;
        this.ask = {
          kind: "effect",
          bookId,
          names: name ? [name] : [],
          title:
            title ??
            (!name
              ? "Lines with the old sound"
              : slots.includes("effect")
                ? `${name} now uses ${effectName(c?.effect)}`
                : c?.thoughts
                  ? `${name}’s thoughts now use ${effectName(c.thoughts)}`
                  : `${name}’s thoughts now follow the book`),
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
    /** After a voice's own speed changed: ask, if any book has lines made at the old one. */
    async askVoiceSpeed(ref: VoiceRef, title: string): Promise<void> {
      const mine = ++asked;
      try {
        const found = await endpointSettingsService().voiceSpeedLines(ref);
        if (mine !== asked || !found.books.length) return;
        this.ask = null;
        this.speedAsk = { ...found, ref, title };
      } catch (cause) {
        toastFailure("find the lines at the old speed", cause);
      }
    },
    /**
     * Redo the lines in the `chosen` books; the others are left, their made-here lines keeping the
     * old sound. True when done.
     */
    async answerVoiceSpeed(chosen: string[]): Promise<boolean> {
      const ask = this.speedAsk;
      if (!ask) return true;
      const picked = new Set(chosen);
      const rest = ask.books.filter((b) => !picked.has(b.bookId));
      const ok =
        (!picked.size || (await redoSpeed(ask, [...picked]))) && (await keepSpeed(ask, rest));
      if (ok && this.speedAsk === ask) this.speedAsk = null;
      return ok;
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
  if (!chosen.length || !ask.names.length) return true;
  if (libraryStore._blocked(ask.bookId, "re-narrate")) return false;
  try {
    const { jobs, chapters } = await libraryService().revoice(ask.bookId, ask.names, chosen);
    libraryStore.chapters[ask.bookId] = chapters;
    await useJobsStore()._changed();
    const lines = linesIn(ask, chosen);
    useUiStore().toast(`Re-narrate · ${plural(lines, "line")}`, {
      kind: "info",
      description: `${ask.names.length === 1 ? ask.names[0] : plural(ask.names.length, "speaker")} in ${plural(jobs.length, "chapter")}. Queued on the server; progress is in the Queue.`,
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
  const speaker = ask.names.length ? { speaker: ask.names[0] } : {};
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

async function redoSpeed(ask: VoiceSpeedAsk, chosen: string[]): Promise<boolean> {
  const libraryStore = useLibraryStore();
  const uiStore = useUiStore();
  try {
    const { books } = await endpointSettingsService().redoVoiceSpeed(ask.ref, chosen);
    for (const b of books)
      if (b.chapters && libraryStore.chapters[b.bookId])
        libraryStore.chapters[b.bookId] = b.chapters;
    await useJobsStore()._changed();
    void Promise.all(ask.books.map((b) => staleMoved(b.bookId)));
    const shown = new Map(ask.books.map((b) => [b.bookId, b]));
    const sum = (of: (b: (typeof books)[number]) => number) => {
      const counted = books.filter((b) => of(b) > 0);
      return { lines: counted.reduce((n, b) => n + of(b), 0), books: counted.length };
    };
    const narrated = sum((b) => (b.jobs ? (shown.get(b.bookId)?.reNarrate ?? 0) : 0));
    const reapplied = sum((b) => {
      const s = shown.get(b.bookId);
      return b.reapplied && s ? s.reApply - s.unavailable : 0;
    });
    const say = (what: string, n: { lines: number; books: number }) =>
      `${what} · ${plural(n.lines, "line")} in ${plural(n.books, "book")}`;
    const parts = [
      ...(narrated.lines ? [say("Re-narrate", narrated)] : []),
      ...(reapplied.lines ? [say("Re-apply", reapplied)] : []),
    ];
    if (parts.length)
      uiStore.toast(parts[0], {
        kind: "info",
        description: `${parts[1] ? `${parts[1]}, free. ` : ""}Queued on the server; progress is in the Queue.`,
        timeout: 8000,
      });
    const refused = books.flatMap((b) => b.refused ?? []);
    if (refused.length)
      uiStore.toast("Some lines were not queued", {
        kind: "warn",
        description: refused.join(" "),
      });
    return true;
  } catch (cause) {
    toastFailure("queue the lines at the old speed", cause);
    return false;
  }
}

async function keepSpeed(ask: VoiceSpeedAsk, books: VoiceSpeedAsk["books"]): Promise<boolean> {
  const left = books.filter((b) => b.reApply);
  if (!left.length) return true;
  try {
    const ids = left.map((b) => b.bookId);
    const kept = await endpointSettingsService().keepVoiceSpeed(ask.ref, ids);
    void Promise.all(ids.map((id) => staleMoved(id)));
    if (kept) useUiStore().toast(`Kept the old sound · ${plural(kept, "line")}`, { kind: "info" });
    return true;
  } catch (cause) {
    toastFailure("keep the old sound", cause);
    return false;
  }
}

/** Lines in these chapters; `redoable` leaves out the ones only re-narrating changes. */
export function linesIn(ask: ExistingAsk, chosen: readonly number[], redoable = false): number {
  const picked = new Set(chosen);
  return ask.chapters
    .filter((c) => picked.has(c.id))
    .reduce((n, c) => n + c.lines - (redoable ? (c.unavailable ?? 0) : 0), 0);
}
