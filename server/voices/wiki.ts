// A character page as plain text for a voice profile. A MediaWiki page (Fandom included) is read
// through its API with its useful subpages (`/Lore`, `/Voice-Overs`): the infobox's names, gender
// and voice actors, the intro, personality sections and voice lines. Story, plot and history
// sections are left out (spoilers). Any other page is its HTML turned to text.
import type { FetchLike } from "@/services/http";
import { plainText, toMarkdown } from "~/epub/markdown";

export const PAGE_MAX = 8_000;
const BYTES_MAX = 2_000_000;
export const TIMEOUT_MS = 10_000;
const VOICE_LINES = 15;

const INFOBOX_KEYS =
  /^(name|title|titles|alias|aliases|nickname|realname|online_alias|gender|sex|va\w*|voice\w*)$/i;
const KEPT_SECTIONS = /introduction|description|personality|character details|profile/i;
/** what a speaker's tags also read: still an allowlist, so status, fate and kin never come in */
const LOOK_KEYS = /^age$/i;
const LOOK_SECTIONS = /appearance/i;
const KEPT_SUBPAGES = /^(lore|voice-overs|profile|personality)$/i;
/** templates whose last argument is prose worth keeping */
const UNWRAP = /^(description|quote|w)$/i;

const ENTITIES: Record<string, string> = {
  mdash: "—",
  ndash: "–",
  amp: "&",
  nbsp: " ",
  quot: '"',
  "#39": "'",
};

/** Wikitext as plain text: refs, comments, files and templates out; links and markup to words. */
export function wikiPlain(text: string): string {
  let s = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<gallery[^>]*>[\s\S]*?<\/gallery>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n");
  // innermost first, so a template inside another goes before its parent is read
  for (let before = ""; before !== s;) {
    before = s;
    s = s.replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => {
      const parts = inner.split("|");
      return UNWRAP.test(parts[0].trim()) && parts.length > 1
        ? parts.at(-1)!.replace(/^\s*\w+\s*=/, "")
        : "";
    });
  }
  return (
    s
      .replace(/\[\[(?:file|image|category):[^\]]*\]\]/gi, "")
      // interwiki (`[[de:Jade]]`) only: `[[Honkai: Star Rail]]` is a title
      .replace(/\[\[[a-z-]{2,12}:[^|\]\s][^|\]]*\]\]/g, "")
      .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
      .replace(/\[https?:\/\/\S+ ([^\]]+)\]/g, "$1")
      .replace(/\[https?:\/\/[^\]]*\]/g, "")
      .replace(/'{2,}/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&(mdash|ndash|amp|nbsp|quot|#39);/g, (_, e: string) => ENTITIES[e])
      .replace(/__[A-Z]+__/g, "")
      .replace(/\(\s*\)/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** The first infobox's names, gender and voice actors, a `Key: value` line each. */
function infobox(text: string, look: boolean): string[] {
  const start = text.search(/\{\{[^{}|]*infobox/i);
  if (start < 0) return [];
  let depth = 0;
  let end = start;
  while (end < text.length) {
    if (text.startsWith("{{", end)) {
      depth++;
      end += 2;
    } else if (text.startsWith("}}", end)) {
      end += 2;
      if (--depth === 0) break;
    } else end++;
  }
  return text
    .slice(start + 2, end - 2)
    .split(/\n\s*\|/)
    .slice(1)
    .flatMap((field) => {
      const at = field.indexOf("=");
      const key = field.slice(0, at).trim();
      const value = wikiPlain(field.slice(at + 1)).replace(/\n+/g, "; ");
      const kept = INFOBOX_KEYS.test(key) || (look && LOOK_KEYS.test(key));
      return at > 0 && kept && value ? [`${key}: ${value}`] : [];
    });
}

/** The text before the first heading, and every kept section with its subsections. */
function sections(text: string, look: boolean): string[] {
  const out: string[] = [];
  const parts = text.split(/^(=+)\s*(.+?)\s*\1\s*$/m);
  const intro = wikiPlain(parts[0]);
  if (intro) out.push(intro);
  let keptAt = 0;
  for (let i = 1; i < parts.length; i += 3) {
    const level = parts[i].length;
    const heading = parts[i + 1];
    if (keptAt && level <= keptAt) keptAt = 0;
    if (!keptAt && (KEPT_SECTIONS.test(heading) || (look && LOOK_SECTIONS.test(heading))))
      keptAt = level;
    const body = keptAt ? wikiPlain(parts[i + 2] ?? "") : "";
    if (body) out.push(`## ${heading}\n${body}`);
  }
  return out;
}

const voiceLines = (text: string): string[] =>
  [...text.matchAll(/^\|\s*vo_\w+?_tx\s*=(.+)$/gm)].map((m) => wikiPlain(m[1])).filter(Boolean);

/** The body as text, refused past `BYTES_MAX`. */
async function body(fetch: FetchLike, url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal, headers: { accept: "application/json, text/html" } });
  if (!res.ok) throw new Error(`the page answered ${res.status}`);
  if (Number(res.headers.get("content-length")) > BYTES_MAX) throw new Error("the page is too big");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > BYTES_MAX) throw new Error("the page is too big");
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function api<T>(fetch: FetchLike, url: URL, signal: AbortSignal): Promise<T> {
  const answer = JSON.parse(await body(fetch, url.href, signal)) as T & {
    error?: { info?: string };
  };
  if (answer.error) throw new Error(answer.error.info ?? "the wiki refused");
  return answer;
}

async function wikiPage(
  fetch: FetchLike,
  origin: string,
  title: string,
  signal: AbortSignal,
  look: boolean,
): Promise<string> {
  const call = (params: Record<string, string>) => {
    const url = new URL("/api.php", origin);
    url.search = new URLSearchParams({ format: "json", formatversion: "2", ...params }).toString();
    return url;
  };
  const parse = (page: string) =>
    api<{ parse: { title: string; wikitext: string } }>(
      fetch,
      call({ action: "parse", page, prop: "wikitext", redirects: "1" }),
      signal,
    ).then((a) => a.parse);
  const main = await parse(title);
  const listed = await api<{ query?: { allpages?: { title: string }[] } }>(
    fetch,
    call({ action: "query", list: "allpages", apprefix: `${main.title}/`, aplimit: "50" }),
    signal,
  ).catch(() => ({ query: { allpages: [] } }));
  const subpages = (listed.query?.allpages ?? [])
    .map((p) => p.title)
    .filter((t) => KEPT_SUBPAGES.test(t.slice(main.title.length + 1)));
  const pages = [main, ...(await Promise.all(subpages.map(parse)))];
  const lines = pages.flatMap((p) => voiceLines(p.wikitext)).slice(0, VOICE_LINES);
  return [
    `# ${main.title}`,
    ...infobox(main.wikitext, look),
    ...pages.flatMap((p) => sections(p.wikitext, look)),
    ...(lines.length ? [`## Voice lines\n${lines.map((l) => `- ${l}`).join("\n")}`] : []),
  ].join("\n\n");
}

/**
 * The page at `url` as text of at most `PAGE_MAX` characters. Throws a short reason: a bad
 * address, a refusal, a timeout or a page too big. `look` also keeps a wiki's Appearance and age.
 */
export async function readPage(
  url: string,
  signal: AbortSignal,
  fetch: FetchLike = (input, init) => globalThis.fetch(input, init),
  look = false,
): Promise<string> {
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    throw new Error("that is not a web address");
  }
  if (page.protocol !== "http:" && page.protocol !== "https:")
    throw new Error("only http and https pages can be read");
  const within = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  try {
    const wiki = page.pathname.match(/^\/wiki\/(.+)$/);
    const text = wiki
      ? await wikiPage(
          fetch,
          page.origin,
          decodeURIComponent(wiki[1]).replace(/_/g, " "),
          within,
          look,
        ).catch((e: unknown) => {
          if (within.aborted) throw e;
          return null;
        })
      : null;
    const read = text ?? plainText(await toMarkdown(await body(fetch, page.href, within)));
    return read.slice(0, PAGE_MAX).trim();
  } catch (e) {
    if (signal.aborted) throw e;
    if (within.aborted) throw new Error("the page took too long to answer");
    throw e;
  }
}
