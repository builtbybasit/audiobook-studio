// Reading a character page for a voice profile (`server/voices/wiki.ts`): a wiki page through its
// API with its Lore and Voice-Overs subpages, cut from recorded Honkai: Star Rail pages; any other
// page as plain text. Never the network.
import { describe, expect, test } from "bun:test";

import type { FetchLike } from "@/services/http";
import { PAGE_MAX, readPage } from "~/voices/wiki";

const live = () => new AbortController().signal;

const MAIN = `{{Character Tabs}}
{{Character Infobox
|id             = 1314
|image          = <gallery>
Character Jade Splash Art.png|Splash Art
</gallery>
|realname       = Eve (implied)<ref group="Note">She signs the name "Eve".</ref><br />Lady Bonajade
|vaEN           = [[imdb:nm3788571|Faye Mata]]<ref name="bili-jade">[https://www.bilibili.com/x Reveal]</ref>
|vaJP           = {{w|Kotono Mitsuishi|Mitsuishi Kotono ({{ja|三石琴乃}})}}
}}
{{Description|"Wealth is the recipe to happiness."<ref name="reveal">Twitter.</ref>}}
'''Jade''', also known as '''Lady Bonajade''', is a playable [[character]] in ''[[Honkai: Star Rail]]''.

A cold and elegant moneylender, she is skilled at understanding the human heart.

==Combat Info==
{{Skill Table}}

[[de:Jade]]`;

const LORE = `{{Project|Story Pages}}
==Character Introduction==
{{Description|She's willing to wait patiently for high-value acquisitions.}}

==Appearance ==
Jade is a tall woman with back-length, wavy pink hair.

==Character Stories==
In the Silverchain Galaxy, a rare ion storm approached.

==Trivia==
* Jade has the following aliases.`;

const VOICE = `{{VO/Data Bank
|character           = Jade
${Array.from(
  { length: 16 },
  (_, i) =>
    `|vo_${i}_title = Line ${i}\n|vo_${i}_tx             = Spoken line ${i} &mdash; for a price.`,
).join("\n")}
}}`;

const SUBPAGES = [
  "Jade/Change History",
  "Jade/Lore",
  "Jade/Voice-Overs",
  "Jade/Voice-Overs/Chinese",
];

/** The recorded wiki: parse answers by page, allpages by prefix; everything asked is kept. */
function wiki(): { fetch: FetchLike; asked: string[] } {
  const asked: string[] = [];
  const pages: Record<string, string> = {
    Jade: MAIN,
    "Jade/Lore": LORE,
    "Jade/Voice-Overs": VOICE,
  };
  const fetch: FetchLike = async (input) => {
    asked.push(input);
    const url = new URL(input);
    expect(url.origin + url.pathname).toBe("https://honkai-star-rail.fandom.com/api.php");
    const q = url.searchParams;
    if (q.get("list") === "allpages")
      return Response.json({ query: { allpages: SUBPAGES.map((title) => ({ title })) } });
    const page = q.get("page")!;
    return Response.json(
      page in pages
        ? { parse: { title: page, wikitext: pages[page] } }
        : { error: { code: "missingtitle", info: "The page you specified doesn't exist." } },
    );
  };
  return { fetch, asked };
}

describe("reading a character page", () => {
  test("a wiki page keeps names, voices, the intro and voice lines, and leaves the story out", async () => {
    const { fetch, asked } = wiki();
    const text = await readPage("https://honkai-star-rail.fandom.com/wiki/Jade", live(), fetch);

    expect(text).toContain("realname: Eve (implied); Lady Bonajade");
    expect(text).toContain("vaEN: Faye Mata");
    expect(text).toContain("vaJP: Mitsuishi Kotono");
    expect(text).toContain('"Wealth is the recipe to happiness."');
    expect(text).toContain(
      "Jade, also known as Lady Bonajade, is a playable character in Honkai: Star Rail.",
    );
    expect(text).toContain("She's willing to wait patiently");
    expect(text).toContain("- Spoken line 0 — for a price.");
    expect(text.match(/^- Spoken line/gm)).toHaveLength(15);
    for (const gone of [
      "Silverchain",
      "pink hair",
      "aliases",
      "<ref",
      "{{",
      "[[",
      "Splash Art",
      "de:Jade",
    ])
      expect(text).not.toContain(gone);
    // only the useful direct subpages are read
    expect(
      asked
        .filter((u) => u.includes("action=parse"))
        .map((u) => new URL(u).searchParams.get("page")),
    ).toEqual(["Jade", "Jade/Lore", "Jade/Voice-Overs"]);
  });

  test("any other page is its text, without scripts, cut to size", async () => {
    const html = `<html><head><title>T</title><script>evil()</script></head><body>
      <h1>Mara</h1><p>A <a href="/x">gravel</a>-voiced captain.</p><p>${"word ".repeat(3000)}</p></body></html>`;
    const fetch: FetchLike = async () =>
      new Response(html, { headers: { "content-type": "text/html" } });
    const text = await readPage("https://example.test/people/mara", live(), fetch);
    expect(text).toStartWith("Mara\n\nA gravel-voiced captain.");
    expect(text).not.toContain("evil");
    expect(text.length).toBeLessThanOrEqual(PAGE_MAX);
  });

  test.each([
    ["ftp://example.test/mara", () => new Response(""), /only http and https/],
    ["not a url", () => new Response(""), /not a web address/],
    ["https://example.test/mara", () => new Response("gone", { status: 404 }), /answered 404/],
    [
      "https://example.test/huge",
      () => new Response("x", { headers: { "content-length": String(5_000_000) } }),
      /too big/,
    ],
  ])("%s is refused with a reason", async (url, answer, reason) => {
    await expect(readPage(url, live(), async () => answer())).rejects.toThrow(reason);
  });
});
