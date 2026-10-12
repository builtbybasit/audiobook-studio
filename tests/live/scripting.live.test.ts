// The chat-completions provider against a real model, opt-in: `LIVE=1 bun test tests/live`.
//
// The target is built from `SCRIPTING_PROVIDER_URL`, `SCRIPTING_PROVIDER_MODEL` and
// `SCRIPTING_PROVIDER_TOKEN` in `.env` — for this test only; the app itself reads a profile's
// address and key from the endpoints table. One excerpt, one request, and the answer printed so a
// person can judge the attribution as well as the assertions.
import { describe, expect, test } from "bun:test";

import { chatScriptingProvider } from "~/providers/chatScripting";
import type { ScriptTarget } from "~/providers/scripting";
import { EXCERPT, expectTheInn, printScript } from "../support/liveExcerpt";

const env = process.env;

describe.skipIf(!env.LIVE || !env.SCRIPTING_PROVIDER_URL)("a real scripting model", () => {
  const target: ScriptTarget = {
    id: "live",
    name: "Live scripting model",
    baseUrl: (env.SCRIPTING_PROVIDER_URL ?? "").replace(/\/+$/, ""),
    model: env.SCRIPTING_PROVIDER_MODEL ?? "",
    apiKey: env.SCRIPTING_PROVIDER_TOKEN || null,
    needsKey: false,
    timeoutSec: 120,
    maxRetries: 1,
    cooldownSec: 5,
    // none: a reasoning model spends part of any cap thinking, and this gateway counts that too
    maxOutputTokens: 0,
  };

  test(
    "scripts an excerpt word for word, with its speakers named",
    async () => {
      const started = performance.now();
      const { lines, cast, recap } = await chatScriptingProvider().script({
        title: "The Inn at the Ford",
        text: EXCERPT,
        signal: new AbortController().signal,
        target,
        cast: ["Narrator", "Mara"],
      });
      printScript(performance.now() - started, lines, cast, recap);
      expectTheInn(lines);
    },
    { timeout: 180_000 },
  );

  test(
    "answers the Test button",
    async () => {
      const result = await chatScriptingProvider().probe!(target, new AbortController().signal);
      console.log(result);
      expect(result.ok).toBe(true);
    },
    { timeout: 180_000 },
  );
});
