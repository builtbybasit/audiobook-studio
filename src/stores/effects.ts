// The library's voice effects, its thought effect, and the actions on them. Read by `useEffects`;
// refusals are toasted and read back over. `update` applies at once and writes behind (one write
// per effect out at a time), and a read meanwhile keeps the edited copy so a slider never jumps.
// Book and speaker choices are their owners' (`library.setBookThoughts`, `cast.setEffect`).
import { toRaw } from "vue";
import { defineStore } from "pinia";

import type { EffectContext } from "@/lib/effects";
import { speedSplit } from "@/lib/providers";
import { clone } from "@/lib/utils";
import { fetchEffects, staleMoved } from "@/queries/effects";
import { fetchBook } from "@/queries/library";
import { fetchCast } from "@/queries/cast";
import { ApiError } from "@/services/http";
import { effectsService } from "@/services/effects";
import type {
  Effect,
  EffectUses,
  ExistingScope,
  SpeakerEffectUse,
  Step,
  ThoughtChoice,
} from "@/types";
import { useCastStore } from "@/stores/cast";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { toastFailure } from "@/stores/toastFailure";

/** How long an edited effect sits still before sending; a dragged slider sends its last value. */
export const EFFECT_WRITE_MS = 300;

/** What removing an effect took, so the page can say who lost it. */
export interface EffectTaken {
  effect: Effect;
  /** it was the library's thought effect, which is now "none" */
  library: boolean;
  /** books whose thought effect it was; they follow the library now */
  books: string[];
  /** speakers who wore it (`effect`) or thought in it (`thoughts`), of the casts read here */
  speakers: SpeakerEffectUse[];
}

interface EffectsState {
  /** in the order the library lists them */
  effects: Effect[];
  /** the library's thought effect: an effect's id, or "none" */
  libraryThoughts: ThoughtChoice;
  loaded: boolean;
}

/** One effect's write-behind: the send waiting to go, and the one out. */
interface Behind {
  timer: ReturnType<typeof setTimeout> | null;
  out: Promise<void> | null;
  /** edited again while `out` was on its way: sent once more when it lands */
  again: boolean;
}

/** Writes waiting or out, per store, outside reactive state. Keyed by the raw store (see cast). */
const pending = new WeakMap<object, { edits: Map<string, Behind>; thoughtsOut: number }>();

function pendingOf(store: object) {
  let p = pending.get(toRaw(store));
  if (!p) pending.set(toRaw(store), (p = { edits: new Map(), thoughtsOut: 0 }));
  return p;
}

const busy = (w: Behind | undefined): boolean => !!w && (!!w.timer || !!w.out);

/** "<name> Duplicated", then "<name> Duplicated (2)", (3)… while the name is taken. */
function duplicateName(name: string, taken: ReadonlySet<string>): string {
  const base = `${name} Duplicated`;
  let out = base;
  for (let n = 2; taken.has(out); n++) out = `${base} (${n})`;
  return out;
}

export const useEffectsStore = defineStore("effects", {
  state: (): EffectsState => ({ effects: [], libraryThoughts: "none", loaded: false }),
  getters: {
    /** Every effect by id; also what a line's `EffectContext.effects` is. */
    byId(s): ReadonlyMap<string, Effect> {
      return new Map(s.effects.map((e) => [e.id, e]));
    },
    /** What `chainsFor` / `thoughtEffectOf` read for a book, from what the stores hold now. */
    contextFor(s): (bookId: string) => EffectContext {
      const libraryStore = useLibraryStore();
      const castStore = useCastStore();
      const effects = new Map(s.effects.map((e) => [e.id, e]));
      return (bookId) => ({
        effects,
        library: s.libraryThoughts,
        book: libraryStore.bookById(bookId)?.thoughts ?? null,
        cast: new Map(
          castStore.charactersOf(bookId).flatMap((c) => {
            // as the server's `effectContext`: only a speed their endpoint can't take is made here
            const stretched = speedSplit(
              castStore.effectiveVoice(bookId, c.name).endpoint,
              castStore.effectiveSpeed(bookId, c.name),
            ).stretched;
            if (!c.effect && !c.thoughts && !c.personaOf && !stretched) return [];
            const own = { effect: c.effect, thoughts: c.thoughts, personaOf: c.personaOf };
            return [[c.name, stretched ? { ...own, stretched } : own] as const];
          }),
        ),
      });
    },
  },
  actions: {
    /**
     * Install the server's effects (`useEffects`). An effect with an edit waiting or out keeps its
     * newer local copy; so does the library's thought effect while its write is out.
     */
    _install(effects: Effect[], thoughts: ThoughtChoice): void {
      const p = pendingOf(this);
      const here = this.byId;
      this.effects = effects.map((e) => (busy(p.edits.get(e.id)) && here.get(e.id)) || e);
      if (!p.thoughtsOut) this.libraryThoughts = thoughts;
      this.loaded = true;
    },
    /**
     * A new effect at the end, or right after `after`, once the server gives it an id; offered as
     * a line effect when given a `useWhen`. Null if refused.
     */
    async create(
      name: string,
      chain: Step[],
      { after, useWhen }: { after?: string; useWhen?: string } = {},
    ): Promise<Effect | null> {
      try {
        const effect = await effectsService().create(
          useWhen ? { name, chain: clone(chain), useWhen } : { name, chain: clone(chain) },
          after,
        );
        const at = after ? this.effects.findIndex((e) => e.id === after) : -1;
        if (at < 0) this.effects.push(effect);
        else this.effects.splice(at + 1, 0, effect);
        return effect;
      } catch (cause) {
        toastFailure("add this effect", cause);
        return null;
      }
    },
    /**
     * Change an effect here at once and write it behind whole (`EFFECT_WRITE_MS`); `useWhen`
     * blank = none. Call it per slider move; `flush` sends now.
     */
    update(id: string, patch: { name?: string; chain?: Step[]; useWhen?: string }): void {
      const e = this.byId.get(id);
      if (!e) return;
      if (patch.name !== undefined) e.name = patch.name;
      if (patch.chain !== undefined) e.chain = patch.chain;
      if (patch.useWhen !== undefined) {
        if (patch.useWhen.trim()) e.useWhen = patch.useWhen;
        else delete e.useWhen;
      }
      const w = pendingOf(this).edits.get(id) ?? { timer: null, out: null, again: false };
      pendingOf(this).edits.set(id, w);
      if (w.timer) clearTimeout(w.timer);
      w.timer = setTimeout(() => void this._send(id), EFFECT_WRITE_MS);
    },
    /** Send an effect's waiting edit now; resolves once it and any edit made meanwhile landed. */
    _send(id: string): Promise<void> {
      const w = pendingOf(this).edits.get(id);
      if (!w) return Promise.resolve();
      if (w.timer) clearTimeout(w.timer);
      w.timer = null;
      if (w.out) {
        w.again = true;
        return w.out;
      }
      const run = async (): Promise<boolean> => {
        do {
          w.again = false;
          const e = this.byId.get(id);
          // removed here since: the removal is the write that counts
          if (!e) return false;
          try {
            await effectsService().update(clone(e));
          } catch (cause) {
            if (!this.byId.get(id)) return false;
            toastFailure("save this effect", cause);
            return true;
          }
          void staleMoved();
        } while (w.again);
        return false;
      };
      const out = run().then(async (refused) => {
        w.out = null;
        if (!refused) return;
        // what the server kept wins over the edit it refused, and over one made since
        if (w.timer) clearTimeout(w.timer);
        w.timer = null;
        await fetchEffects().catch(() => {});
      });
      w.out = out;
      return out;
    },
    /** Send every edit waiting to go, and resolve once all have landed. */
    async flush(): Promise<void> {
      const edits = pendingOf(this).edits;
      await Promise.all([...edits].filter(([, w]) => busy(w)).map(([id]) => this._send(id)));
    },
    /**
     * Remove an effect and every choice of it (library to "none", books to the library, speakers
     * to none or the book) and every line effect of it, as the server does. Null when refused and
     * read back.
     */
    async remove(id: string): Promise<EffectTaken | null> {
      const libraryStore = useLibraryStore();
      const castStore = useCastStore();

      const i = this.effects.findIndex((e) => e.id === id);
      if (i < 0) return null;
      const w = pendingOf(this).edits.get(id);
      if (w?.timer) clearTimeout(w.timer);
      pendingOf(this).edits.delete(id);
      const [effect] = this.effects.splice(i, 1);
      const taken: EffectTaken = {
        effect: effect!,
        library: this.libraryThoughts === id,
        books: libraryStore._dropEffect(id),
        speakers: castStore._dropEffect(id),
      };
      if (taken.library) this.libraryThoughts = "none";
      try {
        // the lines the server took it off, so no copy here writes it back
        useScriptsStore()._dropEffect(id, await effectsService().remove(id));
      } catch (cause) {
        toastFailure("remove this effect", cause);
        const casts = new Set(taken.speakers.map((s) => s.bookId));
        await Promise.all([
          fetchEffects(),
          ...taken.books.map((b) => fetchBook(b)),
          ...[...casts].map((b) => fetchCast(b)),
        ]).catch(() => {});
        return null;
      }
      void staleMoved();
      return taken;
    },
    /** Copy an effect, chain and `useWhen`, right after it, here and on the server. */
    async duplicate(id: string): Promise<Effect | null> {
      const source = this.byId.get(id);
      if (!source) return null;
      const name = duplicateName(source.name, new Set(this.effects.map((e) => e.name)));
      return await this.create(name, source.chain, { after: id, useWhen: source.useWhen });
    },
    /** Everywhere an effect is chosen, in every book. Null after a toast when the server could not say. */
    async usesOf(id: string): Promise<EffectUses | null> {
      try {
        return await effectsService().uses(id);
      } catch (cause) {
        toastFailure("find where this effect is used", cause);
        return null;
      }
    },
    /** The library's thought effect: an effect's id, or "none". True once the server has it. */
    async setLibraryThoughts(choice: ThoughtChoice): Promise<boolean> {
      if (choice === this.libraryThoughts) return true;
      this.libraryThoughts = choice;
      const p = pendingOf(this);
      p.thoughtsOut++;
      try {
        await effectsService().setLibraryThoughts(choice);
      } catch (cause) {
        p.thoughtsOut--;
        toastFailure("save the library's thought effect", cause);
        // a later choice still out says what is wanted; its own answer settles it
        if (!p.thoughtsOut) await fetchEffects().catch(() => {});
        return false;
      }
      p.thoughtsOut--;
      void staleMoved();
      return true;
    },
    /** Queue a Re-apply of a book's old-sound clips in scope, flushing edits first. True when queued. */
    async reapply(bookId: string, scope: ExistingScope = {}): Promise<boolean> {
      await this.flush();
      try {
        await effectsService().reapply(bookId, scope);
      } catch (cause) {
        toastFailure("re-apply this book's effects", cause);
        return false;
      }
      await useJobsStore()._changed();
      return true;
    },
    /** Let the old-sound clips in scope keep their sound; how many, or null when refused. */
    async keep(bookId: string, scope: ExistingScope): Promise<number | null> {
      try {
        const kept = await effectsService().keep(bookId, scope);
        void staleMoved(bookId);
        return kept;
      } catch (cause) {
        toastFailure("keep the old sound", cause);
        return null;
      }
    },
    /** The clip at `url` run through these chains in order, as a WAV to play; null when refused. */
    async preview(url: string, chains: Step[][]): Promise<Blob | null> {
      try {
        return await effectsService().preview(url, chains);
      } catch (cause) {
        toastFailure("preview this effect", cause);
        return null;
      }
    },
    /** The chain some Pedalboard code builds, or its `error` to show. Null (and a toast) if the ask failed. */
    async parse(code: string): Promise<{ chain: Step[] } | { error: string } | null> {
      try {
        return { chain: await effectsService().parse(code) };
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 400) return { error: cause.message };
        toastFailure("read this code", cause);
        return null;
      }
    },
  },
});
