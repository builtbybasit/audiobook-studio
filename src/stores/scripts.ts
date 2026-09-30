// Canonical script segments and editing. Every edit reaches the same audio freshness rules.
//
// This store is the working copy of each chapter's script: it is filled by `useChapterScript` in
// `@/queries`, every edit acts on it at once, and each edit is then written back through `_commit` — the script as it now stands, with the revision
// it was read at. A write against a script that moved in the meantime (a job landed, another tab
// wrote) is refused by the server, the way a stale job result is, and the server's script is read
// back over the local one with a toast saying so. History is the server's too: a write answers
// with the history it added to, and the history store installs it.
import { bulkInvalidates, bulkOutcome, scriptFingerprint, segmentFingerprint } from "@/lib/bulk";
import { remapExpressions } from "@/lib/expressions";
import { scriptSignature } from "@/lib/scriptHistory";
import { afterOf, beforeOf, bulkLabel, key, SKIP_SUMMARY, SKIP_TEXT } from "@/lib/scriptReview";
import { isSiteText, isSpoken, TYPE_LABEL } from "@/lib/siteText";
import { NARRATOR } from "@/lib/cast";
import { clone } from "@/lib/utils";
import type { ContentPart } from "@/lib/contents";
import { fetchScript } from "@/queries/chapterScript";
import { chapterPartsNow, chapterTextNow } from "@/queries/chapterText";
import { fetchHistory } from "@/queries/history";
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
/** A write in progress for one chapter, and whether another is owed once it lands. */
interface PendingWrite {
  inFlight: boolean;
  /** the loop writing this chapter, while `inFlight` */
  running?: Promise<void>;
  dirty: boolean;
  /** one-line writes (a flag) waiting for their turn, in the order they were asked for */
  lines: (() => Promise<void>)[];
  /** what the next write says produced the script; an ordinary edit when unset */
  origin?: VersionOrigin;
  /** a read of the server's script arrived while this chapter was being written, and was put off */
  deferred?: boolean;
  /** the server's script is being read back once the writes have landed, and is to be installed */
  reading?: boolean;
}

/** Writes in flight, per store instance, kept out of the reactive state. */
const pending = new WeakMap<object, Map<string, PendingWrite>>();

interface ScriptsState {
  segments: SegmentMap;
  _previous: SegmentMap;
  /** the revision each chapter's script was read at, which the next write names */
  _revision: Record<string, number>;
  /** chapters a scripting job just rewrote, whose next read is a re-script */
  _rescripted: Record<string, true>;
  /** set while a batch drives the per-line actions, so it writes each chapter once, as itself */
  _silent: boolean;
}
export const useScriptsStore = defineStore("scripts", {
  // No script is here until it has been read from the server.
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
    /**
     * Whether this chapter's script is here. `segmentsOf` is empty both for a chapter not read yet
     * and for one read with no lines, so this is what says which.
     */
    held(s): (bookId: string, chId: number) => boolean {
      return (bookId: string, chId: number): boolean => key(bookId, chId) in s.segments;
    },
    /**
     * A chapter's lines counted, and how many have a clip done, rendering or failed: the script's
     * own when it is here, which follows every edit, and otherwise the count the server listed the
     * chapter with. Undefined when neither has been read. As the server counts them, only the lines
     * the book reads aloud are lines here (`isSpoken`); the rest are `skipped`, so a chapter with a
     * watermark in it is not a line short of finished.
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
    /**
     * A chapter's source text in the order it is read, with any author note marked.
     *
     * The page that shows a chapter reads `useChapterText` in `@/queries`; this is for the callers
     * that need the prose synchronously — whatever the query cache already holds. Text that has not
     * been read yet is no parts at all.
     */
    partsOf(): (bookId: string, chId: number) => ContentPart[] {
      return (bookId: string, chId: number): ContentPart[] => chapterPartsNow(bookId, chId);
    },
    /**
     * The chapter as anything that counts, bills or speaks it must read it.
     *
     * That is the `plain` reading, never the stored Markdown: the stored form would have a heading's `##` narrated, a link's address read out, and both charged for.
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
    /** What a bulk correction would do, computed without touching anything. The dialog shows this;
     *  `applyBulk` then changes exactly the rows it counted. */
    bulkPreview(): (bookId: string, targets: BulkTarget[], action: BulkAction) => BulkPreview {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();

      return (bookId, targets, action) => {
        const cast = castStore.charactersOf(bookId);
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
          const willStale = changes && bulkInvalidates(action) && s.audio.status === "done";
          if (changes) changing++;
          if (willStale) stale++;
          rows.push({
            chId: t.chId,
            segId: t.segId,
            chapter: libraryStore.chapter(bookId, t.chId)?.title ?? `Chapter ${t.chId}`,
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
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (s && s.speaker !== speaker) {
        s.speaker = speaker;
        s.edited = true;
        this._markStale(bookId, chId, s);
        this._commit(bookId, chId);
      }
    },
    updateSegment(bookId: string, chId: number, segId: number, patch: Partial<Segment>): void {
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s) return;
      const changed = (Object.keys(patch) as (keyof Segment)[]).some((k) => s[k] !== patch[k]);
      if (patch.text != null && s.expressions && patch.expressions === undefined)
        s.expressions = remapExpressions(s.expressions, s.text, patch.text);
      // the detector's suggestion was about the type the line had; the server drops it on the same
      // change, and this side does so at once rather than on the next read
      if (patch.type && patch.type !== s.type) delete s.siteCheck;
      Object.assign(s, patch);
      if (changed) {
        s.edited = true;
        this._markStale(bookId, chId, s);
        this._commit(bookId, chId);
      }
    },
    // ---------- site text ----------
    // A line marked as site text is left out of the audiobook without a word anywhere else saying
    // so — the omission is silent by design — so a mark made by accident has to be as easy to see
    // and take back as it was to make. Every change of type that moves a line into or out of what is
    // read aloud says so in a toast with its Undo, whichever control made it.
    /**
     * Give a line another type. Text that is not the story is nobody's line, so it goes to the
     * Narrator, as the server writes it. A clip is staled only when the line will now be read
     * differently from it: whether a line is heard at all is `isSpoken`'s to decide wherever audio
     * is played, timed, billed or stitched, so a clip on a line marked as site text stays as it was,
     * and marking it back as the story it was rendered as hears the same clip again (`clipDrift`).
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
      // a clip that recorded what it was rendered from is judged against it; one that did not is
      // taken to read the line as it was
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
    /** Take the detector's suggestion: the line gets the type it suggested, with the Undo above. */
    acceptSiteCheck(bookId: string, chId: number, segId: number): void {
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (s?.siteCheck) this.setLineType(bookId, chId, segId, s.siteCheck.suggest);
    },
    /**
     * Leave the line as it is and drop the suggestion. Nothing a person hears changes, so the line
     * is not marked edited and no clip goes stale; the script is written all the same, so the
     * suggestion does not come back on the next read, and the Undo writes it back.
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
    // One correction, many lines, one undo. Everything goes through the per-segment actions above,
    // so a line corrected in a batch ends up in exactly the state it would reach by hand: edited,
    // its clip stale, its annotations and its prose untouched.
    /** Apply `action` to the lines the preview counted. Lines that already have the requested value
     *  are left alone. Returns the batch's single undo, or null when nothing changed. */
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
      // Flagging never touches a clip, so an undo of a flag batch ignores what the audio did since;
      // a speaker or direction batch marked clips stale, so its undo has to see them unchanged.
      const touchesAudio = bulkInvalidates(action);
      const fingerprint = touchesAudio ? segmentFingerprint : scriptFingerprint;
      // what each line read before, plus what it reads straight after — undo refuses to overwrite a
      // line that someone edited in between
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
      // Each chapter this batch rewrites is written once, under the batch's own name, so its
      // history keeps the script it had as one entry. A flag batch says something about the audio
      // without changing a word of the script, so it leaves no version behind and writes no
      // script at all: each flag goes to its line alone (`flagSegment`), naming no revision, so a
      // run landing clips in the chapter meanwhile cannot refuse it.
      const perChapter = new Map<number, number>();
      for (const row of preview.rows)
        if (row.changes) perChapter.set(row.chId, (perChapter.get(row.chId) ?? 0) + 1);
      // the per-line edits below would each write their chapter as an edit; the batch writes each
      // chapter once, under its own name, so they are silenced rather than opening a session a
      // line. A flag writes only its line, so a flag batch is left to write each one.
      const batch = <T>(fn: () => T): T => (touchesAudio ? this.silence(fn) : fn());
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
            this.setSpeaker(bookId, row.chId, row.segId, action.speaker);
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
      // one write per chapter for the whole batch, under the batch's own name
      if (touchesAudio)
        for (const [chId, lines] of perChapter)
          this._commit(bookId, chId, { kind: "bulk", label: preview.label, lines });
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
          // a flag batch is undone the way it was done, a line's flag at a time
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
      // flagging says something about a clip; it does not change what would be sent to the endpoint
      const stale = bulkInvalidates(action) ? before.filter((w) => w.status === "done").length : 0;
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
    // The LLM sometimes groups two speakers into one segment, or cuts a sentence in half. These two
    // actions fix the split by hand; both are undoable and both invalidate the audio they touch.
    /**
     * One edit's undo: the chapter's script as it was, written back as an edit of its own. Taken
     * *before* the edit, like every other snapshot. The server's history follows the script, so
     * there is no history to put back beside it.
     */
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
      // the whitespace the cut falls in is the prose, not padding: a paragraph break has to survive
      // the split so that joining the halves back restores the source exactly
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
      // a hand-split chunk is no longer the model's unverified guess, and the halves start unflagged
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
      // the second half has no audio at all, so a narrated chapter is no longer complete
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
    /** Join a segment with the one after it. The first segment's speaker, type and direction win. */
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
      // put back whatever stood between them — a single space unless a split recorded otherwise
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
      // the pair now ends where b ended, so b's own separator becomes a's
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
     * Drop a line from the chapter. Contents keeps a chapter whole when the story has something
     * else around it — an author's note, a translator's aside — and promises it can be trimmed
     * here once the chapter is scripted; this is that trim. Also the way out for a line the model
     * invented or doubled.
     *
     * Refuses the last line, because a chapter with nothing in it can't be narrated and there
     * would be no row left to undo from. Undoable, like every other boundary edit.
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
     * A chapter's script as the server holds it, in place of what was here.
     *
     * What `useChapterScript` installs on every read. A script that was here before, at an
     * earlier revision, is a script something else replaced — a scripting job landed — and is kept
     * as `_previous` so the reader can show what changed. A re-read at the revision this store
     * already holds is the same script again, and replaces nothing worth keeping; neither does a
     * read whose lines say the same things and only carry different clips, which is what a
     * narration job landing looks like — the revision moved, and there is no diff to show. The
     * one read that keeps the diff regardless is the one after a scripting job (`_noteRescript`):
     * a re-script that came back the same is worth saying so about.
     *
     * A read that arrives while this chapter has an edit on its way, or one waiting to go, is put
     * off rather than installed: it was read before the edit landed, so it would put back what the
     * person just changed, and a write still waiting would then send the server's script back to
     * it instead of the edit. The chapter is read again once its writes have landed (`_flush`).
     */
    _install(bookId: string, chId: number, script: ChapterScript): void {
      const k = key(bookId, chId);
      const p = pending.get(this)?.get(k);
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
    /** A scripting job rewrote this chapter: the next read replaces a script, and keeps it for the diff. */
    _noteRescript(bookId: string, chId: number): void {
      this._rescripted[key(bookId, chId)] = true;
    },
    /**
     * The revision the server says this chapter's script is at now, so the next edit names it.
     *
     * Only for a chapter whose script is here: one not read yet has no edit to name it, and will
     * read its revision with its script. Never backwards, because an edit's answer for this chapter
     * may have landed in between.
     */
    _adoptRevision(bookId: string, chId: number, revision: number): void {
      const k = key(bookId, chId);
      if (!(k in this.segments)) return;
      this._revision[k] = Math.max(this._revision[k] ?? 0, revision);
    },
    /**
     * Lines the server changed in one chapter, changed here the same way: `patch` on each, and its
     * clip marked stale, since the line now reads differently from what was rendered. Then the
     * revision the server's script is at, as `_adoptRevision`. A chapter not read yet has nothing
     * to change.
     */
    _applyLines(
      bookId: string,
      chId: number,
      ids: readonly number[],
      patch: Partial<Pick<Segment, "speaker">>,
      revision: number,
    ): void {
      const segs = this.segments[key(bookId, chId)];
      if (!segs) return;
      const set = new Set(ids);
      for (const s of segs)
        if (set.has(s.id)) {
          Object.assign(s, patch);
          this._markStale(bookId, chId, s);
        }
      this._adoptRevision(bookId, chId, revision);
    },
    /**
     * One line's own pause, in seconds, or none to go back to the book's pacing. Returns whether
     * it changed; the caller re-times the chapter and commits it.
     */
    _setPause(bookId: string, chId: number, segId: number, pause: number | null): boolean {
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s || (s.pause ?? null) === pause) return false;
      if (pause == null) delete s.pause;
      else s.pause = pause;
      return true;
    },
    /**
     * This chapter's script, as a restore or an import worked it out, in place of what is here.
     * The caller commits it.
     */
    _replace(bookId: string, chId: number, segments: Segment[]): void {
      this.segments[key(bookId, chId)] = segments;
    },
    /** The scripts of a renumbered book follow their chapters; a chapter that is gone takes its own. */
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
      // a write owed for one of this book's chapters was for a number that has moved; every
      // other book's writes are still owed
      const mine = pending.get(this);
      if (mine) for (const k of mine.keys()) if (k.startsWith(prefix)) mine.delete(k);
    },
    /** A book that is gone takes every chapter's script with it, and any write still owed. */
    _dropBook(bookId: string): void {
      this._remapBook(bookId, {});
    },
    /**
     * Write a chapter's script to the server as it now stands.
     *
     * Every edit ends with this. Writes for one chapter are serialised: a second edit while one is
     * in flight marks the chapter dirty, and the write that follows sends the script as it then
     * is, so a burst of edits is a few writes rather than one per keystroke. `origin` names what
     * produced the script when it was not an ordinary edit — a bulk correction, a restore — and
     * travels with the next write. Nothing is written while a batch is driving the per-line
     * actions: the batch commits once, under its own name.
     */
    _commit(bookId: string, chId: number, origin?: VersionOrigin): void {
      if (this._silent) return;
      const p = this._pending(bookId, chId);
      if (origin) p.origin = origin;
      p.dirty = true;
      this._kick(bookId, chId, p);
    },
    /**
     * Write one line's own field — a flag — in this chapter's turn, and resolve (or reject) as
     * `write` does. The server moves the chapter's revision on for it, so it cannot overtake an edit
     * already on its way or waiting to go, which names the revision it read: that goes first. An
     * edit made while it is out waits for it in turn, and names the revision `write` took on.
     */
    _writeLine(bookId: string, chId: number, write: () => Promise<void>): Promise<void> {
      const p = this._pending(bookId, chId);
      return new Promise<void>((resolve, reject) => {
        p.lines.push(() => write().then(resolve, reject));
        this._kick(bookId, chId, p);
      });
    },
    _pending(bookId: string, chId: number): PendingWrite {
      let mine = pending.get(this);
      if (!mine) pending.set(this, (mine = new Map()));
      const k = key(bookId, chId);
      const p = mine.get(k) ?? { inFlight: false, dirty: false, lines: [] };
      mine.set(k, p);
      return p;
    },
    /** Start writing the chapter, unless its writes are already going out. */
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
            // Every write has landed, and a read was put off while they did: the chapter is read
            // again now, so what the server did to it meanwhile — a clip that landed — shows. After
            // a refusal it is the server's script over the local one, and not a re-script, so
            // what it replaced is not kept for the diff.
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
          const segments = clone(this.segments[k] ?? []);
          // the reader refuses to delete the last line; a chapter with none is not an edit
          if (!segments.length) continue;
          try {
            const { revision, history } = await svc.editScript(bookId, chId, {
              segments,
              ifRevision: this._revision[k] ?? 0,
              ...(origin ? { origin } : {}),
            });
            // never backwards: a rename's answer for this chapter may have landed in between
            this._revision[k] = Math.max(this._revision[k] ?? 0, revision);
            historyStore._install(bookId, chId, history);
          } catch (cause) {
            // The server's script wins: what is here is read again over the edit, and the toast
            // says so. Anything still dirty is dropped with it — it was an edit of a script that
            // is no longer there.
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
    /**
     * Resolves once nothing is being written for this chapter: every edit and one-line write made
     * so far has been answered, and a read put off meanwhile has been made.
     */
    async _settled(bookId: string, chId: number): Promise<void> {
      const p = pending.get(this)?.get(key(bookId, chId));
      while (p?.inFlight) await p.running;
    },
    /** Run `fn` without its per-line edits each writing their chapter — a batch is one write. */
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
     * Every clip's status in this book's scripts as they stand, and each chapter's narration, for
     * an undo to put back: a change to the book as a whole — the dictionary — stales clips in
     * chapters the undo would otherwise have to find again.
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
    /**
     * Mark stale every rendered clip of this book that `outdated` says no longer matches what its
     * line would send now, and its chapter with it. Returns how many.
     */
    _restale(bookId: string, outdated: (s: Segment) => boolean): number {
      const libraryStore = useLibraryStore();

      let n = 0;
      const prefix = bookId + ":";
      for (const k of Object.keys(this.segments)) {
        if (!k.startsWith(prefix)) continue;
        for (const s of this.segments[k]) {
          if (s.audio.status !== "done" || !outdated(s)) continue;
          s.audio.status = "stale";
          n++;
          libraryStore._staleChapter(bookId, Number(k.slice(prefix.length)));
        }
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
     * Each speaker's lines, in one chapter or across the book's scripts that are here. Counted as
     * they are read aloud (`isSpoken`): a line of site text, or a note this book does not read, gives
     * its speaker nothing to say, and counting it would send a speaker with only a watermark to their
     * name to the voice table. `every` counts every line that names a speaker, spoken or not — what
     * taking a speaker off the cast has to ask.
     */
    lineCounts(bookId: string, chId: number | null = null, every = false): Record<string, number> {
      const book = useLibraryStore().bookById(bookId);
      const counts: Record<string, number> = {};
      const keys = chId
        ? [key(bookId, chId)]
        : Object.keys(this.segments).filter((k) => k.startsWith(bookId + ":"));
      for (const k of keys)
        for (const s of this.segments[k] ?? [])
          if (every || isSpoken(s, book)) counts[s.speaker] = (counts[s.speaker] ?? 0) + 1;
      return counts;
    },
  },
});
