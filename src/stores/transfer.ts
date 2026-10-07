// A book's script as a file: reading one in, and applying what it says. See docs/script-transfer.md.
//
// The server reads the file and answers with a plan — the chapters it matched by their source
// words, the ones it refused, and how the file's cast, dictionary and voices differ from the
// book's — and writes nothing. Everything written is written here, through the paths a restore
// already takes: `planRestore` carries every rendered clip across line by line, the chapter's
// history keeps the script the import replaced, and one Undo takes back what the import wrote —
// what the server took of it, since a refused write has already been read back over.
//
// **Nothing the book already has is overwritten by default.** Speakers and dictionary terms the
// book lacks are added; the ones it has keep its own details, and each difference is offered as
// **Use the file's**, one at a time or all at once. Voices are the person's choice per speaker.
import { key } from "@/lib/scriptReview";
import { planRestore, type RestoreOptions } from "@/lib/scriptHistory";
import { chapterNarration } from "@/lib/runPlan";
import { newSpeaker } from "@/lib/cast";
import { clone } from "@/lib/utils";
import { fetchScript } from "@/queries/chapterScript";
import { libraryService } from "@/services/library";
import type {
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
import { useEndpointsStore } from "@/stores/endpoints";
import { useHistoryStore } from "@/stores/history";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { useSpeakerSamplesStore } from "@/stores/speakerSamples";
import { toastFailure } from "@/stores/toastFailure";
import { useUiStore } from "@/stores/ui";

/** A voice the person chose for a speaker: one this install has, or a public one to add first. */
export interface VoicePick {
  speaker: string;
  ref: VoiceRef;
  /** a public voice not on the endpoint yet, added before the speaker is given it */
  add?: { endpointId: string; voice: Voice };
}

export type SkipReason = "identical" | "busy" | "missing";

/** How an applied import went: all it wrote landed, the server refused some of it, or all of it. */
export type ImportOutcome = "committed" | "partial" | "refused";

/** What an applied import did, for the page to read back once it has happened. */
export interface ImportReport {
  outcome: ImportOutcome;
  /** chapters whose imported script the server took */
  applied: { chapterId: number; title: string }[];
  /** chapters whose write the server refused, so they read as they did before the import */
  refused: { chapterId: number; title: string }[];
  skipped: { chapterId: number; title: string; why: SkipReason }[];
  /** speakers added to the cast, from the file or found in the lines, that the server took */
  speakers: string[];
  /** speakers the file named that no applied line uses, so they were not added */
  unused: string[];
  terms: number;
  voices: number;
  /**
   * Speakers whose voice samples the file carried and this import keeps, to wait with them until
   * someone clones them. Kept once the speakers are on the server, so the page reads which were
   * kept from the samples store rather than from here.
   */
  samples: string[];
}

interface TransferState {
  /** the plan the import page shows, per book */
  plans: Record<string, ScriptImportPlan>;
  /** set once a book's plan has been applied: the page becomes the report */
  reports: Record<string, ImportReport>;
  /** chapters whose current script is still being read, so their preview can wait for it */
  loading: Record<string, true>;
}

const n = (count: number, one: string, many = one + "s") => `${count} ${count === 1 ? one : many}`;

/**
 * The file each book's plan was read from. Applying sends it back so the server can keep the voice
 * samples it carries; held outside the state because a `File` is not something to make reactive.
 */
const files = new Map<string, File>();

/**
 * What writing `imported` over `current` does: a restore's plan, with one difference.
 *
 * A restore carries a clip to the line that reads the clip's own words, so a line whose words were
 * corrected in the file would find no clip and leave its old one behind to be dropped. An import's
 * corrected line is a rewrite of the line it replaces, not a new one: the comparison already pairs
 * the two, so the old clip comes across with it and is judged stale — there to play until the line
 * is narrated again, the way an edit in the reader leaves it.
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
  state: (): TransferState => ({ plans: {}, reports: {}, loading: {} }),
  getters: {
    planOf(s): (bookId: string) => ScriptImportPlan | null {
      return (bookId) => s.plans[bookId] ?? null;
    },
    reportOf(s): (bookId: string) => ImportReport | null {
      return (bookId) => s.reports[bookId] ?? null;
    },
    /** What applying one chapter would do, worked out without touching anything. */
    previewOf(): (bookId: string, chapter: ImportChapter) => RestorePlan {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();
      const narrationStore = useNarrationStore();
      const scriptsStore = useScriptsStore();

      return (bookId, chapter) =>
        planImport(scriptsStore.segmentsOf(bookId, chapter.chapterId), chapter.segments, {
          drift: (segment, audio) => narrationStore.clipDrift(bookId, segment, audio),
          cast: new Set(castStore.charactersOf(bookId).map((c) => c.name)),
          book: libraryStore.bookById(bookId),
        });
    },
  },
  actions: {
    /**
     * Send the file to the server and keep the plan it answers with. The chapters it matched have
     * their current scripts read in, since what applying one does is measured against them.
     */
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
      await this._loadScripts(
        bookId,
        plan.chapters.map((c) => c.chapterId),
      );
      return plan;
    },
    /** Keep the file a plan was read from, for applying it to send back. */
    _hold(bookId: string, file: File): void {
      files.set(bookId, file);
    },
    /** Put the file aside, and the report of it with it. */
    forget(bookId: string): void {
      files.delete(bookId);
      delete this.plans[bookId];
      delete this.reports[bookId];
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
     * Write the chosen chapters, add what the book lacks, and give the chosen speakers their
     * voices — all behind one Undo. Chapters are written the way a restore writes one: the clips
     * that still belong to a line are carried across and re-judged, and the chapter's history
     * keeps the script it replaced under an `imported` origin (`history._rewrite`).
     *
     * Resolves once every write has been answered, with the report of what the server took: a
     * chapter whose write was refused is listed as refused rather than imported, the outcome says
     * whether that was some of the import or all of it, and the Undo leaves it alone.
     */
    async apply(
      bookId: string,
      chapterIds: number[],
      voices: VoicePick[] = [],
    ): Promise<ImportReport | null> {
      const castStore = useCastStore();
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
      };
      // ---- the scripts, worked out before anything changes, so a skipped chapter changes nothing
      const writes: { chapter: ImportChapter; restore: RestorePlan }[] = [];
      for (const chapter of plan.chapters) {
        if (!chosen.has(chapter.chapterId)) continue;
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
      // counted from what is written, so a chapter skipped as identical or busy is not claimed
      const origin: VersionOrigin = { kind: "imported", file: plan.name, chapters: writes.length };

      // ---- the cast: the file's speakers the applied lines use, with the file's details. Every
      // change below is written in the step that makes it (`_addSpeaker`, `_patchSpeaker`), and
      // `pushed` keeps each speaker's last write, which sends them as they then stand. The cast is
      // read afresh where it is used: a book whose cast was never read gets its list as the
      // first speaker is added
      const cast = () => castStore.charactersOf(bookId);
      const castBefore = clone(cast());
      const used = new Set(writes.flatMap((w) => w.restore.segments.map((s) => s.speaker)));
      const pushed = new Map<string, Promise<boolean>>();
      const added: string[] = [];
      for (const speaker of plan.cast.add) {
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
        };
        pushed.set(c.name, castStore._addSpeaker(bookId, c));
        added.push(c.name);
      }
      // aliases are only more ways to recognise someone, so a union loses nothing
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
      // taken before any script changes: an Undo of the dictionary puts back every clip's status
      // by line, and those are the lines the book had before the import
      const revertLex = castStore._lexSnapshot(bookId);
      const rewrites = writes.map(({ chapter, restore }) => ({
        chapter,
        write: historyStore._rewrite(bookId, chapter.chapterId, restore, origin),
      }));
      // a speaker a line names that neither the book nor the file's cast has — a lone chapter
      // file carries no cast — comes in unreviewed, where the Cast page can merge it; it is
      // written once its chapter's write lands, and not at all when only a refused one named it
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

      // ---- the voice samples the file carries for a private voice this install cannot reach: they
      // wait with the speaker, whatever voice the speaker was given here, until someone clones them
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
      // after the speakers are on the server: a sample waits with a speaker the server must know
      const storing =
        file && report.samples.length
          ? Promise.all(pushed.values()).then(() =>
              samplesStore._store(bookId, file, report.samples),
            )
          : Promise.resolve({ stored: [], replaced: [] });

      // ---- what landed. Only that is reported, and only that is what the Undo takes back: a
      // write the server refused has already been read back over and said, so the book reads
      // there as it did and there is nothing of it to undo.
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
      const outcomes = [
        ...chaptersLanded,
        ...castLanded,
        ...voicesLanded,
        ...(terms ? [staled != null] : []),
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
        !report.samples.length
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
      ].filter(Boolean);
      uiStore.toast(`Imported ${plan.name}`, {
        kind: report.outcome === "committed" ? "success" : "warn",
        description: `${facts.join(" · ")}. Each chapter's history keeps the script it replaced.`,
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
          // before any speaker goes: a row whose speaker is removed first cascades away under it
          const samplesBack = storing.then((done) => samplesStore._unstore(bookId, done));
          // The scripts go first, and the dictionary after them: its answer moves the revision of
          // each chapter whose clips it puts back, which a chapter's write still out would then
          // name wrongly. A speaker taken off while the server's script still names them would hand
          // their lines to the Narrator; once the writes land, the removal moves nothing.
          const scriptsBack = Promise.all(landed.map((r) => r.write.undo())).then(async () => {
            if (!report.terms) return;
            revertLex();
            await castStore._pushLexicon(bookId, staled ?? undefined);
          });
          return Promise.all([scriptsBack, samplesBack])
            .then(() => castStore._castSettled(bookId))
            .then(() => castStore._dropSpeakers(bookId, report.speakers));
        },
      });
      return report;
    },

    // ---------- differences the book kept ----------
    /** Give these speakers the file's gender, description and style, with one Undo. */
    useFileSpeakers(bookId: string, diffs: SpeakerDiff[]): number {
      const castStore = useCastStore();
      const uiStore = useUiStore();

      const changed: { name: string; was: SpeakerDiff["book"] }[] = [];
      for (const d of diffs) {
        const c = castStore.charactersOf(bookId).find((x) => x.name === d.name);
        if (!c) continue;
        const was = { gender: c.gender, description: c.description, style: c.style };
        if (
          was.gender === d.file.gender &&
          was.description === d.file.description &&
          was.style === d.file.style
        )
          continue;
        void castStore._patchSpeaker(bookId, c.name, d.file);
        changed.push({ name: c.name, was });
      }
      if (!changed.length) return 0;
      uiStore.toast(
        changed.length === 1
          ? `${changed[0].name} now reads as the file describes them`
          : `${n(changed.length, "speaker")} now read as the file describes them`,
        {
          description: "Gender, description and style. Voices and aliases are unchanged.",
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
        // absent on the file's side is absent here, not left as the book had it
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
