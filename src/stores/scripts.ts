// Canonical script segments and editing. Every edit reaches the same audio freshness rules.
import { bulkInvalidates, bulkOutcome, scriptFingerprint, segmentFingerprint } from "@/lib/bulk";
import { remapExpressions } from "@/lib/expressions";
import { afterOf, beforeOf, bulkLabel, key, SKIP_SUMMARY, SKIP_TEXT } from "@/lib/scriptReview";
import { clone } from "@/lib/utils";
import { chapterParts, partsText, type ContentPart } from "@/mock";
import type {
  AudioStatus,
  BulkAction,
  BulkPreview,
  BulkResult,
  BulkRow,
  BulkSkip,
  BulkTarget,
  NarrationStatus,
  RescriptReport,
  ScriptDiff,
  Segment,
  SegmentFlag,
  SegmentMap,
} from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useHistoryStore } from "@/stores/history";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { seedState } from "@/stores/seed";
import { useUiStore } from "@/stores/ui";
interface ScriptsState {
  segments: SegmentMap;
  _previous: SegmentMap;
  /** what a re-script did with the manual corrections it was asked to preserve, keyed like `segments` */
  _corrections: Record<string, RescriptReport>;
}
export const useScriptsStore = defineStore("scripts", {
  state: (): ScriptsState => ({ ...seedState("segments"), _previous: {}, _corrections: {} }),
  getters: {
    segmentsOf(s): (bookId: string, chId: number) => Segment[] {
      return (bookId: string, chId: number): Segment[] => s.segments[key(bookId, chId)] ?? [];
    },
    /** A chapter's source text in the order it is read, with any author note marked. */
    partsOf(): (bookId: string, chId: number) => ContentPart[] {
      const libraryStore = useLibraryStore();

      return (bookId: string, chId: number): ContentPart[] =>
        chapterParts(
          bookId,
          chId,
          libraryStore.chapter(bookId, chId),
          libraryStore.bookById(bookId)?.sample,
        );
    },
    rawText(): (bookId: string, chId: number) => string {
      return (bookId: string, chId: number): string => partsText(this.partsOf(bookId, chId));
    },
    /** What the last re-script did with this chapter's manual corrections, while the diff is up. */
    correctionsOf(s): (bookId: string, chId: number) => RescriptReport | null {
      return (bookId: string, chId: number): RescriptReport | null =>
        s._corrections[key(bookId, chId)] ?? null;
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
      const historyStore = useHistoryStore();
      const uiStore = useUiStore();

      // history is preserved before the change, so the lines are counted before they are touched
      const targets = this.segmentsOf(bookId, chId).filter(
        (s) => s.speaker === speaker && (s.direction || "") !== direction,
      );
      if (targets.length) historyStore.noteEdit(bookId, chId);
      let n = 0;
      for (const s of targets) {
        s.direction = direction;
        s.edited = true;
        this._markStale(bookId, chId, s);
        n++;
      }
      if (n)
        uiStore.toast(`Direction applied to ${n} ${speaker} line${n === 1 ? "" : "s"}`, {
          kind: "success",
          description: `“${direction}” — rendered lines are now stale`,
          timeout: 4000,
        });
      return n;
    },
    setSpeaker(bookId: string, chId: number, segId: number, speaker: string): void {
      const historyStore = useHistoryStore();

      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (s && s.speaker !== speaker) {
        historyStore.noteEdit(bookId, chId);
        s.speaker = speaker;
        s.edited = true;
        this._markStale(bookId, chId, s);
      }
    },
    updateSegment(bookId: string, chId: number, segId: number, patch: Partial<Segment>): void {
      const historyStore = useHistoryStore();

      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s) return;
      const changed = (Object.keys(patch) as (keyof Segment)[]).some((k) => s[k] !== patch[k]);
      if (changed) historyStore.noteEdit(bookId, chId);
      if (patch.text != null && s.expressions && patch.expressions === undefined)
        s.expressions = remapExpressions(s.expressions, s.text, patch.text);
      Object.assign(s, patch);
      if (changed) {
        s.edited = true;
        this._markStale(bookId, chId, s);
      }
    },
    // ---------- bulk script corrections (Search) ----------
    // One correction, many lines, one undo. Everything goes through the per-segment actions above,
    // so a line corrected in a batch ends up in exactly the state it would reach by hand: edited,
    // its clip stale, its annotations and its prose untouched.
    /** Apply `action` to the lines the preview counted. Lines that already have the requested value
     *  are left alone. Returns the batch's single undo, or null when nothing changed. */
    applyBulk(bookId: string, targets: BulkTarget[], action: BulkAction): BulkResult {
      const historyStore = useHistoryStore();
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
      // Each chapter this batch rewrites keeps the script it had, under the batch's own name — one
      // entry per chapter, taken before a single line moves. A flag batch says something about the
      // audio without changing a word of the script, so it leaves no version behind.
      const perChapter = new Map<number, number>();
      for (const row of preview.rows)
        if (row.changes) perChapter.set(row.chId, (perChapter.get(row.chId) ?? 0) + 1);
      const historyUndo = touchesAudio
        ? [...perChapter].map(([chId, lines]) =>
            historyStore.noteBulk(bookId, chId, preview.label, lines),
          )
        : [];
      // the per-line actions below each note an edit of their own; the batch has already preserved
      // the script once, so they are silenced rather than opening an editing session per line
      historyStore.silence(() => {
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
          else narrationStore.flagSegment(bookId, row.chId, row.segId, action.flag, action.note);
          was.after = fingerprint(at());
          before.push(was);
          chapters.add(row.chId);
        }
      });
      if (!before.length) {
        for (const undo of historyUndo) undo();
        return empty;
      }
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
          s.speaker = w.speaker;
          s.direction = w.direction;
          if (w.flag) s.flag = w.flag;
          else delete s.flag;
          if (w.edited) s.edited = true;
          else delete s.edited;
          if (touchesAudio) s.audio.status = w.status;
        }
        if (touchesAudio)
          for (const chId of clean) {
            const c = libraryStore.chapter(bookId, chId);
            const was = narration.get(chId);
            if (c && was) c.narration = was;
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
        // the batch is off the script, so it comes off the history with it
        for (const undo of historyUndo) undo();
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
    _segSnapshot(bookId: string, chId: number): () => void {
      const libraryStore = useLibraryStore();

      const before = clone(this.segments[key(bookId, chId)] ?? []);
      const c = libraryStore.chapter(bookId, chId);
      const narration = c?.narration;
      const duration = c?.duration;
      return () => {
        this.segments[key(bookId, chId)] = before;
        const ch = libraryStore.chapter(bookId, chId);
        if (ch && narration) {
          ch.narration = narration;
          ch.duration = duration ?? ch.duration;
        }
      };
    },
    /**
     * One edit's undo, for both owners it touches: the chapter's script here, and its place in the
     * history next door. An edit that is undone has to leave the history saying what the script now
     * is — not that a manual edit happened which no longer exists — so the two are put back
     * together or not at all. Taken *before* the edit, like every other snapshot.
     */
    _editSnapshot(bookId: string, chId: number): () => void {
      const historyStore = useHistoryStore();

      const script = this._segSnapshot(bookId, chId);
      const history = historyStore._chapterSnapshot(bookId, chId);
      return () => {
        script();
        history();
      };
    },
    /** Cut a segment in two at character offset `at`. Returns the new segment's id. */
    splitSegment(bookId: string, chId: number, segId: number, at: number): number | null {
      const castStore = useCastStore();
      const historyStore = useHistoryStore();
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
      historyStore.noteEdit(bookId, chId);
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
      const c = libraryStore.chapter(bookId, chId);
      if (c && c.narration === "done") c.narration = "stale";
      segs.splice(i + 1, 0, second);
      castStore._retime(bookId, chId);
      uiStore.toast("Segment split in two", {
        description: `#${s.id} keeps “${head.slice(0, 40)}…”, #${id} starts “${tail.slice(0, 40)}…”`,
        undo: revert,
      });
      return id;
    },
    /** Join a segment with the one after it. The first segment's speaker, type and direction win. */
    joinSegments(bookId: string, chId: number, segId: number): boolean {
      const castStore = useCastStore();
      const historyStore = useHistoryStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      const segs = this.segments[key(bookId, chId)];
      const i = segs?.findIndex((x) => x.id === segId) ?? -1;
      if (i < 0 || i + 1 >= segs.length) return false;
      const revert = this._editSnapshot(bookId, chId);
      historyStore.noteEdit(bookId, chId);
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
      const c = libraryStore.chapter(bookId, chId);
      if (c && c.narration === "done" && b.audio.status !== "none") c.narration = "stale";
      segs.splice(i + 1, 1);
      castStore._retime(bookId, chId);
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
      const historyStore = useHistoryStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      const segs = this.segments[key(bookId, chId)];
      const i = segs?.findIndex((x) => x.id === segId) ?? -1;
      if (i < 0 || segs.length < 2) return false;
      const revert = this._editSnapshot(bookId, chId);
      historyStore.noteEdit(bookId, chId);
      const [gone] = segs.splice(i, 1);
      // its audio goes with it, so a finished chapter no longer matches what was rendered
      const c = libraryStore.chapter(bookId, chId);
      if (c && c.narration === "done" && gone.audio.status !== "none") c.narration = "stale";
      castStore._retime(bookId, chId);
      uiStore.toast(`#${gone.id} deleted`, {
        description: `${gone.speaker}: “${
          gone.text.length > 70 ? gone.text.slice(0, 70).trimEnd() + "…" : gone.text
        }”`,
        undo: revert,
      });
      return true;
    },
    /** A finished re-script says what it could and could not re-apply; the reader shows both. */
    _noteCorrections(bookId: string, chId: number, report: RescriptReport): void {
      this._corrections[key(bookId, chId)] = report;
    },
    dismissDiff(bookId: string, chId: number): void {
      delete this._previous[key(bookId, chId)];
      delete this._corrections[key(bookId, chId)];
    },
    // edited after narration → existing audio no longer matches the script
    _markStale(bookId: string, chId: number, s: Segment): void {
      const libraryStore = useLibraryStore();

      if (s.audio.status === "done" || s.audio.status === "stale") {
        s.audio.status = "stale";
        const c = libraryStore.chapter(bookId, chId);
        if (c?.narration === "done") c.narration = "stale";
      }
    },
    lineCounts(bookId: string, chId: number | null = null): Record<string, number> {
      const counts: Record<string, number> = {};
      const keys = chId
        ? [key(bookId, chId)]
        : Object.keys(this.segments).filter((k) => k.startsWith(bookId + ":"));
      for (const k of keys)
        for (const s of this.segments[k] ?? []) counts[s.speaker] = (counts[s.speaker] ?? 0) + 1;
      return counts;
    },
  },
});
