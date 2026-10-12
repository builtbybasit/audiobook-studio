// A scripting provider that runs an AI command-line tool on this computer — Codex (`codex exec`) or
// Claude Code (`claude -p`) — instead of calling an API, signed in with the tool's own login.
//
// The request is the one a chat-completions model is sent (`renderPrompt`), and the answer is read
// and checked word for word the same way (`checkedScript`): only the way there differs. Claude Code
// and Codex are both given the system prompt as their own — Claude Code's `--system-prompt-file`,
// Codex's `model_instructions_file`, which replaces its agent instructions (about 10k tokens of
// how to work in a repository, which also made it drop words) — and the user message on stdin.
//
// **Locked down.** Each run is in a fresh empty folder, removed after: Codex runs in it read-only
// with its shell and every other tool it can switch off switched off, ignoring the user's own
// config and rules; Claude Code runs with no tools at all, nobody to ask for a permission, and
// none of the user's CLAUDE.md, skills, hooks, plugins or MCP servers (`--safe-mode`, which keeps
// the login; `--bare` would not). Neither saves the session. No `--dangerously-*` flag is passed.
//
// **Usage.** A subscription has no price per token, so a request is priced on the endpoint's card
// like any other — which the presets leave at no charge — with the tokens the tool reported:
// Codex's `turn.completed` event, Claude Code's `usage`. Claude Code's `total_cost_usd` is what the
// tokens would have cost on the API, not what the subscription charged, so it is not carried.
//
// The endpoint's timeout is each run's wall clock and its retries apply as they do to an HTTP call:
// a run that timed out or failed for no reason it names is tried again, one that names a reason
// another run will not change (not signed in, a model it refuses, a flag it does not know) is not.
// A cancel kills the tool and everything it started, at once.
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
  /** the environment the tool runs in; the server's own otherwise */
  env?: NodeJS.ProcessEnv;
}

/**
 * Codex features that reach outside the conversation, switched off for every run. `codex features
 * list` names them; one Codex no longer knows fails the run with "Unknown feature flag".
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
];

/** What one run is: the command line, what goes on stdin, and a file it needs written first. */
interface Invocation {
  argv: string[];
  stdin: string;
  files: Record<string, string>;
}

/** The command line for `target`'s tool, run in `dir`. Exported for the tests. */
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
        "--output-last-message",
        join(dir, ANSWER_FILE),
        "-",
      ],
      stdin: prompt.user,
      files: { [SYSTEM_FILE]: prompt.system },
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

/** The most of what a tool printed worth putting in a message. */
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

/** How long a killed tool is given to stop before it and its children are killed outright. */
const GRACE_MS = 2000;

/**
 * Run `argv` in `dir` with `stdin`, until it exits, `timeoutMs` passes, or `signal` aborts —
 * either of which kills it and every process it started (it leads a process group of its own).
 * Rejects with the spawn's own error when the program could not be started at all.
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
      // the end of it is what says what went wrong; a chatty tool's log is not kept whole
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
    signal.addEventListener("abort", kill, { once: true });
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
      // whatever it started may outlive it; a run leaves nothing behind
      if (hard) group("SIGKILL");
      clearTimeout(hard);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Reading what came back

/** What a run said: the final message, or why there is none, and the tokens it reported. */
interface Outcome {
  content: string | null;
  /** why there is no message: the tool's own words, and the status it gave them where it did */
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

/**
 * A refusal as Codex passes it on: the API's own JSON as a string, `{"status":400,"error":
 * {"message":…}}`, or plain words.
 */
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

/** Codex's `--json` events and the last message it wrote to the answer file. */
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

/** Claude Code's one JSON result. */
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
  // `total_cost_usd` is left behind: it is the API's price for the tokens, not the subscription's
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

/** A failure the tool named, as an error a person can act on, and whether to try again. */
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

/**
 * The provider for a profile whose base URL names a command-line tool (`cliOf`). Refuses a run
 * with no profile, and one whose base URL names no tool, before anything is run.
 */
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
      if (signal.aborted) {
        if (attempt > 1) report(null, "cancelled");
        throw signal.reason;
      }
      const dir = await mkdtemp(join(tmpdir(), "audiobook-cli-"));
      let failed: ProviderError;
      let usage: TokenUsage | null = null;
      try {
        const call = invocation(cli, target, prompt, dir);
        for (const [name, body] of Object.entries(call.files))
          await writeFile(join(dir, name), body);
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
          // never started, so nothing ran and nothing is reported
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
              // refused for what it said, so keep what it said for the Activity tab
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
