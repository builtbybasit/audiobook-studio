// Voice samples that came in a script file and wait with a speaker. See docs/script-transfer.md,
// "Slice 3".
//
// A script file can carry the samples a private voice was cloned from. Nothing here can speak
// with them — the voice lives on someone else's account — so they wait with the speaker until
// someone clones them on the Voices tab, or discards them. **Nothing clones by itself:** the clone
// link only fills the form, the person still ticks their own consent and presses the button, and
// only then does the new voice go to the speaker — and only if the speaker's voice is still the one
// they had when the link was opened, so a choice made meanwhile is never overwritten.
import { defineStore } from "pinia";
import type { RouteLocationRaw } from "vue-router";
import { cloningOf, type CloneSupport } from "@/lib/providers";
import {
  ApiError,
  type LibraryService,
  libraryService,
  type StoredSamples,
} from "@/services/library";
import type { Endpoint, KeptSample, SpeakerSamples, VoiceRef } from "@/types";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";

interface SpeakerSamplesState {
  /** per book, what the server holds, as last read */
  waiting: Record<string, SpeakerSamples[]>;
}

/** What a clone link carries, so the Voices tab knows whose samples it is making a voice from. */
export interface CloneFromSamples {
  bookId: string;
  sampleId: number;
  speaker: string;
  /** the speaker's voice when the link was opened; the new voice replaces only this */
  was: VoiceRef | null;
}

/**
 * How well a provider takes these samples: 2 when it takes all of them as they are, 1 when it takes
 * each one's format and size but not so many, 0 when some sample is one it refuses.
 */
export function cloneFit(cloning: CloneSupport, samples: readonly KeptSample[]): number {
  const each = samples.every(
    (s) => cloning.formats.includes(s.format) && s.bytes <= cloning.maxSampleBytes,
  );
  if (!each) return 0;
  return samples.length <= cloning.maxSamples ? 2 : 1;
}

export const useSpeakerSamplesStore = defineStore("speakerSamples", {
  state: (): SpeakerSamplesState => ({ waiting: {} }),
  getters: {
    waitingOf(s): (bookId: string) => SpeakerSamples[] {
      return (bookId) => s.waiting[bookId] ?? [];
    },
    waitingFor(s): (bookId: string, speaker: string) => SpeakerSamples | null {
      return (bookId, speaker) => s.waiting[bookId]?.find((x) => x.speaker === speaker) ?? null;
    },
    /**
     * The endpoint a clone link opens for these samples: of the enabled ones whose provider keeps
     * a cloned voice, the first that takes every sample as it is, else the first that takes each
     * one's format and size (and makes a voice from as many as it takes), else the first that
     * clones at all — where the Voices tab says what stands in the way. Providers differ: one makes
     * a voice from a single file, another from twenty, and not every one takes every format.
     */
    cloneEndpointFor(): (sample: SpeakerSamples) => Endpoint | null {
      const endpointsStore = useEndpointsStore();
      return (sample) => {
        let best: Endpoint | null = null;
        let bestFit = -1;
        for (const e of endpointsStore.endpoints) {
          const cloning = e.enabled ? cloningOf(e) : null;
          if (!cloning) continue;
          const fit = cloneFit(cloning, sample.samples);
          if (fit > bestFit) [best, bestFit] = [e, fit];
        }
        return best;
      };
    },
    /** Where "Clone on the Voices tab" goes for these samples; null when nothing can clone. */
    cloneLink(): (bookId: string, sample: SpeakerSamples) => RouteLocationRaw | null {
      const castStore = useCastStore();
      return (bookId, sample) => {
        const ep = this.cloneEndpointFor(sample);
        if (!ep) return null;
        const was = castStore.charactersOf(bookId).find((c) => c.name === sample.speaker)?.voice;
        return {
          path: "/endpoints",
          query: {
            endpoint: `tts:${ep.id}`,
            tab: "voices",
            book: bookId,
            samples: String(sample.id),
            // no speaker: the row names them, and follows a rename the address would not
            was: was ?? "",
          },
        };
      };
    },
  },
  actions: {
    _service(): LibraryService {
      return libraryService();
    },
    _failed(what: string, cause: unknown): void {
      const uiStore = useUiStore();
      const api = cause instanceof ApiError ? cause : null;
      uiStore.toast(api ? api.message : `Could not ${what}`, {
        kind: "error",
        description: api?.detail ?? (cause instanceof Error ? cause.message : undefined),
        timeout: 8000,
      });
    },
    _put(bookId: string, sample: SpeakerSamples): void {
      const list = (this.waiting[bookId] ?? []).filter((x) => x.id !== sample.id);
      this.waiting[bookId] = [...list, sample];
    },
    _take(bookId: string, ids: number[]): void {
      this.waiting[bookId] = (this.waiting[bookId] ?? []).filter((x) => !ids.includes(x.id));
    },
    /** Read what waits with this book's speakers. */
    async load(bookId: string): Promise<SpeakerSamples[]> {
      try {
        this.waiting[bookId] = await this._service().speakerSamples(bookId);
      } catch {
        // a list that could not be read offers nothing; it is asked again next time
      }
      return this.waitingOf(bookId);
    },
    /**
     * Keep the samples `file` carries for these speakers. What an applied import calls; its Undo
     * hands what this answered to `_unstore`.
     */
    async _store(bookId: string, file: File, speakers: string[]): Promise<StoredSamples> {
      if (!speakers.length) return { stored: [], replaced: [] };
      try {
        const done = await this._service().storeSpeakerSamples(bookId, file, speakers);
        this._take(bookId, done.replaced);
        for (const s of done.stored) this._put(bookId, s);
        return done;
      } catch (cause) {
        this._failed("keep the file's voice samples", cause);
        return { stored: [], replaced: [] };
      }
    },
    /**
     * Put these aside without a word. A row the server no longer has — gone with a speaker the same
     * Undo removed, say — is already where this was taking it, so a 404 is done, not a failure.
     */
    async _drop(bookId: string, ids: number[]): Promise<void> {
      const svc = this._service();
      this._take(bookId, ids);
      await Promise.all(
        ids.map((id) =>
          svc.discardSpeakerSamples(bookId, id).catch((cause) => {
            if (cause instanceof ApiError && cause.status === 404) return;
            this._failed("put the voice samples aside", cause);
          }),
        ),
      );
    },
    /** Bring rows put aside back, without a word unless one could not be. */
    async _restore(bookId: string, ids: number[]): Promise<void> {
      const svc = this._service();
      await Promise.all(
        ids.map((id) =>
          svc.restoreSpeakerSamples(bookId, id).then(
            (back) => this._put(bookId, back),
            (cause) => this._failed("bring the voice samples back", cause),
          ),
        ),
      );
    },
    /** The Undo of `_store`: what it kept goes aside first, then what it replaced comes back. */
    async _unstore(bookId: string, done: StoredSamples): Promise<void> {
      await this._drop(
        bookId,
        done.stored.map((x) => x.id),
      );
      await this._restore(bookId, done.replaced);
    },
    /**
     * Discard a speaker's waiting samples. The server hides them at once and keeps them a day,
     * so the Undo — from the toast or ⌘Z, however late — brings them back while it still can.
     */
    async discard(bookId: string, sample: SpeakerSamples): Promise<boolean> {
      const svc = this._service();
      const uiStore = useUiStore();
      try {
        await svc.discardSpeakerSamples(bookId, sample.id);
      } catch (cause) {
        this._failed("discard the voice samples", cause);
        return false;
      }
      this._take(bookId, [sample.id]);
      uiStore.toast(`Discarded the voice samples for ${sample.speaker}`, {
        description: "They go from this server for good after a day.",
        undo: () =>
          void svc.restoreSpeakerSamples(bookId, sample.id).then(
            (back) => this._put(bookId, back),
            (cause) => this._failed("bring the voice samples back", cause),
          ),
      });
      return true;
    },
    /** The samples, as files the clone form can send on. Null when they could not be read. */
    async files(bookId: string, sample: SpeakerSamples): Promise<File[] | null> {
      const svc = this._service();
      try {
        return await Promise.all(
          sample.samples.map((k) => svc.speakerSampleFile(bookId, sample.id, k)),
        );
      } catch (cause) {
        this._failed("read the voice samples", cause);
        return null;
      }
    },
    /**
     * A voice was just made from these samples. It goes to the speaker when their voice is still
     * the one they had when the link was opened — anything else is a choice made since, and is left
     * alone — and the samples stop waiting: the voice keeps them now.
     */
    async afterClone(from: CloneFromSamples, voice: VoiceRef): Promise<"assigned" | "kept"> {
      const castStore = useCastStore();
      const uiStore = useUiStore();
      // the Voices tab has no book open, so the cast may not have been read yet
      if (!castStore.characters[from.bookId]) {
        try {
          castStore._install(from.bookId, await this._service().cast(from.bookId));
        } catch {
          // judged as not found below
        }
      }
      const c = castStore.charactersOf(from.bookId).find((x) => x.name === from.speaker);
      let outcome: "assigned" | "kept" = "kept";
      if (c && (c.voice ?? null) === from.was) {
        await castStore.updateCharacter(from.bookId, c.name, { voice });
        outcome = "assigned";
        uiStore.toast(`${from.speaker} speaks with the new voice`, {
          kind: "success",
          description: "It replaced the voice they had when the clone link was opened.",
          undo: () =>
            void castStore.updateCharacter(from.bookId, from.speaker, { voice: from.was }),
        });
      } else {
        uiStore.toast(`The new voice was not given to ${from.speaker}`, {
          kind: "info",
          description: c
            ? "Their voice changed after the clone link was opened, so it was left as chosen. The new voice is on the endpoint's list."
            : "They are no longer in the book's cast. The new voice is on the endpoint's list.",
        });
      }
      await this._drop(from.bookId, [from.sampleId]);
      return outcome;
    },
  },
});
