// What the ⌘K palette can do, worked out from the stores and nothing else.
//
// The palette used to be one component: seven stores and every derivation it needed to decide which
// rows exist, wrapped around a reka Dialog. The two halves have nothing to say to each other — this
// half knows the domain and no DOM, `CommandPalette.vue` knows the widget and no domain — and only
// the first one is worth reading on its own, or checking without mounting a dialog and seven stores.
//
// Read-only over the stores, like `reviewInbox`: nothing here decides anything, and a row's `run` is
// a call into the store that owns the work. The rules the rows are offered by are the owners' —
// a chapter skipped from the audiobook is skipped by every run, and "retry all failed" is whatever
// the queue says it would actually re-run — because a palette with its own copy of either offers a
// count the button then does not honour.
import { useCastStore } from "@/stores/cast";
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

/**
 * Every row the palette can show right now, in the order they are offered.
 *
 * `mod` is the modifier key legend this machine uses; it appears in a hint and is the one thing
 * here that depends on the browser the palette is open in.
 */
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
        return n ? `${n} decision${n === 1 ? "" : "s"} waiting` : "nothing waiting";
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
    // a chapter skipped from the audiobook is skipped by every run that reaches the store, so it is
    // not offered here either: counting it made "Script all pending chapters — 4 ch" script two
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
          scriptingStore.runScripting(b, pending);
          router.push(`/book/${b}/scripting`);
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
          narrationStore.runNarration(b, scripted);
          router.push(`/book/${b}/narration`);
        },
      });
    if (stale.length)
      out.push({
        id: "act-stale",
        group: "Actions",
        label: `Re-narrate changed segments`,
        hint: `${stale.length} ch stale`,
        keywords: "edited",
        // One run over every stale chapter, never a loop of single-chapter calls: the expression
        // guard holds one pending review at a time, so chapter 2 overwrote chapter 1's and only the
        // last blocked chapter ever got a dialog — the rest returned having queued nothing.
        run: () => {
          narrationStore.runNarration(
            b,
            stale.map((c) => c.id),
            { scope: "fill" },
          );
          router.push(`/book/${b}/narration`);
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
          narrationStore.runNarration(
            b,
            failedN.map((c) => c.id),
            { scope: "failed" },
          );
          router.push(`/book/${b}/narration`);
        },
      });
    if (castStore.charactersOf(b).some((c) => !c.voice && c.name !== "Narrator"))
      out.push({
        id: "act-auto",
        group: "Actions",
        label: "Auto-assign voices by gender",
        hint: "unvoiced cast",
        run: () => {
          castStore.autoAssignByGender(b);
          router.push(`/book/${b}/narration`);
        },
      });
    if (castStore.mergeSuggestions(b).length)
      out.push({
        id: "act-merge",
        group: "Actions",
        label: "Review merge suggestions",
        hint: `${castStore.mergeSuggestions(b).length}`,
        keywords: "alias duplicate cast",
        run: go(`/book/${b}/cast`),
      });
  }
  // what "retry all failed" would actually re-run — the store's own answer, so the row is offered
  // exactly when there is work and the number on it is the number of chapters that get re-run
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
      router.push("/endpoints");
    },
  });
  out.push({
    id: "act-script-endpoint",
    group: "Actions",
    label: "Add scripting endpoint",
    keywords: "server llm model api openai compatible",
    run: () => {
      endpointsStore.addScriptProfile();
      router.push("/endpoints");
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
  // chapters of the open book → the stage they're at
  for (const c of chs) {
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
      label: `${String(c.id).padStart(2, "0")} · ${c.title}`,
      hint: state,
      keywords: `chapter ${c.id} ${libraryStore.volumeOf(b!, c.id)?.name ?? ""}`,
      run: go({ path: `/book/${b}/${stage}`, query: { ch: c.id } }),
    });
  }
  // speakers of the open book
  if (b)
    for (const c of castStore.charactersOf(b))
      out.push({
        id: "sp-" + c.name,
        group: "Speakers",
        label: c.name,
        hint: c.voice ? endpointsStore.voiceLabel(c.voice) : "Narrator’s voice",
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
 * The rows to show for a query, capped.
 *
 * Without a query the list stays short — everything you can go to and everything you can do, plus a
 * few of each long group — because a palette that opens on 200 rows is a list, not a shortcut.
 * With one, the whole script is searchable too, and that row goes first.
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
