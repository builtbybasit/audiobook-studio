// What a dropped EPUB turns out to contain. Nothing parses a file in this prototype, so an import
// is one of these samples: a title, an author, its volumes, and for each chapter the title and —
// where the chapter is not story — the note the review shows for it.
//
// Every situation the review has to survive is here: a clean book, a long serial with updates
// scattered through it, notices between volumes, one announcement repeated a dozen times, titles
// that only look like notices, chapters that mix a note with story, and a file of nothing but
// notices with titles too long for a row.
import type { NoticeKind } from "@/types";
import { noticeTitle } from "@/mock/fixtures/notices";

/** One chapter as the sample describes it. A `kind` makes it a notice (or a chapter to review). */
export interface ChapterSpec {
  title: string;
  kind?: NoticeKind;
  /** for `mixed`: where the note sits */
  at?: "start" | "end";
  /** picks the notice's title and body variant, so repeats read as related, not identical */
  variant?: number;
  /** override the word count the sample would otherwise pick */
  words?: number;
}

export interface VolumeSpec {
  name: string;
  file: string;
  chapters: ChapterSpec[];
}

export interface ImportSample {
  id: string;
  /** what the Demo tools and the Library's sample row call it */
  label: string;
  /** one line on what the review will show */
  hint: string;
  title: string;
  author: string;
  cover: [string, string];
  /** which seeded book's prose the story chapters read with */
  prose: string;
  volumes: VolumeSpec[];
}

const STORY_TITLES = [
  "The Ledger Opens",
  "A Debt in Three Currencies",
  "What the Auditor Saw",
  "Interest, Compounded",
  "The Villain Pays in Full",
  "A Receipt for the Duke",
  "Salt Tax",
  "The Counting House at Night",
  "Two Sets of Books",
  "The Quiet Partner",
  "A Line Struck Through",
  "The Price of a Name",
  "Arrears",
  "The Vault Beneath the Chapel",
  "An Honest Forgery",
  "Balance Brought Forward",
  "The Widow’s Percentage",
  "Coin and Consequence",
  "The Clerk Who Would Not Sign",
  "Year End",
];

const story = (i: number, pool = STORY_TITLES): ChapterSpec => ({
  title: `${pool[i % pool.length]}${i >= pool.length ? ` (${["II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"][Math.floor(i / pool.length) - 1] ?? Math.floor(i / pool.length) + 1})` : ""}`,
});

const notice = (kind: NoticeKind, variant = 0, title?: string): ChapterSpec => ({
  title: title ?? noticeTitle(kind, variant),
  kind,
  variant,
});

/** `count` story chapters with `notes` dropped in at the given positions (1-based, in the volume). */
function serial(
  count: number,
  notes: Record<number, ChapterSpec>,
  pool = STORY_TITLES,
): ChapterSpec[] {
  const out: ChapterSpec[] = [];
  let storyIndex = 0;
  for (let i = 1; i <= count; i++) out.push(notes[i] ?? story(storyIndex++, pool));
  return out;
}

const LANTERN_TITLES = [
  "Prologue · The Last Lamp on the Pier",
  "High Tide",
  "The Keeper’s Ledger",
  "Salt in the Hinges",
  "A Letter Left at the Door",
  "Interlude · What the Gulls Saw",
  "Under the Breakwater",
  "The Harbourmaster’s Daughter",
  "Glass and Silt",
  "The Long Night of the Storm",
  "Side Story · The Rope-Maker’s Wife",
  "Ink That Will Not Dry",
  "Low Water",
  "The Lamp Relit",
  "A Bargain with the Tide",
  "The Drowned Bell",
  "Bonus · A Recipe for Storm Bread",
  "Epilogue · First Light",
];

export const IMPORT_SAMPLES: ImportSample[] = [
  {
    id: "clean",
    label: "A clean novel",
    hint: "18 chapters and no notices — a prologue, an interlude and a bonus chapter, all story. Nothing to review.",
    title: "The Lantern Keeper’s Daughter",
    author: "Ines Varga",
    cover: ["#164e63", "#67e8f9"],
    prose: "drowned",
    volumes: [
      {
        name: "The Lantern Keeper’s Daughter",
        file: "The Lantern Keeper's Daughter.epub",
        chapters: LANTERN_TITLES.map((title) => ({ title })),
      },
    ],
  },
  {
    id: "serial",
    label: "A long serial with scattered updates",
    hint: "212 chapters. Hiatus, health and schedule notices scattered through, a duplicate, two chapters that mix a note with story, and titles that only look like notices.",
    title: "Reborn as the Villain’s Accountant",
    author: "Ledger of Ash",
    cover: ["#3f1d0b", "#f59e0b"],
    prose: "cliche",
    volumes: [
      {
        name: "Reborn as the Villain’s Accountant",
        file: "Reborn as the Villain's Accountant (ch 1-212).epub",
        chapters: serial(212, {
          9: { title: "Interlude · The Duke’s Ledger" },
          23: notice("schedule", 0),
          41: notice("health", 0),
          58: { title: "A Word From the Author", kind: "mixed", at: "start", variant: 0 },
          77: { title: "Notice of Termination", kind: "title" },
          84: notice("hiatus", 0),
          85: notice("duplicate", 0, "Going on hiatus"),
          96: notice("return", 0),
          112: notice("promo", 0),
          131: { title: "Side Story · The Clerk’s Holiday" },
          140: notice("progress", 0),
          149: { title: "Sorry For the Delay", kind: "title" },
          163: notice("schedule", 1),
          170: { title: "The Widow’s Percentage, Revisited", kind: "mixed", at: "end", variant: 2 },
          188: notice("donation", 0),
          201: notice("hiatus", 2),
        }),
      },
    ],
  },
  {
    id: "volumes",
    label: "Several volumes with notices between",
    hint: "Three volumes. Each opens with release notes and closes with an afterword, and one chapter in the middle carries a note at the end.",
    title: "Ninefold Ascension",
    author: "Cloudwalker of the Eastern Sea",
    cover: ["#1e3a8a", "#93c5fd"],
    prose: "gates",
    volumes: [
      {
        name: "Vol. 1 · The Iron Stair",
        file: "Ninefold Ascension - Vol 1.epub",
        chapters: serial(30, {
          1: notice("progress", 1, "Volume 1 release notes"),
          30: notice("afterword", 0),
        }),
      },
      {
        name: "Vol. 2 · The Salt Road",
        file: "Ninefold Ascension - Vol 2.epub",
        chapters: serial(32, {
          1: notice("progress", 0, "Volume 2 release notes"),
          17: { title: "Nine Steps, Counted Twice", kind: "mixed", at: "end", variant: 3 },
          32: notice("afterword", 1),
        }),
      },
      {
        name: "Vol. 3 · The Gate of Mirrors",
        file: "Ninefold Ascension - Vol 3.epub",
        chapters: serial(28, {
          1: notice("schedule", 1, "Volume 3 schedule"),
          28: notice("afterword", 0),
        }),
      },
    ],
  },
  {
    id: "repeated",
    label: "The same announcement, again and again",
    hint: "120 chapters with sponsor thanks every ten and a vote reminder every twenty — two groups, one decision each.",
    title: "The Iron Ledger Chronicles",
    author: "M. R. Halloway",
    cover: ["#3b0764", "#c084fc"],
    prose: "starforge",
    volumes: [
      {
        name: "The Iron Ledger Chronicles",
        file: "Iron Ledger Chronicles.epub",
        chapters: serial(
          120,
          Object.fromEntries([
            ...[10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120].map((i, n) => [
              i,
              notice("sponsor", n % 2),
            ]),
            ...[15, 35, 55, 75, 95, 115].map((i) => [i, notice("vote", 0)]),
          ]),
        ),
      },
    ],
  },
  {
    id: "misleading",
    label: "Titles that look like notices but are story",
    hint: "An epistolary novel whose chapters are titled like author notes — every one flagged for a look, and one real notice among them.",
    title: "Letters Never Posted",
    author: "Ines Varga",
    cover: ["#365314", "#bef264"],
    prose: "drowned",
    volumes: [
      {
        name: "Letters Never Posted",
        file: "Letters Never Posted.epub",
        chapters: serial(
          40,
          {
            3: { title: "An Announcement", kind: "title" },
            8: { title: "Author’s Note", kind: "title" },
            14: { title: "On Hiatus", kind: "title" },
            19: { title: "Sorry for the Delay", kind: "title" },
            24: notice("schedule", 0),
            27: { title: "Please Read Before Continuing", kind: "title" },
            33: { title: "A Personal Update", kind: "title" },
            38: { title: "Prologue, Rewritten" },
          },
          [
            "First Letter · High Water",
            "The Lamplighter Writes Back",
            "A Reply Unsent",
            "Under the Salt Bridge",
            "What the Tide Keeps",
            "Wren Goes Down",
            "The Warden’s Terms",
            "Glass and Silt",
            "Last Light on Cannery Row",
            "The Drowned Bell",
            "Ink That Will Not Dry",
            "Second Letter · Low Water",
          ],
        ),
      },
    ],
  },
  {
    id: "mixed",
    label: "Chapters that mix a note with story",
    hint: "60 chapters. Five open or close with an author note but are story underneath; two are notices through and through.",
    title: "Crownless",
    author: "Unknown Daoist",
    cover: ["#7f1d1d", "#fca5a5"],
    prose: "cliche",
    volumes: [
      {
        name: "Crownless",
        file: "Crownless.epub",
        chapters: serial(60, {
          6: { title: "The Elder’s Test", kind: "mixed", at: "start", variant: 0 },
          17: { title: "Seven Paths Down the Mountain", kind: "mixed", at: "end", variant: 2 },
          22: notice("hiatus", 1),
          29: { title: "Lan’er Returns", kind: "mixed", at: "start", variant: 1 },
          44: { title: "Blood on the Jade Steps", kind: "mixed", at: "end", variant: 3 },
          47: notice("promo", 1),
          53: { title: "The Pill Furnace", kind: "mixed", at: "start", variant: 0 },
        }),
      },
    ],
  },
  {
    id: "notices",
    label: "An EPUB that is nothing but notices",
    hint: "Fourteen announcements exported by mistake, with titles too long for a row. Skip them all and see what the import says.",
    title: "Announcements (feed export)",
    author: "Ledger of Ash",
    cover: ["#3f3f46", "#a1a1aa"],
    prose: "cliche",
    volumes: [
      {
        name: "Announcements (feed export)",
        file: "announcements-feed-export-2026-09.epub",
        chapters: [
          notice(
            "schedule",
            0,
            "Regarding the upcoming schedule changes for the month of September and the reasons behind them (please read before commenting)",
          ),
          notice(
            "health",
            0,
            "A personal update that I did not want to write but which I think you deserve to hear from me rather than from the comments",
          ),
          notice(
            "hiatus",
            0,
            "Hiatus notice — the story is NOT dropped, I repeat, the story is not dropped, please read the whole post before asking",
          ),
          notice(
            "duplicate",
            0,
            "Hiatus notice — the story is NOT dropped, I repeat, the story is not dropped, please read the whole post before asking (reposted)",
          ),
          notice(
            "return",
            0,
            "I’m back, and here is everything that happened while I was away and what it means for the release schedule going forward",
          ),
          notice(
            "schedule",
            1,
            "Posting schedule (updated again, sorry) — two chapters a week from now on, Tuesdays and Saturdays, longer than before",
          ),
          notice(
            "promo",
            0,
            "Check out my other work, which is now complete and available as an ebook wherever books are sold (links inside)",
          ),
          notice(
            "donation",
            0,
            "A word about donations, why the story will always be free, and what supporters get if they choose to chip in",
          ),
          notice(
            "sponsor",
            0,
            "Sponsored chapter — thank you to this week’s supporters, the list is on the support page, the bonus goal is nearly met",
          ),
          notice(
            "vote",
            0,
            "Please vote! Votes reset this week and the listing decides who sees the story next — it takes ten seconds",
          ),
          notice(
            "progress",
            0,
            "Progress update on the second volume, the paperback of the first, and the official translation that was just announced",
          ),
          notice(
            "sponsor",
            1,
            "Sponsored chapter! — huge thanks to everyone who chipped in, the bonus goal has been met, extra release on Sunday",
          ),
          notice(
            "promo",
            1,
            "New book out now — first volume on every major store, reviews help more than you would think (link below)",
          ),
          notice(
            "afterword",
            1,
            "Volume complete — an afterword on how this arc changed shape twice and where the next one starts on the first of the month",
          ),
        ],
      },
    ],
  },
];

export const importSample = (id: string): ImportSample | undefined =>
  IMPORT_SAMPLES.find((s) => s.id === id);

/** The sample a dropped file lands on when nothing chose one: keyed off its name, so the same file
 *  gives the same contents twice, and different files differ. */
export function sampleForFile(file: string): string {
  const name = file.toLowerCase();
  if (/vol|part|book \d/.test(name)) return "volumes";
  if (/announce|notice|feed/.test(name)) return "notices";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const ids = IMPORT_SAMPLES.map((s) => s.id);
  return ids[h % ids.length];
}
