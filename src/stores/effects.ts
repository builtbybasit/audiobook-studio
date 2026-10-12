// The library's voice effects, its thought effect, and the actions on them.
//
// The effects are the library's, not a book's: `useEffects` in `@/queries` reads them in, and
// every change here is a request whose refusal is said in a toast and read back over. An editor
// moves an effect on every step of a slider, so an edit is not a request each: `update` changes
// the effect here at once and writes it behind, a short while after the last change, one write of
// an effect out at a time — an edit made while one is out is sent once it lands, as the effect
// then stands. A read landing meanwhile keeps the edited copy (`_install`), so a slider never
// jumps back.
//
// A book's thought effect and a speaker's choices are their owners': `library.setBookThoughts`,
// `cast.setEffect` and `cast.setThoughts`. Removing an effect clears every choice of it on the
// server in one go, and here through each owner's `_dropEffect`.
import { toRaw } from "vue";
import { defineStore } from "pinia";

import type { EffectContext } from "@/lib/effects";
import { clone } from "@/lib/utils";
import { fetchEffects, staleMoved } from "@/queries/effects";
import { fetchBook } from "@/queries/library";
import { fetchCast } from "@/queries/cast";
import { ApiError } from "@/services/http";
import { effectsService } from "@/services/effects";
import type { Effect, Step, ThoughtChoice } from "@/types";
import { useCastStore } from "@/stores/cast";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { toastFailure } from "@/stores/toastFailure";

/** How long an edited effect sits still before it is sent: a slider dragged sends its last value. */
export const EFFECT_WRITE_MS = 300;

/** What removing an effect took, so the page can say who lost it. */
export interface EffectTaken {
  effect: Effect;
  /** it was the library's thought effect, which is now "none" */
  library: boolean;
  /** books whose thought effect it was; they follow the library now */
  books: string[];
  /** speakers who wore it (`effect`) or thought in it (`thoughts`), of the casts this page has read */
  speakers: { bookId: string; name: string; effect: boolean; thoughts: boolean }[];
}

interface EffectsState {
  /** in the order the library lists them */
  effects: Effect[];
  /** the library's thought effect: an effect's id, or "none" */
  libraryThoughts: ThoughtChoice;
  /** whether they have been read from the server yet */
  loaded: boolean;
}

/** One effect's write-behind: the send waiting to go, and the one out. */
interface Behind {
  timer: ReturnType<typeof setTimeout> | null;
  out: Promise<void> | null;
  /** edited again while `out` was on its way: sent once more when it lands */
  again: boolean;
}

/**
 * Writes waiting or out, per store instance, kept out of the reactive state. Keyed by the raw
 * store, as the cast store's are: devtools hand each action a fresh proxy as `this`.
 */
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
  // Nothing is here until it has been read from the server.
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
          castStore
            .charactersOf(bookId)
            .filter((c) => c.effect || c.thoughts)
            .map((c) => [c.name, { effect: c.effect, thoughts: c.thoughts }]),
        ),
      });
    },
  },
  actions: {
    /**
     * What the server holds, in place of what was here. What `useEffects` installs. An effect with
     * an edit waiting or out keeps the copy here, which is newer than any read of it; the library's
     * thought effect too, while a write of it is out.
     */
    _install(effects: Effect[], thoughts: ThoughtChoice): void {
      const p = pendingOf(this);
      const here = this.byId;
      this.effects = effects.map((e) => (busy(p.edits.get(e.id)) && here.get(e.id)) || e);
      if (!p.thoughtsOut) this.libraryThoughts = thoughts;
      this.loaded = true;
    },
    /** A new effect at the end of the list, once the server has given it its id; null if refused. */
    async create(name: string, chain: Step[]): Promise<Effect | null> {
      try {
        const effect = await effectsService().create(name, clone(chain));
        this.effects.push(effect);
        return effect;
      } catch (cause) {
        toastFailure("add this effect", cause);
        return null;
      }
    },
    /**
     * Change an effect's name or chain here at once, and write it behind (`EFFECT_WRITE_MS`). Call
     * it as often as a slider moves; `flush` sends what is waiting now.
     */
    update(id: string, patch: { name?: string; chain?: Step[] }): void {
      const e = this.byId.get(id);
      if (!e) return;
      if (patch.name !== undefined) e.name = patch.name;
      if (patch.chain !== undefined) e.chain = patch.chain;
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
            await effectsService().update(id, e.name, clone(e.chain));
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
     * Remove an effect, and every choice of it: the library's thought effect goes to "none", a
     * book's to following the library, a speaker's to none or to following the book — here at
     * once, as the server does. Resolves with what it took, or null when the server refused and
     * everything was read back.
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
        await effectsService().remove(id);
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
    /**
     * A copy of an effect named "<name> Duplicated" — " (2)" on, only while that is taken — placed
     * right after it. The server lists a new effect last, so after a reload it is there.
     */
    async duplicate(id: string): Promise<Effect | null> {
      const source = this.byId.get(id);
      if (!source) return null;
      const name = duplicateName(source.name, new Set(this.effects.map((e) => e.name)));
      const copy = await this.create(name, source.chain);
      if (!copy) return null;
      const made = this.effects.findIndex((e) => e.id === copy.id);
      const [moved] = this.effects.splice(made, 1);
      this.effects.splice(this.effects.findIndex((e) => e.id === id) + 1, 0, moved!);
      return copy;
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
    /**
     * Queue a Re-apply of a book's clips whose sound is old. Effect edits still waiting are sent
     * first, so it applies what the page shows. True when it was queued.
     */
    async reapply(bookId: string): Promise<boolean> {
      await this.flush();
      try {
        await effectsService().reapply(bookId);
      } catch (cause) {
        toastFailure("re-apply this book's effects", cause);
        return false;
      }
      await useJobsStore()._changed();
      return true;
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
    /**
     * The chain a piece of Pedalboard code builds, or why it builds none (`error`, for the page to
     * show beside the code). A failure to ask at all is a toast, and null.
     */
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
