import type { Spoken } from "@/lib/speech";
// Book cast, pronunciation and pacing. Speech text stays separate from source prose.
//
// With a server answering, the cast is the server's: `useCast` in `@/queries` reads it in, and
// every change here is a request — a speaker written as stated, a rename or a merge that moves
// lines in every chapter, the dictionary replaced whole — with what comes back installed in place
// of what was here. An Undo is exact on both sides: a rename is renamed back, and a merge or a
// removal records the lines that moved and puts exactly those back (`attribute`), rather than
// restoring a snapshot the server never saw. The dictionary works the same way: a change reports
// the clips it staled, and its Undo names exactly those, for the server to put back to done.
import { keyring } from "@/lib/keyring";
import { key, norm } from "@/lib/scriptReview";
import { hitsIn, pacingOrDefault, silenceOf, speak } from "@/lib/speech";
import { clone } from "@/lib/utils";
import { newSpeaker, voiceRef } from "@/mock";
import {
  activeLibraryService,
  ApiError,
  type Cast,
  type ChapterLines,
  type LibraryService,
  type MovedLines,
} from "@/services/library";
import type {
  CastStat,
  Character,
  EffectiveVoice,
  Gender,
  LexEntry,
  MergeSuggestion,
  Pacing,
  RoutingIssue,
  Segment,
  SegmentMap,
  VoiceRef,
} from "@/types";
import { defineStore } from "pinia";
import { useEndpointsStore } from "@/stores/endpoints";
import { useHistoryStore } from "@/stores/history";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { seedState } from "@/stores/seed";
import { useUiStore } from "@/stores/ui";
interface CastState {
  characters: Record<string, Character[]>;
  lexicon: Record<string, LexEntry[]>;
}
/** What an undo of a request-backed change does; resolves once the server agrees. */
type Undo = () => Promise<void>;
export interface AutoVoiceAssignment {
  name: string;
  gender: Gender;
  voice: VoiceRef;
  voiceLabel: string;
  endpoint: string;
  matchedGender: boolean;
}
export const useCastStore = defineStore("cast", {
  // With a server answering, no cast is here until it has been read from it: the seeded casts
  // belong to seeded books.
  state: (): CastState =>
    activeLibraryService()
      ? { characters: {}, lexicon: {} }
      : { ...seedState("characters", "lexicon") },
  getters: {
    charactersOf(s): (id: string) => Character[] {
      return (id: string): Character[] => s.characters[id] ?? [];
    },
    lexiconOf(s): (bookId: string) => LexEntry[] {
      return (bookId: string): LexEntry[] => s.lexicon[bookId] ?? [];
    },
    pacingOf(): (bookId: string) => Pacing {
      const libraryStore = useLibraryStore();
      return (bookId: string): Pacing =>
        pacingOrDefault(libraryStore.books.find((b) => b.id === bookId)?.pacing);
    },
    spoken(s): (bookId: string, text: string) => Spoken {
      return (bookId: string, text: string) => speak(text, s.lexicon[bookId] ?? []);
    },
    lexUses(s): (bookId: string) => Record<number, number> {
      const scriptsStore = useScriptsStore();
      return (bookId: string) => {
        const list = s.lexicon[bookId] ?? [];
        const uses: Record<number, number> = Object.fromEntries(list.map((e) => [e.id, 0]));
        const prefix = bookId + ":";
        for (const k of Object.keys(scriptsStore.segments)) {
          if (!k.startsWith(prefix)) continue;
          for (const seg of scriptsStore.segments[k])
            // one entry at a time, so an entry that is currently shadowed by a longer one reads 0
            for (const e of list) uses[e.id] += hitsIn(seg.text, [e]).length;
        }
        return uses;
      };
    },
    lexSample(): (bookId: string, entry: LexEntry) => string {
      const scriptsStore = useScriptsStore();
      return (bookId: string, entry: LexEntry) => {
        const prefix = bookId + ":";
        for (const k of Object.keys(scriptsStore.segments)) {
          if (!k.startsWith(prefix)) continue;
          for (const seg of scriptsStore.segments[k])
            if (hitsIn(seg.text, [entry]).length) return seg.text;
        }
        return "";
      };
    },
    // a character with no voice of their own is read in the Narrator's voice
    effectiveVoice(): (bookId: string, name: string) => EffectiveVoice {
      const endpointsStore = useEndpointsStore();

      return (bookId, name) => {
        const cast = this.characters[bookId] ?? [];
        const c = cast.find((x) => x.name === name);
        const ref = c?.voice || cast.find((x) => x.name === "Narrator")?.voice || null;
        const r = endpointsStore.resolveVoice(ref);
        return {
          ref,
          own: !!c?.voice,
          voice: r?.voice.id ?? null,
          label: r ? r.voice.label : ref ? "missing" : null,
          endpoint: r?.endpoint ?? null,
        };
      };
    },
    routingIssues(): (bookId: string) => RoutingIssue[] {
      const endpointsStore = useEndpointsStore();

      return (bookId) => {
        const out: RoutingIssue[] = [];
        for (const c of this.characters[bookId] ?? []) {
          if (!c.voice) continue;
          const r = endpointsStore.resolveVoice(c.voice);
          if (!r)
            out.push({
              name: c.name,
              ref: c.voice,
              reason: "voice no longer exists",
              kind: "missing" as const,
            });
          else if (!r.endpoint.enabled)
            out.push({
              name: c.name,
              ref: c.voice,
              reason: `${r.endpoint.name} is paused`,
              kind: "paused" as const,
              endpoint: r.endpoint,
            });
          else if (r.endpoint.needsKey && !keyring.has(r.endpoint.id))
            out.push({
              name: c.name,
              ref: c.voice,
              reason: `${r.endpoint.name} has no API key`,
              kind: "nokey" as const,
              endpoint: r.endpoint,
            });
        }
        return out;
      };
    },
    castStats(): (bookId: string) => Record<string, CastStat> {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();
      return (bookId: string): Record<string, CastStat> => {
        const stats: Record<string, CastStat> = {};
        for (const c of libraryStore.chapters[bookId] ?? [])
          for (const seg of scriptsStore.segments[`${bookId}:${c.id}`] ?? []) {
            const st = (stats[seg.speaker] ??= { lines: 0, chapters: new Set(), first: c.id });
            st.lines++;
            st.chapters.add(c.id);
            if (c.id < st.first) st.first = c.id;
          }
        return stats;
      };
    },
    mergeSuggestions(s): (bookId: string) => MergeSuggestion[] {
      return (bookId: string): MergeSuggestion[] => {
        const cast = s.characters[bookId] ?? [];
        const out: MergeSuggestion[] = [];
        for (const a of cast)
          for (const b of cast) {
            // `keep` is the user saying "this name is its own speaker". Without it here the
            // suggestion came straight back on the next read, so dismissing it settled nothing —
            // and the review inbox would have listed the same decision for ever.
            if (a === b || a.name === "Narrator" || b.name === "Narrator" || b.keep) continue;
            const na = norm(a.name);
            const nb = norm(b.name);
            if (
              a.major &&
              !b.major &&
              b.aliases.length === 0 &&
              a.aliases.some((x) => norm(x) === nb)
            )
              out.push({
                from: b.name,
                into: a.name,
                reason: `“${b.name}” is a known alias of ${a.name}`,
              });
            else if (!b.major && na !== nb && na.split(" ").includes(nb) && nb.length > 2)
              out.push({
                from: b.name,
                into: a.name,
                reason: `“${b.name}” looks like a short form of ${a.name}`,
              });
            else if (!b.major && b.isNew && na !== nb && na.includes(nb) && nb.length > 3)
              out.push({
                from: b.name,
                into: a.name,
                reason: `“${b.name}” is contained in ${a.name}`,
              });
          }
        const seen = new Set<string>();
        return out.filter((x) => {
          const k = x.from;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      };
    },
  },
  actions: {
    // ---------- the seam ----------
    _service(): LibraryService | null {
      return activeLibraryService();
    },
    /** Say a request failed, and change nothing. */
    _failed(what: string, cause: unknown): void {
      const uiStore = useUiStore();
      const api = cause instanceof ApiError ? cause : null;
      uiStore.toast(api ? api.message : `Could not ${what}`, {
        kind: "error",
        description: api?.detail ?? (cause instanceof Error ? cause.message : undefined),
        timeout: 8000,
      });
    },
    /** The cast as the server holds it, in place of what was here. What `useCast` installs. */
    _install(bookId: string, { characters, lexicon }: Cast): void {
      this.characters[bookId] = characters;
      this.lexicon[bookId] = lexicon;
    },
    /**
     * Write one speaker to the server as they now stand here. Demo mode holds its own.
     *
     * For every change that moves no lines. What comes back is the cast as the server holds it,
     * which is what the store then holds; a change the server refused is read back over.
     */
    async _push(bookId: string, name: string): Promise<void> {
      const svc = this._service();
      const c = this.characters[bookId]?.find((x) => x.name === name);
      if (!svc || !c) return;
      try {
        this.characters[bookId] = await svc.putCharacter(bookId, clone(c));
      } catch (cause) {
        this._failed("save this speaker", cause);
        await this._reread(bookId);
      }
    },
    /** The server's cast over whatever was here, after a request it refused. */
    async _reread(bookId: string): Promise<void> {
      const svc = this._service();
      if (!svc) return;
      try {
        this._install(bookId, await svc.cast(bookId));
      } catch {
        // the failure has been said once already
      }
    },
    /**
     * Lines the server moved, applied here: the speaker on each, and the revision the chapter's
     * script is at now, so the next edit of it names the right one.
     */
    _moved(bookId: string, { characters, moved }: MovedLines, speaker: string): void {
      const scriptsStore = useScriptsStore();

      this.characters[bookId] = characters;
      for (const { chapterId, ids, revision } of moved) {
        const segs = scriptsStore.segments[key(bookId, chapterId)];
        if (segs) {
          const set = new Set(ids);
          for (const s of segs)
            if (set.has(s.id)) {
              s.speaker = speaker;
              scriptsStore._markStale(bookId, chapterId, s);
            }
        }
        // never backwards: an edit's answer for this chapter may have landed in between
        const k = key(bookId, chapterId);
        scriptsStore._revision[k] = Math.max(scriptsStore._revision[k] ?? 0, revision);
      }
    },
    // snapshots used by undo: the cast + every segment of a book (speakers live in both)
    _castSnapshot(bookId: string): () => void {
      const scriptsStore = useScriptsStore();

      const chars = clone(this.characters[bookId]);
      const segs: SegmentMap = {};
      for (const [k, v] of Object.entries(scriptsStore.segments))
        if (k.startsWith(bookId + ":")) segs[k] = clone(v);
      return () => {
        this.characters[bookId] = chars;
        for (const [k, v] of Object.entries(segs)) scriptsStore.segments[k] = v;
      };
    },
    /** Add any speaker this chapter uses that the cast does not have yet. Returns their names, so
     *  an undo of whatever brought them in can take exactly those back off again. */
    _absorbCast(bookId: string, chId: number): string[] {
      const scriptsStore = useScriptsStore();

      const cast = this.characters[bookId];
      const added: string[] = [];
      for (const s of scriptsStore.segmentsOf(bookId, chId))
        if (!cast.some((c) => c.name === s.speaker)) {
          cast.push(newSpeaker(s.speaker, cast.length));
          added.push(s.speaker);
        }
      return added;
    },
    /** Take those speakers off again — but never one that some line still gives words to. */
    _dropSpeakers(bookId: string, names: string[]): void {
      const scriptsStore = useScriptsStore();

      if (!names.length) return;
      const gone = new Set(names);
      const lines = scriptsStore.lineCounts(bookId);
      const dropping = (this.characters[bookId] ?? []).filter(
        (c) => gone.has(c.name) && !lines[c.name],
      );
      this.characters[bookId] = (this.characters[bookId] ?? []).filter(
        (c) => !dropping.includes(c),
      );
      // no line names them any more, so taking them off the server's cast moves nothing
      const svc = this._service();
      if (svc)
        for (const c of dropping)
          void svc
            .deleteCharacter(bookId, c.name)
            .then((r) => this._moved(bookId, r, "Narrator"))
            .catch((cause: unknown) => this._failed("remove this speaker", cause));
    },
    /** Chapter length is the sum of what is actually rendered, plus the silence stitched between. */
    _retime(bookId: string, chId: number): void {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      const c = libraryStore.chapter(bookId, chId);
      if (!c) return;
      const segs = scriptsStore.segmentsOf(bookId, chId);
      c.duration =
        segs.reduce((a, s) => a + s.audio.duration, 0) + silenceOf(segs, this.pacingOf(bookId));
    },
    // ---------- pronunciation & pacing ----------
    // Two ways to change how a book sounds without editing a word of it. The dictionary rewrites a
    // term on its way to the endpoint, so the clips that were rendered with the old spelling no
    // longer match and are marked stale. A pause is stitched between clips instead of rendered, so
    // changing one re-times the chapter and invalidates nothing.
    _lexSnapshot(bookId: string): () => void {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      const before = clone(this.lexicon[bookId] ?? []);
      const prefix = bookId + ":";
      const keys = Object.keys(scriptsStore.segments).filter((k) => k.startsWith(prefix));
      const audio = keys.flatMap((k) =>
        scriptsStore.segments[k].map((s) => [k, s.id, s.audio.status] as const),
      );
      const narration = libraryStore.chaptersOf(bookId).map((c) => [c.id, c.narration] as const);
      return () => {
        this.lexicon[bookId] = before;
        for (const [k, id, status] of audio) {
          const s = scriptsStore.segments[k]?.find((x) => x.id === id);
          if (s) s.audio.status = status;
        }
        for (const [id, was] of narration) {
          const c = libraryStore.chapter(bookId, id);
          if (c) c.narration = was;
        }
      };
    },
    /** Clips that would now be sent different words read the old pronunciation — mark them stale. */
    _lexRestale(bookId: string): number {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      let n = 0;
      const prefix = bookId + ":";
      for (const k of Object.keys(scriptsStore.segments)) {
        if (!k.startsWith(prefix)) continue;
        for (const s of scriptsStore.segments[k]) {
          const sent = s.audio.pronounced ?? s.audio.said ?? s.audio.text;
          if (s.audio.status !== "done" || sent == null) continue;
          if (this.spoken(bookId, s.text).text === sent) continue;
          s.audio.status = "stale";
          n++;
          const c = libraryStore.chapter(bookId, Number(k.slice(prefix.length)));
          if (c?.narration === "done") c.narration = "stale";
        }
      }
      return n;
    },
    _lexChanged(bookId: string, revert: () => void, label: string): void {
      const uiStore = useUiStore();

      const n = this._lexRestale(bookId);
      // The server stales the same clips by the same rule and says which; an Undo names exactly
      // those back to it, so it can put them back to done rather than leave them for re-narration.
      const pushed = this._pushLexicon(bookId);
      uiStore.toast(label, {
        kind: n ? "warn" : "info",
        description: n
          ? `${n} rendered line${n === 1 ? "" : "s"} still read the old pronunciation — re-narrate to apply.`
          : "The book text is unchanged; the endpoint is sent the respelling.",
        // Demo mode holds its own, so its Undo is as immediate as the change was. With a server
        // answering, an Undo clicked before the change has been answered waits for it: it has to
        // name the lines it staled, and the answer installs the new list and marks those lines
        // here — landing after the revert, it would undo the Undo.
        undo: () => {
          if (!this._service()) return revert();
          return pushed.then(async (staled) => {
            revert();
            await this._pushLexicon(bookId, staled ?? undefined);
          });
        },
      });
    },
    /**
     * The dictionary as it now stands here, written whole. Demo mode holds its own.
     *
     * The server stales every clip that now reads the old pronunciation, and puts back to done
     * those `restore` names that read this one again. Both come back with the revision each
     * chapter's script is at now, which is adopted so the next edit of it names the right one.
     * Returns the lines it staled, for an Undo to name; null when there is no server or it refused.
     */
    async _pushLexicon(bookId: string, restore?: ChapterLines[]): Promise<ChapterLines[] | null> {
      const scriptsStore = useScriptsStore();

      const svc = this._service();
      if (!svc) return null;
      try {
        const { entries, stale, restored } = await svc.putLexicon(
          bookId,
          clone(this.lexicon[bookId] ?? []),
          restore,
        );
        this.lexicon[bookId] = entries;
        for (const { chapterId, ids } of stale) {
          // usually already stale here by the same rule; this catches a clip only the server had
          const set = new Set(ids);
          for (const s of scriptsStore.segments[key(bookId, chapterId)] ?? [])
            if (set.has(s.id)) scriptsStore._markStale(bookId, chapterId, s);
        }
        for (const { chapterId, revision } of [...stale, ...restored]) {
          // never backwards: an edit's answer for this chapter may have landed in between
          const k = key(bookId, chapterId);
          scriptsStore._revision[k] = Math.max(scriptsStore._revision[k] ?? 0, revision);
        }
        return stale.map(({ chapterId, ids }) => ({ chapterId, ids }));
      } catch (cause) {
        this._failed("save the dictionary", cause);
        await this._reread(bookId);
        return null;
      }
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
      const historyStore = useHistoryStore();
      const scriptsStore = useScriptsStore();

      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s) return;
      // the pacing of a line is part of the script, so a nudge joins the editing session
      if ((s.pause ?? null) === pause) return;
      historyStore.noteEdit(bookId, chId);
      if (pause == null) delete s.pause;
      else s.pause = pause;
      this._retime(bookId, chId);
      scriptsStore._commit(bookId, chId);
    },
    setPacing(bookId: string, patch: Partial<Pacing>): void {
      const libraryStore = useLibraryStore();

      const b = libraryStore.bookById(bookId);
      if (!b) return;
      b.pacing = { ...this.pacingOf(bookId), ...patch };
      for (const c of libraryStore.chaptersOf(bookId)) this._retime(bookId, c.id);
    },
    resetPacing(bookId: string): void {
      const libraryStore = useLibraryStore();

      const b = libraryStore.bookById(bookId);
      if (!b?.pacing) return;
      delete b.pacing;
      for (const c of libraryStore.chaptersOf(bookId)) this._retime(bookId, c.id);
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
      const cast = this.characters[bookId];
      if (cast.some((c) => c.name === to)) {
        await this.mergeCharacter(bookId, from, to);
        return;
      }
      const c = cast.find((x) => x.name === from);
      if (!c) return;
      const svc = this._service();
      if (svc) {
        // The server moves the lines in every chapter and says which; an undo renames back.
        const undo = await this._remoteRename(bookId, from, to);
        if (undo) uiStore.toast(`Renamed “${from}” to “${to}”`, { undo });
        return;
      }
      const revert = this._castSnapshot(bookId);
      c.name = to;
      c.isNew = false;
      this._replaceSpeaker(bookId, from, to);
      uiStore.toast(`Renamed “${from}” to “${to}”`, { undo: revert });
    },
    /** A rename on the server, applied here. Resolves to the undo — a rename back — or null. */
    async _remoteRename(bookId: string, from: string, to: string): Promise<Undo | null> {
      const svc = this._service();
      if (!svc) return null;
      try {
        this._moved(bookId, await svc.renameCharacter(bookId, from, to), to);
      } catch (cause) {
        this._failed("rename this speaker", cause);
        return null;
      }
      return async () => {
        await this._remoteRename(bookId, to, from);
      };
    },
    async mergeCharacter(
      bookId: string,
      from: string,
      into: string,
      { silent = false } = {},
    ): Promise<void> {
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      if (from === into) return;
      const cast = this.characters[bookId];
      const src = cast.find((c) => c.name === from);
      const dst = cast.find((c) => c.name === into);
      if (!src || !dst) return;
      const svc = this._service();
      if (svc) {
        const merged = await this._remoteMerge(bookId, from, into);
        if (merged && !silent)
          uiStore.toast(
            `Merged “${from}” into ${into} · ${merged.lines} line${merged.lines === 1 ? "" : "s"} moved`,
            { undo: merged.undo },
          );
        return;
      }
      const revert = this._castSnapshot(bookId);
      const n = scriptsStore.lineCounts(bookId)[from] ?? 0;
      dst.aliases = [...new Set([...dst.aliases, from, ...src.aliases])];
      this.characters[bookId] = cast.filter((c) => c !== src);
      this._replaceSpeaker(bookId, from, into);
      if (!silent)
        uiStore.toast(`Merged “${from}” into ${into} · ${n} line${n === 1 ? "" : "s"} moved`, {
          undo: revert,
        });
    },
    /**
     * A merge on the server, applied here. Resolves to how many lines moved and the undo, which
     * puts the speaker back on exactly those lines — a merge folds aliases in and cannot be told
     * apart from ones that were already there, so the undo is recorded rather than inverted.
     */
    async _remoteMerge(
      bookId: string,
      from: string,
      into: string,
    ): Promise<{ lines: number; undo: Undo } | null> {
      const svc = this._service();
      const src = this.characters[bookId]?.find((c) => c.name === from);
      const dst = this.characters[bookId]?.find((c) => c.name === into);
      if (!svc || !src || !dst) return null;
      const was = { src: clone(src), dst: clone(dst) };
      let result: MovedLines;
      try {
        result = await svc.mergeCharacter(bookId, from, into);
      } catch (cause) {
        this._failed("merge these speakers", cause);
        return null;
      }
      this._moved(bookId, result, into);
      return {
        lines: result.moved.reduce((n, m) => n + m.ids.length, 0),
        undo: async () => {
          try {
            // the speaker as they were, on the lines that moved, and the other's aliases as they were
            this._moved(bookId, await svc.attribute(bookId, was.src, result.moved), from);
            const now = this.characters[bookId].find((c) => c.name === into);
            if (now) {
              now.aliases = was.dst.aliases;
              await this._push(bookId, into);
            }
          } catch (cause) {
            this._failed("undo the merge", cause);
          }
        },
      };
    },
    async mergeMany(bookId: string, names: string[], into: string): Promise<void> {
      const uiStore = useUiStore();

      const svc = this._service();
      if (svc) {
        const merged: { lines: number; undo: Undo }[] = [];
        for (const name of names)
          if (name !== into) {
            const m = await this._remoteMerge(bookId, name, into);
            if (m) merged.push(m);
          }
        if (merged.length)
          uiStore.toast(
            `Merged ${merged.length} speaker${merged.length === 1 ? "" : "s"} into ${into}`,
            {
              undo: async () => {
                for (const m of [...merged].reverse()) await m.undo();
              },
            },
          );
        return;
      }
      const revert = this._castSnapshot(bookId);
      let n = 0;
      for (const name of names)
        if (name !== into) {
          void this.mergeCharacter(bookId, name, into, { silent: true });
          n++;
        }
      if (n)
        uiStore.toast(`Merged ${n} speaker${n === 1 ? "" : "s"} into ${into}`, { undo: revert });
    },
    /** A speaker typed in by hand, before any line is attributed to them — so they are not "new"
     *  in the review sense (nothing detected them, you did) and start as main cast. Returns false
     *  when the name is taken; the caller should offer to merge instead. */
    addCharacter(bookId: string, name: string): boolean {
      const uiStore = useUiStore();

      name = (name ?? "").trim();
      const cast = (this.characters[bookId] ??= []);
      if (!name || cast.some((c) => c.name === name)) return false;
      const c: Character = { ...newSpeaker(name, cast.length), major: true, isNew: false };
      cast.push(c);
      void this._push(bookId, name);
      uiStore.toast(`Added “${name}”`, {
        description:
          "No lines are attributed to them yet — merge a detected name in, or re-script.",
        undo: () => {
          this.characters[bookId] = (this.characters[bookId] ?? []).filter((x) => x !== c);
          // no lines were attributed, so taking them off again moves nothing
          void this._service()
            ?.deleteCharacter(bookId, name)
            .then((r) => this._moved(bookId, r, "Narrator"))
            .catch((cause: unknown) => this._failed("remove this speaker", cause));
        },
      });
      return true;
    },
    /** Patch the fields that are the speaker's own description of themselves — gender, notes,
     *  delivery style, main/minor. Nothing here moves a line, so none of it needs a snapshot. */
    updateCharacter(bookId: string, name: string, patch: Partial<Character>): Promise<void> {
      const c = this.characters[bookId]?.find((x) => x.name === name);
      if (!c) return Promise.resolve();
      const { name: _name, aliases: _aliases, ...rest } = patch;
      Object.assign(c, rest);
      return this._push(bookId, name);
    },
    /** Dismiss a merge suggestion: the name stays as its own speaker, and stops being new. */
    keepCharacter(bookId: string, name: string): Promise<void> {
      const c = this.characters[bookId]?.find((x) => x.name === name);
      if (!c) return Promise.resolve();
      c.isNew = false;
      c.keep = true;
      return this._push(bookId, name);
    },
    /** An alias is a name the same speaker is called by. It is matching metadata only — moving
     *  lines from one name to another is `mergeCharacter`, which is why an existing speaker's name
     *  is refused here. */
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
    async deleteCharacter(bookId: string, name: string): Promise<void> {
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const svc = this._service();
      if (svc) {
        const c = this.characters[bookId]?.find((x) => x.name === name);
        if (!c) return;
        const was = clone(c);
        let result: MovedLines;
        try {
          result = await svc.deleteCharacter(bookId, name);
        } catch (cause) {
          this._failed("remove this speaker", cause);
          return;
        }
        this._moved(bookId, result, "Narrator");
        const n = result.moved.reduce((sum, m) => sum + m.ids.length, 0);
        uiStore.toast(
          `Removed “${name}” · ${n} line${n === 1 ? "" : "s"} now read by the Narrator`,
          {
            undo: async () => {
              try {
                this._moved(bookId, await svc.attribute(bookId, was, result.moved), name);
              } catch (cause) {
                this._failed("put this speaker back", cause);
              }
            },
          },
        );
        return;
      }
      const revert = this._castSnapshot(bookId);
      const n = scriptsStore.lineCounts(bookId)[name] ?? 0;
      void this.mergeCharacter(bookId, name, "Narrator", { silent: true });
      uiStore.toast(`Removed “${name}” · ${n} line${n === 1 ? "" : "s"} now read by the Narrator`, {
        undo: revert,
      });
    },
    autoAssignPlan(bookId: string): AutoVoiceAssignment[] {
      const endpointsStore = useEndpointsStore();

      // pool = voices on enabled endpoints, grouped by the gender tag the endpoint's voice list carries
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
      for (const c of this.characters[bookId]) {
        if (c.voice || c.name === "Narrator") continue;
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
      const revert = this._castSnapshot(bookId);
      const cast = this.characters[bookId];
      const assigned: string[] = [];
      for (const assignment of plan) {
        const character = cast.find((c) => c.name === assignment.name);
        if (character && !character.voice) {
          character.voice = assignment.voice;
          assigned.push(character.name);
        }
      }
      for (const name of assigned) void this._push(bookId, name);
      uiStore.toast(`${plan.length} unvoiced speaker${plan.length === 1 ? "" : "s"} assigned`, {
        kind: "success",
        description: "Existing voice assignments were left alone.",
        undo: () => {
          revert();
          for (const name of assigned) void this._push(bookId, name);
        },
      });
      return plan.length;
    },
    _replaceSpeaker(bookId: string, from: string, to: string): void {
      const scriptsStore = useScriptsStore();

      for (const k of Object.keys(scriptsStore.segments)) {
        if (!k.startsWith(bookId + ":")) continue;
        const chId = Number(k.split(":")[1]);
        for (const s of scriptsStore.segments[k])
          if (s.speaker === from) {
            s.speaker = to;
            scriptsStore._markStale(bookId, chId, s);
          }
      }
    },
  },
});
