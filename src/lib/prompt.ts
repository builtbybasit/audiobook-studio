// The scripting prompt: built-in template, layers (book > endpoint > library) and tag filling.
// Shared by browser and server so the page previews exactly what the job sends. The output format
// is appended to every request and not editable: the parser and `fidelity`
// (server/providers/chatScripting.ts) depend on it.
import type {
  BookPrompt,
  Effect,
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
 * Expression-tag markers: the first pair the excerpt contains neither half of, so a marker read
 * back is always the model's. Almost every excerpt gets `[[ ]]`, which keeps the prompt cacheable.
 */
export const SCRIPT_MARKERS = [
  ["[[", "]]"],
  ["<<", ">>"],
  ["{|", "|}"],
] as const;
export type ScriptMarker = (typeof SCRIPT_MARKERS)[number];

/** Null for an excerpt that contains all three. */
export const scriptMarkerFor = (excerpt: string): ScriptMarker | null =>
  SCRIPT_MARKERS.find(([open, close]) => !excerpt.includes(open) && !excerpt.includes(close)) ??
  null;

const TAG_WORDS = /^[\p{L}\p{N}'’ ,-]{1,60}$/u;
const WORD_CHAR = /[\p{L}\p{N}'’-]/u;
/** closes onto the word before it, so a tag before it goes before the space */
const CLOSING = /[,.;:!?…)\]’”"]/u;

/** `tags` once `lead` characters are cut from the front of their line, now `length` long. */
export const shiftTags = (tags: ScriptedTag[], lead: number, length: number): ScriptedTag[] =>
  tags.map((t) => ({ ...t, at: Math.min(Math.max(t.at - lead, 0), length) }));

/**
 * A line's text with the model's markers taken out, and where each was. An unspaced marker moves
 * to its word's start if the joined sides are in `excerpt` (`wo[[sigh]]rd`), else stands for a
 * lost space (`you,[[laughs]]didn't`). A non-word marker stays, for `answerOf` to refuse.
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

/** A library effect the model may put on a line: one with a `useWhen` sentence. */
export type LineEffect = Effect & { useWhen: string };

export const lineEffectsOf = (effects: readonly Effect[]): LineEffect[] =>
  effects.filter((e): e is LineEffect => !!e.useWhen?.trim());

/**
 * The answer format, appended to every system prompt. With no line effects it is word for word
 * the same, so a provider's cache holds.
 */
export const outputFormat = (
  marker: ScriptMarker | null,
  lineEffects: readonly { name: string; useWhen: string }[] = [],
): string =>
  FORMAT_TEMPLATE.replace(
    TAGS_SLOT,
    marker
      ? `- Expression tags, only when your instructions ask for them: a sound the voice should make — a sigh, a laugh — goes in the line's "text" where it is heard, as ${marker[0]}sigh${marker[1]}: plain words between ${marker[0]} and ${marker[1]}, whatever brackets the instructions show. A tag is not a word of the excerpt and never takes the place of one. Never write a cue any other way, such as [sighs] or (laughs).\n- Pauses, only where your instructions call for one: a pause inside a line goes in its "text" where it falls, as ${marker[0]}pause${marker[1]} for a short one or ${marker[0]}long pause${marker[1]} for a long one. Like a tag, it is not a word of the excerpt.\n`
      : `- Never put a cue such as [sighs] in "text".\n`,
  ).replace(
    EFFECTS_SLOT,
    // last, and a function: what the library typed is read for neither a slot nor a `$` pattern
    () =>
      lineEffects.length
        ? `- "effects" (optional): sound effects for how this line is heard, by name, only from this list — ${lineEffects.map((e) => `"${oneLine(e.name)}": ${oneLine(e.useWhen).replace(/\.$/, "")}`).join("; ")}. Several may apply to one line. Use one only when the text says so; most lines have none, and then leave "effects" out. A persona's disguise is already in its voice, so never add a mask effect to a persona's lines.\n`
        : "",
  );

/** `outputFormat` placeholders; not prompt tags. */
const TAGS_SLOT = "%EXPRESSION_TAGS%\n";
const EFFECTS_SLOT = "%LINE_EFFECTS%\n";

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const FORMAT_TEMPLATE = `Output format (always required):
The script is a list of consecutive lines that together read out the excerpt from start to finish: every word of the excerpt exactly once, in the original order. Add nothing, drop nothing, summarise nothing, correct nothing, and keep the punctuation of the prose — an answer that leaves words out or adds any is refused.
Each line has:
- "type": "narration" for the narrator's prose, "dialogue" for words a character says aloud, "thought" for words a character thinks, "watermark" for text that is not the story but the website's (see below), "note" for a translator's or author's note.
- "speaker": "${NARRATOR}" for narration, watermark and note lines; for dialogue and thought, the name of the character speaking or thinking.
- "text": the words of the line, copied verbatim from the excerpt.
%LINE_EFFECTS%
- "direction" (optional): how the line is delivered, in a few words for the voice (see the rules).
%EXPRESSION_TAGS%

Text that is not the story still goes in the script, word for word, on lines of its own — it is marked, never left out:
- "watermark": a website's boilerplate or anti-scraping text, such as "Read the latest chapters at example.com", "This chapter was stolen from …", a web address, or a request to support or vote. Such text is often dropped between paragraphs or into the middle of a sentence; give it its own line even there, so the sentence becomes a narration line, a watermark line and a narration line.
- "note": a translator's or author's note, such as "(TL note: …)" or "A/N: …", including its label and brackets.
When unsure whether something is the story, it is the story.

Besides the lines, the answer has:
- "cast": notes on the characters who speak or think in the excerpt — only what the known cast is missing; [] when there is nothing new. Each note has:
  - "name": as written in "speaker".
  - "gender": "male", "female", "non-binary" or "unknown".
  - "aliases": other names they are called by, such as "Mar" or "the Captain". A description is not a name: never "the old man" or "the beautiful woman". [] when they have none.
  - "description": one short sentence on who they are, and how they sound if the text says.
  - "personaOf": only for a disguise (rule 5): who wears it, or "unknown". For an entry marked "masked, identity unknown", the wearer once the text reveals them. Otherwise null.
- "recap": one to three sentences on where the excerpt leaves off, for whoever scripts the text that follows it: who is present, including anyone who has not spoken; where they are; who spoke last and to whom; any question left unanswered; and what the text is calling each of them. Use the names from "speaker".

Answer with JSON only, in this shape:
{"lines":[{"type":"narration","speaker":"${NARRATOR}","text":"The door opened."},{"type":"dialogue","speaker":"Mara","text":"Come in,","direction":"soft, wary"},{"type":"narration","speaker":"${NARRATOR}","text":"said Mara softly."}],"cast":[{"name":"Mara","gender":"female","aliases":["Mar"],"description":"A young lamplighter, quick and wary."}],"recap":"Mara has let a stranger in out of the cold, at her door; she spoke last, to him, and he has not answered."}`;

/** With no line effects offered. */
export const OUTPUT_FORMAT = outputFormat(SCRIPT_MARKERS[0]);

/** What a library starts with, and what Reset puts back. */
export const BUILT_IN_PROMPT: PromptTemplate = {
  system: `You turn an excerpt from a chapter of an English novel into an audiobook script.

Rules:
1. Split by voice. Start a new line at every paragraph break and every change of speaker or type; sentences of narration in one paragraph may share a line. Whenever a paragraph mixes narration, dialogue and thought, split it into separate lines. A quote with a speech tag in or after it is always several lines: “No,” she said quietly. “Nobody followed me.” is dialogue “No,”, narration “she said quietly.”, dialogue “Nobody followed me.” Speech tags such as “said Mara” or “he asked, frowning” are narration, read by the ${NARRATOR}.
2. Words in quotation marks are dialogue; the line's text leaves the quotation marks out. Name who speaks from the tags, the back-and-forth of the conversation, and the text before the excerpt, which is there only to tell who is speaking or thinking at the start.
3. Thoughts are “thought” lines: italics, “she thought”, “she told herself”, and the point-of-view character's unspoken reflections. Their speaker is the character thinking — usually the one whose point of view the scene follows.
4. A character goes by one name all through the book. Resolve pronouns, titles and nicknames to the known cast's names, and write a known speaker's name exactly as the cast does; a new speaker goes by what the text calls them. Use “Unknown” only when nothing says who speaks. Never write a speaker into the text.
5. A persona is an identity a character hides behind — a mask, a false name — that the people around them do not know is theirs. A cast entry marked “persona of” is one: while the scene has them in that identity, the words they say aloud — and those words replayed or quoted later — go to the persona's cast name, even when the narration keeps calling them by their real name; their thoughts, and what they say once the disguise is off, go to their own name. A disguise the cast does not have yet is the same: a new speaker under the name it goes by, even when the narration says who wears it (“Hand it over,” Kel said behind the crow mask, as the Crow → speaker “Crow”, “personaOf” “Kel”). A masked or disguised figure the text has not identified is a new speaker too, whose “personaOf” is “unknown”. An entry marked “masked, identity unknown” is such a figure: when the text reveals who wears it, give that name as its “personaOf”, and from then on treat it like any persona.
6. A direction is all the voice engine is told besides the words, and it knows nothing of the story: describe the sound — tone, pace, volume, breath — in a few words (“flat, tired refusal”, not “refusing his plan”). Keep the same wording while a mood holds; leave it out for plain delivery.
7. Put a pause inside a line only for a real beat — trailing off, a hesitation, a breath before a reveal — never at an ordinary comma or the end of a sentence.

Before you answer, check that every sentence of the excerpt is in a line, once.

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

/** How often a tag's value changes, which decides whether it breaks a provider's prompt cache. */
export type TagScope = "request" | "chapter" | "book" | "endpoint";

export interface PromptTag {
  name: string;
  /** the chip's title */
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
      "The speakers this chapter names, those who spoke in it or just before it, and every persona and masked figure: names with gender, whose persona one is (or that a masked one's is unknown), and other names, comma-separated, or “(none yet)”",
    scope: "chapter",
  },
  {
    name: "cast.details",
    about: "One line per speaker {{cast}} lists: name, gender, other names, description",
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

const TAG = /\{\{\s*([\w.]+)\s*\}\}/g;

/** In order, repeats included. */
export function tagsIn(text: string): string[] {
  return [...text.matchAll(TAG)].map((m) => m[1]);
}

export interface PromptCastMember {
  name: string;
  aliases?: readonly string[];
  gender?: Gender;
  description?: string;
  personaOf?: string;
  /** `Character.masked`; with no `personaOf`, the wearer is unknown */
  masked?: boolean;
}

export interface PromptVars {
  book: { title: string; author: string; notes: string };
  chapter: { title: string; number: number };
  /** 1-based */
  part: number;
  parts: number;
  /** `chapterCast`; the Narrator and "Unknown" are left out of both cast tags */
  cast: readonly PromptCastMember[];
  excerpt: string;
  /** the end of the text before the excerpt */
  before?: string;
  /** the previous chapter's recap */
  recap?: string;
  endpoint: { name: string; model: string; notes?: string };
  /** `expressionNames` */
  expressions?: readonly string[];
  /** `lineEffectsOf` */
  lineEffects?: readonly { name: string; useWhen: string }[];
}

const GENDER: Record<Gender, string> = { m: "male", f: "female", n: "non-binary", "?": "" };

const UNKNOWN = "Unknown";

function castOf(vars: PromptVars): PromptCastMember[] {
  return vars.cast.filter((c) => c.name !== NARRATOR && c.name !== UNKNOWN);
}

/** "Mara (female; also called Mar)", "Lord of Shadows (male; persona of Sunny)". */
function nameOf(c: PromptCastMember): string {
  const facts = [
    GENDER[c.gender ?? "?"],
    c.personaOf ? `persona of ${c.personaOf}` : c.masked ? "masked, identity unknown" : "",
    c.aliases?.length ? `also called ${c.aliases.join(", ")}` : "",
  ].filter(Boolean);
  return `${c.name}${facts.length ? ` (${facts.join("; ")})` : ""}`;
}

/** "Mara (female; also called Mar): A lamplighter." */
export function speakerLine(c: PromptCastMember): string {
  const description = (c.description ?? "").replace(/\s+/g, " ").trim();
  return `${nameOf(c)}${description ? `: ${description}` : ""}`;
}

const detailOf = (c: PromptCastMember): string => `- ${speakerLine(c)}`;

/** Undefined for a name that is not a tag. */
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
 * One message with its tags filled, in one pass (a novel containing `{{` is sent as is). A line
 * whose tags all came out empty is dropped; an unknown tag is left as written.
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

/** The messages as sent: tags filled, the output format after the system prompt. */
export function renderPrompt(template: PromptTemplate, vars: PromptVars): RenderedPrompt {
  const system = fill(template.system, vars);
  return {
    system: [system, outputFormat(scriptMarkerFor(vars.excerpt), vars.lineEffects)]
      .filter(Boolean)
      .join("\n\n"),
    user: fill(template.user, vars),
  };
}

// ---------------------------------------------------------------------------------------------
// Layers

export const libraryPrompt = (saved: PromptTemplate | null | undefined): PromptTemplate =>
  saved ?? BUILT_IN_PROMPT;

/** A book's conventions are about the text, so its replacement wins over an endpoint's. */
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

/** Notes with text whose tag the template does not name, so they would not be sent. */
export function unplacedNotes(
  t: PromptTemplate,
  notes: { book?: string; endpoint?: string },
): ("book" | "endpoint")[] {
  const named = new Set([...tagsIn(t.system), ...tagsIn(t.user)]);
  return (["book", "endpoint"] as const).filter(
    (k) => (notes[k] ?? "").trim() && !named.has(`${k}.notes`),
  );
}

/** FNV-1a over both messages, as eight hex digits. */
export function fingerprint(t: PromptTemplate): string {
  let h = 0x811c9dc5;
  for (const ch of `${t.system}\u0000${t.user}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

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

/** Every character is sent, and billed, with every request. */
export const PROMPT_MAX_CHARS = 20_000;
export const NOTES_MAX_CHARS = 4_000;

export function notesProblems(notes: string): string[] {
  return notes.length > NOTES_MAX_CHARS
    ? [
        `The notes are ${notes.length.toLocaleString("en")} characters; the most is ${NOTES_MAX_CHARS.toLocaleString("en")}.`,
      ]
    : [];
}

/** What stops a template from being saved as a prompt of its own. */
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

/** For texts kept but not sent, only length is checked. */
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

/** A `default` endpoint's kept texts are sent nowhere, so only their length is checked. */
export function profilePromptProblems(p: ProfilePrompt): string[] {
  return [
    ...notesProblems(p.notes),
    ...(p.mode === "replace" ? promptProblems(p) : lengthProblems(p)),
  ];
}

/** A replacement that is off is kept as typed, problems and all, but not at any length. */
export function bookPromptProblems(p: BookPrompt): string[] {
  return [...notesProblems(p.notes), ...(p.replace ? promptProblems(p) : lengthProblems(p))];
}

/** Allowed but costly: a system-prompt tag that changes per chapter breaks the provider's cache. */
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

/** A made-up book for the Endpoints page preview and the connection test. */
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
 * Roughly how many characters a request sends besides its excerpt, rendered with typical filler.
 * For estimates and budget holds, made before the cast and the chunks are known.
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
    lineEffects: [1, 2].map((i) => ({
      name: `Effect ${i}`,
      useWhen: "A typical sentence saying when a line is heard through it.",
    })),
  };
  const r = renderPrompt(t, vars);
  return r.system.length + r.user.length;
}
