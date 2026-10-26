// `POST /api/books/:id/characters/wiki`: a speaker's tags from their wiki page. Only a page titled
// by their name or an alias is read (a title elsewhere can name a hidden identity), disguises are
// skipped, and only tags come back. A recorded wiki and a simulated profile; never the network.
import { describe, expect, test } from "bun:test";

import type { Character, Profile, SpeakerWikiFill } from "@/types";
import { SIMULATED_BASE_URL, SIMULATED_SCRIPTING_MODEL } from "@/lib/providers";
import type { FetchLike } from "@/services/http";
import { fakeScriptingProvider } from "~/providers/fake";
import type { AskInput } from "~/providers/scripting";
import { endpointRequests } from "~/usage/ledger";
import { line } from "../support/epub";
import { jsonBody, speechEndpoint, testApi, voicedBook } from "../support/server";

const simulated: Profile = {
  id: "sim",
  name: "Simulated",
  model: SIMULATED_SCRIPTING_MODEL,
  baseUrl: SIMULATED_BASE_URL,
  inPrice: 2,
  outPrice: 8,
  enabled: true,
  concurrency: 1,
  maxChars: 0,
  splitAt: "sentence",
  maxOutputTokens: 2000,
  maxRetries: 0,
  secPerChunk: 0.01,
  needsKey: false,
};

const WIKI = "https://w.test";
// Mara's page is under her alias; "Tom" redirects to a title that gives him away
const CAPTAIN = `{{Infobox character
|name = The Captain
|age = young adult
|status = Deceased
}}
A calm captain of the fleet.

==Appearance==
A husky-voiced woman.

==History==
She betrays the crown in the last book.`;

function recorded(): { fetch: FetchLike; asked: string[] } {
  const asked: string[] = [];
  const fetch: FetchLike = async (input) => {
    asked.push(input);
    const url = new URL(input);
    if (url.origin !== WIKI) return new Response("<p>A cheerful girl, a teen.</p>");
    const q = url.searchParams;
    if (q.get("list") === "allpages") return Response.json({ query: { allpages: [] } });
    if (q.get("action") === "parse")
      return Response.json({ parse: { title: q.get("page"), wikitext: CAPTAIN } });
    const found: Record<string, string> = { "The Captain": "The Captain", Tom: "Lord Tom" };
    const pages = q
      .get("titles")!
      .split("|")
      .map((t) => (found[t] ? { title: found[t] } : { title: t, missing: true }));
    return Response.json({ query: { pages } });
  };
  return { fetch, asked };
}

async function setup(o: { wiki?: boolean } = {}) {
  const { fetch, asked } = recorded();
  const told: AskInput[] = [];
  const fake = fakeScriptingProvider();
  const api = testApi({
    scripting: { ...fake, ask: (input) => (told.push(input), fake.ask!(input)) },
    pageFetch: fetch,
  });
  const id = await voicedBook(api, {
    endpoints: [speechEndpoint()],
    paragraphs: [line("One"), line("Two", "Tom")],
    voiceOf: "studio/ash",
  });
  await api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [speechEndpoint()], profiles: [simulated], credentials: [] }),
    method: "PUT",
  });
  const { body } = await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`);
  const mara = body.characters.find((c) => c.name === "Mara")!;
  for (const c of [
    { ...mara, aliases: ["The Captain"] },
    { ...mara, name: "Veil", aliases: [], personaOf: "Mara" },
  ])
    await api.request(`/api/books/${id}/characters/${c.name}`, { ...jsonBody(c), method: "PUT" });
  if (o.wiki !== false)
    await api.request(`/api/books/${id}`, { ...jsonBody({ wiki: WIKI }), method: "PATCH" });
  const fill = (name: string, url?: string) =>
    api.request<SpeakerWikiFill>(
      `/api/books/${id}/characters/wiki`,
      jsonBody({ name, profile: "sim", url }),
    );
  return { api, id, asked, told, fill };
}

describe("filling a speaker from their wiki page", () => {
  test("reads the page titled by an alias and gives back tags only, priced into the book's ledger", async () => {
    const { api, id, told, fill } = await setup();
    const { status, body } = await fill("Mara");

    expect(status).toBe(200);
    expect(body).toEqual({
      name: "Mara",
      url: `${WIKI}/wiki/The_Captain`,
      fill: {
        gender: "f",
        age: "young adult",
        voiceType: { texture: "husky", delivery: ["calm"] },
      },
      notes: [],
    });
    // the model sees the appearance, never the story or the infobox's status
    expect(told[0].user).toContain("A husky-voiced woman.");
    expect(told[0].user).not.toContain("betrays");
    expect(told[0].user).not.toContain("Deceased");
    expect(endpointRequests(api.db, "scripting", "sim", 0)).toMatchObject([
      { bookId: id, label: "Wiki · Mara" },
    ]);
  });

  test.each([
    ["a page under another title", "Tom", {}, /under another name/],
    ["a disguise", "Veil", {}, /disguise/],
    ["a book with no wiki", "Mara", { wiki: false }, /Set the book's wiki first/],
  ])("%s is skipped with a note, and nothing is read", async (_, name, given, note) => {
    const { asked, told, fill } = await setup(given);
    const { status, body } = await fill(name);
    expect(status).toBe(200);
    expect(body.url).toBeNull();
    expect(body.fill).toEqual({});
    expect(body.notes.join("\n")).toMatch(note);
    expect(asked.some((u) => u.includes("action=parse"))).toBe(false);
    expect(told).toHaveLength(0);
  });

  test("a page given by address is read as it is, without asking the wiki", async () => {
    const { asked, fill } = await setup({ wiki: false });
    const url = "https://other.test/people/mara";
    const { body } = await fill("Mara", url);
    expect(body).toMatchObject({
      url,
      fill: { gender: "f", age: "teen", voiceType: { delivery: ["cheerful"] } },
    });
    expect(asked).toEqual([url]);
  });
});
