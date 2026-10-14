// The command-line scripting provider against the real Codex and Claude Code, opt-in:
// `LIVE=1 bun test tests/live`. Each runs on the tool's own login (the user's subscription), so one
// excerpt each; a tool not on PATH is skipped. `CLI_CODEX_MODEL` / `CLI_CLAUDE_MODEL` override
// the presets' models.
import { describe, expect, test } from "bun:test";

import { CLAUDE_CODE, CODEX, type CliShape } from "@/lib/providers/cli";
import { cliScriptingProvider } from "~/providers/cliScripting";
import type { ScriptTarget } from "~/providers/scripting";
import { EXCERPT, expectTheInn, printScript } from "../support/liveExcerpt";

const env = process.env;

const TOOLS: [CliShape, string, ScriptTarget["reasoning"]][] = [
  [CODEX, env.CLI_CODEX_MODEL ?? "gpt-6-luna", "high"],
  [CLAUDE_CODE, env.CLI_CLAUDE_MODEL ?? "claude-sonnet-5-5", "medium"],
];

for (const [cli, model, reasoning] of TOOLS)
  describe.skipIf(!env.LIVE || !Bun.which(cli.program))(`${cli.label}, for real`, () => {
    const target: ScriptTarget = {
      id: "live",
      name: `Live ${cli.label}`,
      baseUrl: cli.scheme,
      model,
      apiKey: null,
      needsKey: false,
      timeoutSec: 600,
      maxRetries: 0,
      cooldownSec: 5,
      maxOutputTokens: 0,
      reasoning,
    };

    test(
      "scripts an excerpt word for word, with its speakers named",
      async () => {
        const started = performance.now();
        const { lines, cast, recap } = await cliScriptingProvider().script({
          title: "The Inn at the Ford",
          text: EXCERPT,
          signal: new AbortController().signal,
          target,
          cast: ["Narrator", "Mara"],
          // what it used, and what it said when that was refused
          sent: (r) => console.log("usage:", JSON.stringify(r.usage), r.error?.body ?? ""),
        });
        printScript(performance.now() - started, lines, cast, recap);
        expectTheInn(lines);
      },
      { timeout: 660_000 },
    );

    test(
      "answers the Test button",
      async () => {
        const result = await cliScriptingProvider().probe!(target, new AbortController().signal);
        console.log(result);
        expect(result.ok).toBe(true);
      },
      { timeout: 660_000 },
    );
  });
