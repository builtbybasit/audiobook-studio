// A stand-in for `codex` or `claude` on disk, so the command-line scripting provider can be run
// end to end without calling a model.
//
// `fakeCli("codex")` writes an executable named `codex` into a fresh folder. Run, it notes what it
// was given — its arguments, its stdin, its working folder and what was in it, the system prompt
// file it was pointed at — and answers with the next of the replies it was handed: what to print,
// what to write as Codex's last message, how long to take, what to exit with. The last reply
// answers every call after it.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeReply {
  stdout?: string;
  stderr?: string;
  /** Codex only: written where `--output-last-message` says */
  answer?: string;
  exit?: number;
  /** how long it takes before answering */
  sleepMs?: number;
  /** start a `sleep 30` of its own first, to see it is killed with its parent */
  child?: boolean;
}

export interface FakeCall {
  argv: string[];
  stdin: string;
  cwd: string;
  /** what was in the working folder when it started */
  files: string[];
  /** the file `--system-prompt-file` named, read */
  system: string | null;
}

const SCRIPT = (dir: string): string => `#!${process.execPath}
const fs = require("node:fs");
const dir = ${JSON.stringify(dir)};
const replies = JSON.parse(fs.readFileSync(dir + "/replies.json", "utf8"));
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
const stdin = fs.readFileSync(0, "utf8");
const system = flag("--system-prompt-file");
const log = dir + "/calls.jsonl";
const n = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length : 0;
fs.appendFileSync(log, JSON.stringify({
  argv, stdin, cwd: process.cwd(), files: fs.readdirSync(process.cwd()),
  system: system ? fs.readFileSync(system, "utf8") : null,
}) + "\\n");
const reply = replies[Math.min(n, replies.length - 1)];
if (reply.child) {
  const c = require("node:child_process").spawn("sleep", ["30"], { stdio: "ignore" });
  fs.writeFileSync(dir + "/child.pid", String(c.pid));
}
await new Promise((r) => setTimeout(r, reply.sleepMs ?? 0));
const out = flag("--output-last-message");
if (out && reply.answer != null) fs.writeFileSync(out, reply.answer);
if (reply.stdout) process.stdout.write(reply.stdout);
if (reply.stderr) process.stderr.write(reply.stderr);
process.exit(reply.exit ?? 0);
`;

export function fakeCli(name: "codex" | "claude", ...replies: FakeReply[]) {
  const dir = mkdtempSync(join(tmpdir(), "fake-cli-"));
  const path = join(dir, name);
  writeFileSync(join(dir, "replies.json"), JSON.stringify(replies.length ? replies : [{}]));
  writeFileSync(path, SCRIPT(dir));
  chmodSync(path, 0o755);
  return {
    dir,
    path,
    /** every call so far, in order */
    calls(): FakeCall[] {
      const log = join(dir, "calls.jsonl");
      return existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as FakeCall)
        : [];
    },
    /** the pid of the child a `child` reply started */
    childPid(): number {
      return Number(readFileSync(join(dir, "child.pid"), "utf8"));
    },
  };
}

/** Codex's `--json` events for a turn that answered, with the usage it reports. */
export const codexEvents = (
  usage = {
    input_tokens: 1200,
    cached_input_tokens: 1000,
    output_tokens: 300,
    reasoning_output_tokens: 40,
  },
): string =>
  [
    { type: "thread.started", thread_id: "t1" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "…" } },
    { type: "turn.completed", usage: { cache_write_input_tokens: 0, ...usage } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n";

/** Claude Code's `--output-format json` result. */
export const claudeResult = (result: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    total_cost_usd: 0.25,
    api_error_status: null,
    usage: {
      input_tokens: 200,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 0,
      output_tokens: 300,
      output_tokens_details: { thinking_tokens: 25 },
    },
    ...over,
  });
