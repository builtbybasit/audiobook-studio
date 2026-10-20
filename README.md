# Audiobook Studio

Turn an EPUB into a full-cast audiobook, with a different voice for every character, on your own machine.

**Import → pick chapters → script → cast voices → narrate → review → export M4B/MP3**

## Features

### 📚 Import and contents

- Reads real EPUBs. A book can be several files, each one a volume.
- Flags notices, schedules and author notes so you can skip or keep them before anything is added.
- Handles long web serials (900 chapters, 300 speakers).

### ✍️ AI scripting

- A chat model splits each chapter into lines, each with a **speaker, type and delivery direction**, and checks the result word for word against the prose.
- Works with any OpenAI-compatible API, or with **Claude Code / Codex** under your own login (run with no tools, in an empty folder).
- Keeps a recap per chapter and running cast notes, so later chapters know who is who. Picks up personas and aliases.
- Marks site boilerplate and translator's notes (it never deletes them). Neither is read aloud unless you turn notes on.
- A detector second-guesses the site-text and note marks: story marked as boilerplate, or boilerplate left as story. You can edit, split and join lines, fix speakers in bulk, and use checkpoints with diff and restore.
- The prompt can be edited per library, per endpoint and per book. You can try it on one chunk first.

### 🎭 Cast and voices

- Every speaker in the book in one place: merge duplicates, set aliases, assign voices.
- Fetch voices from a provider, or **clone** one from an uploaded sample. The sample can be trimmed on a waveform and auto-transcribed.
- Voice effects (Pedalboard presets) for thoughts, masks, phones, telepathy and so on, set per line or per character.
- Pronunciation dictionary, pacing, expression tags (`[laughter]`) and inline `[[pause]]` markers.

### 🎙️ Narration and review

- Renders one clip per line on the endpoint that owns the speaker's voice, with concurrency, retries and rate-limit handling.
- Speech providers: **ElevenLabs, Fish Audio, OpenAI, Gemini, MiniMax, Cartesia, Qwen, Breeze**, plus any OpenAI-compatible server. Local servers can render many lines per request with the [batch speech API](docs/speech-batch-api.md).
- Flag a clip, retake it and compare takes side by side. Nothing replaces the clip in the book until you choose.
- **Check by ear**: a speech-to-text endpoint listens to every clip and flags lines whose audio says something else.
- Clips go stale when the script or dictionary changes, and **Re-narrate changed** renders only what moved.
- A Listen page plays the book with word-by-word highlighting.

### 📦 Export

- M4B with chapter marks, or MP3. One file, one per volume, or one per chapter.
- Loudness is levelled (−18 LUFS by default) across voices from different providers.
- Versioned builds: when the book changes, an export shows exactly what's out of date. The old version stays until the new one lands.
- Script transfer: export a book's script, cast and voice samples, and import them into another copy.

### 🖥️ Local servers

- Any endpoint can name a folder and a start command. The app starts that server when a request needs it and stops it when the app quits.
- Mark servers that need most of the GPU **Heavy**: only one heavy server runs at a time. The app switches once the running one has had nothing to do for a few seconds, so a chapter's lines for one server all go before the switch. Light servers (a CPU model) run beside anything.
- Start, Stop, status and the server's last output are on the endpoint's Connection tab. A server you started yourself is used as it is and never stopped.

### 💸 Costs you can see

- Every request is in a usage ledger with its own receipt.
- Rate cards with schedules and promotions, cost estimates before a run, and per-book budgets.

### 🧪 Demo mode

The **Demo** chip in the header opens a seeded library: four books at different stages, every endpoint simulated, nothing billed. Its drawer sets up repeatable situations (a failed run, missing voices, a spent budget, a stale export), changes the speed of simulated work, and resets the demo.

## Run it

Needs Node.js, Bun ≥ 1.4 and ffmpeg.

```sh
bun install
bun run dev     # API on :8787, web on :5173
```

No `.env` is required. [.env.example](.env.example) lists the defaults. A fresh library has no endpoints, so nothing is sent anywhere until you add one. Pick **Simulated (free)** to try the app offline, or a provider preset and paste its key. Keys stay on the server.

Everything lives in `data/`: `library.db`, clips, audiobooks and samples. The demo uses `data/demo.db`. Jobs that were running when the server stopped resume when it starts again.

## Known limits

- Endpoints in one quota group don't share a daily limit yet.
- Gemini speech is WAV only; ElevenLabs has no Opus.
- OpenAI `gpt-4o-mini-tts` audio cost assumes 25 audio tokens per second, because OpenAI publishes no figure.
- Undoing an endpoint's removal brings it back without its key.
- An export update re-encodes every chapter.
- Changes made in another tab show up on the next save or refresh.

## Develop

| Command                          | Does                                  |
| -------------------------------- | ------------------------------------- |
| `bun run dev:server` / `dev:web` | Start one half                        |
| `vp check`                       | Format, lint, type check              |
| `bun run test`                   | Bun tests                             |
| `bun run test:live`              | Live provider tests (needs `.env`)    |
| `bun run db:generate`            | Drizzle migration from schema changes |
| `bun run build`                  | Type check and build the frontend     |

Stack: Vue 3 + Pinia Colada + Vite+ in front of a Hono server on Bun, with SQLite through Drizzle.
