// What the server writes down, and what it must never write down.
//
// The redaction list is the reason the logger is a module rather than a bare `pino()` call, so it
// is the part with the most tests: a credential reaching a log line is in a file, a scrollback and
// possibly a log shipper, and no amount of care at the call site is a guarantee the way a rule at
// the logger is.
import { describe, expect, test } from "bun:test";

import { createLogger } from "~/log";
import { COLOUR, NO_COLOUR, colourWanted, visibleWidth } from "~/log/colour";
import { formatRecord, prettyStream } from "~/log/pretty";
import { epubFile, story } from "../support/epub";
import { testApi } from "../support/server";

/** A logger that keeps its lines, so a test can read what was written. */
function captured(level = "trace") {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    level,
    format: "json",
    out: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { log, lines };
}

const pretty = (record: Record<string, unknown>) =>
  formatRecord(record, { palette: NO_COLOUR, cwd: "/repo" });

describe("what must never reach a log line", () => {
  test("a credential is redacted wherever it sits", () => {
    const { log, lines } = captured();
    log.info(
      {
        token: "sk-fish-realkey",
        endpoint: { key: "sk-openai-realkey", label: "OpenAI (main)" },
        headers: { authorization: "Bearer sk-realkey" },
        book: "moonlight-ledger",
      },
      "a request",
    );
    const written = JSON.stringify(lines[0]);
    expect(written).not.toContain("sk-fish-realkey");
    expect(written).not.toContain("sk-openai-realkey");
    expect(written).not.toContain("Bearer sk-realkey");
    // and the rest of the object still says what happened
    expect(written).toContain("moonlight-ledger");
    expect(written).toContain("OpenAI (main)");
  });

  test("an endpoint spread into a record does not leak the key it carries", () => {
    // The shape somebody writes without thinking: `log.info({ ...endpoint }, "…")`
    const { log, lines } = captured();
    const endpoint = { id: "openai", label: "OpenAI", token: "sk-real", secret: "s3cret" };
    log.info({ ...endpoint }, "dispatched");
    expect(JSON.stringify(lines[0])).not.toContain("sk-real");
    expect(JSON.stringify(lines[0])).not.toContain("s3cret");
    expect(lines[0].id).toBe("openai");
  });

  test("a request's authorization header is not written down", async () => {
    const api = testApi();
    await api.request("/api/books", { headers: { authorization: "Bearer sk-real" } });
    expect(JSON.stringify(api.logs)).not.toContain("sk-real");
  });
});

describe("what the server records about an import", () => {
  test("a file that was read says what was in it", async () => {
    const api = testApi();
    await api.import(
      await epubFile({
        chapters: [
          { title: "One", paragraphs: story(1) },
          { title: "Two", paragraphs: story(1) },
        ],
      }),
    );
    const read = api.logs.find((l) => l.msg === "read the file");
    expect(read?.chapters).toBe(2);
    expect(read?.words).toBeGreaterThan(0);
    expect(read?.name).toBe("import");
  });

  test("an import that half worked says so, rather than looking like one that worked", async () => {
    const api = testApi();
    await api.import(
      await epubFile({
        chapters: [
          { title: "One", paragraphs: story(1) },
          { title: "Two", missing: true },
        ],
      }),
    );
    const line = api.logs.find((l) => l.msg === "some chapters could not be read");
    expect(line?.level).toBe(40);
    expect(line?.unreadable).toBe(1);
  });

  test("a refusal records why, including what the validator found", async () => {
    const api = testApi();
    await api.import(new File(["not a zip"], "notes.epub"));
    const line = api.logs.find((l) => l.msg === "refused the file");
    expect(line?.level).toBe(40);
    expect(String(line?.epubcheck)).toContain("PKG-004");
  });

  test("every request is recorded with what it was and what came back, and a 404 as a warning", async () => {
    const api = testApi();
    await api.request("/api/books/nope");
    const line = api.logs.find((l) => (l.res as { status?: number })?.status === 404);
    expect((line?.req as { method?: string })?.method).toBe("GET");
    // hono-pino calls anything with an error on the context an error; "no such book" is an answer,
    // and a warning, so the red lines mean something
    expect(line?.level).toBe(40);
  });
});

describe("the line a person reads", () => {
  test("a request reads as what was asked for and what came back", () => {
    const line = pretty({
      level: 30,
      time: Date.now(),
      req: { method: "GET", url: "/api/books" },
      res: { status: 200 },
      ms: 1.2,
    });
    expect(line).toContain("INFO");
    expect(line).toContain("GET /api/books → 200");
    expect(line).toContain("ms=1.2");
  });

  test("a named logger says which part of the server is talking", () => {
    expect(pretty({ level: 40, time: Date.now(), name: "import", msg: "refused" })).toContain(
      "import · refused",
    );
  });

  test("a line written during a request says what it said, not where it was", () => {
    // It carries `req` like every line in that request does. Rendering it as a request line would
    // replace what it actually reported with the path it happened to be on.
    const line = pretty({
      level: 40,
      time: Date.now(),
      req: { method: "POST", url: "/api/books/import" },
      name: "import",
      msg: "refused the file",
      file: "notes.epub",
    });
    expect(line).toContain("import · refused the file");
    expect(line).not.toContain("POST /api/books/import");
  });

  test("an error brings its stack, with this repository's paths made readable", () => {
    const line = pretty({
      level: 50,
      time: Date.now(),
      msg: "refused",
      err: {
        type: "EpubParseError",
        message: "could not be opened",
        stack:
          "EpubParseError: could not be opened\n    at parseEpub (/repo/server/epub/parse.ts:271:11)",
      },
    });
    expect(line).toContain("EpubParseError: could not be opened");
    expect(line).toContain("server/epub/parse.ts:271  parseEpub");
    expect(line).not.toContain("/repo/server");
  });

  test("a line the formatter cannot read is passed through rather than lost", () => {
    // Losing a log line to the log formatter is the worst trade available
    const lines: string[] = [];
    const stream = prettyStream({ palette: NO_COLOUR, out: (s) => lines.push(s) });
    stream.write("not a record {\n");
    expect(lines).toEqual(["not a record {\n"]);
    // and a record it can read is still formatted, through the logger that uses it
    const log = createLogger({
      level: "info",
      format: "pretty",
      colour: false,
      out: (s) => lines.push(s),
    });
    log.info("plain");
    expect(lines[1]).toContain("INFO");
    expect(lines[1]).toContain("plain");
  });

  test("a level and a value are coloured, and the colour is not counted as width", () => {
    const coloured = formatRecord(
      { level: 30, time: Date.now(), msg: "listed", books: 4 },
      { palette: COLOUR },
    );
    expect(coloured).toContain("\u001B[");
    // the padding maths has to ignore escapes, or every line with colour drifts
    expect(visibleWidth(coloured)).toBeLessThan(coloured.length);
  });
});

describe("when to colour at all", () => {
  test("a terminal gets colour and a pipe does not", () => {
    expect(colourWanted({}, true)).toBe(true);
    expect(colourWanted({}, false)).toBe(false);
  });

  test("NO_COLOR wins, whatever it is set to", () => {
    expect(colourWanted({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colourWanted({ NO_COLOR: "0" }, true)).toBe(false);
    // the convention is presence, not truthiness — but an empty value is not presence
    expect(colourWanted({ NO_COLOR: "" }, true)).toBe(true);
  });

  test("FORCE_COLOR is for a CI that renders ANSI without being a terminal", () => {
    expect(colourWanted({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(colourWanted({ FORCE_COLOR: "0" }, true)).toBe(true);
    expect(colourWanted({ TERM: "dumb" }, true)).toBe(false);
  });
});
