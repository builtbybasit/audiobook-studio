// What the ⌘K palette can offer, derived from the stores; `CommandPalette.vue` is the widget.
// Read-only: a row's `run` calls the store that owns the work, and which rows exist follows that
// store's rules (skipped chapters, `retryableFailures`) so a count never differs from what runs.
import { useCastStore } from "@/stores/cast";
import { numberCell } from "@/lib/chapterNumber";
import { plural } from "@/lib/contents";
import { voiced } from "@/lib/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useUiStore } from "@/stores/ui";

import type { RouteLocationRaw, Router } from "vue-router";
import { isNarrated, isScripted } from "@/lib/scriptReview";
import { reviewCount } from "@/views/review/inbox";

/** One row of the palette; the default order is the order they are pushed. */
export interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  /** speaker swatch, on Speakers rows */
  color?: string;
  run: () => void;
}

/** Every row the palette can show right now. `mod` is this machine's modifier-key legend. */
export function paletteCommands(router: Router, mod: string): Command[] {
  const castStore = useCastStore();
  const endpointsStore = useEndpointsStore();
  const jobsStore = useJobsStore();
  const libraryStore = useLibraryStore();
  const narrationStore = useNarrationStore();
  const scriptingStore = useScriptingStore();
  const uiStore = useUiStore();

  const b = uiStore.currentBookId;
  const book = libraryStore.book;
  const chs = b ? libraryStore.chaptersOf(b) : [];
  const go = (to: RouteLocationRaw) => () => router.push(to);

  const out: Command[] = [];
  out.push({
    id: "nav-library",
    group: "Go to",
    label: "Library",
    hint: "all novels",
    run: go("/library"),
  });
  out.push({
    id: "nav-endpoints",
    group: "Go to",
    label: "Endpoints",
    hint: "scripting + TTS, all books",
    keywords: "endpoint provider api server health spend budget",
    run: go("/endpoints"),
  });
  out.push({
    id: "nav-queue",
    group: "Go to",
    label: "Queue",
    hint: `${jobsStore.activeJobs.length} active`,
    run: go("/queue"),
  });
  if (b) {
    out.push({
      id: "nav-overview",
      group: "Go to",
      label: `Overview · ${book!.title}`,
      run: go(`/book/${b}`),
    });
    out.push({
      id: "nav-review",
      group: "Go to",
      label: "Review",
      hint: (() => {
        const n = reviewCount(b);
        return n ? `${plural(n, "decision")} waiting` : "nothing waiting";
      })(),
      keywords: "inbox decisions retakes flagged unreviewed pending waiting",
      run: go(`/book/${b}/review`),
    });
    out.push({
      id: "nav-cast",
      group: "Go to",
      label: "Cast",
      hint: `${castStore.charactersOf(b).length} speakers`,
      run: go(`/book/${b}/cast`),
    });
    out.push({
      id: "nav-scripting",
      group: "Go to",
      label: "Scripting",
      hint: "stage 1",
      run: go(`/book/${b}/scripting`),
    });
    out.push({
      id: "nav-narration",
      group: "Go to",
      label: "Narration",
      hint: "stage 2",
      run: go(`/book/${b}/narration`),
    });
    out.push({
      id: "nav-listen",
      group: "Go to",
      label: "Listen",
      hint: "read along",
      run: go(`/book/${b}/listen`),
    });
    out.push({
      id: "nav-export",
      group: "Go to",
      label: "Export",
      hint: "stage 3",
      run: go(`/book/${b}/export`),
    });
    out.push({
      id: "nav-contents",
      group: "Go to",
      label: "Contents",
      hint: "what goes in the audiobook",
      keywords: "chapters skip notices review",
      run: go(`/book/${b}/contents`),
    });
  }
  // actions on the open book
  if (b) {
    // skipped chapters are skipped by every run, so a count that included them would overstate it
    const runnable = chs.filter((c) => !c.excluded);
    const pending = runnable
      .filter((c) => !isScripted(c) && !["running", "queued"].includes(c.scripting))
      .map((c) => c.id);
    const scripted = runnable
      .filter(
        (c) => isScripted(c) && !isNarrated(c) && !["running", "queued"].includes(c.narration),
      )
      .map((c) => c.id);
    const stale = runnable.filter((c) => c.narration === "stale");
    const failedN = runnable.filter((c) => c.narration === "failed");
    if (pending.length)
      out.push({
        id: "act-script",
        group: "Actions",
        label: `Script all pending chapters`,
        hint: `${pending.length} ch`,
        keywords: "extract run",
        run: () => {
          // held to the Run button's blockers, which it says in a toast when one stands in the way
          void scriptingStore.startRun(b, pending);
          void router.push(`/book/${b}/scripting`);
        },
      });
    if (scripted.length)
      out.push({
        id: "act-narrate",
        group: "Actions",
        label: `Narrate all scripted chapters`,
        hint: `${scripted.length} ch`,
        keywords: "tts render run",
        run: () => {
          void narrationStore.startRun(b, scripted);
          void router.push(`/book/${b}/narration`);
        },
      });
    if (stale.length)
      out.push({
        id: "act-stale",
        group: "Actions",
        label: `Re-narrate changed segments`,
        hint: `${stale.length} ch stale`,
        keywords: "edited",
        // One run over every stale chapter, not a loop: the expression guard holds one pending
        // review at a time, so a loop dropped every blocked chapter's dialog but the last.
        run: () => {
          void narrationStore.startRun(
            b,
            stale.map((c) => c.id),
            { scope: "fill" },
          );
          void router.push(`/book/${b}/narration`);
        },
      });
    if (failedN.length)
      out.push({
        id: "act-retry-ch",
        group: "Actions",
        label: `Retry failed narration`,
        hint: `${failedN.length} ch`,
        // one run, one expression review — see "Re-narrate changed segments" above
        run: () => {
          void narrationStore.startRun(
            b,
            failedN.map((c) => c.id),
            { scope: "failed" },
          );
          void router.push(`/book/${b}/narration`);
        },
      });
    if (
      castStore
        .charactersOf(b)
        .some((c) => !voiced(c, castStore.byName[b] ?? new Map()) && c.name !== "Narrator")
    )
      out.push({
        id: "act-auto",
        group: "Actions",
        label: `Auto-assign voices by ${castStore.matchBy}`,
        hint: "unvoiced cast",
        run: () => {
          castStore.autoAssign(b);
          void router.push(`/book/${b}/narration`);
        },
      });
    const merges = castStore.mergeSuggestions(b).length;
    if (merges)
      out.push({
        id: "act-merge",
        group: "Actions",
        label: "Review merge suggestions",
        hint: `${merges}`,
        keywords: "alias duplicate cast",
        run: go(`/book/${b}/cast`),
      });
  }
  // the store's own answer, so the count is the number of chapters that get re-run
  const retryable = jobsStore.retryableFailures();
  if (retryable.length)
    out.push({
      id: "act-retry-all",
      group: "Actions",
      label: "Retry all failed jobs",
      hint: `${retryable.length}`,
      keywords: "queue",
      run: () => jobsStore.retryAllFailed(),
    });
  if (jobsStore.activeJobs.length)
    out.push({
      id: "act-cancel-all",
      group: "Actions",
      label: "Cancel all running and queued jobs",
      hint: `${jobsStore.activeJobs.length}`,
      keywords: "stop queue",
      run: () => jobsStore.cancelAll(),
    });
  out.push({
    id: "act-endpoint",
    group: "Actions",
    label: "Add TTS endpoint",
    keywords: "server voice api",
    run: () => {
      endpointsStore.addEndpoint();
      void router.push("/endpoints");
    },
  });
  out.push({
    id: "act-script-endpoint",
    group: "Actions",
    label: "Add scripting endpoint",
    keywords: "server llm model api openai compatible",
    run: () => {
      endpointsStore.addScriptProfile();
      void router.push("/endpoints");
    },
  });
  out.push({
    id: "act-stt-endpoint",
    group: "Actions",
    label: "Add speech-to-text endpoint",
    keywords: "server transcription transcribe whisper stt api",
    run: () => {
      endpointsStore.addTranscriber();
      void router.push("/endpoints");
    },
  });
  out.push({
    id: "act-dark",
    group: "Actions",
    label: uiStore.dark ? "Switch to light theme" : "Switch to dark theme",
    keywords: "dark light mode theme",
    run: () => {
      uiStore.dark = !uiStore.dark;
    },
  });
  out.push({
    id: "act-keys",
    group: "Actions",
    label: "Keyboard shortcuts",
    hint: "?",
    keywords: "help keys hotkeys",
    run: () => window.dispatchEvent(new CustomEvent("open-shortcuts")),
  });
  if (b && uiStore._undo.length)
    out.push({
      id: "act-undo",
      group: "Actions",
      label: `Undo: ${uiStore._undo.at(-1)!.label}`,
      hint: `${mod} Z`,
      run: () => uiStore.undoLast(),
    });
  if (b)
    out.push({
      id: "act-pause",
      group: "Actions",
      label: book!.budget?.paused ? `Resume ${book!.title}` : `Pause new work on ${book!.title}`,
      keywords: "budget stop",
      run: () => (book!.budget?.paused ? libraryStore.resumeBook(b) : libraryStore.pauseBook(b)),
    });
  // books
  for (const bk of libraryStore.shelved)
    if (bk.id !== b)
      out.push({
        id: "book-" + bk.id,
        group: "Novels",
        label: bk.title,
        hint: `${bk.author} · ${libraryStore.chaptersOf(bk.id).length} ch`,
        keywords: bk.author,
        run: go(`/book/${bk.id}`),
      });
  // chapters, labelled and found by reading number; a skipped one has none and is found by title
  const numbers = b ? libraryStore.chapterNumbers[b] : undefined;
  for (const c of chs) {
    const n = numbers?.get(c.id);
    const label = `${numberCell(n)} · ${c.title}`;
    const named = n == null ? "skipped" : `chapter ${n}`;
    const stage = isNarrated(c) || c.narration !== "none" ? "narration" : "scripting";
    const state =
      c.narration !== "none"
        ? c.narration
        : c.scripting !== "none"
          ? `scripting ${c.scripting}`
          : "not scripted";
    out.push({
      id: "ch-" + c.id,
      group: "Chapters",
      label,
      hint: state,
      keywords: `${named} ${libraryStore.volumeOf(b!, c.id)?.name ?? ""}`,
      run: go({ path: `/book/${b}/${stage}`, query: { ch: c.id } }),
    });
    // a chapter with audio can also be read along with
    if (isNarrated(c))
      out.push({
        id: "listen-" + c.id,
        group: "Listen",
        label,
        hint: "read along",
        keywords: `listen ${named}`,
        run: go({ path: `/book/${b}/listen`, query: { ch: c.id } }),
      });
  }
  // speakers of the open book
  if (b)
    for (const c of castStore.charactersOf(b))
      out.push({
        id: "sp-" + c.name,
        group: "Speakers",
        label: c.name,
        hint: c.voice ? endpointsStore.voiceLabel(c.voice) : castStore.fallbackLabel(b, c.name),
        color: c.color,
        keywords: `speaker cast ${c.aliases.join(" ")}`,
        run: go(`/book/${b}/cast`),
      });
  // endpoints — pause/resume either kind from anywhere
  for (const e of endpointsStore.endpoints)
    out.push({
      id: "ep-" + e.id,
      group: "Endpoints",
      label: `${e.enabled ? "Pause" : "Resume"} ${e.name}`,
      hint: `TTS · ${e.voices.length} voices · ${e.enabled ? "on" : "paused"}`,
      keywords: "endpoint tts server",
      run: () => {
        e.enabled = !e.enabled;
      },
    });
  for (const p of endpointsStore.profiles)
    out.push({
      id: "profile-" + p.id,
      group: "Endpoints",
      label: `${p.enabled ? "Pause" : "Resume"} ${p.name}`,
      hint: `Scripting · ${p.model} · ${p.enabled ? "on" : "paused"}`,
      keywords: "endpoint scripting llm model server",
      run: () => {
        p.enabled = !p.enabled;
      },
    });
  return out;
}

/** Does a row match what has been typed? `contains` is the accent-insensitive one reka supplies. */
type Contains = (value: string, query: string) => boolean;

/**
 * The rows to show for a query, capped. Without a query only a few of each long group show;
 * with one, a script search row goes first.
 */
export function filterCommands(
  commands: Command[],
  query: string,
  contains: Contains,
  router: Router,
  bookId: string | null,
): Command[] {
  const s = query.trim();
  const search =
    s.length >= 2 && bookId
      ? [
          {
            id: "search",
            group: "Search",
            label: `Search the script for “${s}”`,
            hint: "text · speaker · direction",
            run: () => router.push({ path: `/book/${bookId}/search`, query: { q: s } }),
          } satisfies Command,
        ]
      : [];
  const list = s
    ? [
        ...search,
        ...commands.filter(
          (c) =>
            contains(c.label, s) ||
            contains(c.keywords ?? "", s) ||
            contains(c.group, s) ||
            (c.hint && contains(c.hint, s)),
        ),
      ]
    : commands;
  // without a query keep it short: nav + actions + a few of each big group
  const cap = s ? 40 : 8;
  const seen: Record<string, number> = {};
  return list.filter(
    (c) =>
      (seen[c.group] = (seen[c.group] ?? 0) + 1) <=
      (s ? cap : c.group === "Go to" || c.group === "Actions" ? 99 : cap),
  );
}

/** The rows in their groups, in the order the groups first appear. */
export function groupCommands(list: Command[]): [string, Command[]][] {
  const m = new Map<string, Command[]>();
  for (const c of list) {
    if (!m.has(c.group)) m.set(c.group, []);
    m.get(c.group)!.push(c);
  }
  return [...m.entries()];
}
