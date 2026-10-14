// Points `TMPDIR` at one fresh root per test file (the server's folders included) and removes it
// after, so runs don't leave thousands of folders for Spotlight. Preloaded by `bunfig.toml`; under
// `--parallel` a preload runs once per file.
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
