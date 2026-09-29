// The page's credential registry, put back as it was found after every test. Preloaded by
// `bunfig.toml`.
//
// `@/lib/credentials` is module state that starts as the demo's registry, and the endpoints store
// refills it in place from whatever server it reads — so a store test against a server of its own,
// which holds no credentials, empties it. The demo world is seeded from it, so under a serial
// `bun test` every file after that one opened a demo with no credentials and its endpoints pointing
// at none. `--parallel` gives each file a process of its own and hid it.
//
// A preload runs once per run serially, and its `afterAll` only after the last file, which is too
// late for the files in between; its `afterEach` runs after every test in every file, after the
// file's own. A test starts from the registry a freshly opened page would hold, whichever file ran
// before it.
import { afterEach } from "bun:test";

import { credentials, type Credential } from "@/lib/credentials";

const found: Credential[] = credentials.map((c) => ({ ...c }));
const asFound = JSON.stringify(found);

afterEach(() => {
  // most tests never touch it, and a refill would wake whatever still watches it for nothing
  if (JSON.stringify(credentials) === asFound) return;
  credentials.splice(0, credentials.length, ...found.map((c) => ({ ...c })));
});
