import { toRaw } from "vue";
// Book cast, pronunciation and pacing; speech text stays separate from source prose. The cast is
// the server's (`useCast` reads it); each change is a request whose answer is installed. Undo is
// exact: a merge or removal records the lines that moved and puts back those (`attribute`).
// Writes go one at a time per book (`_write`), and an answer is installed only where no later
// change waits (`_answered`), so an older answer never puts back an older speaker.
import { fetchCast } from "@/queries/cast";
import { staleMoved } from "@/queries/effects";
import { speechReadiness } from "@/lib/endpoints";
import { norm } from "@/lib/scriptReview";
import { pronunciationMoved } from "@/lib/reading";
import { chapterSeconds, lexMatcher, pacingOrDefault, termOf } from "@/lib/speech";
import {
  characterSlot,
  characterVoiceFor,
  NARRATOR,
  newSpeaker,
  personaOwner,
  sameReading,
  speakerVoice,
  voiceRef,
} from "@/lib/cast";
import { clone } from "@/lib/utils";
import {
  type Cast,
  type ChapterLines,
  type LibraryService,
  libraryService,
  type MovedSpeakers,
  type SpeakerLines,
} from "@/services/library";
import type {
  CastStat,
  Character,
  CharacterVoice,
  EffectiveVoice,
  EffectSlot,
  Gender,
  LexEntry,
  MergeSuggestion,
  Pacing,
  RevisedLines,
  RoutingIssue,
  Segment,
  SpeakerEffectUse,
  ThoughtChoice,
  VoiceRef,
} from "@/types";
import { defineStore } from "pinia";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExistingLinesStore } from "@/stores/existingLines";
import { useLibraryStore } from "@/stores/library";
import { chapterTally, useScriptsStore } from "@/stores/scripts";
import { useSpeakerSamplesStore } from "@/stores/speakerSamples";
import { toastFailure } from "@/stores/toastFailure";
import { useUiStore } from "@/stores/ui";
interface CastState {
  characters: Record<string, Character[]>;
  lexicon: Record<string, LexEntry[]>;
}
const lineCount = (moved: RevisedLines[]) => moved.reduce((n, m) => n + m.ids.length, 0);
/** Undo of a request-backed change; resolves once the server agrees. */
type Undo = () => Promise<void>;
/** Which half of the cast a write sends, and so which half its answer may install. */
type Part = "characters" | "lexicon";
interface CastWrite {
  part: Part;
  /** the speaker a `_push` writes, so a second push of them while this waits joins it */
  speaker?: string;
  /** what this write resolves with, for a push that joins it */
  settled: Promise<unknown>;
  send: () => Promise<void>;
}
/** A book's cast and dictionary writes: one out at a time, the rest waiting in order. */
interface BookWrites {
  queue: CastWrite[];
  inFlight: boolean;
  running?: Promise<void>;
  /** a cast read arrived mid-write and was put off */
  deferred?: boolean;
  /** the cast is to be read back and installed once the writes land */
  reading?: boolean;
  /** refused writes, settled once the cast has been read back over them */
  owed: (() => void)[];
  /** writes answered so far, so a read can tell one landed under it */
  landed: number;
}
/**
 * Writes in flight, per store, outside reactive state. Keyed by the raw store: Pinia devtools hand
 * each action a fresh proxy as `this`.
 */
const pending = new WeakMap<object, Map<string, BookWrites>>();
/**
 * A speaker's counts before any line is counted; `castStats` starts from it. With no lines, their
 * first chapter sorts after every real one.
 */
export const newStat = (first = Number.MAX_SAFE_INTEGER): CastStat => ({
  lines: 0,
  thoughts: 0,
  chapters: new Set(),
  first,
});
export interface AutoVoiceAssignment {
  name: string;
  gender: Gender;
  voice: VoiceRef;
  voiceLabel: string;
  endpoint: string;
  matchedGender: boolean;
}
/**
 * `into` as it stood before a merge filled its blanks: the merge's aliases, persona link and filled
 * fields go back, edits made since stay.
 */
function unmerged(now: Character, was: Character): Character {
  const out: Character = { ...clone(now), aliases: was.aliases, personaOf: was.personaOf };
  if (!was.voice) out.voice = null;
  if (!was.effect) delete out.effect;
  if (!was.thoughts) delete out.thoughts;
  if (!was.description.trim()) out.description = was.description;
  if (was.gender === "?") out.gender = "?";
  return out;
}

export const useCastStore = defineStore("cast", {
  state: (): CastState => ({ characters: {}, lexicon: {} }),
  getters: {
    charactersOf(s): (id: string) => Character[] {
      return (id: string): Character[] => s.characters[id] ?? [];
    },
    lexiconOf(s): (bookId: string) => LexEntry[] {
      return (bookId: string): LexEntry[] => s.lexicon[bookId] ?? [];
    },
    /** Whether the cast is read: `charactersOf` is empty both before and for none. */
    held(s): (bookId: string) => boolean {
      return (bookId: string): boolean => bookId in s.characters;
    },
    pacingOf(): (bookId: string) => Pacing {
      const libraryStore = useLibraryStore();
      return (bookId: string): Pacing =>
        pacingOrDefault(libraryStore.books.find((b) => b.id === bookId)?.pacing);
    },
    lexUses(s): (bookId: string) => Record<number, number> {
      const scriptsStore = useScriptsStore();
      return (bookId: string) => {
        const list = s.lexicon[bookId] ?? [];
        const uses: Record<number, number> = Object.fromEntries(list.map((e) => [e.id, 0]));
        // each entry on its own, so one inside a longer term still counts; built once, and a
        // line that doesn't hold the term is passed over before its regex runs
        const each = list.map((e) => ({
          id: e.id,
          term: termOf(e).toLowerCase(),
          m: lexMatcher([e]),
        }));
        const prefix = bookId + ":";
        for (const k of Object.keys(scriptsStore.segments)) {
          if (!k.startsWith(prefix)) continue;
          for (const seg of scriptsStore.segments[k]) {
            const lower = seg.text.toLowerCase();
            for (const { id, term, m } of each)
              if (term && lower.includes(term)) uses[id] += m.hits(seg.text).length;
          }
        }
        return uses;
      };
    },
    lexSample(): (bookId: string, entry: LexEntry) => string {
      const scriptsStore = useScriptsStore();
      return (bookId: string, entry: LexEntry) => {
        const m = lexMatcher([entry]);
        const prefix = bookId + ":";
        for (const k of Object.keys(scriptsStore.segments)) {
          if (!k.startsWith(prefix)) continue;
          for (const seg of scriptsStore.segments[k]) if (m.hits(seg.text).length) return seg.text;
        }
        return "";
      };
    },
    /** Each book's cast by name (first of a name wins, as `find`), for per-line lookups. */
    byName(s): Record<string, Map<string, Character>> {
      const out: Record<string, Map<string, Character>> = {};
      for (const [bookId, cast] of Object.entries(s.characters)) {
        const m = (out[bookId] = new Map<string, Character>());
        for (const c of cast) if (!m.has(c.name)) m.set(c.name, c);
      }
      return out;
    },
    // the narration job's rule (`speakerVoice`): a voiceless linked persona uses their character's
    // voice, anyone else the book's Character voice, else the Narrator's
    effectiveVoice(): (bookId: string, name: string) => EffectiveVoice {
      const endpointsStore = useEndpointsStore();
      const libraryStore = useLibraryStore();

      return (bookId, name) => {
        const { ref, from, of } = speakerVoice(
          name,
          this.byName[bookId] ?? new Map(),
          libraryStore.bookById(bookId)?.characterVoice,
        );
        const r = endpointsStore.resolveVoice(ref);
        return {
          ref,
          own: from === "own",
          from,
          ...(of ? { of } : {}),
          voice: r?.voice.id ?? null,
          label: r ? r.voice.label : ref ? "missing" : null,
          endpoint: r?.endpoint ?? null,
        };
      };
    },
    /**
     * What the empty choice in a speaker's voice picker means: "Character voice", "Narrator’s
     * voice", or a linked persona's character's ("Wearer’s voice" when `masked`, a spoiler).
     */
    fallbackLabel(): (bookId: string, name: string) => string {
      const libraryStore = useLibraryStore();

      return (bookId, name) => {
        const cast = this.byName[bookId] ?? new Map<string, Character>();
        const c = cast.get(name);
        const cv = libraryStore.bookById(bookId)?.characterVoice;
        // the speaker as if they had no voice of their own
        const bare = {
          get: (n: string) => (n === name && c ? { ...c, voice: null } : cast.get(n)),
        };
        const { from, of } = speakerVoice(name, bare, cv);
        return from === "persona"
          ? c?.masked
            ? "Wearer’s voice"
            : `${of}’s voice`
          : from === "character"
            ? "Character voice"
            : "Narrator’s voice";
      };
    },
    /**
     * Voices the cast routes to that cannot render: gone, or endpoint paused or keyless
     * (`speechReadiness`); a cooldown is not an issue. Fallback slots are named "Character voice"
     * (by gender if split) or covered by the Narrator's or the persona's character's row.
     */
    routingIssues(): (bookId: string) => RoutingIssue[] {
      const endpointsStore = useEndpointsStore();
      const libraryStore = useLibraryStore();

      return (bookId) => {
        const out: RoutingIssue[] = [];
        const check = (name: string, ref: VoiceRef) => {
          const r = endpointsStore.resolveVoice(ref);
          if (!r) {
            out.push({ name, ref, reason: "voice no longer exists", kind: "missing" });
            return;
          }
          const { state } = speechReadiness(r.endpoint, Date.now());
          if (state === "paused" || state === "nokey")
            out.push({
              name,
              ref,
              reason: `${r.endpoint.name} ${state === "paused" ? "is paused" : "has no API key"}`,
              kind: state,
              endpoint: r.endpoint,
            });
        };
        const byName = this.byName[bookId] ?? new Map<string, Character>();
        const cast = this.characters[bookId] ?? [];
        for (const c of cast) if (c.voice) check(c.name, c.voice);
        const cv = libraryStore.bookById(bookId)?.characterVoice;
        if (cv) {
          const slots = new Set<ReturnType<typeof characterSlot>>();
          for (const c of cast)
            if (!c.voice && c.name !== NARRATOR && !personaOwner(c, byName))
              slots.add(characterSlot(cv, c.gender));
          for (const slot of slots) {
            const ref = cv[slot];
            if (ref) check(slot === "one" ? "Character voice" : `Character voice (${slot})`, ref);
          }
        }
        return out;
      };
    },
    castStats(): (bookId: string) => Record<string, CastStat> {
      const libraryStore = useLibraryStore();
      return (bookId: string): Record<string, CastStat> => {
        const stats: Record<string, CastStat> = {};
        for (const c of libraryStore.chapters[bookId] ?? [])
          // spoken lines, as `lineCounts` counts them, one chapter at a time
          for (const [name, t] of chapterTally(bookId, c.id).spoken) {
            const st = (stats[name] ??= newStat(c.id));
            st.lines += t.lines;
            st.thoughts += t.thoughts;
            st.chapters.add(c.id);
            if (c.id < st.first) st.first = c.id;
          }
        return stats;
      };
    },
    mergeSuggestions(s): (bookId: string) => MergeSuggestion[] {
      return (bookId: string): MergeSuggestion[] => {
        // names normalized once, not per pair: a 350-speaker cast is 120k pairs
        const cast = (s.characters[bookId] ?? [])
          .filter((c) => c.name !== "Narrator")
          .map(({ name, major, isNew, keep, aliases }) => {
            const n = norm(name);
            return {
              name,
              major,
              isNew,
              keep,
              n,
              words: new Set(n.split(" ")),
              aliases: new Set(aliases.map(norm)),
              noAliases: aliases.length === 0,
            };
          });
        // `keep` means "this name is its own speaker", so a dismissed suggestion stays dismissed.
        // A major speaker is never the one merged away.
        const minor = cast.filter((c) => !c.major && !c.keep);
        const out: MergeSuggestion[] = [];
        // one suggestion per name, the first pair that makes it
        const seen = new Set<string>();
        for (const a of cast)
          for (const b of minor) {
            if (a === b || seen.has(b.name)) continue;
            let reason: string | null = null;
            if (a.major && b.noAliases && a.aliases.has(b.n))
              reason = `“${b.name}” is a known alias of ${a.name}`;
            else if (a.n === b.n) continue;
            else if (b.n.length > 2 && a.words.has(b.n))
              reason = `“${b.name}” looks like a short form of ${a.name}`;
            else if (b.isNew && b.n.length > 3 && a.n.includes(b.n))
              reason = `“${b.name}” is contained in ${a.name}`;
            if (!reason) continue;
            seen.add(b.name);
            out.push({ from: b.name, into: a.name, reason });
          }
        return out;
      };
    },
  },
  actions: {
    // ---------- the seam ----------
    _service(): LibraryService {
      return libraryService();
    },
    /**
     * Install the server's cast (what `useCast` calls). A read arriving while a write is out or
     * waiting is put off and redone after `_drain`. `readAt` is `_readAt` when the read was asked;
     * if a write was answered since, the read may predate it, so it is dropped and redone.
     */
    _install(bookId: string, { characters, lexicon }: Cast, readAt?: number): void {
      const w = pending.get(toRaw(this))?.get(bookId);
      // no write answered since it was asked for, and none out or waiting but the read-back's
      const current = readAt == null || readAt === w?.landed;
      const free = !w?.inFlight || (w.reading && !w.queue.length);
      if (w && !(current && free)) {
        w.deferred = true;
        if (!w.inFlight) w.running = this._drain(bookId, w);
        return;
      }
      this.characters[bookId] = characters;
      this.lexicon[bookId] = lexicon;
    },
    /** Where this book's writes are, for a read to name when it lands (`_install`). */
    _readAt(bookId: string): number {
      return pending.get(toRaw(this))?.get(bookId)?.landed ?? 0;
    },
    /** Install a write's answer, each half only while no later write of it waits. */
    _answered(bookId: string, { characters, lexicon }: Partial<Cast>): void {
      const queue = pending.get(toRaw(this))?.get(bookId)?.queue ?? [];
      if (characters && !queue.some((w) => w.part === "characters"))
        this.characters[bookId] = characters;
      if (lexicon && !queue.some((w) => w.part === "lexicon")) this.lexicon[bookId] = lexicon;
    },
    /**
     * Send one cast or dictionary write in its turn; resolves as `send` does, or null when refused
     * (said, and the cast read back). `send` builds the request when its turn comes and passes the
     * answer to `_answered`. A push of a speaker already waiting joins that push.
     */
    _write<T>(
      bookId: string,
      part: Part,
      failure: string,
      send: () => Promise<T>,
      speaker?: string,
    ): Promise<T | null> {
      let mine = pending.get(toRaw(this));
      if (!mine) pending.set(toRaw(this), (mine = new Map()));
      let w = mine.get(bookId);
      if (!w) mine.set(bookId, (w = { queue: [], inFlight: false, owed: [], landed: 0 }));
      const waiting = speaker != null && w.queue.find((x) => x.speaker === speaker);
      if (waiting) return waiting.settled as Promise<T | null>;
      let resolve!: (value: T | null) => void;
      const settled = new Promise<T | null>((r) => (resolve = r));
      const book = w;
      w.queue.push({
        part,
        speaker,
        settled,
        send: async () => {
          try {
            resolve(await send());
          } catch (cause) {
            // the server's cast wins, read back once nothing else is waiting
            toastFailure(failure, cause);
            book.deferred = true;
            book.owed.push(() => resolve(null));
          } finally {
            book.landed++;
          }
        },
      });
      if (!w.inFlight) w.running = this._drain(bookId, w);
      return settled;
    },
    async _drain(bookId: string, w: BookWrites): Promise<void> {
      w.inFlight = true;
      try {
        while (w.queue.length || w.deferred) {
          if (w.queue.length) {
            await w.queue.shift()!.send();
            continue;
          }
          // All writes landed and a read was put off or a write refused: read again now.
          w.deferred = false;
          w.reading = true;
          const owed = w.owed.splice(0);
          try {
            await fetchCast(bookId);
          } catch {
            // the toast has said the server could not be reached, or the next read will
          } finally {
            w.reading = false;
          }
          for (const settle of owed) settle();
        }
      } finally {
        w.inFlight = false;
      }
    },
    /** Resolves once this book has no cast or dictionary write out or waiting, nor a read owed. */
    async _castSettled(bookId: string): Promise<void> {
      const w = pending.get(toRaw(this))?.get(bookId);
      while (w?.inFlight) await w.running;
    },
    // Changes made for another store (an import) are written in the same step, so no earlier
    // answer can land between and undo them.
    /** Add a new speaker here and write it; resolves as `_push`. */
    _addSpeaker(bookId: string, c: Character): Promise<boolean> {
      (this.characters[bookId] ??= []).push(c);
      return this._push(bookId, c.name);
    },
    /** Change some of a speaker's fields and write them; false when there is no such speaker. */
    _patchSpeaker(
      bookId: string,
      name: string,
      patch: Partial<Omit<Character, "name">>,
    ): Promise<boolean> {
      const c = this.characters[bookId]?.find((x) => x.name === name);
      if (!c) return Promise.resolve(false);
      Object.assign(c, patch);
      // a link set or removed by hand drops the model's finding, as on the server
      if ("personaOf" in patch) delete c.masked;
      return this._push(bookId, name);
    },
    /**
     * Add the new terms under the next ids, stale the clips that now read them, and write the
     * dictionary. Returns the count and the write (`_pushLexicon`), null at once when none.
     */
    _addTerms(
      bookId: string,
      entries: Omit<LexEntry, "id">[],
    ): { added: number; pushed: Promise<ChapterLines[] | null> } {
      const list = (this.lexicon[bookId] ??= []);
      let added = 0;
      for (const entry of entries) {
        if (list.some((e) => e.term === entry.term)) continue;
        list.push({ id: Math.max(0, ...list.map((e) => e.id)) + 1, ...entry });
        added++;
      }
      if (!added) return { added, pushed: Promise.resolve(null) };
      this._lexRestale(bookId);
      return { added, pushed: this._pushLexicon(bookId) };
    },
    /** Replace the entry of the same term; the caller writes it. */
    _replaceTerm(bookId: string, next: LexEntry): void {
      const list = this.lexicon[bookId] ?? [];
      const i = list.findIndex((e) => e.term === next.term);
      if (i >= 0) list[i] = next;
    },
    /** A removed book takes its cast and dictionary with it. */
    _dropBook(bookId: string): void {
      delete this.characters[bookId];
      delete this.lexicon[bookId];
    },
    /**
     * Write one speaker as they stand when the write's turn comes; for changes that move no lines.
     * True once the server has them, false when refused (read back over). `after` is the chapter
     * write that brought them in (`history._rewrite`): if it was refused and no line still names
     * them, they are taken off here again and this resolves false.
     */
    async _push(bookId: string, name: string, after?: Promise<boolean>): Promise<boolean> {
      const scriptsStore = useScriptsStore();

      const ok = await this._write(
        bookId,
        "characters",
        "save this speaker",
        async () => {
          if (after && !(await after) && !scriptsStore.lineCounts(bookId, null, true)[name]) {
            this.characters[bookId] = (this.characters[bookId] ?? []).filter(
              (x) => x.name !== name,
            );
            return false;
          }
          const c = this.characters[bookId]?.find((x) => x.name === name);
          if (c)
            this._answered(bookId, {
              characters: await this._service().putCharacter(bookId, clone(c)),
            });
          return true;
        },
        name,
      );
      return ok ?? false;
    },
    /** Remove speakers on the server, their lines going to the Narrator; null when refused. */
    _delete(bookId: string, names: string[]): Promise<MovedSpeakers | null> {
      const failure = names.length === 1 ? "remove this speaker" : "remove these speakers";
      return this._write(bookId, "characters", failure, async () => {
        const r = await this._service().removeCharacters(bookId, names);
        this._moved(
          bookId,
          r.characters,
          r.speakers.map((s) => ({ moved: s.moved, to: NARRATOR })),
        );
        return r;
      });
    },
    /** Put speakers back on exactly their lines: the undo of a merge or removal. */
    _attribute(bookId: string, speakers: SpeakerLines[], failure: string) {
      return this._write(bookId, "characters", failure, async () => {
        const r = await this._service().attribute(bookId, speakers);
        this._moved(
          bookId,
          r.characters,
          r.speakers.map((s) => ({ moved: s.moved, to: s.name })),
        );
        return true;
      });
    },
    /**
     * Install the server's cast, then each move: the speaker on its lines, and the revisions. A
     * clip goes stale as the server staled it: unless both speakers read alike (`sameReading`).
     */
    _moved(
      bookId: string,
      characters: Character[],
      moves: { moved: RevisedLines[]; to: string }[],
    ): void {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();
      const samplesStore = useSpeakerSamplesStore();

      // an unread cast cannot say two speakers read alike, so the clip needs speech
      const before = this.byName[bookId];
      const after = new Map(characters.map((c) => [c.name, c]));
      const cv = libraryStore.bookById(bookId)?.characterVoice;
      this._answered(bookId, { characters });
      // an unread chapter has nothing to move and reads its revision with its script
      for (const { moved, to } of moves)
        for (const { chapterId, ids, revision } of moved)
          scriptsStore._applyLines(
            bookId,
            chapterId,
            ids,
            { speaker: to },
            revision,
            (s) => !before || !sameReading(s.speaker, to, before, cv, after),
          );
      // a moved line may wear another effect now, and waiting samples moved with their speaker
      void staleMoved(bookId);
      if (bookId in samplesStore.waiting) void samplesStore.load(bookId);
    },
    /** Add speakers this chapter uses that the cast lacks. Returns their names for an undo. */
    _absorbCast(bookId: string, chId: number): string[] {
      const scriptsStore = useScriptsStore();

      const cast = (this.characters[bookId] ??= []);
      const added: string[] = [];
      for (const s of scriptsStore.segmentsOf(bookId, chId))
        if (!cast.some((c) => c.name === s.speaker)) {
          cast.push(newSpeaker(s.speaker, cast.length));
          added.push(s.speaker);
        }
      return added;
    },
    /** Take those speakers off again, but never one some line still gives words to. */
    _dropSpeakers(bookId: string, names: string[]): void {
      const scriptsStore = useScriptsStore();

      if (!names.length) return;
      const gone = new Set(names);
      // every line naming them, spoken or not: site text still names a speaker
      const lines = scriptsStore.lineCounts(bookId, null, true);
      const dropping = (this.characters[bookId] ?? []).filter(
        (c) => gone.has(c.name) && !lines[c.name],
      );
      this.characters[bookId] = (this.characters[bookId] ?? []).filter(
        (c) => !dropping.includes(c),
      );
      // no line names them, so removing them on the server moves nothing
      if (dropping.length)
        void this._delete(
          bookId,
          dropping.map((c) => c.name),
        );
    },
    /** Chapter length is the sum of what is actually rendered, plus the silence stitched between. */
    _retime(bookId: string, chId: number): void {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      if (!libraryStore.chapter(bookId, chId)) return;
      const segs = scriptsStore.segmentsOf(bookId, chId);
      libraryStore._patchChapter(bookId, chId, {
        duration: chapterSeconds(segs, this.pacingOf(bookId), libraryStore.bookById(bookId)),
      });
    },
    // ---------- pronunciation & pacing ----------
    // The dictionary rewrites terms on the way to the endpoint, so clips with the old spelling go
    // stale. A pause is stitched between clips, so changing one re-times and invalidates nothing.
    _lexSnapshot(bookId: string): () => void {
      const scriptsStore = useScriptsStore();

      const before = clone(this.lexicon[bookId] ?? []);
      const audio = scriptsStore._audioSnapshot(bookId);
      return () => {
        this.lexicon[bookId] = before;
        audio();
      };
    },
    /** Mark stale the clips that would now be sent different words. */
    _lexRestale(bookId: string): number {
      const scriptsStore = useScriptsStore();

      const say = lexMatcher(this.lexiconOf(bookId));
      return scriptsStore._restale(
        bookId,
        (s) => !!pronunciationMoved(s.audio, say.speak(s.text).text),
      );
    },
    _lexChanged(bookId: string, revert: () => void, label: string): void {
      const uiStore = useUiStore();

      const n = this._lexRestale(bookId);
      // The server stales the same clips and names them; Undo names them back so the server can
      // restore them to done rather than leave them for re-narration.
      const pushed = this._pushLexicon(bookId);
      uiStore.toast(label, {
        kind: n ? "warn" : "info",
        description: n
          ? `${n} rendered line${n === 1 ? "" : "s"} still read the old pronunciation — re-narrate to apply.`
          : "The book text is unchanged; the endpoint is sent the respelling.",
        // An Undo before the change is answered waits for it: landing after the revert, the answer
        // would undo the Undo.
        undo: () =>
          pushed.then(async (staled) => {
            revert();
            await this._pushLexicon(bookId, staled ?? undefined);
          }),
      });
    },
    /**
     * Write the dictionary whole. The server stales clips that read the old pronunciation and
     * restores to done those `restore` names that match again, with each chapter's new revision.
     * Returns the lines staled, for an Undo; null when refused.
     */
    _pushLexicon(bookId: string, restore?: ChapterLines[]): Promise<ChapterLines[] | null> {
      const scriptsStore = useScriptsStore();

      return this._write(bookId, "lexicon", "save the dictionary", async () => {
        const { entries, stale, restored } = await this._service().putLexicon(
          bookId,
          clone(this.lexicon[bookId] ?? []),
          restore,
        );
        this._answered(bookId, { lexicon: entries });
        // usually already stale here; this catches a clip only the server had. The lines and
        // revisions are the server's even if a later list is waiting.
        for (const { chapterId, ids, revision } of stale)
          scriptsStore._applyLines(bookId, chapterId, ids, {}, revision);
        for (const { chapterId, revision } of restored)
          scriptsStore._adoptRevision(bookId, chapterId, revision);
        return stale.map(({ chapterId, ids }) => ({ chapterId, ids }));
      });
    },
    addTerm(bookId: string, term = "", say = ""): number {
      const revert = this._lexSnapshot(bookId);
      const list = (this.lexicon[bookId] ??= []);
      const id = Math.max(0, ...list.map((e) => e.id)) + 1;
      list.push({ id, term: term.trim(), say: say.trim(), enabled: true });
      if (term.trim() && say.trim())
        this._lexChanged(bookId, revert, `“${term.trim()}” is said “${say.trim()}”`);
      else void this._pushLexicon(bookId);
      return id;
    },
    updateTerm(bookId: string, id: number, patch: Partial<LexEntry>): void {
      const e = this.lexiconOf(bookId).find((x) => x.id === id);
      if (!e) return;
      if (!(Object.keys(patch) as (keyof LexEntry)[]).some((k) => e[k] !== patch[k])) return;
      const revert = this._lexSnapshot(bookId);
      const was = { ...e };
      Object.assign(e, patch);
      const renamed = e.term !== was.term || e.say !== was.say;
      this._lexChanged(
        bookId,
        revert,
        patch.enabled != null && !renamed
          ? `“${e.term}” ${e.enabled ? "is applied again" : "is no longer applied"}`
          : `“${e.term}” is said “${e.say}”`,
      );
    },
    removeTerm(bookId: string, id: number): void {
      const list = this.lexiconOf(bookId);
      const e = list.find((x) => x.id === id);
      if (!e) return;
      const revert = this._lexSnapshot(bookId);
      list.splice(list.indexOf(e), 1);
      if (e.term && e.say)
        this._lexChanged(bookId, revert, `“${e.term}” removed from the dictionary`);
      else void this._pushLexicon(bookId);
    },
    /** Silence after one line, in seconds; null goes back to the book's pacing. */
    setPause(bookId: string, chId: number, segId: number, pause: number | null): void {
      const scriptsStore = useScriptsStore();

      // a line's pacing is part of the script, so it is written as an edit
      if (!scriptsStore._setPause(bookId, chId, segId, pause)) return;
      this._retime(bookId, chId);
      scriptsStore._commit(bookId, chId);
    },
    setPacing(bookId: string, patch: Partial<Pacing>): Promise<void> {
      const libraryStore = useLibraryStore();

      if (!libraryStore.bookById(bookId)) return Promise.resolve();
      const pacing = { ...this.pacingOf(bookId), ...patch };
      libraryStore._setPacing(bookId, pacing);
      return this._pacingChanged(bookId, pacing);
    },
    resetPacing(bookId: string): Promise<void> {
      const libraryStore = useLibraryStore();

      if (!libraryStore.bookById(bookId)?.pacing) return Promise.resolve();
      libraryStore._setPacing(bookId, null);
      return this._pacingChanged(bookId, null);
    },
    /**
     * Re-time the chapters whose scripts are here (an unread one would be all silence) so lengths
     * follow the slider, and write the pacing; the server re-times every narrated chapter and its
     * lengths are kept. Changed in-line pauses stale clips, which `_writeSettings` marks.
     */
    async _pacingChanged(bookId: string, pacing: Pacing | null): Promise<void> {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      for (const c of libraryStore.chaptersOf(bookId))
        if (scriptsStore.held(bookId, c.id)) this._retime(bookId, c.id);
      const answer = await libraryStore._writeSettings(
        bookId,
        { pacing },
        pacing ? "save the pacing" : "reset the pacing",
      );
      if (!answer) return;
      for (const { id, duration } of answer.chapters)
        libraryStore._patchChapter(bookId, id, { duration });
    },
    /** Lines in this book that carry a pause of their own. */
    pauseOverrides(bookId: string): {
      chId: number;
      seg: Segment;
    }[] {
      const scriptsStore = useScriptsStore();

      const prefix = bookId + ":";
      return Object.keys(scriptsStore.segments)
        .filter((k) => k.startsWith(prefix))
        .flatMap((k) =>
          scriptsStore.segments[k]
            .filter((s) => s.pause != null)
            .map((seg) => ({ chId: Number(k.slice(prefix.length)), seg })),
        )
        .sort((a, b) => a.chId - b.chId || a.seg.id - b.seg.id);
    },
    async renameCharacter(bookId: string, from: string, to: string): Promise<void> {
      const uiStore = useUiStore();

      to = (to ?? "").trim();
      if (!to || from === to) return;
      const cast = this.characters[bookId] ?? [];
      if (cast.some((c) => c.name === to)) {
        await this.mergeCharacter(bookId, from, to);
        return;
      }
      if (!cast.some((x) => x.name === from)) return;
      // the server moves the lines in every chapter; an undo renames back
      const undo = await this._rename(bookId, from, to);
      if (undo) uiStore.toast(`Renamed “${from}” to “${to}”`, { undo });
    },
    /**
     * Rename on the server and here; the old name stays on as an alias. Resolves to the undo (a
     * rename back, with the aliases as they were), or null.
     */
    async _rename(bookId: string, from: string, to: string): Promise<Undo | null> {
      const aliases = [...(this.characters[bookId]?.find((c) => c.name === from)?.aliases ?? [])];
      const ok = await this._write(bookId, "characters", "rename this speaker", async () => {
        const r = await this._service().renameCharacter(bookId, from, to);
        this._moved(bookId, r.characters, [{ moved: r.moved, to }]);
        return true;
      });
      if (!ok) return null;
      return async () => {
        if (await this._rename(bookId, to, from))
          await this._patchSpeaker(bookId, from, { aliases });
      };
    },
    mergeCharacter(bookId: string, from: string, into: string): Promise<void> {
      return this.mergeMany(bookId, [{ from, into }]);
    },
    /**
     * Fold each `from` into its `into` with one request, under one toast. Its Undo puts each
     * speaker back on exactly the lines that moved, since merged aliases cannot be told apart.
     * Self-merges and names the cast lacks are skipped; a refusal merges no one.
     */
    async mergeMany(bookId: string, merges: { from: string; into: string }[]): Promise<void> {
      const uiStore = useUiStore();

      const cast = this.characters[bookId] ?? [];
      const has = (name: string) => cast.some((c) => c.name === name);
      merges = merges
        .filter((m) => m.from !== m.into && has(m.from) && has(m.into))
        .map(({ from, into }) => ({ from, into }));
      if (!merges.length) return;
      const was = new Map(cast.map((c) => [c.name, clone(c)]));
      const froms = new Set(merges.map((m) => m.from));
      const intos = new Set(merges.map((m) => m.into));
      const intoOf = new Map(merges.map((m) => [m.from, m.into]));
      // the server moves or unlinks their personas; the Undo links back those still so
      const personas = cast.filter(
        (p) => p.personaOf && froms.has(p.personaOf) && !froms.has(p.name) && !intos.has(p.name),
      );
      const result = await this._write(bookId, "characters", "merge these speakers", async () => {
        const r = await this._service().mergeCharacters(bookId, merges);
        this._moved(
          bookId,
          r.characters,
          r.speakers.map((s, i) => ({ moved: s.moved, to: merges[i].into })),
        );
        return r;
      });
      if (!result) return;
      const n = result.speakers.reduce((sum, s) => sum + lineCount(s.moved), 0);
      const what =
        merges.length === 1
          ? `“${merges[0].from}” into ${merges[0].into}`
          : `${merges.length} speakers${intos.size === 1 ? ` into ${merges[0].into}` : ""}`;
      uiStore.toast(`Merged ${what} · ${n} line${n === 1 ? "" : "s"} moved`, {
        undo: async () => {
          // the last merge first; then those that stayed get back what the merge gave them
          const back: SpeakerLines[] = result.speakers
            .map((s) => ({ character: was.get(s.name)!, lines: s.moved, samples: s.samples }))
            .reverse();
          for (const into of intos) {
            const now = this.characters[bookId]?.find((c) => c.name === into);
            if (now && !froms.has(into))
              back.push({ character: unmerged(now, was.get(into)!), lines: [] });
          }
          for (const p of personas) {
            const now = this.characters[bookId]?.find((c) => c.name === p.name);
            if (now && (!now.personaOf || now.personaOf === intoOf.get(p.personaOf!)))
              back.push({ character: { ...clone(now), personaOf: p.personaOf }, lines: [] });
          }
          await this._attribute(bookId, back, "undo the merge");
        },
      });
      // a voice filled in from the merged speaker reaches the lines `into` already had
      const revoiced = [...intos].filter(
        (into) =>
          !froms.has(into) &&
          (was.get(into)?.voice ?? null) !==
            (this.characters[bookId]?.find((c) => c.name === into)?.voice ?? null),
      );
      if (revoiced.length) await useExistingLinesStore().askVoice(bookId, revoiced);
    },
    /** A speaker typed in by hand: not "new" in the review sense, and starts as main cast. False
     *  when the name is taken (offer a merge). With `personaOf` they join as that character's
     *  persona, which the server may refuse (`personaRefusal`). */
    addCharacter(bookId: string, name: string, personaOf?: string): boolean {
      const uiStore = useUiStore();

      name = (name ?? "").trim();
      const cast = (this.characters[bookId] ??= []);
      if (!name || cast.some((c) => c.name === name)) return false;
      const c: Character = {
        ...newSpeaker(name, cast.length),
        major: true,
        isNew: false,
        ...(personaOf ? { personaOf } : {}),
      };
      cast.push(c);
      void this._push(bookId, name);
      uiStore.toast(
        personaOf ? `Added “${name}” as a persona of ${personaOf}` : `Added “${name}”`,
        {
          description:
            "No lines are attributed to them yet — merge a detected name in, or re-script.",
          undo: () => {
            this.characters[bookId] = (this.characters[bookId] ?? []).filter((x) => x !== c);
            // no lines were attributed, so taking them off again moves nothing
            void this._delete(bookId, [name]);
          },
        },
      );
      return true;
    },
    /** Patch the speaker's own description (gender, notes, style, main/minor). Moves no line. */
    async updateCharacter(bookId: string, name: string, patch: Partial<Character>): Promise<void> {
      const c = this.characters[bookId]?.find((x) => x.name === name);
      if (!c) return;
      const { name: _name, aliases: _aliases, ...rest } = patch;
      // a link set or removed by hand drops the model's finding, as on the server
      const relinked = "personaOf" in rest && rest.personaOf !== c.personaOf;
      Object.assign(c, rest);
      if (relinked) delete c.masked;
      const saved = await this._push(bookId, name);
      // a voiceless persona reads in their character's voice, so a link moves their lines' voice
      if (saved && relinked && !c.voice) await useExistingLinesStore().askVoice(bookId, [name]);
    },
    /** Take the model's "masked" finding off a speaker; their link stays. */
    async unmask(bookId: string, name: string): Promise<void> {
      const c = this.characters[bookId]?.find((x) => x.name === name);
      if (!c?.masked) return;
      delete c.masked;
      await this._push(bookId, name);
    },
    /**
     * Give a speaker a voice, or null to fall back. Every picker writes through this: binding
     * `c.voice` directly would never reach the server. Once saved, lines already made with another
     * voice are asked about (`existingLines`).
     */
    async setVoice(bookId: string, name: string, voice: VoiceRef | null): Promise<void> {
      const c = this.characters[bookId]?.find((x) => x.name === name);
      if (!c || (c.voice ?? null) === voice) return;
      c.voice = voice;
      if (await this._push(bookId, name)) await useExistingLinesStore().askVoice(bookId, [name]);
    },
    /**
     * Write these speakers as they stand with one request, then ask about their lines made in
     * another voice (`existingLines`). False when refused.
     */
    async _pushVoices(bookId: string, names: string[], title?: string): Promise<boolean> {
      const ok = await this._write(bookId, "characters", "save these speakers", async () => {
        const list = (this.characters[bookId] ?? []).filter((c) => names.includes(c.name));
        if (list.length)
          this._answered(bookId, {
            characters: await this._service().putCharacters(
              bookId,
              list.map((c) => clone(c)),
            ),
          });
        return true;
      });
      if (ok) await useExistingLinesStore().askVoice(bookId, names, title);
      return ok ?? false;
    },
    /**
     * After the book's Character voice changed from `was`: ask about the lines of every speaker
     * whose fallback slot it moved (own-voiced speakers, voiced personas and the Narrator aside).
     */
    async _characterVoiceChanged(bookId: string, was: CharacterVoice | undefined): Promise<void> {
      const libraryStore = useLibraryStore();

      const cv = libraryStore.bookById(bookId)?.characterVoice;
      const byName = this.byName[bookId] ?? new Map<string, Character>();
      const names = (this.characters[bookId] ?? [])
        .filter(
          (c) =>
            c.name !== NARRATOR &&
            !c.voice &&
            !personaOwner(c, byName) &&
            characterVoiceFor(was, c.gender) !== characterVoiceFor(cv, c.gender),
        )
        .map((c) => c.name);
      if (names.length)
        await useExistingLinesStore().askVoice(bookId, names, "The Character voice changed");
    },
    /**
     * Put a voice effect on a speaker's lines, or null to remove it. Existing clips show in the
     * reread old-sound count. True once the server has it.
     */
    setEffect(bookId: string, name: string, id: string | null): Promise<boolean> {
      return this._setChoice(bookId, name, "effect", id);
    },
    /** A speaker's thought effect: an effect id, "none", or null to follow the book. */
    setThoughts(bookId: string, name: string, choice: ThoughtChoice | null): Promise<boolean> {
      return this._setChoice(bookId, name, "thoughts", choice);
    },
    async _setChoice(
      bookId: string,
      name: string,
      field: EffectSlot,
      choice: string | null,
    ): Promise<boolean> {
      const c = this.characters[bookId]?.find((x) => x.name === name);
      if (!c) return false;
      if (choice === null) delete c[field];
      else c[field] = choice;
      const ok = await this._push(bookId, name);
      if (ok) void staleMoved(bookId);
      return ok;
    },
    /** Clear a removed effect from every held cast, as the server did. Returns who had it, as what. */
    _dropEffect(id: string): SpeakerEffectUse[] {
      const out: SpeakerEffectUse[] = [];
      for (const [bookId, cast] of Object.entries(this.characters))
        for (const c of cast) {
          const effect = c.effect === id;
          const thoughts = c.thoughts === id;
          if (effect) delete c.effect;
          if (thoughts) delete c.thoughts;
          if (effect || thoughts) out.push({ bookId, name: c.name, effect, thoughts });
        }
      return out;
    },
    /** Dismiss a merge suggestion: the name stays its own speaker and stops being new. */
    async keepCharacter(bookId: string, name: string): Promise<void> {
      const c = this.characters[bookId]?.find((x) => x.name === name);
      if (!c) return;
      c.isNew = false;
      c.keep = true;
      await this._push(bookId, name);
    },
    /** An alias is matching metadata only; moving lines is `mergeCharacter`, so an existing
     *  speaker's name is refused. */
    addAlias(bookId: string, name: string, alias: string): boolean {
      alias = (alias ?? "").trim();
      const cast = this.characters[bookId] ?? [];
      const c = cast.find((x) => x.name === name);
      if (!c || !alias || alias === name) return false;
      if (cast.some((x) => x.name === alias)) return false;
      if (c.aliases.includes(alias)) return false;
      c.aliases = [...c.aliases, alias];
      void this._push(bookId, name);
      return true;
    },
    removeAlias(bookId: string, name: string, alias: string): void {
      const uiStore = useUiStore();

      const c = this.characters[bookId]?.find((x) => x.name === name);
      if (!c || !c.aliases.includes(alias)) return;
      c.aliases = c.aliases.filter((a) => a !== alias);
      void this._push(bookId, name);
      uiStore.toast(`Removed alias “${alias}”`, {
        undo: () => {
          const now = this.characters[bookId]?.find((x) => x.name === name);
          if (!now) return;
          now.aliases = [...now.aliases, alias];
          void this._push(bookId, name);
        },
      });
    },
    deleteCharacter(bookId: string, name: string): Promise<void> {
      return this.removeMany(bookId, [name]);
    },
    /**
     * Remove speakers with one request (lines go to the Narrator) under one toast and Undo. The
     * Narrator and unknown names are skipped; a refusal removes no one.
     */
    async removeMany(bookId: string, names: Iterable<string>): Promise<void> {
      const uiStore = useUiStore();

      const cast = this.characters[bookId] ?? [];
      const gone = [...new Set(names)].filter(
        (name) => name !== NARRATOR && cast.some((c) => c.name === name),
      );
      if (!gone.length) return;
      const was = new Map(cast.map((c) => [c.name, clone(c)]));
      // the server unlinks their personas; the Undo links back those still unlinked
      const personas = cast.filter(
        (p) => p.personaOf && gone.includes(p.personaOf) && !gone.includes(p.name),
      );
      const result = await this._delete(bookId, gone);
      if (!result) return;
      const n = result.speakers.reduce((sum, s) => sum + lineCount(s.moved), 0);
      const who = gone.length === 1 ? `“${gone[0]}”` : `${gone.length} speakers`;
      uiStore.toast(`Removed ${who} · ${n} line${n === 1 ? "" : "s"} now read by the Narrator`, {
        undo: async () => {
          const back: SpeakerLines[] = result.speakers.map((s) => ({
            character: was.get(s.name)!,
            lines: s.moved,
            samples: s.samples,
          }));
          for (const p of personas) {
            const now = this.characters[bookId]?.find((c) => c.name === p.name);
            if (now && !now.personaOf)
              back.push({ character: { ...clone(now), personaOf: p.personaOf }, lines: [] });
          }
          await this._attribute(
            bookId,
            back,
            gone.length === 1 ? "put this speaker back" : "put these speakers back",
          );
        },
      });
    },
    autoAssignPlan(bookId: string): AutoVoiceAssignment[] {
      const endpointsStore = useEndpointsStore();

      // pool: voices on enabled endpoints, grouped by the voice list's gender tag
      const all = endpointsStore.enabledEndpoints.flatMap((e) =>
        e.voices.map((v) => ({ ref: voiceRef(e.id, v.id), gender: v.gender })),
      );
      if (!all.length) return [];
      const byGender: Partial<Record<Gender, typeof all>> = {
        m: all.filter((v) => v.gender === "m"),
        f: all.filter((v) => v.gender === "f"),
        n: all.filter((v) => v.gender === "n"),
      };
      const used: Partial<Record<Gender, number>> = {};
      const plan: AutoVoiceAssignment[] = [];
      const byName = this.byName[bookId] ?? new Map<string, Character>();
      // an unread cast has no one to assign; a voiceless linked persona keeps their character's
      for (const c of this.characters[bookId] ?? []) {
        if (c.voice || c.name === "Narrator" || personaOwner(c, byName)) continue;
        const byG = byGender[c.gender];
        const pool = byG?.length ? byG : all;
        const i = used[c.gender] ?? 0;
        used[c.gender] = i + 1;
        const voice = pool[i % pool.length].ref;
        const resolved = endpointsStore.resolveVoice(voice)!;
        plan.push({
          name: c.name,
          gender: c.gender,
          voice,
          voiceLabel: resolved.voice.label,
          endpoint: resolved.endpoint.name,
          matchedGender: !!byG?.length,
        });
      }
      return plan;
    },
    autoAssignByGender(bookId: string): number {
      const uiStore = useUiStore();
      const plan = this.autoAssignPlan(bookId);
      if (!plan.length) return 0;
      const cast = this.characters[bookId];
      const assigned: string[] = [];
      for (const assignment of plan) {
        const character = cast.find((c) => c.name === assignment.name);
        if (character && !character.voice) {
          character.voice = assignment.voice;
          assigned.push(character.name);
        }
      }
      const title = `${plan.length} speaker${plan.length === 1 ? "" : "s"} voiced`;
      void this._pushVoices(bookId, assigned, title);
      uiStore.toast(`${plan.length} unvoiced speaker${plan.length === 1 ? "" : "s"} assigned`, {
        kind: "success",
        description: "Existing voice assignments were left alone.",
        // all of them had no voice of their own, so that is what they go back to
        undo: () => {
          for (const c of this.characters[bookId] ?? [])
            if (assigned.includes(c.name)) c.voice = null;
          void this._pushVoices(bookId, assigned);
        },
      });
      return plan.length;
    },
  },
});
