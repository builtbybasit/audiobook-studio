// The command-line scripting provider, against a fake `codex` and `claude` on disk: the command
// line and stdin each is run with, the answer read and checked as a chat answer is, what reaches
// the ledger, and every way a run can end — cancelled, timed out, not found, refused.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Book, Profile, PromptTrialResult } from "@/types";
import { SCRIPTING_PRESETS } from "@/lib/presets";
import { newProfile } from "@/lib/scripting";
import { cliScriptingProvider } from "~/providers/cliScripting";
import { endpointScriptingProvider } from "~/providers/endpointScripting";
import { ProviderError } from "~/providers/http";
import type { ScriptInput, ScriptTarget } from "~/providers/scripting";
import type { SentScript } from "~/providers/sent";
import { endpointRequests } from "~/usage/ledger";
import { epubFile, story } from "../support/epub";
import { claudeResult, codexEvents, fakeCli } from "../support/fakeCli";
import { jsonBody, testApi } from "../support/server";

const TEXT = "The door opened. “Come in,” said Mara softly.";
const SCRIPT = JSON.stringify({
  lines: [
    { type: "narration", speaker: "Narrator", text: "The door opened." },
    { type: "dialogue", speaker: "Mara", text: "Come in,", direction: "softly" },
    { type: "narration", speaker: "Narrator", text: "said Mara softly." },
  ],
});
const DROPPED = JSON.stringify({ lines: [{ type: "narration", text: "The door opened." }] });
const PROMPT = { system: "You script audiobooks.", user: `Excerpt:\n${TEXT}` };

const target = (baseUrl: string, over: Partial<ScriptTarget> = {}): ScriptTarget => ({
  id: "cli",
  name: "My CLI",
  baseUrl,
  model: "some-model",
  apiKey: null,
  needsKey: false,
  timeoutSec: 20,
  maxRetries: 1,
  cooldownSec: 0,
  maxOutputTokens: 0,
  ...over,
});

const provider = cliScriptingProvider({ backoffMs: () => 0 });

function input(t: ScriptTarget, over: Partial<ScriptInput> = {}) {
  const sent: SentScript[] = [];
  return {
    sent,
    input: {
      title: "One",
      text: TEXT,
      signal: new AbortController().signal,
      target: t,
      cast: ["Narrator"],
      prompt: PROMPT,
      sent: (r: SentScript) => sent.push(r),
      ...over,
    } satisfies ScriptInput,
  };
}

const flagOf = (argv: string[], name: string): string | undefined => argv[argv.indexOf(name) + 1];

describe("Codex", () => {
  test("is run locked down in an empty folder, its instructions replaced by the prompt, and its last message read", async () => {
    const cli = fakeCli("codex", { stdout: codexEvents(), answer: SCRIPT });
    const { input: given, sent } = input(target(`codex:${cli.path}`, { reasoning: "medium" }));
    const answer = await provider.script(given);
    expect(answer.lines.map((l) => l.speaker)).toEqual(["Narrator", "Mara", "Narrator"]);

    const [call] = cli.calls();
    expect(call.argv.slice(0, 3)).toEqual(["exec", "--model", "some-model"]);
    expect(call.argv).toContain('model_reasoning_effort="medium"');
    for (const flag of ["--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--json"])
      expect(call.argv).toContain(flag);
    expect(flagOf(call.argv, "--sandbox")).toBe("read-only");
    expect(flagOf(call.argv, "--disable")).toBe("shell_tool");
    // the same folder, though macOS names it through /private
    expect(call.cwd).toEndWith(flagOf(call.argv, "--cd")!);
    expect(call.argv.at(-1)).toBe("-");
    expect(call.argv.some((a) => a.includes("dangerously"))).toBe(false);
    // the system prompt replaces Codex's own instructions, from a file in the run's folder
    expect(call.files).toEqual(["system.txt"]);
    expect(call.system).toBe(PROMPT.system);
    // the folder went with the run
    expect(existsSync(call.cwd)).toBe(false);
    expect(call.stdin).toBe(PROMPT.user);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ status: "done", attempts: 1, simulated: false });
    expect(sent[0].usage).toMatchObject({
      inputTokens: 1200,
      cachedInput: 1000,
      outputTokens: 300,
      reasoningTokens: 40,
    });
  });

  test("off is sent as none, and no level sends no effort at all", async () => {
    const cli = fakeCli("codex", { stdout: codexEvents(), answer: SCRIPT });
    await provider.script(input(target(`codex:${cli.path}`, { reasoning: "off" })).input);
    await provider.script(input(target(`codex:${cli.path}`)).input);
    const [off, none] = cli.calls();
    expect(off.argv).toContain('model_reasoning_effort="none"');
    expect(none.argv.join(" ")).not.toContain("model_reasoning_effort");
  });

  test("a model the login refuses says so, and is not tried again", async () => {
    const refused = JSON.stringify({
      type: "turn.failed",
      error: {
        message: JSON.stringify({
          type: "error",
          status: 400,
          error: {
            message:
              "The 'gpt-6.1-luna' model is not supported when using Codex with a ChatGPT account.",
          },
        }),
      },
    });
    const cli = fakeCli("codex", { stdout: refused + "\n", exit: 1 });
    const { input: given, sent } = input(target(`codex:${cli.path}`, { model: "gpt-6.1-luna" }));
    const error = await provider.script(given).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain("refused the model “gpt-6.1-luna”");
    expect((error as Error).message).toContain("not supported when using Codex with a ChatGPT");
    expect(cli.calls()).toHaveLength(1);
    expect(sent[0]).toMatchObject({ status: "failed", attempts: 1 });
  });

  test("not signed in says what to run", async () => {
    const cli = fakeCli("codex", {
      stdout:
        JSON.stringify({
          type: "turn.failed",
          error: { message: "unexpected status 401 Unauthorized" },
        }) + "\n",
      exit: 1,
    });
    const error = await provider.script(input(target(`codex:${cli.path}`)).input).catch((e) => e);
    expect((error as Error).message).toContain("is not signed in. Run `codex login`");
    expect(cli.calls()).toHaveLength(1);
  });
});

describe("Claude Code", () => {
  test("gets the system prompt as its own and the user message on stdin, with no tools", async () => {
    const cli = fakeCli("claude", { stdout: claudeResult(SCRIPT) });
    const { input: given, sent } = input(target(`claude-code:${cli.path}`, { reasoning: "high" }));
    const answer = await provider.script(given);
    expect(answer.lines).toHaveLength(3);

    const [call] = cli.calls();
    expect(call.argv.slice(0, 5)).toEqual([
      "--print",
      "--output-format",
      "json",
      "--model",
      "some-model",
    ]);
    expect(flagOf(call.argv, "--effort")).toBe("high");
    expect(flagOf(call.argv, "--tools")).toBe("");
    expect(flagOf(call.argv, "--permission-mode")).toBe("dontAsk");
    for (const flag of ["--no-session-persistence", "--safe-mode", "--strict-mcp-config"])
      expect(call.argv).toContain(flag);
    expect(call.argv.some((a) => a.includes("dangerously") || a === "--bare")).toBe(false);
    expect(call.system).toBe(PROMPT.system);
    expect(call.files).toEqual(["system.txt"]);
    expect(call.stdin).toBe(PROMPT.user);
    expect(existsSync(call.cwd)).toBe(false);

    // the tokens it reported, Anthropic-shaped, and not the API price it quotes beside them
    expect(sent[0].usage).toMatchObject({
      inputTokens: 1200,
      cacheWrite: 1000,
      outputTokens: 300,
      reasoningTokens: 25,
    });
    expect(sent[0].usage?.reportedCost).toBeUndefined();
  });

  test("off is sent as low, since it cannot turn thinking off", async () => {
    const cli = fakeCli("claude", { stdout: claudeResult(SCRIPT) });
    await provider.script(input(target(`claude-code:${cli.path}`, { reasoning: "off" })).input);
    expect(flagOf(cli.calls()[0].argv, "--effort")).toBe("low");
  });

  test("not logged in says what to run, and is not tried again", async () => {
    const cli = fakeCli("claude", {
      stdout: claudeResult("Not logged in · Please run /login", { is_error: true }),
      exit: 1,
    });
    const error = await provider
      .script(input(target(`claude-code:${cli.path}`)).input)
      .catch((e) => e);
    expect((error as Error).message).toContain("is not signed in. Run `claude` in a terminal");
    expect(cli.calls()).toHaveLength(1);
  });

  test("an answer that dropped the prose is refused, and kept for the Activity tab", async () => {
    const cli = fakeCli("claude", { stdout: claudeResult(DROPPED) });
    const { input: given, sent } = input(target(`claude-code:${cli.path}`));
    const error = await provider.script(given).catch((e) => e);
    expect((error as Error).message).toContain("did not copy the text faithfully");
    expect(sent[0]).toMatchObject({ status: "failed", error: { body: DROPPED } });
    expect(sent[0].usage?.outputTokens).toBe(300);
  });

  test("a lenient request (a prompt trial) hands back what fails the word check", async () => {
    const cli = fakeCli("claude", { stdout: claudeResult(DROPPED) });
    const answer = await provider.script(
      input(target(`claude-code:${cli.path}`), { lenient: true }).input,
    );
    expect(answer.lines).toHaveLength(1);
  });
});

describe("a run that does not answer", () => {
  test("a failure it names no reason for is tried again, then reported with its exit code", async () => {
    const cli = fakeCli("codex", { stderr: "something broke", exit: 2 });
    const { input: given, sent } = input(target(`codex:${cli.path}`, { maxRetries: 2 }));
    const error = await provider.script(given).catch((e) => e);
    expect((error as Error).message).toContain("failed (exit code 2): something broke");
    expect(cli.calls()).toHaveLength(3);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ status: "failed", attempts: 3 });
  });

  test("a retry that answers is one request, answered", async () => {
    const cli = fakeCli(
      "codex",
      { stderr: "stream disconnected", exit: 1 },
      { stdout: codexEvents(), answer: SCRIPT },
    );
    const { input: given, sent } = input(target(`codex:${cli.path}`));
    expect((await provider.script(given)).lines).toHaveLength(3);
    expect(sent).toEqual([expect.objectContaining({ status: "done", attempts: 2 })]);
  });

  test("the endpoint's timeout kills a run that takes too long", async () => {
    const cli = fakeCli("codex", { sleepMs: 10_000, answer: SCRIPT });
    const { input: given, sent } = input(
      target(`codex:${cli.path}`, { timeoutSec: 0.5, maxRetries: 0 }),
    );
    const started = Date.now();
    const error = await provider.script(given).catch((e) => e);
    expect((error as Error).message).toContain("did not answer within 0.5 s");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(sent[0]).toMatchObject({ status: "failed" });
  });

  test("a cancel kills the tool and what it started, and rejects with the job's reason", async () => {
    const cli = fakeCli("claude", { sleepMs: 10_000, child: true });
    const stop = new AbortController();
    const { input: given, sent } = input(target(`claude-code:${cli.path}`), {
      signal: stop.signal,
    });
    const running = provider.script(given).catch((e) => e);
    // wait for it to start its child
    for (let i = 0; i < 100 && !existsSync(join(cli.dir, "child.pid")); i++)
      await new Promise((r) => setTimeout(r, 50));
    const reason = new Error("cancelled by test");
    stop.abort(reason);
    expect(await running).toBe(reason);
    expect(sent).toEqual([expect.objectContaining({ status: "cancelled" })]);
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(cli.childPid(), 0)).toThrow();
  });

  test("a tool that is not there says so, and nothing is reported", async () => {
    const { input: given, sent } = input(target("codex:/nowhere/codex"));
    const error = await provider.script(given).catch((e) => e);
    expect((error as Error).message).toContain("Codex CLI was not found");
    expect(sent).toHaveLength(0);

    // nor one on a PATH that has none
    const empty = mkdtempSync(join(tmpdir(), "empty-path-"));
    const bare = cliScriptingProvider({ env: { PATH: empty } });
    const missing = await bare.script(input(target("claude-code:")).input).catch((e) => e);
    expect((missing as Error).message).toContain("no `claude` on the server's PATH");
  });

  test("with no program named, the one on PATH is run", async () => {
    const cli = fakeCli("claude", { stdout: claudeResult(SCRIPT) });
    const onPath = cliScriptingProvider({ env: { ...process.env, PATH: cli.dir } });
    expect((await onPath.script(input(target("claude-code:")).input)).lines).toHaveLength(3);
    expect(cli.calls()).toHaveLength(1);
  });
});

describe("the Test button", () => {
  test("answers ok with who spoke, and never throws on a refusal", async () => {
    const said = JSON.stringify({
      lines: [
        { type: "narration", text: "The lamp guttered in the draught." },
        { type: "dialogue", speaker: "Mara", text: "Is someone there?" },
        { type: "narration", text: "Mara whispered." },
      ],
    });
    const ok = fakeCli("codex", { stdout: codexEvents(), answer: said });
    const probe = await provider.probe!(target(`codex:${ok.path}`), new AbortController().signal);
    expect(probe.ok).toBe(true);
    expect(probe.message).toContain("spoken by Mara");
    expect(probe.message).toContain("40 reasoning tokens");

    const refused = await provider.probe!(
      target("claude-code:/nowhere/claude"),
      new AbortController().signal,
    );
    expect(refused).toMatchObject({ ok: false });
    expect(refused.message).toContain("was not found");
  });
});

describe("a CLI endpoint in the app", () => {
  test("a prompt trial through the Codex preset is recorded at no charge, with its tokens", async () => {
    // a trial is shown what came back whatever the word check says, so any script will do
    const cli = fakeCli("codex", { stdout: codexEvents(), answer: SCRIPT });
    const preset = SCRIPTING_PRESETS.find((p) => p.id === "codex-luna")!;
    const profile: Profile = newProfile({
      ...preset.apply,
      id: "codex",
      baseUrl: `codex:${cli.path}`,
      maxChars: 0,
    });
    const api = testApi({ scripting: endpointScriptingProvider({ backoffMs: () => 0 }) });
    const { body } = await api.import<{ book: Book }>(
      await epubFile({ title: "Ledger", chapters: [{ title: "One", paragraphs: story(2) }] }),
    );
    const id = body.book.id;
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    const saved = await api.request("/api/endpoints", {
      ...jsonBody({ endpoints: [], profiles: [profile], credentials: [] }),
      method: "PUT",
    });
    expect(saved.status).toBe(200);

    const prompt = await api.request<{ system: string; user: string }>(
      `/api/books/${id}/script-trial`,
      jsonBody({ profile: "codex", chapterId: 1 }),
    );
    expect(prompt.status).toBe(200);
    // the trial's user message: the chapter's chunk, not a stand-in
    expect(cli.calls()[0].stdin).toContain("Excerpt:");

    const rows = endpointRequests(api.db, "scripting", "codex", 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "done", cost: 0, usage: { inputTokens: 1200 } });
    expect((prompt.body as unknown as PromptTrialResult).cost).toBe(0);
  });
});
