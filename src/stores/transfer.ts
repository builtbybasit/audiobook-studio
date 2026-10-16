// A book's script as a file: reading one in, and applying it. The server answers with a plan and
// writes nothing; this store writes through the restore paths (`planRestore`, history, one Undo).
// Nothing the book has is overwritten by default: missing speakers and terms are added, and each
// difference is offered as "Use the file's". Voices are picked per speaker.
import { key } from "@/lib/scriptReview";
import { planRestore, type RestoreOptions } from "@/lib/scriptHistory";
import { chapterNarration } from "@/lib/runPlan";
import { newSpeaker, personaRefusal } from "@/lib/cast";
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

/** A voice chosen for a speaker: one this install has, or a public one to add first. */
export interface VoicePick {
  speaker: string;
  ref: VoiceRef;
  /** a public voice not on the endpoint yet, added before the speaker is given it */
  add?: { endpointId: string; voice: Voice };
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
}

interface TransferState {
  /** the plan the import page shows, per book */
  plans: Record<string, ScriptImportPlan>;
  /** set once a book's plan is applied: the page becomes the report */
  reports: Record<string, ImportReport>;
  /** chapters whose current script is still being read, so their preview can wait */
  loading: Record<string, true>;
}

const n = (count: number, one: string, many = one + "s") => `${count} ${count === 1 ? one : many}`;

/**
 * The file each plan was read from, sent back on apply so the server can keep its voice samples.
 * Outside state: a `File` should not be reactive.
 */
const files = new Map<string, File>();

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
  state: (): TransferState => ({ plans: {}, reports: {}, loading: {} }),
  getters: {
    planOf(s): (bookId: string) => ScriptImportPlan | null {
      return (bookId) => s.plans[bookId] ?? null;
    },
    reportOf(s): (bookId: string) => ImportReport | null {
      return (bookId) => s.reports[bookId] ?? null;
    },
    /** What applying one chapter would do, touching nothing. */
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
        write: historyStore._rewrite(bookId, chapter.chapterId, restore, origin),
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
          // before any speaker goes, or the row cascades away under it
          const samplesBack = storing.then((done) => samplesStore._unstore(bookId, done));
          // Scripts first, then the dictionary: its answer moves revisions a still-out chapter
          // write would name wrongly. Speakers go last, once no script names them.
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
