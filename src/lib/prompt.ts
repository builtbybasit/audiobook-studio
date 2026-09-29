// The scripting prompt: what a chat model is told, how the three places that may change it are
// layered, and how its tags are filled in for one request.
//
// Shared by the browser and the server. The page previews exactly what the job will send, so the
// rendering lives here and nowhere else — a preview built by a second copy of these rules would
// drift from the requests that are actually billed.
//
// **Three layers.** The library has a default, which is the built-in prompt until somebody edits
// it on the Endpoints page. A scripting endpoint may append to whatever it is given (a model's
// quirk: "keep paragraphs apart") or replace it outright. A book may carry notes, which the
// `{{book.notes}}` tag places, and may replace the whole prompt for itself. A book's replacement
// wins over an endpoint's, because a book's conventions are about the text and hold whichever model
// reads it; an endpoint's append is still added after it, because a model's quirks hold whichever
// book it reads.
//
// **One part is not editable**: the output format. The answer is parsed as `{"lines":[…]}` and held
// word for word against the prose (`fidelity` in `server/providers/chatScripting.ts`), so a prompt
// that forgot to ask for either would fail every chunk. It is added after the system prompt, always,
// and the page shows it read-only under the editor.
//
// **Tags** are `{{name}}`, filled in one pass: nothing a tag puts in is read for tags again, so a
// novel that happens to contain `{{` is sent as it is. A line whose tags all came out empty is left
// out, which is how `Notes on this book: {{book.notes}}` disappears from a book with no notes
// without the template needing a conditional.
import type {
  BookPrompt,
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
 * What every answer must look like. Not editable: the parser and the word-for-word check depend on
 * it. Appended to the system prompt of every request.
 */
export const OUTPUT_FORMAT = `Output format (always required):
The script is a list of consecutive lines that together read out the excerpt from start to finish: every word of the excerpt exactly once, in the original order. Add nothing, drop nothing, summarise nothing, correct nothing, and keep the punctuation of the prose — an answer that leaves words out or adds any is refused.
Each line has:
- "type": "narration" for the narrator's prose, "dialogue" for words a character says aloud, "thought" for words a character thinks.
- "speaker": "${NARRATOR}" for narration; for dialogue and thought, the name of the character speaking or thinking.
- "text": the words of the line, copied verbatim from the excerpt.
- "direction" (optional): a few words on how the line is delivered, e.g. "whispering" or "angrily".

Answer with JSON only, in this shape:
{"lines":[{"type":"narration","speaker":"${NARRATOR}","text":"The door opened."},{"type":"dialogue","speaker":"Mara","text":"Come in,","direction":"softly"},{"type":"narration","speaker":"${NARRATOR}","text":"said Mara softly."}]}`;

/** The prompt a library starts with, and what Reset puts back. */
export const BUILT_IN_PROMPT: PromptTemplate = {
  system: `You turn an excerpt from a chapter of an English novel into an audiobook script.

Rules:
1. Thoughts are usually in italics or marked "she thought"; they are "thought" lines, not narration.
2. Dialogue text is the spoken words without their surrounding quotation marks. A quotation interrupted by narration becomes three lines: dialogue, narration, dialogue.
3. Attribution tags such as "said Mara" or "he asked, frowning" are narration, read by the ${NARRATOR}; they are never part of the dialogue line.
4. Work out who is speaking from the tags and from the conversation's back-and-forth. When a speaker is one of the known cast, use exactly that name; otherwise use the name the text gives them (e.g. "Old Tobiah", "the Captain"). Use "Unknown" only when nothing in the excerpt says who speaks.
5. Consecutive sentences of narration may share one line; start a new line at every change of speaker or type, and at paragraph breaks.
6. Give a direction only when the prose itself says how a line is delivered; leave it out otherwise.

Notes on this book: {{book.notes}}`,
  user: `Chapter: {{chapter.title}}
Known cast: {{cast}}

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
  { name: "part", about: "Which request of the chapter this is, from 1", scope: "request" },
  { name: "parts", about: "How many requests the chapter is cut into", scope: "chapter" },
  { name: "chapter.title", about: "The chapter's title", scope: "chapter" },
  { name: "chapter.number", about: "The chapter's number in the book", scope: "chapter" },
  {
    name: "cast",
    about: "The known speakers' names, comma-separated, or “(none yet)”",
    scope: "chapter",
  },
  {
    name: "cast.details",
    about: "One line per known speaker: name, gender, other names, description",
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
  { name: "model", about: "The model ID the request goes to", scope: "endpoint" },
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
  endpoint: { name: string; model: string };
}

const GENDER: Record<Gender, string> = { m: "male", f: "female", n: "non-binary", "?": "" };

const UNKNOWN = "Unknown";

function castOf(vars: PromptVars): PromptCastMember[] {
  return vars.cast.filter((c) => c.name !== NARRATOR && c.name !== UNKNOWN);
}

function detailOf(c: PromptCastMember): string {
  const facts = [
    GENDER[c.gender ?? "?"],
    c.aliases?.length ? `also called ${c.aliases.join(", ")}` : "",
  ].filter(Boolean);
  const description = (c.description ?? "").replace(/\s+/g, " ").trim();
  return `- ${c.name}${facts.length ? ` (${facts.join("; ")})` : ""}${description ? `: ${description}` : ""}`;
}

/** A tag's value for one request; undefined for a name that is not a tag. */
function valueOf(name: string, vars: PromptVars): string | undefined {
  switch (name) {
    case "excerpt":
      return vars.excerpt;
    case "part":
      return String(vars.part);
    case "parts":
      return String(vars.parts);
    case "chapter.title":
      return vars.chapter.title;
    case "chapter.number":
      return String(vars.chapter.number);
    case "cast": {
      const names = castOf(vars).map((c) => c.name);
      return names.length ? names.join(", ") : "(none yet)";
    }
    case "cast.details":
      return castOf(vars).map(detailOf).join("\n");
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
    system: system ? `${system}\n\n${OUTPUT_FORMAT}` : OUTPUT_FORMAT,
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
 * library's default, else the built-in prompt — then the endpoint's append, if it has one.
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
  const appended = profile?.mode === "append" && !!(profile.system.trim() || profile.user.trim());
  const join = (a: string, b: string): string => (b.trim() ? `${a.trimEnd()}\n\n${b.trim()}` : a);
  const system = appended ? join(base.system, profile.system) : base.system;
  const user = appended ? join(base.user, profile.user) : base.user;
  return { system, user, origin: { from, appended, fingerprint: fingerprint({ system, user }) } };
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
  return `${base}${o.appended ? " + endpoint's addition" : ""}`;
}

// ---------------------------------------------------------------------------------------------
// Checks

/** The longest a message's template may be, and a book's notes. Every character is sent, and billed, with every request. */
export const PROMPT_MAX_CHARS = 20_000;
export const NOTES_MAX_CHARS = 4_000;

/** What stops a book's notes from being saved. */
export function notesProblems(notes: string): string[] {
  return notes.length > NOTES_MAX_CHARS
    ? [
        `The notes are ${notes.length.toLocaleString("en")} characters; the most is ${NOTES_MAX_CHARS.toLocaleString("en")}.`,
      ]
    : [];
}

/**
 * What stops a template from being saved. `whole` is a template that is a prompt on its own (the
 * library's, an endpoint's or a book's replacement); `append` is an endpoint's addition, which may
 * be empty and must not bring a second excerpt.
 */
export function promptProblems(t: PromptTemplate, kind: "whole" | "append"): string[] {
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
  if (kind === "whole") {
    if (inSystem) problems.push("{{excerpt}} goes in the user message, not the system prompt.");
    if (inUser === 0)
      problems.push("The user message must include {{excerpt}}, the text to script.");
    if (inUser > 1)
      problems.push("{{excerpt}} may appear only once: the model would copy it twice.");
  } else if (inUser + inSystem)
    problems.push(
      "An addition must not include {{excerpt}}: the prompt it adds to already has it.",
    );
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
 * What stops an endpoint's say over the prompt from being saved: a replacement is a prompt on its
 * own, an addition must not bring a second excerpt, and the texts a `default` endpoint keeps for
 * later are sent nowhere, so only their length is held against them.
 */
export function profilePromptProblems(p: ProfilePrompt): string[] {
  if (p.mode === "replace") return promptProblems(p, "whole");
  if (p.mode === "append") return promptProblems(p, "append");
  return lengthProblems(p);
}

/**
 * The same for a book's: its notes always, its texts as a whole prompt only while it is switched
 * on. A replacement that is off is kept as it was typed, problems and all, since nothing is sent
 * from it — but not at any length.
 */
export function bookPromptProblems(p: BookPrompt): string[] {
  return [
    ...notesProblems(p.notes),
    ...(p.replace ? promptProblems(p, "whole") : lengthProblems(p)),
  ];
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
export function sampleVars(excerpt: string, endpoint: { name: string; model: string }): PromptVars {
  return {
    book: { title: "The Lamplighter", author: "A. N. Author", notes: "" },
    chapter: { title: "Connection test", number: 1 },
    part: 1,
    parts: 1,
    cast: [{ name: "Mara", gender: "f", aliases: [], description: "" }],
    excerpt,
    endpoint,
  };
}

/**
 * Roughly how many characters a request sends besides its excerpt: both messages rendered with an
 * empty excerpt, a cast of ten and a paragraph of notes, the output format included. For estimates
 * and budget holds, which are made before the cast and the chunks are known.
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
    endpoint: { name: "An endpoint", model: "a-model-id" },
  };
  const r = renderPrompt(t, vars);
  return r.system.length + r.user.length;
}
