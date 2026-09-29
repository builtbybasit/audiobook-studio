// Every temporary folder a test makes lands in one root, removed when the file's tests are done.
// Preloaded by `bunfig.toml`.
//
// The tests make folders with `mkdtemp(tmpdir())` — libraries' audio, builds, voices, databases,
// ffmpeg's work — and never had anywhere to remove them, so each run left thousands behind for
// Spotlight to index. Pointing `TMPDIR` at a fresh root catches all of them, the server's own
// included, without each test tidying up after itself. A preload runs once per file under
// `--parallel` and once per run otherwise, and its `afterAll` runs after the tests it preceded.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "audiobook-tests-"));
process.env.TMPDIR = root;

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // a test that took a folder's permissions away can leave it behind; the OS clears the rest
  }
});
