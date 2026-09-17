// What the Demo tools offer. One row per situation worth testing, named for the situation rather
// than for the data behind it, with a line saying what will be on screen.
//
// This file is the menu; `situations.ts` is what each row does to the world. They are kept apart so
// the wording can be read in one place, and so a row can be added without reading the mutations.
import { exportScenarios } from "@/mock/scenarios/export";
import { IMPORT_SAMPLES } from "@/mock/fixtures/imports";
import type { DemoGroup, DemoScenario } from "@/types";

/** The order the panel lists them in, and what each heading is called. */
export const DEMO_GROUPS: { id: DemoGroup; label: string }[] = [
  { id: "import", label: "Importing an EPUB" },
  { id: "shelf", label: "The shelf" },
  { id: "start", label: "Starting a book" },
  { id: "trouble", label: "Runs that go wrong" },
  { id: "blocked", label: "Blocked before a run" },
  { id: "review", label: "Review and retakes" },
  { id: "bulk", label: "Re-doing finished chapters" },
  { id: "pricing", label: "Rates, cache and promotions" },
  { id: "export", label: "Export" },
];

/**
 * What to try once a row is applied, in the order it is worth doing. The drawer lists these
 * beside the page, so the walkthrough is in the app rather than only in the README.
 */
const STEPS: Record<string, string[]> = {
  import: [
    "Read the note beside each title: a verdict, a kind and one line of reason.",
    "Use a group's Skip N, or Skip all suggested, then ⌘Z it back.",
    "Open Needs review and read a chapter in full — the note is marked in amber — then Keep chapter.",
    "Add to library lands on the overview; the picker's skipped count links back here.",
  ],
  "import-clean": [
    "Nothing was flagged, so there is nothing to review: the header says so.",
    "Open a chapter anyway — reading never changes a tick.",
    "Add to library is one click away.",
  ],
  "import-notices": [
    "Every chapter reads as a notice, so Skip all suggested empties the book.",
    "The Add button is dead with nothing included; the footer says why.",
    "Restore one chapter and the button comes back with its count.",
  ],
  "full-shelf": [
    "Type in the search — title or author, accents ignored, / puts the cursor there.",
    "Narrow with Needs attention, Running, Behind or Up to date; the counts follow the search.",
    "Order by most to do or least narrated, then switch to the table and click a column header.",
    "Copy the URL: search, filter, order and shape are all in it.",
  ],
  "fresh-book": [
    "Tick the first chapters, or press Script the first 3 chapters, and run.",
    "Watch the cast appear; a new alias shows a dashed 'new' — the chip opens Cast for merging.",
    "Open a scripted chapter and click a line to edit its speaker, direction or boundaries.",
  ],
  "resume-book": [
    "Three chapters are scripting as you arrive — the sidebar and the Jobs chip count them.",
    "Ch 7 kept an unverified chunk: open it in Scripting and re-split it, or split it by hand.",
    "The overview's next-step card picks the one thing worth doing; follow it.",
  ],
  "scripting-failed": [
    "Two rows in History failed with nothing kept; open one for its activity log.",
    "The endpoint card shows the 429 cooldown counting down.",
    "Retry from a row, or retry failed for both; the estimate blocks until the cooldown ends.",
  ],
  "narration-failed": [
    "Ch 4 has failed clips beside finished ones: filter the ledger to failed.",
    "Click a failed row: the HTTP status and body, and copy request.",
    "Retry failed re-renders only those; the endpoint is backing off, so watch it wait.",
  ],
  "no-voices": [
    "Cast shows who has no voice, a voice that no longer exists, and one on a paused endpoint.",
    "The narration estimate lists each as a blocker instead of starting a run.",
    "Resume the paused endpoint or repick; Assign N unvoiced… shows its plan before it applies.",
  ],
  "budget-spent": [
    "This run reports the cap as a blocker instead of a cost.",
    "Raise the cap on the overview, or clear it, and the blocker goes.",
    "The scripting budget on the Scripting page blocks the same way.",
  ],
  "stale-audio": [
    "Ch 1 has flagged clips and a retake waiting: press 1 and 2 to play both, A or X to keep one.",
    "Stale rows say what moved under the clip; Re-narrate changed renders only those.",
    "Flag another line yourself (f), then Retake flagged.",
  ],
  expressions: [
    "The reader opens on the line: the chips are the controls — click one to replace, move, omit or remove.",
    "One expression needs its position chosen again after an edit.",
    "Add expression turns the line into word gaps; click a gap to place a tag.",
  ],
  "script-history": [
    "Press History in the reader header: four entries, newest first, with what made each one.",
    "Preview “Before trying DeepSeek” — read-only, the current script is untouched — then Compare with current.",
    "Read the summary before the detail, filter it to Speakers or Structure, and jump to a line.",
    "Restore it: the plan counts the clips that come back, the one recovered from the split paragraph, and the chapter goes from stale to done. ⌘Z puts the re-script back.",
  ],
  "bulk-rework": [
    "The picker's Select row has Completed, Stale and Failed on it; press one and read the line under it.",
    "Tick Completed and watch the run button become “Re-script 6 chapters” with what it replaces spelled out under it.",
    "Preserve manual corrections is on: ch 1 has hand-corrected lines, and the reader lists any the new run could not carry.",
    "On Narration, switch the scope between Missing & changed, Failed only and Everything — the clip, request and cost numbers follow the scope.",
    "A retake is waiting on one line; the run leaves it alone until you turn that switch off.",
  ],
  "bulk-recovery": [
    "Two chapters were re-scripted and the attempt kept nothing: both still read as scripted, and the reader still opens their script.",
    "Open the Queue: one run is 4 chapters, two done and two failed — Retry N failed runs only those.",
    "The third chapter's cancelled run left the chapters before it replaced and the ones after it untouched.",
    "On Narration ch 1, the failed replacements are marked on the lines whose clips still play; Retry failed renders only those.",
  ],
  "cache-mix": [
    "Open Activity: rows show input with the cached slice inside it, so 12k in (8k cached) can’t be read as 20k.",
    "Open a row with a cached slice — the receipt charges 8,000 at the cached rate and the rest at the ordinary one, and names each rate.",
    "Open a row marked “cache ?”: its provider said nothing, so the whole input is charged at the ordinary rate and the total is labelled an estimate, not a reported miss.",
    "The last two rows came back with contradictory counts; the receipt says so rather than quietly charging them.",
  ],
  "off-peak": [
    "Pricing shows the off-peak window in force and the base rate struck through beside it.",
    "The line under it says when it ends, in the endpoint’s own timezone.",
    "Open the schedule: the window runs past midnight, and the day buttons say which day it starts on.",
    "Start a run from Scripting and watch the requests either side of the boundary get charged differently.",
  ],
  "promo-live": [
    "Pricing leads with “50% off gpt-4o-mini” applied and the date it ends.",
    "Open Promotions: one running, one scheduled for later and one that ended last week, kept as history.",
    "Add a second promotion covering the same rate — the panel marks one outranked, because discounts do not stack.",
    "Activity rows recorded before it started are still at the full rate. Letting a promotion expire never re-prices them.",
  ],
  "promo-expired": [
    "Every promotion on this endpoint has ended; Pricing says the base rates apply and lists them under Ended.",
    "Spend from while they ran is unchanged — open Activity and read the rate on an older row.",
    "Change the input rate now and read that row again: still the price it was charged at.",
  ],
  "rate-boundary": [
    "A run is in flight across the moment the off-peak window closes.",
    "Open the Queue and read the activity log: the rate changes part-way down, request by request.",
    "Run details compare the estimate with what was actually charged, and say how much of it the cache explains.",
  ],
  "speech-discount": [
    "Speech endpoints take the same schedule and the same promotions — open OpenAI (main) → Pricing.",
    "The rate is written in the unit this endpoint bills in, and the off-peak window and the promotion are shown against it.",
    "Open the Azure proxy: its rate is unknown, so the night window it has changes nothing and the page says so instead of inventing a number.",
    "Narrate a chapter from the book and read the estimate: the by-endpoint rows name what moved each rate, and the cap is checked without the discounts.",
  ],
  "billing-models": [
    "This run panel adds up four different billing models at once — read “Input text”, “Output audio” and the by-endpoint rows under it.",
    "The UTF-8 bytes row appears because the dictionary rewrites “outer sect” into Hanzi on the way out: Fish Audio bills those bytes, not the characters the book shows.",
    "Narrate the chapter, then open Queue → the chapter’s run details: the estimate is reconciled against what was charged, with the input and audio halves separately.",
    "Open Endpoints → Gemini 3.1 Flash TTS → Pricing: the worked example shows input cost + audio cost = total, and the audio-tokens-per-second assumption is editable.",
    "Change that endpoint’s billing model and switch back: the rates are parked rather than reinterpreted, and every request already recorded keeps the model and the price it was charged at.",
  ],
  "mis-attributed": [
    "Search is open on the alias: tick a chapter, or Select all matching results.",
    "Change speaker… to the main character: the panel says how many change, how many already match and how many clips go stale.",
    "Apply, read the strip, Undo this batch.",
  ],
  ready: [
    "Every chapter is ticked and ready: read What you will get, then See the chapter order.",
    "Switch Files between one file, per volume and per chapter; the names and the count follow.",
    "Build, then Audiobooks lists the result.",
  ],
  mixed: [
    "The plan turns problems into things to do: Narrate them, Leave them out, Use the audio as it is.",
    "Using stale audio is a choice — accept it and the plan says so in amber, with an undo.",
    "Leave them out unticks the chapters, so the list and the build stay the same set.",
  ],
  long: [
    "Filter to Needs attention; the footer warns when the filter hides ticked chapters.",
    "Switch Files to per volume and per chapter and watch the file names follow.",
    "Open Loudness: five voices, the spread between them, and what matching would do.",
  ],
  update: [
    "v2 is nine chapters behind: the card says what changed and how many carry over.",
    "Press Update to v3 and watch the Queue say which file it is encoding.",
    "Nudge a pause under Pauses: the finished export says it is behind the book.",
  ],
  builds: [
    "One build is running, one failed and one finished.",
    "Cancel the running one: the version on disk is untouched.",
    "Retry the failed one from Export, the toast or the Queue.",
  ],
};

const withSteps = (rows: DemoScenario[]): DemoScenario[] =>
  rows.map((s) => ({ ...s, steps: STEPS[s.id] ?? (s.group === "import" ? STEPS.import : []) }));

/** Fresh rows every call — the panel renders these, it never holds on to them. */
export function demoScenarios(): DemoScenario[] {
  return withSteps([
    // the import rows open the contents review on a book the scenario itself creates; the id is
    // fixed so the row knows where it opens before the book exists
    ...IMPORT_SAMPLES.map((s): DemoScenario => ({
      id: `import-${s.id}`,
      group: "import",
      name: s.label,
      blurb: s.hint,
      bookId: `import-${s.id}`,
      path: `/book/import-${s.id}/contents`,
    })),
    {
      id: "full-shelf",
      group: "shelf",
      name: "A full shelf",
      blurb:
        "Eighteen more books, in every state the shelf tells apart — nothing run, part way, failed, stale, built, behind — with three chapters scripting as you arrive. For the search, the filters and the sort.",
      bookId: "cliche",
      path: "/library",
      runs: [{ kind: "scripting", chapterIds: [13, 14, 15] }],
    },
    {
      id: "fresh-book",
      group: "start",
      name: "A new book, nothing scripted",
      blurb:
        "Letters from the Drowned City as it looks just after import: chapters to pick over, no script, no cast but the Narrator.",
      bookId: "drowned",
      path: "/book/drowned/scripting",
    },
    {
      id: "resume-book",
      group: "start",
      name: "A book part-way through",
      blurb:
        "The Cliché Cultivation World: 12 chapters scripted, 3 narrated, one failed and one unverified — and three chapters scripting as you arrive.",
      bookId: "cliche",
      path: "/book/cliche",
      runs: [{ kind: "scripting", chapterIds: [13, 14, 15] }],
    },
    {
      id: "scripting-failed",
      group: "trouble",
      name: "Scripting that failed and was rate-limited",
      blurb:
        "Two chapters kept nothing, the scripting endpoint is in a 429 cooldown, and the queue has the rows to retry.",
      bookId: "drowned",
      path: "/queue",
    },
    {
      id: "narration-failed",
      group: "trouble",
      name: "Narration that failed and was rate-limited",
      blurb:
        "One chapter with failed clips, another only part rendered, and the speech endpoint backing off after a 429.",
      bookId: "cliche",
      path: "/book/cliche/narration?ch=4",
    },
    {
      id: "no-voices",
      group: "blocked",
      name: "Speakers with no voice",
      blurb:
        "The Narrator and two speakers unassigned, one pointing at a voice that no longer exists and one at a paused endpoint.",
      bookId: "cliche",
      path: "/book/cliche/cast",
    },
    {
      id: "budget-spent",
      group: "blocked",
      name: "The budget is spent",
      blurb:
        "The book's cap and its scripting budget are used up, so every estimate reports a blocker instead of starting.",
      bookId: "cliche",
      path: "/book/cliche/narration",
    },
    {
      id: "stale-audio",
      group: "review",
      name: "Edited script, stale audio, retakes to compare",
      blurb:
        "Lines edited after narration, clips that no longer match them, flagged audio and second takes waiting beside the first.",
      bookId: "starforge",
      path: "/book/starforge/narration?ch=1",
    },
    {
      id: "expressions",
      group: "review",
      name: "Expressions placed in a line",
      blurb:
        "Ashes of the Starforge, chapter 1: a sigh and a softer delivery placed on the Captain’s line, and a laugh on the next line whose position needs a look after an edit. The reader opens on the line.",
      bookId: "starforge",
      path: "/book/starforge/scripting?ch=1",
    },
    {
      id: "script-history",
      group: "review",
      name: "A chapter with a script history",
      blurb:
        "Chapter 1 of The Cliché Cultivation World through four versions: OpenAI’s first pass, the corrections a person made to it, the checkpoint saved before trying another model, and the DeepSeek re-script that is the current script — with clips that no longer match it. Opens the reader with History open.",
      bookId: "cliche",
      path: "/book/cliche/scripting",
    },
    {
      id: "mis-attributed",
      group: "review",
      name: "One speaker mis-attributed all through",
      blurb:
        "An alias the model invented, scattered through the book, with the Search page open on the matches to fix in bulk.",
      bookId: "cliche",
      path: "/book/cliche/search",
    },
    {
      id: "bulk-rework",
      group: "bulk",
      name: "A book with everything a bulk run has to tell apart",
      blurb:
        "Chapters that are new, finished, hand-corrected, stale and failed, side by side, with a retake waiting on one line — for the selection shortcuts, the run summary and the narration scopes.",
      bookId: "cliche",
      path: "/book/cliche/scripting",
    },
    {
      id: "bulk-recovery",
      group: "bulk",
      name: "Replacements that failed, and a run that was cancelled",
      blurb:
        "A four-chapter re-script where two chapters kept nothing and a cancelled one stopped the rest, plus narration replacements that failed — every earlier script and every clip is still there and still usable.",
      bookId: "cliche",
      path: "/queue",
    },
    {
      id: "cache-mix",
      group: "pricing",
      name: "Cache reported, partly reported, and not reported at all",
      blurb:
        "One endpoint's activity with every case side by side: requests with no cache use, requests part cached, requests whose provider never mentioned the cache, and two whose counts contradict each other. Opens the Activity tab.",
      bookId: "cliche",
      path: "/endpoints?endpoint=scripting:openai&tab=activity",
    },
    {
      id: "off-peak",
      group: "pricing",
      name: "Off-peak rates in force",
      blurb:
        "The clock is inside the endpoint's off-peak window — a window that runs past midnight — so every rate is discounted, the page says why and when it ends, and the base rates are struck through beside them.",
      bookId: "cliche",
      path: "/endpoints?endpoint=scripting:openai&tab=pricing",
    },
    {
      id: "promo-live",
      group: "pricing",
      name: "A promotion running, one scheduled, one ended",
      blurb:
        "“50% off gpt-4o-mini” applying now and ending on Friday, half-price output starting in two days, and free cache reads that ended last week and is kept as history rather than erased.",
      bookId: "cliche",
      path: "/endpoints?endpoint=scripting:openai&tab=pricing",
    },
    {
      id: "promo-expired",
      group: "pricing",
      name: "A promotion that has expired",
      blurb:
        "The same endpoint a day after its promotions ended: the base rates are back, and every request charged while they ran keeps the price it was charged at. For checking that editing a rate does not move past spending.",
      bookId: "cliche",
      path: "/endpoints?endpoint=scripting:openai&tab=pricing",
    },
    {
      id: "speech-discount",
      group: "pricing",
      name: "Speech rates on discount",
      blurb:
        "A speech endpoint inside its nightly off-peak window with a promotion on top, and beside it one whose rate is unknown — where the schedule it has changes nothing, because there is nothing to discount. Opens the speech endpoint's Pricing tab.",
      bookId: "cliche",
      path: "/endpoints?endpoint=tts:openai&tab=pricing",
    },
    {
      id: "billing-models",
      group: "pricing",
      name: "Every billing model in one chapter",
      blurb:
        "One chapter routed at five different billing models at once — per character, per UTF-8 byte over text the dictionary rewrites into Hanzi, input text tokens plus output audio tokens, a free local model, and one whose rate nobody typed in. Narrate it and compare the estimate against the receipts.",
      bookId: "cliche",
      path: "/book/cliche/narration",
    },
    {
      id: "rate-boundary",
      group: "pricing",
      name: "A run crossing a pricing boundary",
      blurb:
        "A four-chapter re-script in flight as the off-peak window closes, so its requests are charged at two different prices. The Queue's run details reconcile the estimate against what was actually charged.",
      bookId: "cliche",
      path: "/queue",
      runs: [{ kind: "scripting", chapterIds: [13, 14, 15, 16] }],
    },
    // the Export rows keep their own wording, so the page's own Demo chip and this panel agree
    ...exportScenarios().map((s): DemoScenario => ({
      id: s.id,
      group: "export",
      name: s.label,
      blurb: s.hint,
      bookId: s.bookId,
      path: `/book/${s.bookId}/export`,
    })),
  ]);
}

export const demoScenario = (id: string): DemoScenario | undefined =>
  demoScenarios().find((s) => s.id === id);
