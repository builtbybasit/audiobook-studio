// A real scripting model, opt-in: `LIVE=1 bun test tests/live`. The target comes from
// `SCRIPTING_PROVIDER_URL`, `_MODEL`, `_KEY` and `_REASONING` in `.env` (this test only; the app
// reads endpoints from its table). One excerpt, one request, the answer printed to judge by eye.
import { describe, expect, test } from "bun:test";

import type { ReasoningEffort } from "@/types";
import { endpointScriptingProvider } from "~/providers/endpointScripting";
import type { ScriptTarget } from "~/providers/scripting";
import { EXCERPT, expectTheInn, printScript } from "../support/liveExcerpt";

const env = process.env;

describe.skipIf(!env.LIVE || !env.SCRIPTING_PROVIDER_URL)("a real scripting model", () => {
  const target: ScriptTarget = {
    id: "live",
    name: "Live scripting model",
    baseUrl: (env.SCRIPTING_PROVIDER_URL ?? "").replace(/\/+$/, ""),
    model: env.SCRIPTING_PROVIDER_MODEL ?? "",
    apiKey: env.SCRIPTING_PROVIDER_KEY || null,
    needsKey: false,
    // a command-line tool starts up and thinks before it answers
    timeoutSec: 600,
    maxRetries: 1,
    cooldownSec: 5,
    // none: a reasoning model spends part of any cap thinking, and this gateway counts that too
    maxOutputTokens: 0,
    reasoning: (env.SCRIPTING_PROVIDER_REASONING as ReasoningEffort | undefined) || null,
  };

  test(
    "scripts an excerpt word for word, with its speakers named",
    async () => {
      const started = performance.now();
      const { lines, cast, recap } = await endpointScriptingProvider().script({
        title: "The Inn at the Ford",
        text: EXCERPT,
        signal: new AbortController().signal,
        target,
        cast: ["Narrator", "Mara"],
      });
      printScript(performance.now() - started, lines, cast, recap);
      expectTheInn(lines);
    },
    { timeout: 660_000 },
  );

  test(
    "answers the Test button",
    async () => {
      const result = await endpointScriptingProvider().probe!(target, new AbortController().signal);
      console.log(result);
      expect(result.ok).toBe(true);
    },
    { timeout: 660_000 },
  );
});
