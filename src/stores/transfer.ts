// A book's script as a file: reading one in, and applying it. The server answers with a plan and
// writes nothing; this store writes through the restore paths (`planRestore`, history, one Undo).
// Nothing the book has is overwritten by default: missing speakers and terms are added, and each
// difference is offered as "Use the file's". Voices, new library effects and the book's settings
// are each taken only when ticked.
import { key } from "@/lib/scriptReview";
import { NEW_EFFECT } from "@/lib/scriptFile";
import { planRestore, type RestoreOptions } from "@/lib/scriptHistory";
import { chapterNarration } from "@/lib/runPlan";
import { newSpeaker, personaRefusal } from "@/lib/cast";
import { clone } from "@/lib/utils";
import { fetchScript } from "@/queries/chapterScript";
import { staleMoved } from "@/queries/effects";
import { libraryService, type BookSettings } from "@/services/library";
import type {
  Book,
  Character,
  ImportChapter,
  RestorePlan,
  ScriptImportPlan,
  Segment,
  SpeakerDiff,
  TermDiff,
  VersionOrigin,
  Voice,
  VoiceRef,
} from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useEffectsStore } from "@/stores/effects";
import { useEndpointsStore } from "@/stores/endpoints";
import { useHistoryStore } from "@/stores/history";
import { storedBookPrompt, useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { useSpeakerSamplesStore } from "@/stores/speakerSamples";
import { toastFailure } from "@/stores/toastFailure";
import { useUiStore } from "@/stores/ui";

/** A voice chosen for a speaker: one this install has, or a public one to add first. */
export interface VoicePick {
  speaker: string;
  ref: VoiceRef;
  /** a public voice not on the endpoint yet, added before the speaker is given it */
  add?: { endpointId: string; voice: Voice };
}

/** What else the person ticked: new library effects by name, and the file's book settings. */
export interface ImportCarry {
  effects?: string[];
  book?: boolean;
}

export type SkipReason = "identical" | "busy" | "missing";

/** All writes landed, some were refused, or all were. */
export type ImportOutcome = "committed" | "partial" | "refused";

/** What an applied import did, for the page to read back. */
export interface ImportReport {
  outcome: ImportOutcome;
  /** chapters whose imported script the server took */
  applied: { chapterId: number; title: string }[];
  /** chapters whose write was refused, so they read as before */
  refused: { chapterId: number; title: string }[];
  skipped: { chapterId: number; title: string; why: SkipReason }[];
  /** speakers added to the cast (from the file or the lines) that the server took */
  speakers: string[];
  /** speakers the file named that no applied line uses, so not added */
  unused: string[];
  terms: number;
  voices: number;
  /** Speakers whose carried voice samples were kept to wait for a clone; the page reads which from the samples store. */
  samples: string[];
  /** effects added to the library, by name; Undo leaves them */
  effects: string[];
  /** the file's book settings were written */
  book: boolean;
}

interface TransferState {
  /** the plan the import page shows, per book */
  plans: Record<string, ScriptImportPlan>;
  /** set once a book's plan is applied: the page becomes the report */
  reports: Record<string, ImportReport>;
  /** chapters whose current script is still being read, so their preview can wait */
  loading: Record<string, true>;
  /** per book, once applied: the file's effect names this library has, with their ids */
  effectIds: Record<string, Record<string, string>>;
}

const n = (count: number, one: string, many = one + "s") => `${count} ${count === 1 ? one : many}`;

/**
 * The file each plan was read from, sent back on apply so the server can keep its voice samples.
 * Outside state: a `File` should not be reactive.
 */
const files = new Map<string, File>();

/** Each file-only effect (`NEW_EFFECT + name`) swapped for `idOf(name)`, dropped where undefined. */
export function carryEffects(
  segments: Segment[],
  idOf: (name: string) => string | undefined,
): Segment[] {
  return segments.map((s) => {
    if (!s.effects?.some((e) => e.startsWith(NEW_EFFECT))) return s;
    const effects = s.effects.flatMap((e) => {
      if (!e.startsWith(NEW_EFFECT)) return [e];
      const id = idOf(e.slice(NEW_EFFECT.length));
      return id ? [id] : [];
    });
    const { effects: _, ...rest } = s;
    return effects.length ? { ...rest, effects } : rest;
  });
}

type CarriedSlots = Partial<Pick<Character, "effect" | "thoughts">>;
/** The speaker fields a replace sets; a slot present as `undefined` is cleared. */
type SpeakerPatch = Partial<Pick<Character, "gender" | "description" | "style">> & CarriedSlots;
/**
 * A speaker's effect names as ids: a name with no id here leaves that slot out (the book's
 * stands), while a slot the file leaves empty is `undefined`, which clears it.
 */
function slotsOf(
  file: { effect?: string; thoughts?: string },
  idOf: (name: string) => string | undefined,
): CarriedSlots {
  const out: CarriedSlots = {};
  for (const slot of ["effect", "thoughts"] as const) {
    const name = file[slot];
    const id = name == null ? undefined : idOf(name);
    if (name == null || id) out[slot] = id;
  }
  return out;
}

/** The file's settings the book lacks, as the settings write takes them; empty = the default. */
function bookSettings(
  book: NonNullable<ScriptImportPlan["book"]>,
  idOf: (name: string) => string | undefined,
): BookSettings {
  const f = book.file;
  const out: BookSettings = {};
  for (const k of book.differ) {
    if (k === "pacing") out.pacing = f.pacing ?? null;
    else if (k === "prompt") out.prompt = f.prompt ? storedBookPrompt(f.prompt) : null;
    else if (k === "readNotes") out.readNotes = !!f.readNotes;
    else if (k === "characterVoice") out.characterVoice = f.characterVoice ?? null;
    else if (k === "thoughts") {
      const id = f.thoughts ? idOf(f.thoughts) : null;
      if (id !== undefined) out.thoughts = id;
    }
  }
  return out;
}

/** The book's own values for the keys `settings` names, to write back on Undo. */
function settingsNow(b: Book | undefined, settings: BookSettings): BookSettings {
  const now: BookSettings = {
    pacing: b?.pacing ?? null,
    prompt: b?.prompt ?? null,
    readNotes: !!b?.readNotes,
    thoughts: b?.thoughts ?? null,
    characterVoice: b?.characterVoice ?? null,
  };
  return clone(
    Object.fromEntries(Object.keys(settings).map((k) => [k, now[k as keyof BookSettings]])),
  );
}

/**
 * A restore's plan, except a line whose words the file corrected keeps its old clip (judged
 * stale) rather than dropping it: the comparison pairs it with the line it rewrites.
 */
export function planImport(
  current: Segment[],
  imported: Segment[],
  opts: RestoreOptions,
): RestorePlan {
  const plan = planRestore(current, imported, opts);
  // a clip is known by where it is and what it said: clips of one run can land in the same instant
  const clipKey = (s: Segment) => `${s.audio.url ?? ""}|${s.audio.at ?? ""}|${s.audio.text ?? ""}`;
  const carried = new Set(plan.segments.filter((s) => s.audio.duration > 0).map(clipKey));
  let moved = 0;
  for (const change of plan.comparison.changes) {
    if (change.kind !== "changed" || change.fromIds.length !== 1 || change.toIds.length !== 1)
      continue;
    if (!change.fields.some((f) => f.field === "text")) continue;
    const from = current.find((s) => s.id === change.fromIds[0]);
    const to = plan.segments.find((s) => s.id === change.toIds[0]);
    if (!from || !to || from.audio.duration <= 0 || to.audio.duration > 0) continue;
    if (carried.has(clipKey(from))) continue;
    to.audio = clone(from.audio);
    to.audio.status = "stale";
    if (from.flag) to.flag = { ...from.flag };
    carried.add(clipKey(from));
    moved++;
  }
  if (!moved) return plan;
  return {
    ...plan,
    stale: plan.stale + moved,
    dropped: Math.max(0, plan.dropped - moved),
    unrendered: Math.max(0, plan.unrendered - moved),
    narration: chapterNarration(plan.segments, opts.book),
  };
}

export const useTransferStore = defineStore("transfer", {
  state: (): TransferState => ({ plans: {}, reports: {}, loading: {}, effectIds: {} }),
  getters: {
    planOf(s): (bookId: string) => ScriptImportPlan | null {
      return (bookId) => s.plans[bookId] ?? null;
    },
    reportOf(s): (bookId: string) => ImportReport | null {
      return (bookId) => s.reports[bookId] ?? null;
    },
    /**
     * The file's effect names as this library's ids, once applied; `"none"` is a thought choice.
     * Undefined for one the library does not have.
     */
    effectIdOf(s): (bookId: string) => (name: string) => string | undefined {
      return (bookId) => (name) => (name === "none" ? name : s.effectIds[bookId]?.[name]);
    },
    /**
     * What "Use the file's" would set on a speaker, and what it would put back; null when nothing
     * would change. An effect this library lacks leaves the book's in place.
     */
    speakerChangeOf(): (
      bookId: string,
      d: SpeakerDiff,
    ) => { to: SpeakerPatch; was: SpeakerPatch } | null {
      const castStore = useCastStore();

      return (bookId, d) => {
        const c = castStore.charactersOf(bookId).find((x) => x.name === d.name);
        if (!c) return null;
        const { gender, description, style } = d.file;
        const to: SpeakerPatch = {
          gender,
          description,
          style,
          ...slotsOf(d.file, this.effectIdOf(bookId)),
        };
        const keys = Object.keys(to) as (keyof SpeakerPatch)[];
        if (keys.every((k) => c[k] === to[k])) return null;
        return { to, was: Object.fromEntries(keys.map((k) => [k, c[k]])) };
      };
    },
    /**
     * What applying one chapter would do, touching nothing. `take` names the new library effects
     * ticked; the lines drop the rest. Left out, all are taken.
     */
    previewOf(): (
      bookId: string,
      chapter: ImportChapter,
      take?: ReadonlySet<string>,
    ) => RestorePlan {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();
      const narrationStore = useNarrationStore();
      const scriptsStore = useScriptsStore();

      return (bookId, chapter, take) =>
        planImport(
          scriptsStore.segmentsOf(bookId, chapter.chapterId),
          take
            ? carryEffects(chapter.segments, (name) =>
                take.has(name) ? NEW_EFFECT + name : undefined,
              )
            : chapter.segments,
          {
            drift: (segment, audio) => narrationStore.clipDrift(bookId, segment, audio),
            cast: new Set(castStore.charactersOf(bookId).map((c) => c.name)),
            book: libraryStore.bookById(bookId),
          },
        );
    },
  },
  actions: {
    /** Get the server's plan for a file, and read the matched chapters' current scripts. */
    async readFile(bookId: string, file: File): Promise<ScriptImportPlan | null> {
      let plan: ScriptImportPlan;
      try {
        plan = await libraryService().planScriptImport(bookId, file);
      } catch (cause) {
        toastFailure("read this script file", cause);
        return null;
      }
      this.plans[bookId] = plan;
      this._hold(bookId, file);
      delete this.reports[bookId];
      delete this.effectIds[bookId];
      await this._loadScripts(
        bookId,
        plan.chapters.map((c) => c.chapterId),
      );
      return plan;
    },
    _hold(bookId: string, file: File): void {
      files.set(bookId, file);
    },
    /** Follow a renumbering; a chapter that went leaves the plan. */
    _remapBook(bookId: string, map: Record<number, number>): void {
      const plan = this.plans[bookId];
      if (!plan) return;
      this.plans[bookId] = {
        ...plan,
        chapters: plan.chapters.flatMap((c) =>
          map[c.chapterId] ? [{ ...c, chapterId: map[c.chapterId] }] : [],
        ),
      };
    },
    /** Drop the file and its report. */
    forget(bookId: string): void {
      files.delete(bookId);
      delete this.plans[bookId];
      delete this.reports[bookId];
      delete this.effectIds[bookId];
    },
    /** Read the scripts of these chapters that are not here yet, a few at a time. */
    async _loadScripts(bookId: string, ids: number[]): Promise<void> {
      const scriptsStore = useScriptsStore();
      const todo = ids.filter((id) => !scriptsStore.held(bookId, id));
      for (const id of todo) this.loading[key(bookId, id)] = true;
      const next = async (): Promise<void> => {
        const id = todo.shift();
        if (id == null) return;
        try {
          await fetchScript(bookId, id);
        } catch {
          // the preview says it could not read the chapter; applying it would be refused anyway
        } finally {
          delete this.loading[key(bookId, id)];
        }
        return next();
      };
      await Promise.all(Array.from({ length: 6 }, next));
    },

    // ---------- applying the plan ----------
    /**
     * Write the chosen chapters as a restore does (`history._rewrite`, origin `imported`), add what
     * the book lacks and set chosen voices, behind one Undo. Resolves once all writes are answered
     * with a report of what the server took; refused chapters are listed and left out of the Undo.
     * Ticked effects are made first, so lines and speakers can name them; Undo leaves them.
     */
    async apply(
      bookId: string,
      chapterIds: number[],
      voices: VoicePick[] = [],
      carry: ImportCarry = {},
    ): Promise<ImportReport | null> {
      const castStore = useCastStore();
      const effectsStore = useEffectsStore();
      const endpointsStore = useEndpointsStore();
      const historyStore = useHistoryStore();
      const libraryStore = useLibraryStore();
      const samplesStore = useSpeakerSamplesStore();
      const uiStore = useUiStore();

      const plan = this.plans[bookId];
      if (!plan) return null;
      const chosen = new Set(chapterIds);
      const report: ImportReport = {
        outcome: "committed",
        applied: [],
        refused: [],
        skipped: [],
        speakers: [],
        unused: [],
        terms: 0,
        voices: 0,
        samples: [],
        effects: [],
        book: false,
      };
      // ---- the effects: one already here by name is used rather than made twice (an import
      // applied again after its Undo)
      const ids = new Map(plan.effects.known.map((k) => [k.name, k.id]));
      const take = new Set(carry.effects ?? []);
      for (const e of plan.effects.add) {
        if (!take.has(e.name)) continue;
        const have = effectsStore.effects.find((x) => x.name === e.name);
        const made =
          have ??
          (await effectsStore.create(e.name, e.chain, e.useWhen ? { useWhen: e.useWhen } : {}));
        if (!made) continue;
        ids.set(e.name, made.id);
        if (!have) report.effects.push(e.name);
      }
      this.effectIds[bookId] = Object.fromEntries(ids);
      const idOf = this.effectIdOf(bookId);

      // ---- the scripts, worked out before anything changes, so a skipped chapter changes nothing
      const writes: { chapter: ImportChapter; restore: RestorePlan }[] = [];
      for (const fileChapter of plan.chapters) {
        if (!chosen.has(fileChapter.chapterId)) continue;
        const chapter = { ...fileChapter, segments: carryEffects(fileChapter.segments, idOf) };
        const why: SkipReason | null = !libraryStore.chapter(bookId, chapter.chapterId)
          ? "missing"
          : historyStore.busyJobs(bookId, chapter.chapterId).length
            ? "busy"
            : null;
        const restore = why ? null : this.previewOf(bookId, chapter);
        if (why || !restore || restore.comparison.identical) {
          report.skipped.push({
            chapterId: chapter.chapterId,
            title: chapter.title,
            why: why ?? "identical",
          });
          continue;
        }
        writes.push({ chapter, restore });
      }
      // counted from what is written, so a skipped (identical or busy) chapter is not claimed
      const origin: VersionOrigin = { kind: "imported", file: plan.name, chapters: writes.length };

      // ---- the cast: the file's speakers the applied lines use, with the file's details. Each
      // change is written in the step that makes it; `pushed` keeps each speaker's last write
      const cast = () => castStore.charactersOf(bookId);
      const castBefore = clone(cast());
      const used = new Set(writes.flatMap((w) => w.restore.segments.map((s) => s.speaker)));
      const pushed = new Map<string, Promise<boolean>>();
      const added: string[] = [];
      // personas last, so their character is in the cast first; a link that would be refused
      // (`personaRefusal`) is dropped and the persona keeps a voice of their own
      const personasLast = [...plan.cast.add].sort((a, b) => +!!a.personaOf - +!!b.personaOf);
      for (const speaker of personasLast) {
        if (cast().some((c) => c.name === speaker.name)) continue;
        if (!used.has(speaker.name)) {
          report.unused.push(speaker.name);
          continue;
        }
        const c: Character = {
          ...newSpeaker(speaker.name, cast().length),
          aliases: [...speaker.aliases],
          gender: speaker.gender,
          description: speaker.description,
          style: speaker.style,
          ...(speaker.color ? { color: speaker.color } : {}),
          ...(speaker.major != null ? { major: speaker.major } : {}),
          ...(speaker.personaOf && !personaRefusal(speaker.name, speaker.personaOf, cast())
            ? { personaOf: speaker.personaOf }
            : {}),
          ...slotsOf(speaker, idOf),
        };
        pushed.set(c.name, castStore._addSpeaker(bookId, c));
        added.push(c.name);
      }
      // aliases only add ways to recognise someone, so a union loses nothing
      const aliased: string[] = [];
      for (const { name, add } of plan.cast.aliases) {
        const c = cast().find((x) => x.name === name);
        const fresh = add.filter(
          (a) => a !== name && !c?.aliases.includes(a) && !cast().some((x) => x.name === a),
        );
        if (!c || !fresh.length) continue;
        pushed.set(
          name,
          castStore._patchSpeaker(bookId, name, { aliases: [...c.aliases, ...fresh] }),
        );
        aliased.push(name);
      }

      // ---- the chapters, each written the way a restore writes one
      // taken before any script changes, so a dictionary Undo restores pre-import clip statuses
      const revertLex = castStore._lexSnapshot(bookId);
      const rewrites = writes.map(({ chapter, restore }) => ({
        chapter,
        write: historyStore._rewrite(
          bookId,
          chapter.chapterId,
          restore,
          origin,
          chapter.recap != null
            ? { to: chapter.recap, back: chapter.recapBefore ?? "" }
            : undefined,
        ),
      }));
      // a speaker no cast has (a lone chapter file carries none) comes in unreviewed, written once
      // its chapter's write lands, and not at all when only a refused write named it
      for (const { write } of rewrites)
        write.absorbed.forEach((name, i) => pushed.set(name, write.pushed[i]));
      const speakers = [...added, ...rewrites.flatMap((r) => r.write.absorbed)];

      // ---- the dictionary: terms the book lacks
      const { added: terms, pushed: lexPushed } = castStore._addTerms(
        bookId,
        plan.lexicon.add.map((t) => ({
          term: t.term,
          say: t.say,
          enabled: t.enabled,
          ...(t.ipa ? { ipa: t.ipa } : {}),
          ...(t.note ? { note: t.note } : {}),
          ...(t.matchCase ? { matchCase: true } : {}),
        })),
      );

      // ---- the voices the person ticked
      const addedVoices: { endpointId: string; voiceId: string }[] = [];
      const voiced: { name: string; voice: VoiceRef | null; pushed: Promise<boolean> }[] = [];
      for (const pick of voices) {
        const c = cast().find((x) => x.name === pick.speaker);
        if (!c) continue;
        if (pick.add) {
          const ep = endpointsStore.endpoints.find((e) => e.id === pick.add!.endpointId);
          if (!ep) continue;
          if (endpointsStore.addVoice(ep, pick.add.voice))
            addedVoices.push({ endpointId: ep.id, voiceId: pick.add.voice.id });
        }
        if (c.voice === pick.ref) continue;
        voiced.push({
          name: c.name,
          voice: c.voice,
          pushed: castStore._patchSpeaker(bookId, c.name, { voice: pick.ref }),
        });
      }

      // ---- samples for a private voice this install cannot reach wait with the speaker until
      // someone clones them
      const file = files.get(bookId);
      report.samples = file
        ? (plan.voices ?? [])
            .filter(
              (row) =>
                row.samples?.kind === "ok" &&
                (row.match.kind === "private" || row.match.kind === "unchecked") &&
                cast().some((c) => c.name === row.speaker),
            )
            .map((row) => row.speaker)
        : [];
      // after the speakers are on the server, which must know them
      const storing =
        file && report.samples.length
          ? Promise.all(pushed.values()).then(() =>
              samplesStore._store(bookId, file, report.samples),
            )
          : Promise.resolve({ stored: [], replaced: [] });

      // ---- what landed: only that is reported and undone; refusals were already read back over
      const [chaptersLanded, castLanded, staled, voicesLanded] = await Promise.all([
        Promise.all(rewrites.map((r) => r.write.landed)),
        Promise.all(pushed.values()),
        lexPushed,
        Promise.all(voiced.map((v) => v.pushed)),
      ]);
      const landed = rewrites.filter((_, i) => chaptersLanded[i]);
      report.applied = landed.map(({ chapter }) => ({
        chapterId: chapter.chapterId,
        title: chapter.title,
      }));
      report.refused = rewrites
        .filter((_, i) => !chaptersLanded[i])
        .map(({ chapter }) => ({ chapterId: chapter.chapterId, title: chapter.title }));
      const onServer = new Set([...pushed.keys()].filter((_, i) => castLanded[i]));
      report.speakers = speakers.filter((name) => onServer.has(name));
      const aliasedNow = aliased.filter((name) => onServer.has(name));
      report.terms = staled ? terms : 0;
      const voicedNow = voiced.filter((_, i) => voicesLanded[i]);
      report.voices = voicedNow.length;

      // ---- the book's settings, once the scripts are in: a pacing change moves their revisions
      const settings = carry.book && plan.book ? bookSettings(plan.book, idOf) : {};
      const bookBefore = settingsNow(libraryStore.bookById(bookId), settings);
      const wantBook = Object.keys(settings).length > 0;
      if (wantBook) {
        const was = libraryStore.bookById(bookId)?.characterVoice;
        report.book = await this._writeBook(bookId, settings, "use the file's book settings");
        if (report.book && "characterVoice" in settings)
          void castStore._characterVoiceChanged(bookId, was && { ...was });
      }
      const outcomes = [
        ...chaptersLanded,
        ...castLanded,
        ...voicesLanded,
        ...(terms ? [staled != null] : []),
        ...(wantBook ? [report.book] : []),
      ];
      report.outcome = outcomes.every(Boolean)
        ? "committed"
        : outcomes.some(Boolean)
          ? "partial"
          : "refused";

      this.reports[bookId] = report;
      if (
        !report.applied.length &&
        !report.speakers.length &&
        !report.terms &&
        !report.voices &&
        !aliasedNow.length &&
        !report.samples.length &&
        !report.effects.length &&
        !report.book
      ) {
        if (report.outcome === "refused")
          uiStore.toast(`Nothing from ${plan.name} was saved`, {
            kind: "error",
            description: "The server refused every change, so the book reads as it did.",
          });
        else
          uiStore.toast("Nothing to import", {
            kind: "info",
            description: report.skipped.length
              ? `${n(report.skipped.length, "chapter")} already read as the file does, or could not be written now.`
              : "No chapter was ticked.",
          });
        return report;
      }

      const facts = [
        n(report.applied.length, "chapter"),
        report.refused.length && n(report.refused.length, "chapter") + " refused",
        report.speakers.length && n(report.speakers.length, "speaker") + " added",
        report.terms && n(report.terms, "dictionary term") + " added",
        report.voices && n(report.voices, "voice") + " set",
        report.samples.length && "voice samples kept for " + n(report.samples.length, "speaker"),
        report.effects.length && n(report.effects.length, "effect") + " added to the library",
        report.book && "book settings taken",
      ].filter(Boolean);
      uiStore.toast(`Imported ${plan.name}`, {
        kind: report.outcome === "committed" ? "success" : "warn",
        description: `${facts.join(" · ")}. Each chapter's history keeps the script it replaced.${
          report.effects.length ? " Undo keeps the new effects." : ""
        }`,
        timeout: 12000,
        undo: () => {
          // the voices and the aliases go back as they were; so do the endpoints' voice lists
          for (const { name, voice } of voicedNow)
            void castStore._patchSpeaker(bookId, name, { voice });
          for (const { endpointId, voiceId } of addedVoices)
            endpointsStore._dropVoice(endpointId, voiceId);
          for (const name of aliasedNow) {
            const b = castBefore.find((x) => x.name === name);
            if (b) void castStore._patchSpeaker(bookId, name, { aliases: [...b.aliases] });
          }
          delete this.reports[bookId];
          // before any speaker goes, or the row cascades away under it
          const samplesBack = storing.then((done) => samplesStore._unstore(bookId, done));
          // Scripts first, then the dictionary and the book's settings: their answers move
          // revisions a still-out chapter write would name wrongly. Speakers go last, once no
          // script names them.
          const scriptsBack = Promise.all(landed.map((r) => r.write.undo())).then(async () => {
            if (report.terms) {
              revertLex();
              await castStore._pushLexicon(bookId, staled ?? undefined);
            }
            if (report.book)
              await this._writeBook(bookId, bookBefore, "put the book's settings back");
          });
          return Promise.all([scriptsBack, samplesBack])
            .then(() => castStore._castSettled(bookId))
            .then(() => castStore._dropSpeakers(bookId, report.speakers));
        },
      });
      return report;
    },

    /** Write some book settings whole, and take the chapters' lengths and statuses they moved. */
    async _writeBook(bookId: string, settings: BookSettings, what: string): Promise<boolean> {
      const libraryStore = useLibraryStore();

      const answer = await libraryStore._writeSettings(bookId, settings, what);
      if (!answer) return false;
      for (const { id, narration, duration, lines } of answer.chapters)
        libraryStore._patchChapter(bookId, id, {
          narration,
          duration,
          ...(lines ? { lines } : {}),
        });
      if ("thoughts" in settings) void staleMoved(bookId);
      return true;
    },

    // ---------- differences the book kept ----------
    /** Give these speakers the file's details and effects, with one Undo. */
    useFileSpeakers(bookId: string, diffs: SpeakerDiff[]): number {
      const castStore = useCastStore();
      const uiStore = useUiStore();

      const changed: { name: string; was: SpeakerPatch }[] = [];
      for (const d of diffs) {
        const change = this.speakerChangeOf(bookId, d);
        if (!change) continue;
        void castStore._patchSpeaker(bookId, d.name, change.to);
        changed.push({ name: d.name, was: change.was });
      }
      if (!changed.length) return 0;
      uiStore.toast(
        changed.length === 1
          ? `${changed[0].name} now reads as the file describes them`
          : `${n(changed.length, "speaker")} now read as the file describes them`,
        {
          description: "Details and effects. Voices and aliases are unchanged.",
          undo: () => {
            for (const { name, was } of changed) void castStore._patchSpeaker(bookId, name, was);
          },
        },
      );
      return changed.length;
    },
    /** Give these terms the file's pronunciation, with one Undo. */
    useFileTerms(bookId: string, diffs: TermDiff[]): number {
      const castStore = useCastStore();

      const revert = castStore._lexSnapshot(bookId);
      let changed = 0;
      let last = "";
      for (const d of diffs) {
        const e = castStore.lexiconOf(bookId).find((x) => x.term === d.term);
        if (!e) continue;
        const { ipa, note, matchCase, ...rest } = d.file;
        if (JSON.stringify({ ...e, ...rest, ipa, note, matchCase }) === JSON.stringify(e)) continue;
        // absent in the file means absent here
        const { ipa: _ipa, note: _note, matchCase: _matchCase, ...kept } = e;
        castStore._replaceTerm(bookId, {
          ...kept,
          ...rest,
          ...(ipa ? { ipa } : {}),
          ...(note ? { note } : {}),
          ...(matchCase ? { matchCase: true } : {}),
        });
        changed++;
        last = e.term;
      }
      if (!changed) return 0;
      castStore._lexChanged(
        bookId,
        revert,
        changed === 1
          ? `“${last}” is said as the file says`
          : `${n(changed, "term")} are said as the file says`,
      );
      return changed;
    },
  },
});
