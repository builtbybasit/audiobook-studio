// The scripting prompt: what a chat model is told, how the three places that may change it are
// layered, and how its tags are filled in for one request.
//
// Shared by the browser and the server. The page previews exactly what the job will send, so the
// rendering lives here and nowhere else — a preview built by a second copy of these rules would
// drift from the requests that are actually billed.
//
// **Three layers.** The library has a default, which is the built-in prompt until somebody edits
// it on the Endpoints page. A scripting endpoint may replace it outright. A book may replace the
// whole prompt for itself, and wins over an endpoint, because a book's conventions are about the
// text and hold whichever model reads it.
//
// **Notes** are the other way in, and hold whichever prompt is sent: an endpoint's (a model's
// quirk: "keep paragraphs apart") and a book's ("dialogue is marked with em-dashes"), each kept
// whatever its prompt mode and placed where the prompt says `{{endpoint.notes}}` or
// `{{book.notes}}`. A prompt without the tag does not send the notes; the page says so where they
// are typed, rather than the notes turning up somewhere nobody put them.
//
// **One part is not editable**: the output format. The answer is parsed as `{"lines":[…]}` and held
// word for word against the prose (`fidelity` in `server/providers/chatScripting.ts`), so a prompt
// that forgot to ask for either would fail every chunk. It is added after the system prompt, always,
// and the page shows it read-only under the editor.
//
// **Expression tags** are the model's to add only when a prompt asks for them, and the output
// format says how: plain words in a marker the excerpt does not already have (`[[sigh]]`), read out
// of the line when the answer comes back (`readScriptedTags`), so the line's text stays the prose
// and the word-for-word check never sees them. Which brackets a voice wants is decided when the
// line is sent, by the voice it is sent to.
//
// **Tags** are `{{name}}`, filled in one pass: nothing a tag puts in is read for tags again, so a
// novel that happens to contain `{{` is sent as it is. A line whose tags all came out empty is left
// out, which is how `Notes on this book: {{book.notes}}` disappears from a book with no notes
// without the template needing a conditional.
import type {
  BookPrompt,
  ScriptedTag,
  Gender,
  ProfilePrompt,
  PromptOrigin,
  PromptTemplate,
  ReasoningEffort,
  RenderedPrompt,
  ResolvedPrompt,
} from "@/types";
import { NARRATOR } from "@/lib/cast";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["off", "low", "medium", "high"];

// ---------------------------------------------------------------------------------------------
// The built-in prompt

/**
 * How the model marks an expression tag in a line's text: `[[sigh]]`, or for an excerpt that has
 * either half of that in it already, the first pair it has neither half of — so a marker read back
 * is always the model's, never the book's. Almost every excerpt gets the first, which keeps the
 * system prompt the same from one request to the next, as a provider's cache wants.
 */
export const SCRIPT_MARKERS = [
  ["[[", "]]"],
  ["<<", ">>"],
  ["{|", "|}"],
] as const;
export type ScriptMarker = (typeof SCRIPT_MARKERS)[number];

/** The marker an excerpt's tags are written in; null for one that has all three in it. */
export const scriptMarkerFor = (excerpt: string): ScriptMarker | null =>
  SCRIPT_MARKERS.find(([open, close]) => !excerpt.includes(open) && !excerpt.includes(close)) ??
  null;

/** What a tag's words may be: a few words, a sound or a delivery, nothing that is markup. */
const TAG_WORDS = /^[\p{L}\p{N}'’ ,-]{1,60}$/u;
/** what a word is made of, an apostrophe or a hyphen inside it included (`don't`, `well-known`) */
const WORD_CHAR = /[\p{L}\p{N}'’-]/u;
/** punctuation that closes onto the word before it, so a tag before it goes before the space */
const CLOSING = /[,.;:!?…)\]’”"]/u;

/** `tags` once `lead` characters are cut from the front of their line, now `length` long. */
export const shiftTags = (tags: ScriptedTag[], lead: number, length: number): ScriptedTag[] =>
  tags.map((t) => ({ ...t, at: Math.min(Math.max(t.at - lead, 0), length) }));

/**
 * A line's text with the model's markers taken out, and where each one was. A tag goes between
 * words, never inside one. A marker with no space on either side is told apart by the `excerpt`:
 * when the two sides glued together are in it, the marker was cut into one word and moves to the
 * word's start (`wo[[sigh]]rd`); when they are not, it stood for the space between two words,
 * which is put back (`you,[[laughs]]didn't`). With no excerpt, it is read as one word. A marker
 * that is not a few plain words is left in the text as written, for `answerOf` to refuse.
 */
export function readScriptedTags(
  marked: string,
  marker: ScriptMarker | null,
  excerpt?: string,
): { text: string; tags: ScriptedTag[] } {
  if (!marker) return { text: marked, tags: [] };
  const [open, close] = marker;
  /** where the prose resumes after the marker ending at `i`, past any marker straight after it */
  const prose = (i: number): number => {
    while (marked.startsWith(open, i) && marked.indexOf(close, i) >= 0)
      i = marked.indexOf(close, i) + close.length;
    return i;
  };
  let text = "";
  const tags: ScriptedTag[] = [];
  let i = 0;
  for (;;) {
    const from = marked.indexOf(open, i);
    const to = from < 0 ? -1 : marked.indexOf(close, from + open.length);
    if (to < 0) break;
    const label = marked
      .slice(from + open.length, to)
      .replace(/\s+/g, " ")
      .trim();
    text += marked.slice(i, from);
    i = to + close.length;
    if (!TAG_WORDS.test(label)) {
      text += marked.slice(from, i);
      continue;
    }
    const next = marked[i] ?? "";
    const left = text.match(/\S*$/)![0];
    const right = marked.slice(prose(i)).match(/^\S*/)![0];
    let at = text.length;
    if (left && right) {
      if (excerpt !== undefined && !excerpt.includes(left + right)) at = (text += " ").length;
      else if (WORD_CHAR.test(left.at(-1)!) && WORD_CHAR.test(right[0]))
        at = text.search(/[\p{L}\p{N}'’-]*$/u);
    } else if (/\s$/.test(text) && CLOSING.test(next)) at = (text = text.trimEnd()).length;
    else if ((!text || /\s$/.test(text)) && /\s/.test(next)) i++;
    tags.push({ label, at });
  }
  text += marked.slice(i);
  const lead = text.length - text.trimStart().length;
  text = text.trim();
  return { text, tags: shiftTags(tags, lead, text.length) };
}

/**
 * What every answer must look like, with its tags in `marker`. Not editable: the parser and the
 * word-for-word check depend on it. Appended to the system prompt of every request. A cue written
 * any other way is forbidden either way: nothing could tell it from the prose.
 */
export const outputFormat = (marker: ScriptMarker | null): string =>
  FORMAT_TEMPLATE.replace(
    TAGS_SLOT,
    marker
      ? `- Expression tags, only when your instructions ask for them: a sound the voice should make — a sigh, a laugh — goes in the line's "text" where it is heard, as ${marker[0]}sigh${marker[1]}: plain words between ${marker[0]} and ${marker[1]}, whatever brackets the instructions show. A tag is not a word of the excerpt and never takes the place of one. Never write a cue any other way, such as [sighs] or (laughs).\n`
      : `- Never put a cue such as [sighs] in "text".\n`,
  );

/** Where `outputFormat` puts what it says of expression tags; not a prompt tag. */
const TAGS_SLOT = "%EXPRESSION_TAGS%\n";

const FORMAT_TEMPLATE = `Output format (always required):
The script is a list of consecutive lines that together read out the excerpt from start to finish: every word of the excerpt exactly once, in the original order. Add nothing, drop nothing, summarise nothing, correct nothing, and keep the punctuation of the prose — an answer that leaves words out or adds any is refused.
Each line has:
- "type": "narration" for the narrator's prose, "dialogue" for words a character says aloud, "thought" for words a character thinks, "watermark" for text that is not the story but the website's (see below), "note" for a translator's or author's note.
- "speaker": "${NARRATOR}" for narration, watermark and note lines; for dialogue and thought, the name of the character speaking or thinking.
- "text": the words of the line, copied verbatim from the excerpt.
- "direction" (optional): how the line is delivered, in a few words for the voice (see the rules).
%EXPRESSION_TAGS%

Text that is not the story still goes in the script, word for word, on lines of its own — it is marked, never left out:
- "watermark": a website's boilerplate or anti-scraping text, such as "Read the latest chapters at example.com", "This chapter was stolen from …", a web address, or a request to support or vote. Such text is often dropped between paragraphs or into the middle of a sentence; give it its own line even there, so the sentence becomes a narration line, a watermark line and a narration line.
- "note": a translator's or author's note, such as "(TL note: …)" or "A/N: …", including its label and brackets.
When unsure whether something is the story, it is the story.

Besides the lines, the answer has:
- "cast": what the excerpt tells you about the characters who speak or think in it, for each one the known cast does not list or lists without it — "name" (as used for "speaker"), "gender" ("male", "female", "non-binary" or "unknown"), "aliases" (the other names, titles and nicknames the text calls them, e.g. "the Captain") and "description" (one short sentence: who they are, and how they sound when the text says). Leave out characters with nothing new; [] when there are none.
- "recap": one to three sentences on where the excerpt leaves off, for whoever scripts the text that follows it: who is present, including anyone who has not spoken; where they are; who spoke last and to whom; any question left unanswered; and what the text is calling each of them. Use the names from "speaker".

Answer with JSON only, in this shape:
{"lines":[{"type":"narration","speaker":"${NARRATOR}","text":"The door opened."},{"type":"dialogue","speaker":"Mara","text":"Come in,","direction":"soft, wary"},{"type":"narration","speaker":"${NARRATOR}","text":"said Mara softly."}],"cast":[{"name":"Mara","gender":"female","aliases":["the lamplighter"],"description":"A young lamplighter, quick and wary."}],"recap":"Mara has let a stranger in out of the cold, at her door; she spoke last, to him, and he has not answered."}`;

/** The output format as almost every request is sent it, for the page to show under the editor. */
export const OUTPUT_FORMAT = outputFormat(SCRIPT_MARKERS[0]);

/** The prompt a library starts with, and what Reset puts back. */
export const BUILT_IN_PROMPT: PromptTemplate = {
  system: `You turn an excerpt from a chapter of an English novel into an audiobook script.

Rules:
1. Thoughts are usually in italics or marked "she thought"; they are "thought" lines, not narration.
2. Dialogue text is the spoken words without their surrounding quotation marks. A quotation interrupted by narration becomes three lines: dialogue, narration, dialogue.
3. Attribution tags such as "said Mara" or "he asked, frowning" are narration, read by the ${NARRATOR}; they are never part of the dialogue line.
4. Work out who is speaking from the tags, the conversation's back-and-forth, and where the text before the excerpt left off. A character goes by one name all through the book: resolve pronouns, titles and nicknames ("the girl", "the Captain") to it, using the known cast's other names. When a speaker is one of the known cast, use exactly that name; otherwise use the name the text gives them (e.g. "Old Tobiah"). Use "Unknown" only when nothing says who speaks.
5. Consecutive sentences of narration may share one line; start a new line at every change of speaker or type, and at paragraph breaks.
6. A direction is all the voice engine is told besides the words, and it knows nothing of the story — no names, no plot — so describe the sound: tone, pace, volume, breath. Not "mocking his plan" but "lazy, open contempt"; not "shaking her head" but "flat, tired refusal". Base it on the prose (speech tags, punctuation, what the narrator says of the speaker); keep the same wording while a character's mood holds; leave it out for plain delivery.

Notes on this book: {{book.notes}}
Notes for this model: {{endpoint.notes}}`,
  user: `Chapter: {{chapter.title}}
Known cast: {{cast}}
Where the previous chapter left off: {{previous.recap}}
Just before this excerpt, already scripted (context only, not part of the excerpt): {{excerpt.before}}

Excerpt:
{{excerpt}}`,
};

// ---------------------------------------------------------------------------------------------
// Tags

/** How often a tag's value changes — what decides whether it breaks a provider's prompt cache. */
export type TagScope = "request" | "chapter" | "book" | "endpoint";

export interface PromptTag {
  name: string;
  /** what it is replaced with, for the chip's title */
  about: string;
  scope: TagScope;
}

export const PROMPT_TAGS: readonly PromptTag[] = [
  {
    name: "excerpt",
    about: "The text of this request. Required, once, in the user message",
    scope: "request",
  },
  {
    name: "excerpt.before",
    about: "The end of the text before this request's, for context; empty for a chapter's first",
    scope: "request",
  },
  { name: "part", about: "Which request of the chapter this is, from 1", scope: "request" },
  { name: "parts", about: "How many requests the chapter is cut into", scope: "chapter" },
  { name: "chapter.title", about: "The chapter's title", scope: "chapter" },
  {
    name: "chapter.number",
    about: "The chapter's reading number: its place among the chapters the audiobook keeps",
    scope: "chapter",
  },
  {
    name: "cast",
    about:
      "The known speakers' names with gender and other names, comma-separated, or “(none yet)”",
    scope: "chapter",
  },
  {
    name: "cast.details",
    about: "One line per known speaker: name, gender, other names, description",
    scope: "chapter",
  },
  {
    name: "previous.recap",
    about:
      "Where the chapter before left off, as its script's model summed it up; empty when it has none",
    scope: "chapter",
  },
  { name: "book.title", about: "The book's title", scope: "book" },
  { name: "book.author", about: "The book's author", scope: "book" },
  {
    name: "book.notes",
    about: "The book's notes for the scripter; empty leaves its line out",
    scope: "book",
  },
  { name: "endpoint.name", about: "The endpoint's name", scope: "endpoint" },
  {
    name: "endpoint.notes",
    about: "The endpoint's notes for its model; empty leaves its line out",
    scope: "endpoint",
  },
  { name: "model", about: "The model ID the request goes to", scope: "endpoint" },
  {
    name: "expressions",
    about:
      "The expression tags your voices list on their Expressions tabs, comma-separated, for a prompt that asks for tags; empty leaves its line out",
    scope: "endpoint",
  },
];

const TAG_NAMES = new Set(PROMPT_TAGS.map((t) => t.name));

/** `{{ name }}`, spaces inside the braces allowed. */
const TAG = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Every tag a text names, in order, repeats included. */
export function tagsIn(text: string): string[] {
  return [...text.matchAll(TAG)].map((m) => m[1]);
}

/** A known speaker, as `{{cast}}` and `{{cast.details}}` read one. */
export interface PromptCastMember {
  name: string;
  aliases?: readonly string[];
  gender?: Gender;
  description?: string;
}

/** Everything a request's tags are filled from. */
export interface PromptVars {
  book: { title: string; author: string; notes: string };
  chapter: { title: string; number: number };
  /** 1-based */
  part: number;
  parts: number;
  /** the book's speakers; the Narrator and "Unknown" are left out of both cast tags */
  cast: readonly PromptCastMember[];
  excerpt: string;
  /** the end of the text before the excerpt, when it is not the chapter's first request */
  before?: string;
  /** the recap the chapter before's script left; absent or empty when it has none */
  recap?: string;
  /** `notes` absent is none, as for an endpoint with nothing typed */
  endpoint: { name: string; model: string; notes?: string };
  /** the tag names the speech endpoints list (`expressionNames`); absent is none */
  expressions?: readonly string[];
}

const GENDER: Record<Gender, string> = { m: "male", f: "female", n: "non-binary", "?": "" };

const UNKNOWN = "Unknown";

function castOf(vars: PromptVars): PromptCastMember[] {
  return vars.cast.filter((c) => c.name !== NARRATOR && c.name !== UNKNOWN);
}

/** "Mara (female; also called Mar)": what tells a speaker apart, without the description. */
function nameOf(c: PromptCastMember): string {
  const facts = [
    GENDER[c.gender ?? "?"],
    c.aliases?.length ? `also called ${c.aliases.join(", ")}` : "",
  ].filter(Boolean);
  return `${c.name}${facts.length ? ` (${facts.join("; ")})` : ""}`;
}

/** "Mara (female; also called Mar): A lamplighter." — everything known of a speaker, on one line. */
export function speakerLine(c: PromptCastMember): string {
  const description = (c.description ?? "").replace(/\s+/g, " ").trim();
  return `${nameOf(c)}${description ? `: ${description}` : ""}`;
}

const detailOf = (c: PromptCastMember): string => `- ${speakerLine(c)}`;

/** A tag's value for one request; undefined for a name that is not a tag. */
function valueOf(name: string, vars: PromptVars): string | undefined {
  switch (name) {
    case "excerpt":
      return vars.excerpt;
    case "excerpt.before":
      return (vars.before ?? "").trim();
    case "part":
      return String(vars.part);
    case "parts":
      return String(vars.parts);
    case "chapter.title":
      return vars.chapter.title;
    case "chapter.number":
      return String(vars.chapter.number);
    case "cast": {
      const names = castOf(vars).map(nameOf);
      return names.length ? names.join(", ") : "(none yet)";
    }
    case "cast.details":
      return castOf(vars).map(detailOf).join("\n");
    case "previous.recap":
      return (vars.recap ?? "").replace(/\s+/g, " ").trim();
    case "book.title":
      return vars.book.title;
    case "book.author":
      return vars.book.author;
    case "book.notes":
      return vars.book.notes.trim();
    case "endpoint.name":
      return vars.endpoint.name;
    case "model":
      return vars.endpoint.model;
    case "endpoint.notes":
      return (vars.endpoint.notes ?? "").trim();
    case "expressions":
      return (vars.expressions ?? []).join(", ");
    default:
      return undefined;
  }
}

/**
 * One message with its tags filled. A line whose tags all came out empty is dropped; an unknown
 * tag is left as it was written (`promptProblems` refuses one before it is saved).
 */
export function fill(text: string, vars: PromptVars): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    let tags = 0;
    let empty = 0;
    const filled = line.replace(TAG, (whole, name: string) => {
      const value = valueOf(name, vars);
      if (value === undefined) return whole;
      tags++;
      if (!value.trim()) empty++;
      return value;
    });
    if (tags > 0 && tags === empty) continue;
    out.push(filled);
  }
  return out.join("\n").trim();
}

/** The messages as they are sent: tags filled, and the output format after the system prompt. */
export function renderPrompt(template: PromptTemplate, vars: PromptVars): RenderedPrompt {
  const system = fill(template.system, vars);
  return {
    system: [system, outputFormat(scriptMarkerFor(vars.excerpt))].filter(Boolean).join("\n\n"),
    user: fill(template.user, vars),
  };
}

// ---------------------------------------------------------------------------------------------
// Layers

/** The library's default, or the built-in prompt when nobody has edited it. */
export const libraryPrompt = (saved: PromptTemplate | null | undefined): PromptTemplate =>
  saved ?? BUILT_IN_PROMPT;

/**
 * The template one request is built from: the book's replacement, else the endpoint's, else the
 * library's default, else the built-in prompt.
 */
export function resolvePrompt(layers: {
  library: PromptTemplate | null | undefined;
  profile?: ProfilePrompt | null;
  book?: BookPrompt | null;
}): ResolvedPrompt {
  const { library, profile, book } = layers;
  let base: PromptTemplate;
  let from: PromptOrigin["from"];
  if (book?.replace) [base, from] = [book, "book"];
  else if (profile?.mode === "replace") [base, from] = [profile, "endpoint"];
  else if (library) [base, from] = [library, "library"];
  else [base, from] = [BUILT_IN_PROMPT, "built-in"];
  const { system, user } = base;
  return { system, user, origin: { from, fingerprint: fingerprint({ system, user }) } };
}

/**
 * Which notes a template would not send: the ones with text whose tag it does not name. What the
 * page warns about beside the notes, so a note typed for a prompt that drops it says so.
 */
export function unplacedNotes(
  t: PromptTemplate,
  notes: { book?: string; endpoint?: string },
): ("book" | "endpoint")[] {
  const named = new Set([...tagsIn(t.system), ...tagsIn(t.user)]);
  return (["book", "endpoint"] as const).filter(
    (k) => (notes[k] ?? "").trim() && !named.has(`${k}.notes`),
  );
}

/** A short, stable hash of a template: FNV-1a over both messages, as eight hex digits. */
export function fingerprint(t: PromptTemplate): string {
  let h = 0x811c9dc5;
  for (const ch of `${t.system}\u0000${t.user}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** How a history entry or a run names where its prompt came from, e.g. "library prompt + endpoint". */
export function describeOrigin(o: PromptOrigin): string {
  const base = {
    "built-in": "built-in prompt",
    library: "library prompt",
    endpoint: "endpoint's prompt",
    book: "book's prompt",
  }[o.from];
  return base;
}

// ---------------------------------------------------------------------------------------------
// Checks

/** The longest a message's template may be, and a book's or an endpoint's notes. Every character is sent, and billed, with every request. */
export const PROMPT_MAX_CHARS = 20_000;
export const NOTES_MAX_CHARS = 4_000;

/** What stops a book's or an endpoint's notes from being saved. */
export function notesProblems(notes: string): string[] {
  return notes.length > NOTES_MAX_CHARS
    ? [
        `The notes are ${notes.length.toLocaleString("en")} characters; the most is ${NOTES_MAX_CHARS.toLocaleString("en")}.`,
      ]
    : [];
}

/**
 * What stops a template from being saved as a prompt of its own — the library's, an endpoint's or
 * a book's replacement: unknown tags, the excerpt missing, doubled or in the system prompt, and
 * length.
 */
export function promptProblems(t: PromptTemplate): string[] {
  const problems = lengthProblems(t);
  for (const [label, text] of [
    ["system prompt", t.system],
    ["user message", t.user],
  ] as const) {
    const unknown = [...new Set(tagsIn(text).filter((n) => !TAG_NAMES.has(n)))];
    for (const n of unknown) problems.push(`The ${label} names {{${n}}}, which is not a tag.`);
  }
  const inUser = tagsIn(t.user).filter((n) => n === "excerpt").length;
  const inSystem = tagsIn(t.system).filter((n) => n === "excerpt").length;
  if (inSystem) problems.push("{{excerpt}} goes in the user message, not the system prompt.");
  if (inUser === 0) problems.push("The user message must include {{excerpt}}, the text to script.");
  if (inUser > 1) problems.push("{{excerpt}} may appear only once: the model would copy it twice.");
  return problems;
}

/** Only how long a template is: what a prompt keeps but does not send is otherwise its own. */
export function lengthProblems(t: PromptTemplate): string[] {
  return (
    [
      ["system prompt", t.system],
      ["user message", t.user],
    ] as const
  ).flatMap(([label, text]) =>
    text.length > PROMPT_MAX_CHARS
      ? [
          `The ${label} is ${text.length.toLocaleString("en")} characters; the most is ${PROMPT_MAX_CHARS.toLocaleString("en")}.`,
        ]
      : [],
  );
}

/**
 * What stops an endpoint's say over the prompt from being saved: its notes always; a replacement
 * as a prompt on its own, and the texts a `default` endpoint keeps for later only for their
 * length, since they are sent nowhere.
 */
export function profilePromptProblems(p: ProfilePrompt): string[] {
  return [
    ...notesProblems(p.notes),
    ...(p.mode === "replace" ? promptProblems(p) : lengthProblems(p)),
  ];
}

/**
 * The same for a book's: its notes always, its texts as a whole prompt only while it is switched
 * on. A replacement that is off is kept as it was typed, problems and all, since nothing is sent
 * from it — but not at any length.
 */
export function bookPromptProblems(p: BookPrompt): string[] {
  return [...notesProblems(p.notes), ...(p.replace ? promptProblems(p) : lengthProblems(p))];
}

/** What is allowed but costly: a tag in the system prompt that changes with every chapter. */
export function promptWarnings(t: PromptTemplate): string[] {
  const scopes = new Map(PROMPT_TAGS.map((tag) => [tag.name, tag.scope]));
  const moving = [
    ...new Set(
      tagsIn(t.system).filter((n) => ["request", "chapter"].includes(scopes.get(n) ?? "")),
    ),
  ];
  return moving.map(
    (n) =>
      `{{${n}}} changes from one ${scopes.get(n) === "request" ? "request" : "chapter"} to the next: in the system prompt it stops the provider caching it, and cached input is cheaper. The user message is the place for it.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Fixed values

/** What the Endpoints page previews and the connection test sends: a made-up book. */
export function sampleVars(excerpt: string, endpoint: PromptVars["endpoint"]): PromptVars {
  return {
    book: { title: "The Lamplighter", author: "A. N. Author", notes: "" },
    chapter: { title: "The Bridge", number: 1 },
    part: 1,
    parts: 1,
    cast: [{ name: "Mara", gender: "f", aliases: [], description: "" }],
    excerpt,
    endpoint,
  };
}

/**
 * Roughly how many characters a request sends besides its excerpt: both messages rendered with an
 * empty excerpt, a cast of ten, a paragraph of each kind of notes, of text before the excerpt and of
 * recap, the output format included. For estimates and budget holds, which are made before the cast
 * and the chunks are known.
 */
export function promptOverhead(t: PromptTemplate): number {
  const cast = Array.from({ length: 10 }, (_, i) => ({
    name: `Speaker ${i + 1}`,
    gender: "?" as const,
    aliases: [],
    description: "A typical one-sentence description of a speaker in the book.",
  }));
  const vars: PromptVars = {
    book: { title: "A Typical Book Title", author: "A. Author", notes: "x".repeat(300) },
    chapter: { title: "Chapter Twelve: A Typical Title", number: 12 },
    part: 1,
    parts: 1,
    cast,
    excerpt: "",
    before: "x".repeat(600),
    recap: "x".repeat(400),
    endpoint: { name: "An endpoint", model: "a-model-id", notes: "x".repeat(300) },
  };
  const r = renderPrompt(t, vars);
  return r.system.length + r.user.length;
}
