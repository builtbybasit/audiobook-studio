// Voice samples that came in a script file and wait with a speaker until someone clones them on the
// Voices tab or discards them. Nothing clones by itself, and the new voice goes to the speaker only
// if their voice is unchanged since the clone link was opened.
import { defineStore } from "pinia";
import type { RouteLocationRaw } from "vue-router";
import { cloningOf, type CloneSupport } from "@/lib/providers";
import { fetchCast } from "@/queries/cast";
import {
  ApiError,
  type LibraryService,
  libraryService,
  type StoredSamples,
} from "@/services/library";
import type { Endpoint, KeptSample, SpeakerSamples, VoiceRef } from "@/types";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { toastFailure } from "@/stores/toastFailure";
import { useUiStore } from "@/stores/ui";

interface SpeakerSamplesState {
  /** per book, what the server holds, as last read */
  waiting: Record<string, SpeakerSamples[]>;
}

/** What a clone link carries, so the Voices tab knows whose samples it is cloning. */
export interface CloneFromSamples {
  bookId: string;
  sampleId: number;
  speaker: string;
  /** the speaker's voice when the link was opened; the new voice replaces only this */
  was: VoiceRef | null;
}

/** How well a provider takes these: 2 all as they are, 1 each one but not so many, 0 not some. */
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
     * The enabled cloning endpoint a clone link opens: the first with the best `cloneFit`, else the
     * first that clones at all (the Voices tab then says what is in the way).
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
    _put(bookId: string, sample: SpeakerSamples): void {
      const list = (this.waiting[bookId] ?? []).filter((x) => x.id !== sample.id);
      this.waiting[bookId] = [...list, sample];
    },
    _take(bookId: string, ids: number[]): void {
      this.waiting[bookId] = (this.waiting[bookId] ?? []).filter((x) => !ids.includes(x.id));
    },
    async load(bookId: string): Promise<SpeakerSamples[]> {
      try {
        this.waiting[bookId] = await this._service().speakerSamples(bookId);
      } catch {
        // an unreadable list offers nothing and is asked again next time
      }
      return this.waitingOf(bookId);
    },
    /** Keep the samples `file` carries for these speakers (import); its Undo calls `_unstore`. */
    async _store(bookId: string, file: File, speakers: string[]): Promise<StoredSamples> {
      if (!speakers.length) return { stored: [], replaced: [] };
      try {
        const done = await this._service().storeSpeakerSamples(bookId, file, speakers);
        this._take(bookId, done.replaced);
        for (const s of done.stored) this._put(bookId, s);
        return done;
      } catch (cause) {
        toastFailure("keep the file's voice samples", cause);
        return { stored: [], replaced: [] };
      }
    },
    /** Put these aside silently. A 404 means the row is already gone (say, with its speaker), so done. */
    async _drop(bookId: string, ids: number[]): Promise<void> {
      const svc = this._service();
      this._take(bookId, ids);
      await Promise.all(
        ids.map((id) =>
          svc.discardSpeakerSamples(bookId, id).catch((cause) => {
            if (cause instanceof ApiError && cause.status === 404) return;
            toastFailure("put the voice samples aside", cause);
          }),
        ),
      );
    },
    /** Bring rows put aside back, silently unless one could not be. */
    async _restore(bookId: string, ids: number[]): Promise<void> {
      const svc = this._service();
      await Promise.all(
        ids.map((id) =>
          svc.restoreSpeakerSamples(bookId, id).then(
            (back) => this._put(bookId, back),
            (cause) => toastFailure("bring the voice samples back", cause),
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
    /** Discard a speaker's waiting samples. The server keeps them hidden a day, so a late Undo works. */
    async discard(bookId: string, sample: SpeakerSamples): Promise<boolean> {
      const svc = this._service();
      const uiStore = useUiStore();
      try {
        await svc.discardSpeakerSamples(bookId, sample.id);
      } catch (cause) {
        toastFailure("discard the voice samples", cause);
        return false;
      }
      this._take(bookId, [sample.id]);
      uiStore.toast(`Discarded the voice samples for ${sample.speaker}`, {
        description: "They go from this server for good after a day.",
        undo: () =>
          void svc.restoreSpeakerSamples(bookId, sample.id).then(
            (back) => this._put(bookId, back),
            (cause) => toastFailure("bring the voice samples back", cause),
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
        toastFailure("read the voice samples", cause);
        return null;
      }
    },
    /**
     * A voice was made from these samples: it goes to the speaker only if their voice is unchanged
     * since the link opened, and the samples stop waiting (the voice keeps them).
     */
    async afterClone(from: CloneFromSamples, voice: VoiceRef): Promise<"assigned" | "kept"> {
      const castStore = useCastStore();
      const uiStore = useUiStore();
      // the Voices tab has no book open, so the cast may not have been read yet
      if (!castStore.held(from.bookId)) {
        try {
          await fetchCast(from.bookId);
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
