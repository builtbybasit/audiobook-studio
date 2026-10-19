// Scripting through a local CLI, Codex (`codex exec`) or Claude Code (`claude -p`), on its own
// login. Same prompt and word check as chat (`checkedScript`); the system prompt replaces the
// tool's own instructions (Codex's ~10k tokens of them made it drop words). Each run is locked down
// in a fresh empty folder with no tools, user config or saved session. A cancel kills its group.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";

import type { RenderedPrompt, TokenUsage } from "@/types";
import { normalizeUsage } from "@/lib/pricing";
import { cliOf, type CliShape } from "@/lib/providers/cli";
import { builtInPrompt, checkedScript, NO_PROFILE, probeWith } from "~/providers/chatScripting";
import { sleep } from "~/providers/fake";
import { ProviderError, type CallOptions } from "~/providers/http";
import type { ScriptAnswer, ScriptTarget, ScriptingProvider } from "~/providers/scripting";
import type { SentScript } from "~/providers/sent";

export interface CliScriptingOptions {
  /** the wait before a retry, when a rate limit names none; tests make it 0 */
  backoffMs?: CallOptions["backoffMs"];
  env?: NodeJS.ProcessEnv;
}

/**
 * Codex features switched off for every run (`codex features list`). One Codex no longer knows
 * fails the run with "Unknown feature flag". The last three only cost tokens.
 */
const CODEX_OFF = [
  "shell_tool",
  "unified_exec",
  "apps",
  "browser_use",
  "computer_use",
  "image_generation",
  "memories",
  "multi_agent",
  "hooks",
  "plugins",
  "goals",
  "view_image",
  "sleep_tool",
];

/**
 * Codex's `--output-schema`: without it gpt-6-luna sometimes writes broken JSON. Strict, so every
 * field is required and an optional one is nullable; the parser reads null as absent.
 */
const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lines", "cast", "recap"],
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "speaker", "text", "direction", "effects"],
        properties: {
          type: { type: "string", enum: ["narration", "dialogue", "thought", "watermark", "note"] },
          speaker: { type: "string" },
          text: { type: "string" },
          direction: { type: ["string", "null"] },
          effects: { type: ["array", "null"], items: { type: "string" } },
        },
      },
    },
    cast: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "gender", "age", "aliases", "description", "personaOf"],
        properties: {
          name: { type: "string" },
          gender: { type: "string", enum: ["male", "female", "non-binary", "unknown"] },
          age: {
            type: "string",
            enum: ["child", "teen", "young adult", "middle-aged", "elderly", "unknown"],
          },
          aliases: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          personaOf: { type: ["string", "null"] },
        },
      },
    },
    recap: { type: "string" },
  },
};

interface Invocation {
  argv: string[];
  stdin: string;
  /** written into the run's folder first */
  files: Record<string, string>;
}

/** Exported for the tests. */
export function invocation(
  cli: CliShape & { path: string },
  target: ScriptTarget,
  prompt: RenderedPrompt,
  dir: string,
): Invocation {
  const program = cli.path || cli.program;
  const effort = target.reasoning ? cli.effort(target.reasoning).value : null;
  if (cli.id === "codex")
    return {
      argv: [
        program,
        "exec",
        "--model",
        target.model,
        ...(effort ? ["--config", `model_reasoning_effort="${effort}"`] : []),
        "--config",
        `model_instructions_file=${JSON.stringify(join(dir, SYSTEM_FILE))}`,
        "--config",
        'web_search="disabled"',
        // Drops Codex's agents section (~1.6k tokens) and skill catalogue (~2.5k).
        "--config",
        "agents.enabled=false",
        "--config",
        "skills.max_context_tokens=1",
        ...CODEX_OFF.flatMap((feature) => ["--disable", feature]),
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--cd",
        dir,
        "--json",
        "--output-schema",
        join(dir, SCHEMA_FILE),
        "--output-last-message",
        join(dir, ANSWER_FILE),
        "-",
      ],
      stdin: prompt.user,
      files: { [SYSTEM_FILE]: prompt.system, [SCHEMA_FILE]: JSON.stringify(ANSWER_SCHEMA) },
    };
  return {
    argv: [
      program,
      "--print",
      "--output-format",
      "json",
      "--model",
      target.model,
      ...(effort ? ["--effort", effort] : []),
      "--system-prompt-file",
      join(dir, SYSTEM_FILE),
      "--tools",
      "",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--no-session-persistence",
      "--safe-mode",
      "--disable-slash-commands",
    ],
    stdin: prompt.user,
    files: { [SYSTEM_FILE]: prompt.system },
  };
}

const ANSWER_FILE = "answer.txt";
const SYSTEM_FILE = "system.txt";
const SCHEMA_FILE = "schema.json";

const SAID_CHARS = 300;
const trimmed = (text: string): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > SAID_CHARS ? one.slice(0, SAID_CHARS) + "…" : one;
};

// ---------------------------------------------------------------------------------------------
// Running the tool

interface Ran {
  /** null when it was killed */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** SIGTERM to SIGKILL. */
const GRACE_MS = 2000;

/**
 * A timeout or abort kills the tool's whole process group. Rejects with the spawn's error when it
 * could not be started.
 */
function run(
  argv: string[],
  stdin: string,
  dir: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Ran & { timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: dir,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      // only the tail says what went wrong
      stderr = (stderr + d).slice(-20_000);
    });
    // a tool that exits before reading all of its input closes the pipe under the write
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
    const group = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        // already gone
      }
    };
    let hard: ReturnType<typeof setTimeout> | undefined;
    const kill = (): void => {
      group("SIGTERM");
      hard ??= setTimeout(() => group("SIGKILL"), GRACE_MS);
    };
    const clock = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    // a signal that fired before the spawn never fires again
    if (signal.aborted) kill();
    else signal.addEventListener("abort", kill, { once: true });
    const done = (): void => {
      clearTimeout(clock);
      signal.removeEventListener("abort", kill);
    };
    child.on("error", (e) => {
      done();
      clearTimeout(hard);
      reject(e);
    });
    child.on("close", (code) => {
      done();
      // what it started may outlive it
      if (hard) group("SIGKILL");
      clearTimeout(hard);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Reading what came back

interface Outcome {
  content: string | null;
  /** the tool's own words, and its status where it gave one */
  failure: { said: string; status: number } | null;
  usage: TokenUsage | null;
  reasoningTokens: number | null;
}

const CodexEvent = v.looseObject({
  type: v.string(),
  message: v.optional(v.unknown()),
  error: v.optional(v.looseObject({ message: v.optional(v.unknown()) })),
  usage: v.optional(
    v.looseObject({
      input_tokens: v.optional(v.number()),
      cached_input_tokens: v.optional(v.number()),
      cache_write_input_tokens: v.optional(v.number()),
      output_tokens: v.optional(v.number()),
      reasoning_output_tokens: v.optional(v.number()),
    }),
  ),
});

/** Codex passes a refusal on as `{"status":400,"error":{"message":…}}` in a string, or words. */
function codexSaid(message: string): { said: string; status: number } {
  try {
    const body = JSON.parse(message) as { status?: unknown; error?: { message?: unknown } };
    if (typeof body.error?.message === "string")
      return {
        said: body.error.message,
        status: typeof body.status === "number" ? body.status : 0,
      };
  } catch {
    // words, not JSON
  }
  const status = Number(message.match(/\bstatus (\d{3})\b/)?.[1] ?? 0);
  return { said: message, status };
}

function codexOutcome(ran: Ran, answer: string | null): Outcome {
  let usage: TokenUsage | null = null;
  let reasoningTokens: number | null = null;
  let failure: Outcome["failure"] = null;
  for (const line of ran.stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: v.InferOutput<typeof CodexEvent>;
    try {
      const read = v.safeParse(CodexEvent, JSON.parse(line));
      if (!read.success) continue;
      event = read.output;
    } catch {
      continue;
    }
    if (event.type === "turn.completed" && event.usage) {
      const u = event.usage;
      // the Responses API's input_tokens holds the cached ones, as the ledger's total does
      usage = normalizeUsage(
        {
          inputTokens: u.input_tokens,
          cachedInput: u.cached_input_tokens,
          cacheWrite: u.cache_write_input_tokens,
          outputTokens: u.output_tokens,
          reasoningTokens: u.reasoning_output_tokens,
        },
        "internal",
      );
      reasoningTokens = u.reasoning_output_tokens ?? null;
    } else if (event.type === "turn.failed" && typeof event.error?.message === "string")
      failure = codexSaid(event.error.message);
    else if (event.type === "error" && typeof event.message === "string" && !failure)
      failure = codexSaid(event.message);
  }
  if (ran.code === 0 && answer != null)
    return { content: answer, failure: null, usage, reasoningTokens };
  return {
    content: null,
    failure: failure ?? { said: ran.stderr || ran.stdout, status: 0 },
    usage,
    reasoningTokens,
  };
}

const ClaudeResult = v.looseObject({
  type: v.literal("result"),
  is_error: v.optional(v.boolean()),
  result: v.optional(v.string()),
  api_error_status: v.optional(v.nullable(v.number())),
  usage: v.optional(v.record(v.string(), v.unknown())),
});

function claudeOutcome(ran: Ran): Outcome {
  let read: v.SafeParseResult<typeof ClaudeResult> | null = null;
  try {
    read = v.safeParse(ClaudeResult, JSON.parse(ran.stdout));
  } catch {
    read = null;
  }
  if (!read?.success)
    return {
      content: null,
      failure: { said: ran.stderr || ran.stdout, status: 0 },
      usage: null,
      reasoningTokens: null,
    };
  const r = read.output;
  // `total_cost_usd` is the API's price, not the subscription's, so it is not carried
  const usage = r.usage ? normalizeUsage(r.usage, "anthropic") : null;
  const details = r.usage?.output_tokens_details as { thinking_tokens?: unknown } | undefined;
  const reasoningTokens =
    typeof details?.thinking_tokens === "number" ? details.thinking_tokens : null;
  if (usage) usage.reasoningTokens = reasoningTokens;
  if (r.is_error || ran.code !== 0)
    return {
      content: null,
      failure: { said: r.result || ran.stderr, status: r.api_error_status ?? 0 },
      usage,
      reasoningTokens,
    };
  return { content: r.result ?? "", failure: null, usage, reasoningTokens };
}

/** An actionable error; retryable only when another run could change the outcome. */
function refusal(
  cli: CliShape,
  target: ScriptTarget,
  failure: { said: string; status: number },
  code: number | null,
): ProviderError {
  const said = trimmed(failure.said);
  const { status } = failure;
  const who = `${target.name} (${cli.label})`;
  if (status === 401 || /not logged in|log ?in|unauthori[sz]ed|authenticat/i.test(said))
    return new ProviderError(
      `${who} is not signed in. ${cli.login} (It said: ${said})`,
      401,
      false,
    );
  if (
    status === 404 ||
    (/model/i.test(said) &&
      /not supported|not found|does not exist|may not exist|unrecognized|unknown|access/i.test(
        said,
      ))
  )
    return new ProviderError(
      `${who} refused the model “${target.model}”: ${said} Check the model ID on the Endpoints page.`,
      status || 400,
      false,
    );
  if (/usage limit|quota|credits/i.test(said))
    return new ProviderError(
      `${who} has used up what the subscription allows for now: ${said}`,
      429,
      false,
    );
  if (status === 429 || /rate limit|too many requests|overloaded/i.test(said))
    return new ProviderError(`${who} is rate limited: ${said}`, 429, true, true);
  if (/unknown feature|unexpected argument|unknown option|invalid value/i.test(said))
    return new ProviderError(
      `${who} did not accept the command line this app runs it with: ${said} Update the tool, or tell the app's developer.`,
      0,
      false,
    );
  return new ProviderError(
    `${who} failed${code != null ? ` (exit code ${code})` : ""}${said ? `: ${said}` : ""}`,
    status,
    status === 0 || status === 408 || status >= 500,
  );
}

// ---------------------------------------------------------------------------------------------
// The provider

const defaultBackoff: NonNullable<CallOptions["backoffMs"]> = (attempt, t) =>
  Math.min(t.cooldownSec * 1000, 500 * 2 ** (attempt - 1));

/** For a profile whose base URL names a CLI (`cliOf`). Retries and timeout work as for HTTP. */
export function cliScriptingProvider(options: CliScriptingOptions = {}): ScriptingProvider {
  const backoff = options.backoffMs ?? defaultBackoff;

  async function request(
    target: ScriptTarget,
    prompt: RenderedPrompt,
    text: string,
    signal: AbortSignal,
    sent?: (request: SentScript) => void,
    lenient = false,
  ): Promise<{ answer: ScriptAnswer; reasoningTokens: number | null }> {
    const cli = cliOf(target.baseUrl);
    if (!cli) throw new ProviderError(`${target.name} does not name a command-line tool`, 0, false);
    const attempts = 1 + Math.max(0, target.maxRetries);
    const startedAt = Date.now();
    let attempt = 0;
    let rateLimited = false;
    const report = (
      usage: TokenUsage | null,
      status: SentScript["status"],
      error?: ProviderError,
      body?: string,
    ): void =>
      sent?.({
        startedAt,
        finishedAt: Date.now(),
        attempts: Math.max(1, attempt),
        rateLimited,
        status,
        ...(error ? { error: { code: error.status, message: error.message, body } } : {}),
        simulated: false,
        usage,
      });

    for (;;) {
      attempt++;
      const dir = await mkdtemp(join(tmpdir(), "audiobook-cli-"));
      let failed: ProviderError;
      let usage: TokenUsage | null = null;
      try {
        const call = invocation(cli, target, prompt, dir);
        for (const [name, body] of Object.entries(call.files))
          await writeFile(join(dir, name), body);
        // after the awaits, so a cancel during them never starts the tool
        if (signal.aborted) {
          if (attempt > 1) report(null, "cancelled");
          throw signal.reason;
        }
        let ran: Ran & { timedOut: boolean };
        try {
          ran = await run(
            call.argv,
            call.stdin,
            dir,
            options.env ?? process.env,
            target.timeoutSec * 1000,
            signal,
          );
        } catch (e) {
          // never started, so nothing is reported
          const code = (e as NodeJS.ErrnoException).code;
          throw new ProviderError(
            code === "ENOENT"
              ? `${target.name}: ${cli.label} was not found — no \`${call.argv[0]}\` ${cli.path ? "at that path" : "on the server's PATH"}. Install it, or give its full path after “${cli.scheme}” on the Endpoints page.`
              : `${target.name}: ${cli.label} could not be started (${e instanceof Error ? e.message : String(e)})`,
            0,
            false,
          );
        }
        if (signal.aborted) {
          report(null, "cancelled");
          throw signal.reason;
        }
        if (ran.timedOut)
          failed = new ProviderError(
            `${target.name} did not answer within ${target.timeoutSec} s`,
            0,
            true,
          );
        else {
          const answer =
            cli.id === "codex"
              ? await readFile(join(dir, ANSWER_FILE), "utf8").catch(() => null)
              : null;
          const outcome = cli.id === "codex" ? codexOutcome(ran, answer) : claudeOutcome(ran);
          usage = outcome.usage;
          if (outcome.content != null) {
            try {
              const script = checkedScript(target.name, outcome.content, text, 200, lenient);
              report(usage, "done");
              return { answer: script, reasoningTokens: outcome.reasoningTokens };
            } catch (e) {
              // keep what a refused answer said, for the Activity tab
              if (e instanceof ProviderError) report(usage, "failed", e, outcome.content);
              throw e;
            }
          }
          failed = refusal(cli, target, outcome.failure!, ran.code);
          if (failed.rateLimited) rateLimited = true;
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      if (!failed.retryable || attempt >= attempts) {
        report(usage, "failed", failed);
        throw failed;
      }
      await sleep(
        failed.rateLimited ? target.cooldownSec * 1000 : backoff(attempt, target),
        signal,
      ).catch((e: unknown) => {
        report(usage, "cancelled");
        throw e;
      });
    }
  }

  return {
    name: "Command-line tools",
    callsProfile: true,
    async script({ title, text, signal, progress, target, cast, prompt, lenient, sent }) {
      if (!target) throw new ProviderError(NO_PROFILE, 0, false);
      progress?.(0, 1);
      const { answer } = await request(
        target,
        prompt ?? builtInPrompt(title, cast, text),
        text,
        signal,
        sent,
        lenient,
      );
      progress?.(1, 1);
      return answer;
    },
    probe: (target, signal, given) =>
      probeWith(target, signal, given, (prompt, text) => request(target, prompt, text, signal)),
  };
}
