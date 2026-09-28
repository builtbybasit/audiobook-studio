// Voice samples that came in a script file and wait with a speaker. See docs/script-transfer.md,
// "Slice 3".
//
// A script file can carry the recordings a private voice was cloned from. Nothing here can speak
// with them — the voice lives on someone else's account — so they wait with the speaker until
// someone clones them on the Voices tab, or discards them. **Nothing clones by itself:** the clone
// link only fills the form, the person still ticks their own consent and presses the button, and
// only then does the new voice go to the speaker — and only if the speaker's voice is still the one
// they had when the link was opened, so a choice made meanwhile is never overwritten.
import { defineStore } from "pinia";
import type { RouteLocationRaw } from "vue-router";
import { canCloneVoices } from "@/lib/endpointShapes";
import { activeLibraryService, ApiError, type LibraryService } from "@/services/library";
import type { Endpoint, SpeakerSamples, VoiceRef } from "@/types";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";

interface SpeakerSamplesState {
  /** per book, what the server holds, as last read */
  waiting: Record<string, SpeakerSamples[]>;
}

/** What a clone link carries, so the Voices tab knows whose recordings it is making a voice from. */
export interface CloneFromSamples {
  bookId: string;
  sampleId: number;
  speaker: string;
  /** the speaker's voice when the link was opened; the new voice replaces only this */
  was: VoiceRef | null;
}

export const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const useSpeakerSamplesStore = defineStore("speakerSamples", {
  state: (): SpeakerSamplesState => ({ waiting: {} }),
  getters: {
    waitingOf(s): (bookId: string) => SpeakerSamples[] {
      return (bookId) => s.waiting[bookId] ?? [];
    },
    waitingFor(s): (bookId: string, speaker: string) => SpeakerSamples | null {
      return (bookId, speaker) => s.waiting[bookId]?.find((x) => x.speaker === speaker) ?? null;
    },
    /** The endpoint a clone link opens: the first enabled one whose provider keeps a cloned voice. */
    cloneEndpoint(): Endpoint | null {
      const endpointsStore = useEndpointsStore();
      return endpointsStore.endpoints.find((e) => e.enabled && canCloneVoices(e)) ?? null;
    },
    /** Where "Clone on the Voices tab" goes for these recordings; null when nothing can clone. */
    cloneLink(): (bookId: string, sample: SpeakerSamples) => RouteLocationRaw | null {
      const castStore = useCastStore();
      return (bookId, sample) => {
        const ep = this.cloneEndpoint;
        if (!ep) return null;
        const was = castStore.charactersOf(bookId).find((c) => c.name === sample.speaker)?.voice;
        return {
          path: "/endpoints",
          query: {
            endpoint: `tts:${ep.id}`,
            tab: "voices",
            book: bookId,
            samples: String(sample.id),
            speaker: sample.speaker,
            was: was ?? "",
          },
        };
      };
    },
  },
  actions: {
    _service(): LibraryService | null {
      return activeLibraryService();
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
    /** Read what waits with this book's speakers. Quietly nothing when there is no server. */
    async load(bookId: string): Promise<SpeakerSamples[]> {
      const svc = this._service();
      if (!svc) return [];
      try {
        this.waiting[bookId] = await svc.speakerSamples(bookId);
      } catch {
        // a list that could not be read offers nothing; it is asked again next time
      }
      return this.waitingOf(bookId);
    },
    /**
     * Keep the recordings `file` carries for these speakers. What an applied import calls; its Undo
     * calls `_drop` with what this answered.
     */
    async _store(bookId: string, file: File, speakers: string[]): Promise<SpeakerSamples[]> {
      const svc = this._service();
      if (!svc || !speakers.length) return [];
      try {
        const stored = await svc.storeSpeakerSamples(bookId, file, speakers);
        for (const s of stored) this._put(bookId, s);
        return stored;
      } catch (cause) {
        this._failed("keep the file's voice samples", cause);
        return [];
      }
    },
    /** Put these aside without a word — the Undo of the import that kept them. */
    async _drop(bookId: string, ids: number[]): Promise<void> {
      const svc = this._service();
      this._take(bookId, ids);
      if (!svc) return;
      await Promise.all(
        ids.map((id) =>
          svc.discardSpeakerSamples(bookId, id).catch((cause) => {
            this._failed("put the voice samples aside", cause);
          }),
        ),
      );
    },
    /**
     * Discard a speaker's waiting recordings. The server hides them at once and keeps them a day,
     * so the Undo — from the toast or ⌘Z, however late — brings them back while it still can.
     */
    async discard(bookId: string, sample: SpeakerSamples): Promise<boolean> {
      const svc = this._service();
      if (!svc) return false;
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
    /** The recordings, as files the clone form can send on. Null when they could not be read. */
    async files(bookId: string, sample: SpeakerSamples): Promise<File[] | null> {
      const svc = this._service();
      if (!svc) return null;
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
     * A voice was just made from these recordings. It goes to the speaker when their voice is still
     * the one they had when the link was opened — anything else is a choice made since, and is left
     * alone — and the recordings stop waiting: the voice keeps them now.
     */
    async afterClone(from: CloneFromSamples, voice: VoiceRef): Promise<"assigned" | "kept"> {
      const castStore = useCastStore();
      const uiStore = useUiStore();
      const svc = this._service();
      // the Voices tab has no book open, so the cast may not have been read yet
      if (svc && !castStore.characters[from.bookId]) {
        try {
          castStore._install(from.bookId, await svc.cast(from.bookId));
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
