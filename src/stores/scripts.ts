// Canonical script segments and editing: the working copy of each chapter's script, filled by
// `useChapterScript`. Each edit applies at once, then `_commit` writes the script with the revision
// it was read at; a stale write is refused and the server's script is read back over it.
import { computed, toRaw, type ComputedRef } from "vue";
import { bulkInvalidates, bulkOutcome, scriptFingerprint, segmentFingerprint } from "@/lib/bulk";
import { remapExpressions } from "@/lib/expressions";
import { scriptSignature } from "@/lib/scriptHistory";
import { afterOf, beforeOf, bulkLabel, key, SKIP_SUMMARY, SKIP_TEXT } from "@/lib/scriptReview";
import { isSiteText, isSpoken, TYPE_LABEL } from "@/lib/siteText";
import { NARRATOR, sameReading } from "@/lib/cast";
import { clone } from "@/lib/utils";
import type { ContentPart } from "@/lib/contents";
import { fetchScript } from "@/queries/chapterScript";
import { chapterPartsNow, chapterTextNow } from "@/queries/chapterText";
import { fetchHistory } from "@/queries/history";
import { staleMoved } from "@/queries/effects";
import type {
  AudioStatus,
  BulkAction,
  BulkPreview,
  BulkResult,
  BulkRow,
  BulkSkip,
  BulkTarget,
  LineCounts,
  NarrationStatus,
  RevisedLines,
  ScriptDiff,
  Segment,
  SegmentFlag,
  SegmentMap,
  SegmentType,
  VersionOrigin,
} from "@/types";
import { ApiError, libraryService, type ChapterScript } from "@/services/library";
import { defineStore } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useHistoryStore } from "@/stores/history";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useUiStore } from "@/stores/ui";
/** One line's new speaker or line effects (`retouchLines`). */
export type LineRetouch = { id: number } & Partial<Pick<Segment, "speaker" | "effects">>;

/** A write in progress for one chapter, and whether another is owed once it lands. */
interface PendingWrite {
  inFlight: boolean;
  running?: Promise<void>;
  dirty: boolean;
  /** one-line writes (a flag) waiting their turn, in order */
  lines: (() => Promise<void>)[];
  /** `_save`s answered by the next write: true once it lands */
  answers: ((landed: boolean) => void)[];
  /** what produced the script for the next write; an ordinary edit when unset */
  origin?: VersionOrigin;
  /** a server read arrived mid-write and was put off */
  deferred?: boolean;
  /** the server's script is to be read back and installed once the writes land */
  reading?: boolean;
}

/**
 * Writes in flight, per store, outside reactive state. Keyed by the raw store: Pinia devtools hand
 * each action a fresh proxy as `this`.
 */
const pending = new WeakMap<object, Map<string, PendingWrite>>();

interface ScriptsState {
  segments: SegmentMap;
  _previous: SegmentMap;
  /** the revision each chapter's script was read at, which the next write names */
  _revision: Record<string, number>;
  /** chapters a scripting job just rewrote, whose next read is a re-script */
  _rescripted: Record<string, true>;
  /** set while a batch drives the per-line actions, so it writes each chapter once */
  _silent: boolean;
}
export const useScriptsStore = defineStore("scripts", {
  state: (): ScriptsState => ({
    segments: {},
    _previous: {},
    _revision: {},
    _rescripted: {},
    _silent: false,
  }),
  getters: {
    segmentsOf(s): (bookId: string, chId: number) => Segment[] {
      return (bookId: string, chId: number): Segment[] => s.segments[key(bookId, chId)] ?? [];
    },
    /** Whether the script is here: `segmentsOf` is empty both unread and with no lines. */
    held(s): (bookId: string, chId: number) => boolean {
      return (bookId: string, chId: number): boolean => key(bookId, chId) in s.segments;
    },
    /**
     * A chapter's line counts: the script's own when here, else the server's listing. Undefined
     * when neither is read. Only spoken lines count (`isSpoken`); the rest are `skipped`.
     */
    lineCountsOf(s): (bookId: string, chId: number) => LineCounts | undefined {
      const libraryStore = useLibraryStore();
      return (bookId: string, chId: number): LineCounts | undefined => {
        const segs = s.segments[key(bookId, chId)];
        if (!segs) return libraryStore.chapter(bookId, chId)?.lines;
        const book = libraryStore.bookById(bookId);
        const counts: LineCounts = { total: 0, done: 0, generating: 0, failed: 0, skipped: 0 };
        for (const seg of segs) {
          if (!isSpoken(seg, book)) {
            counts.skipped++;
            continue;
          }
          counts.total++;
          if (seg.audio.status === "done") counts.done++;
          else if (seg.audio.status === "generating") counts.generating++;
          else if (seg.audio.status === "failed") counts.failed++;
        }
        return counts;
      };
    },
    /** A chapter's source text, from whatever the query cache holds; for synchronous callers. */
    partsOf(): (bookId: string, chId: number) => ContentPart[] {
      return (bookId: string, chId: number): ContentPart[] => chapterPartsNow(bookId, chId);
    },
    /**
     * The chapter as anything that counts, bills or speaks it must read it: the `plain` reading,
     * never the stored Markdown (a `##` or a link's address would be narrated and charged).
     */
    rawText(): (bookId: string, chId: number) => string {
      return (bookId: string, chId: number): string => chapterTextNow(bookId, chId, "plain");
    },
    scriptDiff(s): (bookId: string, chId: number) => ScriptDiff | null {
      return (bookId: string, chId: number): ScriptDiff | null => {
        const prev = s._previous[key(bookId, chId)];
        if (!prev) return null;
        const cur = s.segments[key(bookId, chId)] ?? [];
        const byText = (arr: Segment[]): Map<string, Segment> => {
          const m = new Map<string, Segment>();
          for (const x of arr) m.set(x.text, x);
          return m;
        };
        const pm = byText(prev);
        const cm = byText(cur);
        const speaker: ScriptDiff["speaker"] = [];
        const direction: ScriptDiff["direction"] = [];
        for (const [t, c] of cm) {
          const p = pm.get(t);
          if (!p) continue;
          if (p.speaker !== c.speaker)
            speaker.push({ id: c.id, text: t, from: p.speaker, to: c.speaker });
          else if ((p.direction || "") !== (c.direction || ""))
            direction.push({ id: c.id, text: t, from: p.direction, to: c.direction });
        }
        const added = cur.filter((c) => !pm.has(c.text));
        const removed = prev.filter((p) => !cm.has(p.text));
        return {
          speaker,
          direction,
          added,
          removed,
          total: speaker.length + direction.length + added.length + removed.length,
          prevCount: prev.length,
          curCount: cur.length,
        };
      };
    },
    // ---------- bulk script corrections (Search) ----------
    /** What a bulk correction would do, touching nothing; `applyBulk` changes exactly these rows. */
    bulkPreview(): (bookId: string, targets: BulkTarget[], action: BulkAction) => BulkPreview {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();

      return (bookId, targets, action) => {
        const cast = castStore.charactersOf(bookId);
        const byName = castStore.byName[bookId];
        const cv = libraryStore.bookById(bookId)?.characterVoice;
        // a new speaker read in the same voice and style keeps the clip (`retouchLines`)
        const respeaks = (s: Segment) =>
          action.kind !== "speaker" ||
          !byName ||
          !sameReading(s.speaker, action.speaker, byName, cv);
        const ordered = [...targets].sort((a, b) => a.chId - b.chId || a.segId - b.segId);
        const rows: BulkRow[] = [];
        const chapters = new Set<number>();
        const skips = new Set<BulkSkip>();
        let missing = 0;
        let changing = 0;
        let stale = 0;
        const parts: string[] = [];
        for (const t of ordered) {
          const s = this.segmentsOf(bookId, t.chId).find((x) => x.id === t.segId);
          parts.push(`${t.chId}:${t.segId}:${scriptFingerprint(s)}`);
          if (!s) {
            missing++;
            continue;
          }
          chapters.add(t.chId);
          const { changes, skip } = bulkOutcome(s, action);
          if (skip) skips.add(skip);
          const willStale =
            changes && bulkInvalidates(action) && s.audio.status === "done" && respeaks(s);
          if (changes) changing++;
          if (willStale) stale++;
          rows.push({
            chId: t.chId,
            segId: t.segId,
            speaker: s.speaker,
            color: cast.find((c) => c.name === s.speaker)?.color ?? "#71717a",
            text: s.text,
            before: beforeOf(s, action),
            after: afterOf(s, action),
            changes,
            skip: skip ? SKIP_TEXT[skip](s, action) : "",
            stale: willStale,
          });
        }
        const n = changing;
        const one = n === 1;
        const confirm =
          action.kind === "speaker"
            ? `Change ${n} line${one ? "" : "s"}`
            : action.kind === "flag"
              ? `Flag ${n} line${one ? "" : "s"}`
              : action.mode === "clear"
                ? `Clear ${n} direction${one ? "" : "s"}`
                : `Set ${n} direction${one ? "" : "s"}`;
        const skipList = [...skips] as BulkSkip[];
        return {
          label: bulkLabel(action),
          confirm,
          selected: targets.length,
          chapters: chapters.size,
          changing,
          skipped: rows.length - changing,
          skipReason:
            skipList.length === 1
              ? SKIP_SUMMARY[skipList[0]](action)
              : "already match this correction",
          stale,
          missing,
          rows,
          signature: parts.join("|"),
        };
      };
    },
  },
  actions: {
    // apply one direction to every line of a speaker in a chapter (marks rendered ones stale)
    applyDirection(bookId: string, chId: number, speaker: string, direction: string): number {
      const uiStore = useUiStore();

      const targets = this.segmentsOf(bookId, chId).filter(
        (s) => s.speaker === speaker && (s.direction || "") !== direction,
      );
      let n = 0;
      for (const s of targets) {
        s.direction = direction;
        s.edited = true;
        this._markStale(bookId, chId, s);
        n++;
      }
      if (n) this._commit(bookId, chId);
      if (n)
        uiStore.toast(`Direction applied to ${n} ${speaker} line${n === 1 ? "" : "s"}`, {
          kind: "success",
          description: `“${direction}” — rendered lines are now stale`,
          timeout: 4000,
        });
      return n;
    },
    setSpeaker(bookId: string, chId: number, segId: number, speaker: string): void {
      this.retouchLines(bookId, chId, [{ id: segId, speaker }]);
    },
    updateSegment(bookId: string, chId: number, segId: number, patch: Partial<Segment>): void {
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s) return;
      const changed = (Object.keys(patch) as (keyof Segment)[]).some((k) => s[k] !== patch[k]);
      if (patch.text != null && s.expressions && patch.expressions === undefined)
        s.expressions = remapExpressions(s.expressions, s.text, patch.text);
      // the detector's suggestion was about the old type; the server drops it too
      if (patch.type && patch.type !== s.type) delete s.siteCheck;
      Object.assign(s, patch);
      if (changed) {
        s.edited = true;
        this._markStale(bookId, chId, s);
        this._commit(bookId, chId);
      }
    },
    /**
     * Change speakers or line effects with one write. Returns how many clips need new speech.
     * A clip goes stale only when its reading changes (`sameReading`); otherwise only its effects
     * may be old, so the old-sound count is reread once the write lands.
     */
    retouchLines(bookId: string, chId: number, changes: readonly LineRetouch[]): number {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();

      // an unread cast cannot say two speakers read alike, so the clip needs speech
      const cast = castStore.byName[bookId];
      const cv = libraryStore.bookById(bookId)?.characterVoice;
      const lines = new Map(this.segmentsOf(bookId, chId).map((s) => [s.id, s]));
      let changed = 0;
      let respoken = 0;
      for (const { id, speaker, effects } of changes) {
        const s = lines.get(id);
        if (!s) continue;
        const moves = speaker != null && speaker !== s.speaker;
        const retouches = !!effects && effects.join("\n") !== (s.effects ?? []).join("\n");
        if (!moves && !retouches) continue;
        if (moves && (!cast || !sameReading(s.speaker, speaker, cast, cv))) {
          if (s.audio.status === "done") respoken++;
          this._markStale(bookId, chId, s);
        }
        if (moves) s.speaker = speaker;
        if (retouches && effects.length) s.effects = [...effects];
        else if (retouches) delete s.effects;
        s.edited = true;
        changed++;
      }
      if (changed && !this._silent) {
        this._commit(bookId, chId);
        void this._settled(bookId, chId).then(() => staleMoved(bookId));
      }
      return respoken;
    },
    // ---------- site text ----------
    // Site text is left out silently, so every type change into or out of what is read aloud says
    // so in a toast with Undo, whichever control made it.
    /**
     * Give a line another type; non-story text goes to the Narrator, as the server writes it. A
     * clip is staled only when the line would read differently (`clipDrift`); whether it is heard
     * at all is `isSpoken`'s call.
     */
    setLineType(bookId: string, chId: number, segId: number, type: SegmentType): void {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();
      const narrationStore = useNarrationStore();
      const uiStore = useUiStore();

      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s || s.type === type) return;
      const book = libraryStore.bookById(bookId);
      const was = s.type;
      const crosses = isSiteText(was) !== isSiteText(type);
      const revert = crosses ? this._editSnapshot(bookId, chId) : null;
      s.type = type;
      s.edited = true;
      delete s.siteCheck;
      if (isSiteText(type)) s.speaker = NARRATOR;
      // a clip without a recorded source is taken to read the line as it was
      const drifted = s.audio.at ? narrationStore.clipDrift(bookId, s).length > 0 : was !== type;
      if (isSpoken(s, book) && drifted) this._markStale(bookId, chId, s);
      castStore._retime(bookId, chId);
      this._commit(bookId, chId);
      if (revert)
        uiStore.toast(
          isSiteText(type)
            ? `#${s.id} marked as ${TYPE_LABEL[type].toLowerCase()} · ${isSpoken(s, book) ? "read aloud" : "not read"}`
            : `#${s.id} is story again, read as ${TYPE_LABEL[type].toLowerCase()}`,
          {
            description: `Was ${TYPE_LABEL[was].toLowerCase()}. “${s.text.length > 60 ? s.text.slice(0, 60).trimEnd() + "…" : s.text}”`,
            undo: revert,
          },
        );
    },
    /** Take the detector's suggested type, with the Undo above. */
    acceptSiteCheck(bookId: string, chId: number, segId: number): void {
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (s?.siteCheck) this.setLineType(bookId, chId, segId, s.siteCheck.suggest);
    },
    /**
     * Drop the suggestion. Nothing heard changes, so no edit mark or stale clip; the script is
     * still written so the suggestion does not return.
     */
    dismissSiteCheck(bookId: string, chId: number, segId: number): void {
      const uiStore = useUiStore();

      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s?.siteCheck) return;
      const revert = this._editSnapshot(bookId, chId);
      delete s.siteCheck;
      this._commit(bookId, chId);
      uiStore.toast(`#${s.id} stays ${TYPE_LABEL[s.type].toLowerCase()}`, {
        description: "The suggestion was dismissed.",
        undo: revert,
      });
    },
    // ---------- bulk script corrections (Search) ----------
    // Goes through the per-segment actions above, so a batch leaves each line as a hand edit would.
    /** Apply `action` to the previewed lines, skipping ones already at the value. Returns the
     *  batch's single undo, or null when nothing changed. */
    applyBulk(bookId: string, targets: BulkTarget[], action: BulkAction): BulkResult {
      const libraryStore = useLibraryStore();
      const narrationStore = useNarrationStore();
      const uiStore = useUiStore();

      const preview = this.bulkPreview(bookId, targets, action);
      const empty: BulkResult = {
        changed: 0,
        chapters: 0,
        skipped: preview.skipped,
        stale: 0,
        label: preview.label,
        entry: null,
      };
      if (!preview.changing) return empty;
      // A flag never touches a clip, so its undo ignores audio changes since; a speaker or
      // direction batch staled clips, so its undo needs them unchanged.
      const touchesAudio = bulkInvalidates(action);
      const fingerprint = touchesAudio ? segmentFingerprint : scriptFingerprint;
      // each line before and straight after: undo refuses to overwrite a line edited in between
      const before: {
        chId: number;
        segId: number;
        speaker: string;
        direction: string;
        flag?: SegmentFlag;
        edited?: boolean;
        status: AudioStatus;
        after: string;
      }[] = [];
      const chapters = new Set<number>();
      const narration = new Map<number, NarrationStatus>();
      // Each chapter is written once under the batch's name, one history entry. A flag batch writes
      // no script: each flag goes to its line alone (`flagSegment`) with no revision, so a run
      // landing clips meanwhile cannot refuse it.
      const perChapter = new Map<number, number>();
      for (const row of preview.rows)
        if (row.changes) perChapter.set(row.chId, (perChapter.get(row.chId) ?? 0) + 1);
      // silence the per-line writes when the batch writes each chapter itself
      const batch = <T>(fn: () => T): T => (touchesAudio ? this.silence(fn) : fn());
      /** speaker changes whose clip now needs new speech (`retouchLines`) */
      let respoken = 0;
      batch(() => {
        for (const row of preview.rows) {
          if (!row.changes) continue;
          const at = () => this.segmentsOf(bookId, row.chId).find((x) => x.id === row.segId);
          const s = at();
          if (!s) continue;
          if (!narration.has(row.chId))
            narration.set(row.chId, libraryStore.chapter(bookId, row.chId)?.narration ?? "none");
          const was = {
            chId: row.chId,
            segId: row.segId,
            speaker: s.speaker,
            direction: s.direction,
            flag: s.flag ? clone(s.flag) : undefined,
            edited: s.edited,
            status: s.audio.status,
            after: "",
          };
          if (action.kind === "speaker")
            respoken += this.retouchLines(bookId, row.chId, [
              { id: row.segId, speaker: action.speaker },
            ]);
          else if (action.kind === "direction")
            this.updateSegment(bookId, row.chId, row.segId, {
              direction: action.mode === "clear" ? "" : action.direction.trim(),
            });
          else
            void narrationStore.flagSegment(bookId, row.chId, row.segId, action.flag, action.note);
          was.after = fingerprint(at());
          before.push(was);
          chapters.add(row.chId);
        }
      });
      if (!before.length) return empty;
      if (touchesAudio)
        for (const [chId, lines] of perChapter)
          this._commit(bookId, chId, { kind: "bulk", label: preview.label, lines });
      // a new speaker may hear a line through other effects: reread the old-sound count
      if (action.kind === "speaker")
        void Promise.all([...perChapter.keys()].map((chId) => this._settled(bookId, chId))).then(
          () => staleMoved(bookId),
        );
      const revert = () => {
        const clean = new Set(chapters);
        let conflicts = 0;
        for (const w of before) {
          const s = this.segmentsOf(bookId, w.chId).find((x) => x.id === w.segId);
          if (!s || fingerprint(s) !== w.after) {
            conflicts++;
            clean.delete(w.chId); // something else in this chapter moved on; leave its status alone
            continue;
          }
          // a flag batch is undone a line's flag at a time
          if (!touchesAudio) {
            if (w.flag)
              void narrationStore.flagSegment(bookId, w.chId, w.segId, w.flag.kind, w.flag.note);
            else void narrationStore.clearFlag(bookId, w.chId, w.segId);
            continue;
          }
          s.speaker = w.speaker;
          s.direction = w.direction;
          if (w.flag) s.flag = w.flag;
          else delete s.flag;
          if (w.edited) s.edited = true;
          else delete s.edited;
          s.audio.status = w.status;
        }
        if (touchesAudio) {
          for (const chId of clean) {
            const was = narration.get(chId);
            if (was) libraryStore._patchChapter(bookId, chId, { narration: was });
          }
          for (const chId of chapters) this._commit(bookId, chId);
        }
        if (conflicts)
          uiStore.toast(
            `${conflicts} line${conflicts === 1 ? " was" : "s were"} edited after this batch`,
            {
              kind: "warn",
              description:
                "They were left as they are — undo only restored the lines it still recognised.",
              timeout: 7000,
            },
          );
      };
      // a flag does not change what would be sent to the endpoint
      const stale =
        action.kind === "speaker"
          ? respoken
          : bulkInvalidates(action)
            ? before.filter((w) => w.status === "done").length
            : 0;
      const changed = before.length;
      uiStore.toast(preview.label, {
        kind: "success",
        description:
          `${changed} line${changed === 1 ? "" : "s"} in ${chapters.size} chapter${chapters.size === 1 ? "" : "s"}` +
          (preview.skipped ? ` \u00b7 ${preview.skipped} unchanged` : "") +
          (stale
            ? ` \u00b7 ${stale} rendered clip${stale === 1 ? "" : "s"} now need re-narration`
            : ""),
        undo: revert,
        timeout: 12000,
      });
      return {
        changed,
        chapters: chapters.size,
        skipped: preview.skipped,
        stale,
        label: preview.label,
        entry: uiStore._undo.at(-1) ?? null,
      };
    },
    // ---------- segment boundaries ----------
    // Hand fixes for the model's split; both undoable, both invalidate the audio they touch.
    /** One edit's undo: the script as it was, taken before the edit and written back as an edit. */
    _editSnapshot(bookId: string, chId: number): () => void {
      const libraryStore = useLibraryStore();

      const before = clone(this.segments[key(bookId, chId)] ?? []);
      const c = libraryStore.chapter(bookId, chId);
      const narration = c?.narration;
      const duration = c?.duration;
      return () => {
        this.segments[key(bookId, chId)] = before;
        if (narration)
          libraryStore._patchChapter(bookId, chId, {
            narration,
            ...(duration != null ? { duration } : {}),
          });
        this._commit(bookId, chId);
        // the restored lines may be heard through other effects
        void this._settled(bookId, chId).then(() => staleMoved(bookId));
      };
    },
    /** Cut a segment in two at character offset `at`. Returns the new segment's id. */
    splitSegment(bookId: string, chId: number, segId: number, at: number): number | null {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      const segs = this.segments[key(bookId, chId)];
      const i = segs?.findIndex((x) => x.id === segId) ?? -1;
      if (i < 0) return null;
      const s = segs[i];
      const head = s.text.slice(0, at).trimEnd();
      const tail = s.text.slice(at).trimStart();
      if (!head || !tail) return null;
      const revert = this._editSnapshot(bookId, chId);
      // the whitespace at the cut is prose (maybe a paragraph break): joining must restore it
      const sep = s.text.slice(head.length, s.text.length - tail.length);
      const id = Math.max(0, ...segs.map((x) => x.id)) + 1;
      const second: Segment = {
        ...clone(s),
        id,
        text: tail,
        edited: true,
        audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
      };
      delete second.candidate;
      const tailStart = s.text.length - tail.length;
      second.expressions = (s.expressions ?? [])
        .filter((a) => a.at >= at)
        .map((a) => ({ ...a, at: Math.max(0, a.at - tailStart) }));
      s.expressions = (s.expressions ?? [])
        .filter((a) => a.at < at)
        .map((a) => ({ ...a, at: Math.min(a.at, head.length) }));
      // a hand-split chunk is no longer the model's guess; the halves start unflagged
      delete second.fallback;
      delete second.fallbackCount;
      delete second.fallbackMismatch;
      delete second.fallbackRetrying;
      delete second.flag;
      s.text = head;
      s.edited = true;
      delete s.candidate; // a retake of the line as it was says nothing about either half
      if (sep === " ") delete s.sep;
      else s.sep = sep;
      delete s.fallback;
      delete s.fallbackCount;
      delete s.fallbackMismatch;
      delete s.fallbackRetrying;
      this._markStale(bookId, chId, s);
      // the second half has no audio, so a narrated chapter is no longer complete
      libraryStore._staleChapter(bookId, chId);
      segs.splice(i + 1, 0, second);
      castStore._retime(bookId, chId);
      this._commit(bookId, chId);
      uiStore.toast("Segment split in two", {
        description: `#${s.id} keeps “${head.slice(0, 40)}…”, #${id} starts “${tail.slice(0, 40)}…”`,
        undo: revert,
      });
      return id;
    },
    /** Join a segment with the next. The first one's speaker, type and direction win. */
    joinSegments(bookId: string, chId: number, segId: number): boolean {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      const segs = this.segments[key(bookId, chId)];
      const i = segs?.findIndex((x) => x.id === segId) ?? -1;
      if (i < 0 || i + 1 >= segs.length) return false;
      const revert = this._editSnapshot(bookId, chId);
      const a = segs[i];
      const b = segs[i + 1];
      // restore what stood between them: a space unless a split recorded otherwise
      const head = a.text.trimEnd();
      const tail = b.text.trimStart();
      const offset = head.length + (a.sep ?? " ").length;
      a.expressions = [
        ...(a.expressions ?? []).map((x) => ({ ...x, at: Math.min(x.at, head.length) })),
        ...(b.expressions ?? []).map((x) => ({
          ...x,
          at: offset + Math.max(0, x.at - (b.text.length - tail.length)),
        })),
      ].map((x, i) => ({ ...x, annotationId: i + 1 }));
      a.text = `${head}${a.sep ?? " "}${tail}`;
      a.edited = true;
      a.flag ??= b.flag;
      delete a.candidate; // neither half's retake is a take of the joined line
      // the pair now ends where b ended, so b's separator becomes a's
      if (b.sep == null) delete a.sep;
      else a.sep = b.sep;
      delete a.fallback;
      delete a.fallbackCount;
      delete a.fallbackMismatch;
      delete a.fallbackRetrying;
      this._markStale(bookId, chId, a);
      if (b.audio.status !== "none") libraryStore._staleChapter(bookId, chId);
      segs.splice(i + 1, 1);
      castStore._retime(bookId, chId);
      this._commit(bookId, chId);
      uiStore.toast(`#${b.id} joined into #${a.id}`, {
        description:
          a.speaker === b.speaker
            ? `Read as one ${a.type} line by ${a.speaker}.`
            : `${b.speaker}\u2019s line is now read by ${a.speaker} \u2014 check the speaker.`,
        kind: a.speaker === b.speaker ? "info" : "warn",
        undo: revert,
      });
      return true;
    },
    /**
     * Drop a line: the trim Contents promises for author's notes kept in a chapter, or a line the
     * model invented. Refuses the last line (nothing to narrate, no row to undo from). Undoable.
     */
    deleteSegment(bookId: string, chId: number, segId: number): boolean {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      const segs = this.segments[key(bookId, chId)];
      const i = segs?.findIndex((x) => x.id === segId) ?? -1;
      if (i < 0 || segs.length < 2) return false;
      const revert = this._editSnapshot(bookId, chId);
      const [gone] = segs.splice(i, 1);
      // its audio goes with it, so a finished chapter no longer matches what was rendered
      if (gone.audio.status !== "none") libraryStore._staleChapter(bookId, chId);
      castStore._retime(bookId, chId);
      this._commit(bookId, chId);
      uiStore.toast(`#${gone.id} deleted`, {
        description: `${gone.speaker}: “${
          gone.text.length > 70 ? gone.text.slice(0, 70).trimEnd() + "…" : gone.text
        }”`,
        undo: revert,
      });
      return true;
    },
    // ---------- the seam ----------
    /**
     * Install the server's script (every `useChapterScript` read). A script replaced at a newer
     * revision is kept as `_previous` for the diff, unless only its clips changed (a narration job
     * landed); after a scripting job (`_noteRescript`) it is kept regardless. A read arriving while
     * an edit is out or waiting is put off and redone after `_flush`, or it would undo the edit.
     */
    _install(bookId: string, chId: number, script: ChapterScript): void {
      const k = key(bookId, chId);
      const p = pending.get(toRaw(this))?.get(k);
      if (p && !p.reading && (p.inFlight || p.dirty)) {
        p.deferred = true;
        return;
      }
      const { segments, revision } = script;
      const had = this.segments[k];
      const known = this._revision[k];
      const rescripted = this._rescripted[k] ?? false;
      delete this._rescripted[k];
      if (
        had?.length &&
        segments.length &&
        known != null &&
        revision > known &&
        (rescripted || scriptSignature(had) !== scriptSignature(segments))
      )
        this._previous[k] = clone(had);
      this.segments[k] = segments;
      this._revision[k] = revision;
    },
    /** A scripting job rewrote this chapter: the next read keeps the old script for the diff. */
    _noteRescript(bookId: string, chId: number): void {
      this._rescripted[key(bookId, chId)] = true;
    },
    /**
     * The server's current revision, for the next edit to name. Only for a script that is here,
     * and never backwards (an edit's answer may have landed in between).
     */
    _adoptRevision(bookId: string, chId: number, revision: number): void {
      const k = key(bookId, chId);
      if (!(k in this.segments)) return;
      this._revision[k] = Math.max(this._revision[k] ?? 0, revision);
    },
    /**
     * Apply lines the server changed: `patch` each and stale its clip where `stales` says (asked
     * before the patch), then `_adoptRevision`. A chapter not read yet has nothing to change.
     */
    _applyLines(
      bookId: string,
      chId: number,
      ids: readonly number[],
      patch: Partial<Pick<Segment, "speaker">>,
      revision: number,
      stales: (s: Segment) => boolean = () => true,
    ): void {
      const libraryStore = useLibraryStore();

      const segs = this.segments[key(bookId, chId)];
      if (!segs) return;
      const set = new Set(ids);
      let staled = false;
      for (const s of segs) {
        if (!set.has(s.id)) continue;
        const rendered = s.audio.status === "done" || s.audio.status === "stale";
        if (rendered && stales(s)) {
          s.audio.status = "stale";
          staled = true;
        }
        Object.assign(s, patch);
      }
      // once per chapter: a removal can move a thousand lines
      if (staled) libraryStore._staleChapter(bookId, chId);
      this._adoptRevision(bookId, chId, revision);
    },
    /** A removed effect comes off the lines the server took it from, at their new revisions. */
    _dropEffect(id: string, lines: readonly (RevisedLines & { bookId: string })[]): void {
      for (const { bookId, chapterId, ids, revision } of lines) {
        const set = new Set(ids);
        for (const s of this.segments[key(bookId, chapterId)] ?? []) {
          if (!set.has(s.id) || !s.effects) continue;
          const rest = s.effects.filter((e) => e !== id);
          if (rest.length) s.effects = rest;
          else delete s.effects;
        }
        this._adoptRevision(bookId, chapterId, revision);
      }
    },
    /** One line's pause in seconds, or none for the book's pacing. Returns whether it changed;
     *  the caller re-times and commits. */
    _setPause(bookId: string, chId: number, segId: number, pause: number | null): boolean {
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s || (s.pause ?? null) === pause) return false;
      if (pause == null) delete s.pause;
      else s.pause = pause;
      return true;
    },
    /** Replace this chapter's script, from a restore or import. The caller commits it. */
    _replace(bookId: string, chId: number, segments: Segment[]): void {
      this.segments[key(bookId, chId)] = segments;
    },
    /** Scripts follow a renumbered book's chapters; a removed chapter's script goes with it. */
    _remapBook(bookId: string, map: Record<number, number>): void {
      const prefix = bookId + ":";
      const move = <T>(from: Record<string, T>): Record<string, T> => {
        const next: Record<string, T> = {};
        for (const [k, v] of Object.entries(from)) {
          if (!k.startsWith(prefix)) {
            next[k] = v;
            continue;
          }
          const to = map[Number(k.slice(prefix.length))];
          if (to) next[key(bookId, to)] = v;
        }
        return next;
      };
      this.segments = move(this.segments);
      this._previous = move(this._previous);
      this._revision = move(this._revision);
      this._rescripted = move(this._rescripted);
      // writes owed for this book's chapters name numbers that have moved; other books' stay
      const mine = pending.get(toRaw(this));
      if (mine)
        for (const [k, p] of mine)
          if (k.startsWith(prefix)) {
            for (const answer of p.answers.splice(0)) answer(false);
            mine.delete(k);
          }
    },
    /** Drop a removed book's scripts and owed writes. */
    _dropBook(bookId: string): void {
      this._remapBook(bookId, {});
    },
    /**
     * Write a chapter's script as it now stands; every edit ends here. Writes per chapter are
     * serialised: an edit during a write marks it dirty, so a burst is a few writes. `origin`
     * names a non-edit source (bulk, restore). Nothing is written inside `silence()`.
     */
    _commit(bookId: string, chId: number, origin?: VersionOrigin): void {
      if (this._silent) return;
      const p = this._pending(bookId, chId);
      if (origin) p.origin = origin;
      p.dirty = true;
      this._kick(bookId, chId, p);
    },
    /**
     * `_commit`, answered: true once landed, false when refused (script reverted, toast said) or
     * never sent, as inside `silence()`. For callers that report or undo only what persisted.
     */
    _save(bookId: string, chId: number, origin?: VersionOrigin): Promise<boolean> {
      if (this._silent) return Promise.resolve(false);
      return new Promise((resolve) => {
        this._pending(bookId, chId).answers.push(resolve);
        this._commit(bookId, chId, origin);
      });
    },
    /**
     * Write one line's own field (a flag) in this chapter's turn. It moves the revision on, so
     * edits already out or waiting go first; an edit made meanwhile names the revision it takes.
     */
    _writeLine(bookId: string, chId: number, write: () => Promise<void>): Promise<void> {
      const p = this._pending(bookId, chId);
      return new Promise<void>((resolve, reject) => {
        p.lines.push(() => write().then(resolve, reject));
        this._kick(bookId, chId, p);
      });
    },
    _pending(bookId: string, chId: number): PendingWrite {
      let mine = pending.get(toRaw(this));
      if (!mine) pending.set(toRaw(this), (mine = new Map()));
      const k = key(bookId, chId);
      const p = mine.get(k) ?? { inFlight: false, dirty: false, lines: [], answers: [] };
      mine.set(k, p);
      return p;
    },
    _kick(bookId: string, chId: number, p: PendingWrite): void {
      if (!p.inFlight) p.running = this._flush(bookId, chId, p);
    },
    async _flush(bookId: string, chId: number, p: PendingWrite): Promise<void> {
      const historyStore = useHistoryStore();
      const uiStore = useUiStore();
      const svc = libraryService();
      const k = key(bookId, chId);
      p.inFlight = true;
      /** a write was refused, so the server's history is read back with its script */
      let refused = false;
      try {
        while (p.dirty || p.lines.length || p.deferred) {
          // edits already made go before a one-line write asked for after them
          if (!p.dirty && p.lines.length) {
            await p.lines.shift()!();
            continue;
          }
          if (!p.dirty) {
            // All writes landed and a read was put off: read again now. After a refusal it is the
            // server's script over ours, not a re-script, so nothing is kept for the diff.
            p.deferred = false;
            p.reading = true;
            try {
              await Promise.all([
                fetchScript(bookId, chId),
                refused ? fetchHistory(bookId, chId) : undefined,
              ]);
              if (refused) delete this._previous[k];
            } catch {
              // the toast has said the server could not be reached, or the next read will
            } finally {
              p.reading = false;
              refused = false;
            }
            continue;
          }
          p.dirty = false;
          const origin = p.origin;
          p.origin = undefined;
          // this write answers every save asked for so far
          const answers = p.answers.splice(0);
          const segments = clone(this.segments[k] ?? []);
          // the reader refuses to delete the last line; a chapter with none is not an edit
          if (!segments.length) {
            for (const answer of answers) answer(false);
            continue;
          }
          try {
            const { revision, history } = await svc.editScript(bookId, chId, {
              segments,
              ifRevision: this._revision[k] ?? 0,
              ...(origin ? { origin } : {}),
            });
            // never backwards: a rename's answer may have landed in between
            this._revision[k] = Math.max(this._revision[k] ?? 0, revision);
            historyStore._install(bookId, chId, history);
            for (const answer of answers) answer(true);
          } catch (cause) {
            // The server's script wins and the toast says so. Anything still dirty edited a
            // script that is gone, so it is dropped and its waiting saves refused.
            for (const answer of [...answers, ...p.answers.splice(0)]) answer(false);
            p.dirty = false;
            p.deferred = true;
            refused = true;
            const api = cause instanceof ApiError ? cause : null;
            uiStore.toast(
              api?.status === 409
                ? "The script changed on the server"
                : "Could not save the script",
              {
                kind: "error",
                description:
                  api?.status === 409
                    ? "Your last change was not saved; the chapter has been read again."
                    : (api?.detail ?? (cause instanceof Error ? cause.message : undefined)),
                timeout: 8000,
              },
            );
          }
        }
      } finally {
        p.inFlight = false;
      }
    },
    /** Resolves once every write for this chapter is answered and any put-off read is made. */
    async _settled(bookId: string, chId: number): Promise<void> {
      const p = pending.get(toRaw(this))?.get(key(bookId, chId));
      while (p?.inFlight) await p.running;
    },
    /** Run `fn` without per-line edits writing their chapter; a batch is one write. */
    silence<T>(fn: () => T): T {
      const was = this._silent;
      this._silent = true;
      try {
        return fn();
      } finally {
        this._silent = was;
      }
    },
    dismissDiff(bookId: string, chId: number): void {
      delete this._previous[key(bookId, chId)];
    },
    /**
     * Every clip's status in this book and each chapter's narration, for an undo of a book-wide
     * change (the dictionary) to put back.
     */
    _audioSnapshot(bookId: string): () => void {
      const libraryStore = useLibraryStore();

      const prefix = bookId + ":";
      const audio = Object.keys(this.segments)
        .filter((k) => k.startsWith(prefix))
        .flatMap((k) => this.segments[k].map((s) => [k, s.id, s.audio.status] as const));
      const narration = libraryStore.chaptersOf(bookId).map((c) => [c.id, c.narration] as const);
      return () => {
        for (const [k, id, status] of audio) {
          const s = this.segments[k]?.find((x) => x.id === id);
          if (s) s.audio.status = status;
        }
        for (const [id, was] of narration)
          libraryStore._patchChapter(bookId, id, { narration: was });
      };
    },
    /** Stale every rendered clip `outdated` flags, and its chapter. Returns how many. */
    _restale(bookId: string, outdated: (s: Segment) => boolean): number {
      const libraryStore = useLibraryStore();

      let n = 0;
      const prefix = bookId + ":";
      for (const k of Object.keys(this.segments)) {
        if (!k.startsWith(prefix)) continue;
        const before = n;
        for (const s of this.segments[k]) {
          if (s.audio.status !== "done" || !outdated(s)) continue;
          s.audio.status = "stale";
          n++;
        }
        if (n > before) libraryStore._staleChapter(bookId, Number(k.slice(prefix.length)));
      }
      return n;
    },
    // edited after narration → existing audio no longer matches the script
    _markStale(bookId: string, chId: number, s: Segment): void {
      const libraryStore = useLibraryStore();

      if (s.audio.status === "done" || s.audio.status === "stale") {
        s.audio.status = "stale";
        libraryStore._staleChapter(bookId, chId);
      }
    },
    /**
     * Each speaker's lines in one chapter or across the loaded scripts, counting only spoken lines
     * (`isSpoken`), so a watermark gives a speaker nothing to say. `every` counts every line naming
     * a speaker, as taking one off the cast needs.
     */
    lineCounts(bookId: string, chId: number | null = null, every = false): Record<string, number> {
      const counts: Record<string, number> = {};
      const ids = chId
        ? [chId]
        : Object.keys(this.segments)
            .filter((k) => k.startsWith(bookId + ":"))
            .map((k) => Number(k.slice(bookId.length + 1)));
      for (const id of ids) {
        const tally = chapterTally(bookId, id);
        if (every) for (const [name, n] of tally.every) counts[name] = (counts[name] ?? 0) + n;
        else for (const [name, t] of tally.spoken) counts[name] = (counts[name] ?? 0) + t.lines;
      }
      return counts;
    },
  },
});

export interface SpeakerTally {
  lines: number;
  thoughts: number;
}
/** A chapter's speakers counted: spoken lines each has, and every line naming them. */
export interface ChapterTally {
  spoken: Map<string, SpeakerTally>;
  every: Map<string, number>;
}

// Each chapter's count, cached until its script or the book's reading of notes changes, so the
// book-wide counts add these up instead of rereading every line. Keyed by the raw store.
// ponytail: one entry per chapter ever counted, never evicted; key by book if memory matters
const tallies = new WeakMap<object, Map<string, ComputedRef<ChapterTally>>>();

/** Worked out once per change to the chapter. */
export function chapterTally(bookId: string, chId: number): ChapterTally {
  const scriptsStore = useScriptsStore();
  let byChapter = tallies.get(toRaw(scriptsStore));
  if (!byChapter) tallies.set(toRaw(scriptsStore), (byChapter = new Map()));
  const k = key(bookId, chId);
  let tally = byChapter.get(k);
  if (!tally)
    byChapter.set(
      k,
      (tally = computed(() => {
        const book = useLibraryStore().bookById(bookId);
        const spoken = new Map<string, SpeakerTally>();
        const every = new Map<string, number>();
        for (const s of scriptsStore.segments[k] ?? []) {
          every.set(s.speaker, (every.get(s.speaker) ?? 0) + 1);
          if (!isSpoken(s, book)) continue;
          let t = spoken.get(s.speaker);
          if (!t) spoken.set(s.speaker, (t = { lines: 0, thoughts: 0 }));
          t.lines++;
          if (s.type === "thought") t.thoughts++;
        }
        return { spoken, every };
      })),
    );
  return tally.value;
}
