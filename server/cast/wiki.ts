// A speaker's blank age, gender and voice type from their fan wiki page, as tags only. Pages are
// written from the whole series, so a page found under another title is left alone (the title can
// name a hidden identity), disguises are skipped, and the model is told to keep to first sight.
import type { Gender, SpeakerWikiFill } from "@/types";
import type { FetchLike } from "@/services/http";
import { AGES } from "@/lib/cast";
import { tokenEstimate } from "@/lib/scripting";
import { DELIVERIES, PITCHES, TEXTURES } from "@/lib/voiceProfile";
import type { Db } from "~/db/client";
import { getCharacter } from "~/db/cast";
import { readProfiles } from "~/db/endpoints";
import { getBook } from "~/db/library";
import { notFound } from "~/lib/errors";
import { ageOf, genderOf, voiceTypeOf } from "~/providers/chatScripting";
import { ProviderError } from "~/providers/http";
import type { ScriptingProvider } from "~/providers/scripting";
import { scriptTarget } from "~/providers/target";
import { budgetProblem } from "~/usage/budget";
import { dispatch } from "~/usage/dispatch";
import { api, readPage, TIMEOUT_MS } from "~/voices/wiki";

export interface WikiFillRequest {
  name: string;
  /** scripting profile id */
  profile: string;
  url?: string;
}

const OTHER_TITLE = "Its page is under another name, so it was left alone (spoilers)";

const SYSTEM = [
  "You read a fan wiki page about a character in a novel and tag how they should sound in an audiobook.",
  "The listener has not read the book. Describe the character as first introduced: never a later age after a time skip, a true identity, a later form or a fate.",
  "gender: only when the page states it, else null.",
  `age: ${AGES.join(", ")}, or null when unknown.`,
  `voiceType: pitch (${PITCHES.join(", ")}) within their gender, texture (${TEXTURES.join(", ")}), up to 3 delivery words from: ${DELIVERIES.join(", ")}. Null for anything the page does not suggest.`,
  "Answer only with the JSON object.",
].join("\n");

const nullable = (list: readonly string[]) => ({ type: ["string", "null"], enum: [...list, null] });
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gender", "age", "voiceType"],
  properties: {
    gender: nullable(["male", "female", "non-binary"]),
    age: nullable(AGES),
    voiceType: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["pitch", "texture", "delivery"],
      properties: {
        pitch: nullable(PITCHES),
        texture: nullable(TEXTURES),
        delivery: { type: "array", items: { type: "string", enum: [...DELIVERIES] } },
      },
    },
  },
};

const fold = (title: string): string =>
  title
    .replace(/[_\s]+/g, " ")
    .trim()
    .toLowerCase();

/** The page on `wiki` titled exactly one of `names`, or a note saying why there is none. */
async function lookUp(
  fetch: FetchLike,
  wiki: string,
  names: string[],
  signal: AbortSignal,
): Promise<{ url: string } | { note: string }> {
  const origin = new URL(wiki).origin;
  const url = new URL("/api.php", origin);
  // `|` separates titles and can't be in one
  const titles = names.filter((n) => !n.includes("|")).slice(0, 50);
  url.search = new URLSearchParams({
    action: "query",
    titles: titles.join("|"),
    redirects: "1",
    format: "json",
    formatversion: "2",
  }).toString();
  const within = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  let pages: { title: string; missing?: boolean; invalid?: boolean }[];
  try {
    const answer = await api<{ query?: { pages?: typeof pages } }>(fetch, url, within);
    pages = (answer.query?.pages ?? []).filter((p) => !p.missing && !p.invalid);
  } catch (e) {
    if (signal.aborted) throw e;
    return {
      note: `The wiki could not be asked: ${within.aborted ? "it took too long" : (e as Error).message}`,
    };
  }
  for (const name of titles.map(fold)) {
    const page = pages.find((p) => fold(p.title) === name);
    if (page) return { url: `${origin}/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}` };
  }
  return { note: pages.length ? OTHER_TITLE : `No page for ${names[0]} on this wiki` };
}

/** What a simulated profile answers: the shared words the page itself uses. */
function simulatedAnswer(page: string) {
  const said = <T extends string>(list: readonly T[]): T[] =>
    list.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(page));
  const gender = /\b(?:female|woman|girl)\b/i.test(page)
    ? "female"
    : /\b(?:male|man|boy)\b/i.test(page)
      ? "male"
      : null;
  return {
    gender,
    age: said(AGES)[0] ?? null,
    voiceType: {
      pitch: said(PITCHES)[0] ?? null,
      texture: said(TEXTURES)[0] ?? null,
      delivery: said(DELIVERIES).slice(0, 3),
    },
  };
}

export async function fillFromWiki(
  db: Db,
  scripting: ScriptingProvider,
  bookId: string,
  request: WikiFillRequest,
  signal: AbortSignal,
  fetch: FetchLike = (input, init) => globalThis.fetch(input, init),
): Promise<SpeakerWikiFill> {
  const book = getBook(db, bookId);
  if (!book) throw notFound("No such book");
  const c = getCharacter(db, bookId, request.name);
  if (!c) throw notFound(`“${request.name}” is not in this book’s cast`);
  const out: SpeakerWikiFill = { name: c.name, url: null, fill: {}, notes: [] };
  const done = (note: string): SpeakerWikiFill => (out.notes.push(note), out);

  if (c.personaOf || c.masked) return done("A disguise, so their page was left alone (spoilers)");
  const p = readProfiles(db).find((x) => x.id === request.profile);
  if (!p) return done(`There is no scripting endpoint “${request.profile}”`);
  if (!scripting.ask) return done(`${p.name} cannot read wiki pages`);

  let url = request.url?.trim();
  if (!url) {
    if (!book.wiki) return done("Set the book's wiki first");
    const found = await lookUp(fetch, book.wiki, [c.name, ...c.aliases], signal);
    if ("note" in found) return done(found.note);
    url = found.url;
  }
  let page: string;
  try {
    page = await readPage(url, signal, fetch, true);
  } catch (e) {
    if (signal.aborted) throw e;
    return done(`Page not read: ${(e as Error).message}`);
  }
  out.url = url;
  if (!page) return done("The page had nothing to read");

  const user = `Character: ${c.name}\n\nTheir wiki page:\n${page}`;
  const reserve = tokenEstimate(SYSTEM + user, p).reserve;
  const problem = budgetProblem(db, bookId, {
    kind: "scripting",
    cost: reserve,
    what: "this wiki fill",
    requests: [{ endpoint: p.id, cost: reserve }],
  });
  if (problem) return done(problem);
  const money = dispatch(db, {
    kind: "scripting",
    endpoint: p,
    work: { bookId, chapterUid: null, label: `Wiki · ${c.name}` },
    hold: reserve,
  });
  let answer: unknown;
  try {
    answer = await scripting.ask({
      system: SYSTEM,
      user,
      schema: SCHEMA,
      target: scriptTarget(db, p),
      signal,
      sent: (report) => void money.sent(report),
      simulated: simulatedAnswer(page),
    });
  } catch (e) {
    if (signal.aborted || !(e instanceof ProviderError)) throw e;
    return done(`Not read: ${e.message}`);
  } finally {
    money.release();
  }

  const said = (answer && typeof answer === "object" ? answer : {}) as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === "string" ? x : null);
  const gender: Gender = genderOf(text(said.gender));
  const age = ageOf(text(said.age));
  const voiceType = voiceTypeOf(said.voiceType);
  out.fill = {
    ...(gender !== "?" ? { gender } : {}),
    ...(age ? { age } : {}),
    ...(voiceType ? { voiceType } : {}),
  };
  if (!Object.keys(out.fill).length) out.notes.push("The page gave nothing to fill");
  return out;
}
