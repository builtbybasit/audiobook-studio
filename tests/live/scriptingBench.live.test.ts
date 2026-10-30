// A bench for scripting models, opt-in: every `BENCH` model scripts every `LIVE_CASES` excerpt
// `BENCH_RUNS` times (10) in one pool of `BENCH_POOL` (24), and prints how many runs kept every
// word and speaker right, and why the others did not.
//   LIVE=1 BENCH="codex:|gpt-6-luna|high, claude-code:|claude-haiku-5-5|medium" bun test tests/live/scriptingBench
// An entry is `base URL|model|reasoning`; chat-completions takes `SCRIPTING_PROVIDER_KEY`.
// `BENCH_CASES` picks excerpts by id (`inn,letter`); `BENCH_PROMPT` names a `{"system","user"}`
// JSON file to send instead of the built-in prompt.
// Pool: BENCH_POOL, else SCRIPTING_PROVIDER_CONCURRENCY, else 24.
import { expect, test } from "bun:test";

import type { PromptTemplate, ReasoningEffort } from "@/types";
import { BUILT_IN_PROMPT, renderPrompt } from "@/lib/prompt";
import { endpointScriptingProvider } from "~/providers/endpointScripting";
import type { ScriptTarget } from "~/providers/scripting";
import { LIVE_CASES, problemsOf, type LiveCase } from "../support/liveExcerpt";
import { liveScriptingConcurrency } from "../support/liveScripting";

const env = process.env;
const RUNS = Number(env.BENCH_RUNS) || 10;
const POOL = Number(env.BENCH_POOL) || (env.LIVE ? liveScriptingConcurrency(env, 24) : 24);
const picked = env.BENCH_CASES?.split(",").map((s) => s.trim());
const cases = LIVE_CASES.filter((c) => !picked || picked.includes(c.id));
const template: PromptTemplate = env.BENCH_PROMPT
  ? await Bun.file(env.BENCH_PROMPT).json()
  : BUILT_IN_PROMPT;

const targets: ScriptTarget[] = (env.BENCH ?? "")
  .split(",")
  .filter((s) => s.trim())
  .map((entry) => {
    const [baseUrl, model = "", reasoning = ""] = entry.split("|").map((s) => s.trim());
    return {
      id: "bench",
      name: `${baseUrl} ${model}`,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      model,
      apiKey: env.SCRIPTING_PROVIDER_KEY || null,
      needsKey: false,
      timeoutSec: 600,
      maxRetries: 0,
      cooldownSec: 0,
      maxOutputTokens: 0,
      reasoning: (reasoning as ReasoningEffort) || null,
    };
  });

interface Run {
  ms: number;
  inputTokens: number;
  problems: string[];
}

async function once(target: ScriptTarget, c: LiveCase): Promise<Run> {
  const started = performance.now();
  let inputTokens = 0;
  try {
    const { lines, cast } = await endpointScriptingProvider().script({
      title: c.title,
      text: c.text,
      cast: c.cast,
      signal: new AbortController().signal,
      target,
      // the lines back even when words are lost, so the bench can say which
      lenient: true,
      prompt: renderPrompt(template, {
        book: { title: "", author: "", notes: "" },
        chapter: { title: c.title, number: 1 },
        part: 1,
        parts: 1,
        cast: c.cast.map((name) => ({
          name,
          personaOf: c.personas?.[name],
          masked: c.masked?.includes(name) || undefined,
        })),
        excerpt: c.text,
        endpoint: { name: target.name, model: target.model },
      }),
      sent: (r) => (inputTokens += r.usage?.inputTokens ?? 0),
    });
    return { ms: performance.now() - started, inputTokens, problems: problemsOf(c, lines, cast) };
  } catch (e) {
    return { ms: performance.now() - started, inputTokens, problems: [`error: ${String(e)}`] };
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test.skipIf(!env.LIVE || !targets.length)(
  "scripting bench",
  async () => {
    const jobs = targets.flatMap((target) =>
      cases.flatMap((c) => Array.from({ length: RUNS }, () => ({ target, c }))),
    );
    const done: (Run & { key: string })[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: POOL }, async () => {
        while (next < jobs.length) {
          const { target, c } = jobs[next++];
          const key = `${target.name} ${target.reasoning ?? ""} · ${c.id}`;
          done.push({ key, ...(await once(target, c)) });
        }
      }),
    );
    let failed = 0;
    for (const key of new Set(
      jobs.map((j) => `${j.target.name} ${j.target.reasoning ?? ""} · ${j.c.id}`),
    )) {
      const runs = done.filter((r) => r.key === key);
      const passed = runs.filter((r) => !r.problems.length).length;
      failed += runs.length - passed;
      console.log(
        `${key}: ${passed}/${runs.length}, ` +
          `median ${(median(runs.map((r) => r.ms)) / 1000).toFixed(1)} s, ` +
          `~${median(runs.map((r) => r.inputTokens))} input tokens`,
      );
      for (const r of runs) if (r.problems.length) console.log("  ✗", r.problems.join("; "));
    }
    expect(failed).toBe(0);
  },
  3_600_000,
);
