// The Contents page's state and actions, gathered once for the page and the tabs it is made of.
//
// Contents review: what goes in the audiobook, and how it is cut into volumes. Reached twice —
// straight after an EPUB is read, when confirming is what adds the book to the library, and any
// time later from the overview, when every change applies at once. It is one page either way, so
// a chapter skipped on import is restored in the same place, with the same words.
//
// Nothing here removes content. A skipped chapter keeps its text, its number and its place, and
// leaves every stage and the audiobook; the suggestions the import attached are a reason beside a
// title until the person acts on them. A volume boundary is a line between two chapters: moving
// it, cutting one or joining two renumbers nothing — the store writes the whole list of starts and
// the toast's Undo writes back the one before.
import { computed, watch } from "vue";
import { useRouter } from "vue-router";
import { useMediaQuery } from "@vueuse/core";
import { chapterNumbers, chapterRef, numberSpan } from "@/lib/chapterNumber";
import { importLabel, isUndecided } from "@/lib/contents";
import * as vol from "@/lib/volumes";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { useChapterText } from "@/queries";
import { useBookId } from "@/composables/useBookId";
import {
  enumParam,
  idParam,
  idSetParam,
  textParam,
  useQueryParam,
} from "@/composables/useQueryParam";
import { useRangeSelect } from "@/composables/useRangeSelect";
import type { VolumeRow } from "@/views/contents/ContentsList.vue";
import { FILTER_KEYS, passes, type ContentsFilter } from "@/views/contents/shared";
import type { Chapter, NoticeGroup, NoticeKind, VolumeStart } from "@/types";

export const TABS = [
  { value: "decide", label: "To decide" },
  { value: "all", label: "All chapters" },
  { value: "volumes", label: "Volumes" },
] as const;
export type ContentsTab = (typeof TABS)[number]["value"];

export function useContents() {
  const libraryStore = useLibraryStore();
  const scriptsStore = useScriptsStore();
  const uiStore = useUiStore();
  const router = useRouter();
  const bookId = useBookId();

  const book = computed(() => libraryStore.bookById(bookId));
  const chapters = computed(() => libraryStore.chaptersOf(bookId));
  /** reading numbers, which the search finds a chapter by and the rows and preview show */
  const numbers = computed(() => libraryStore.chapterNumbers[bookId]);
  const volumes = computed(() => libraryStore.volumesOf(bookId));
  const multi = computed(() => volumes.value.length > 1);
  const summary = computed(() => libraryStore.contentsOf(bookId));
  const groups = computed(() => libraryStore.noticeGroupsOf(bookId));
  const undecided = computed(() => chapters.value.filter(isUndecided));
  /** book: a new novel waiting to be added; volume: one more volume of a shelved book; null: shelved */
  const importing = computed<"book" | "volume" | null>(() =>
    book.value?.importing ? "book" : libraryStore.importingVolume(bookId) ? "volume" : null,
  );
  // a book still in review flags its volumes too; only a shelved book has one new volume to count
  const newVolume = computed(() =>
    book.value?.importing ? undefined : libraryStore.importingVolume(bookId),
  );

  // ---- page state, kept in the URL so leaving and coming back finds the same view
  const tab = useQueryParam<ContentsTab>(
    "tab",
    enumParam(
      TABS.map((t) => t.value),
      undecided.value.length ? "decide" : "all",
    ),
  );
  const q = useQueryParam("find", textParam());
  const filter = useQueryParam("filter", enumParam(FILTER_KEYS, "all"));
  const kind = useQueryParam<NoticeKind | null>("kind", {
    parse: (text) => (text as NoticeKind) || null,
    serialize: (value) => value ?? undefined,
    default: null,
  });
  const collapsed = useQueryParam(
    "closed",
    // a new volume of a shelved book: the volumes already reviewed start folded away
    idSetParam(
      () =>
        new Set(newVolume.value ? volumes.value.filter((v) => !v.importing).map((v) => v.id) : []),
    ),
  );
  const wide = useMediaQuery("(min-width: 1024px)");
  const opened = useQueryParam("ch", idParam());
  // the first thing worth reading is the first chapter still to decide — on a clean book, nothing
  if (opened.value == null && wide.value) opened.value = undecided.value[0]?.id ?? null;
  // Reading a chapter here makes it the book's current chapter, so Scripting opens on the one you
  // were just reading. Contents keeps its own first pick — the chapter still to decide — because
  // that is the job this page is for.
  watch(
    opened,
    (id) => {
      if (id != null) uiStore.openChapter(bookId, id);
    },
    { immediate: true },
  );

  // ---- the list
  const shows = (c: Chapter) =>
    passes(c, numbers.value?.get(c.id), filter.value, kind.value, q.value);
  const rows = computed<VolumeRow[]>(() =>
    volumes.value
      .map((v) => {
        const all = chapters.value.filter((c) => c.volumeId === v.id);
        return { ...v, all, chapters: all.filter(shows) };
      })
      .filter((v) => v.chapters.length),
  );
  const visible = computed(() => rows.value.flatMap((v) => v.chapters));
  const narrowed = computed(() => !!q.value || filter.value !== "all" || !!kind.value);
  const filterCounts = computed<Record<ContentsFilter, number>>(() => ({
    all: summary.value.total,
    included: summary.value.included,
    suggested: summary.value.suggested,
    review: summary.value.review,
    skipped: summary.value.skipped,
  }));

  const textOf = (c: Chapter) => scriptsStore.rawText(bookId, c.id);
  const openedChapter = computed(() =>
    opened.value == null ? undefined : libraryStore.chapter(bookId, opened.value),
  );
  // The opened chapter's prose, read from the server the first time it is opened.
  const { parts: openedParts } = useChapterText(bookId, () => openedChapter.value?.id);
  const undecidedAfter = computed(
    () => undecided.value.filter((c) => c.id !== opened.value).length,
  );

  // ---- decisions. Every one goes through the store's two actions, so the row, the preview, the
  // inbox and the volume header leave a chapter in exactly the same state.
  // a run over what is on screen, not over the whole book — the list you can see is the list
  const range = useRangeSelect(() => visible.value.map((x) => x.id));
  function toggle(c: Chapter, e?: MouseEvent | KeyboardEvent) {
    const run = range.span(c.id, e);
    // one row is its own undo; a run toasts, with Undo, naming the chapters it covered
    const skip = !c.excluded;
    // the toast names the run by the reading numbers its chapters have while kept: the ones they
    // held before a skip, the ones they are given by an include
    const ids = new Set(run);
    const span = numberSpan(
      run,
      skip
        ? numbers.value
        : chapterNumbers(
            chapters.value.map((x) => ({ id: x.id, excluded: x.excluded && !ids.has(x.id) })),
          ),
    );
    libraryStore.skipChapters(
      bookId,
      run,
      skip,
      run.length === 1 ? { quiet: true } : span ? { scope: span } : {},
    );
  }
  function toggleVolume(v: Pick<VolumeRow, "name" | "all" | "chapters">) {
    const on = v.all.filter((c) => !c.excluded).length;
    const hidden = v.all.length - v.chapters.length;
    libraryStore.skipChapters(
      bookId,
      v.all.map((c) => c.id),
      on === v.all.length,
      {
        scope:
          v.name + (narrowed.value && hidden ? ` (${hidden} of them hidden by the filter)` : ""),
      },
    );
  }
  const skipOne = (id: number) => libraryStore.skipChapters(bookId, [id], true, { quiet: true });
  const includeOne = (id: number) =>
    libraryStore.skipChapters(bookId, [id], false, { quiet: true });
  const keepOne = (id: number) => libraryStore.keepChapters(bookId, [id], { quiet: true });
  const skipGroup = (g: NoticeGroup) =>
    libraryStore.skipChapters(bookId, g.pending, true, { scope: g.label.toLowerCase() });
  const keepGroup = (g: NoticeGroup) => libraryStore.keepChapters(bookId, g.pending);
  function skipAllSuggested() {
    const ids = undecided.value.filter((c) => c.note?.verdict === "skip").map((c) => c.id);
    libraryStore.skipChapters(bookId, ids, true, { scope: "every suggested chapter" });
  }
  function setFilter(f: ContentsFilter) {
    filter.value = f;
    kind.value = null;
  }
  function showEverything() {
    filter.value = "all";
    kind.value = null;
    q.value = "";
  }

  // ---- reading. Opening never touches a tick; moving keeps the list where it is.
  const open = (id: number) => (opened.value = id);
  function step(delta: number) {
    const ids = visible.value.map((c) => c.id);
    const i = opened.value == null ? -1 : ids.indexOf(opened.value);
    const next = ids[i < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, i + delta))];
    if (next != null) open(next);
  }
  /** Open the next chapter still to decide, after the one open; answers it, for the list to focus. */
  function nextUndecided(): Chapter | undefined {
    const all = chapters.value;
    const from = opened.value == null ? -1 : all.findIndex((c) => c.id === opened.value);
    const after = all.slice(from + 1).find(isUndecided) ?? all.find(isUndecided);
    if (!after) return;
    if (!shows(after)) showEverything();
    open(after.id);
    return after;
  }

  // ---- volumes. Every change is the whole list of starts, written through the store, which
  // installs the server's answer and toasts with Undo.
  const chapterIds = computed(() => chapters.value.map((c) => c.id));
  const starts = computed(() => libraryStore.volumeStartsOf(bookId));
  const volumeRows = computed(() => vol.volumeRows(volumes.value, chapters.value, numbers.value));
  const titleCandidates = computed(() => vol.startsByTitles(chapters.value));
  const refOf = (id: number) => chapterRef(numbers.value?.get(id));
  const nameAt = (id: number) => starts.value.find((s) => s.chapter === id)?.name ?? "Volume";
  const write = (next: VolumeStart[], scope: string) =>
    libraryStore.setVolumes(bookId, next, { scope });
  const cutAt = (id: number) =>
    write(vol.cutAt(starts.value, chapterIds.value, id), `Cut before ${refOf(id)}`);
  function joinAt(id: number) {
    const i = starts.value.findIndex((s) => s.chapter === id);
    if (i < 1) return;
    write(
      vol.joinAt(starts.value, id),
      `${starts.value[i].name} joined with ${starts.value[i - 1].name}`,
    );
  }
  /** Move the start at `id` by `delta` chapters; answers the chapter it now begins at. */
  function moveStart(id: number, delta: number): number {
    const next = vol.moveStart(starts.value, chapterIds.value, id, delta);
    const moved = next[starts.value.findIndex((s) => s.chapter === id)];
    if (!moved || moved.chapter === id) return id;
    write(next, `${moved.name} now starts at ${refOf(moved.chapter)}`);
    return moved.chapter;
  }
  function rename(id: number, name: string) {
    const before = nameAt(id);
    const next = vol.renameAt(starts.value, id, name);
    if (next.find((s) => s.chapter === id)?.name !== before)
      write(next, `Renamed ${before} to ${name.trim()}`);
  }
  const firstName = () => starts.value[0]?.name ?? book.value?.title ?? "Volume 1";
  const cutEvery = (n: number) =>
    write(vol.every(chapterIds.value, n, firstName()), `Every ${n} chapters`);
  function cutEvenly(n: number) {
    const next = vol.evenly(chapterIds.value, n, firstName());
    write(next, `${next.length} volumes`);
  }
  function cutByTitles(ids: number[]) {
    const next = vol.atChapters(chapterIds.value, ids, firstName());
    write(next, `${next.length} volumes, where the titles say so`);
  }

  // ---- the import itself
  const included = computed(() => {
    if (!newVolume.value) return summary.value.included;
    return chapters.value.filter((c) => c.volumeId === newVolume.value!.id && !c.excluded).length;
  });
  const actionLabel = computed(() =>
    importLabel(importing.value === "volume" ? "volume" : "book", included.value),
  );
  async function confirm() {
    if (!(await libraryStore.confirmImport(bookId))) return;
    uiStore.currentBookId = bookId;
    void router.push(`/book/${bookId}`);
  }
  /** Answers whether the import went, so the header can put its question away. */
  async function discard(): Promise<boolean> {
    const what = await libraryStore.discardImport(bookId);
    if (!what) return false;
    uiStore.toast(what === "book" ? "Import cancelled" : "Volume not added", {
      kind: "info",
      description: "Nothing was added to the library.",
      timeout: 4000,
    });
    void router.push(what === "book" ? "/library" : `/book/${bookId}`);
    return true;
  }

  return {
    libraryStore,
    bookId,
    book,
    chapters,
    numbers,
    volumes,
    multi,
    summary,
    groups,
    undecided,
    importing,
    newVolume,
    tab,
    q,
    filter,
    kind,
    collapsed,
    wide,
    opened,
    rows,
    visible,
    narrowed,
    filterCounts,
    textOf,
    openedChapter,
    openedParts,
    undecidedAfter,
    toggle,
    toggleVolume,
    skipOne,
    includeOne,
    keepOne,
    skipGroup,
    keepGroup,
    skipAllSuggested,
    setFilter,
    showEverything,
    open,
    step,
    nextUndecided,
    volumeRows,
    titleCandidates,
    cutAt,
    joinAt,
    moveStart,
    rename,
    cutEvery,
    cutEvenly,
    cutByTitles,
    included,
    actionLabel,
    confirm,
    discard,
  };
}

export type ContentsPage = ReturnType<typeof useContents>;
