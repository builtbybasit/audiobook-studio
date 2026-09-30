# Audiobook Studio

A personal app for turning EPUBs into reviewed, multi-voice audiobooks. It runs on your own machine: a Vue 3 page in front of a Bun server that keeps the library in SQLite, sends work to the scripting and speech endpoints you configure, and writes real audio files.

Import → review contents → script → assign voices → narrate and review → export.

## Run locally

You need Node.js (for Vite), pnpm and Bun 1.4 or later. ffmpeg is optional; see [export](docs/exports.md).

```sh
pnpm install
pnpm dev
```

That starts the API on :8787 and the frontend beside it, proxying `/api` to it. Open the URL Vite prints, normally `http://localhost:5173`. Every server setting has a working default, so no `.env` is needed; [.env.example](.env.example) lists them.

A fresh library has no books and no endpoints, so nothing is sent anywhere until you add one. The **Simulated (free)** preset on the Endpoints page adds an endpoint the server answers itself (a script read from the prose's punctuation, a quiet tone per line), with no network and no charge. For real narration, pick a provider preset and paste its key. The key is saved on the server and never sent back to the page.

`pnpm dev:server` and `pnpm dev:web` start the two halves on their own. All commands are in [development](docs/development.md).

## What it does

- **Library and contents:** reads real EPUBs, one or more files per book as volumes, and flags notices, schedules and author notes for you to skip or keep before anything is added.
- **Scripting:** a chat model splits each chapter into lines with a speaker, type and direction, held word for word against the prose. Site boilerplate and translator's notes are marked rather than cut, so they stay in the script but are left out of the audio (notes are read only if the book asks for them), and a detector suggests the lines the model got wrong. You can edit lines, split and join them, correct speakers in bulk, keep checkpoints, and compare or restore earlier versions. The prompt is editable per library, per endpoint and per book.
- **Cast and voices:** speakers across the book, merges, a pronunciation dictionary, pacing, and voices fetched from or cloned on the speech endpoint.
- **Narration and review:** narration renders a clip per line on the endpoint that owns the speaker's voice. You can flag and retake clips and compare takes; clips the script or dictionary has moved under are marked stale.
- **Export:** builds an audiobook as one file, one per volume or one per chapter, updates it by carrying over unchanged chapters, and keeps the previous version until the new one lands.
- **Endpoints and spending:** a usage ledger of every request with its receipt, rate cards with schedules and promotions, per-book budgets, and concurrency and rate-limit handling per endpoint.
- **Script transfer:** exports a book's script, cast and voice samples as a file, and imports one into another copy of the book.

## The demo

The header's **Demo** chip opens a seeded demo library in the current tab: four books in every state worth seeing, and every endpoint simulated. It is a second library on the same server, with its own database, so nothing done there touches yours and nothing is billed. Its drawer offers repeatable situations (a failed run, missing voices, a spent budget, an export that needs updating…), the speed of simulated work, and a reset. See [the demo](docs/demo.md).

## Where things are kept

The server keeps everything the page shows: your library in `data/library.db` with clips, audiobooks and voice samples under `data/`, and the demo in `data/demo.db` and `data/demo/`. A job that was running when the server stopped is picked up again when it starts. The browser keeps only a few view preferences; see [state that survives a reload](docs/development.md#state-that-survives-a-reload).

## Documentation

| If you want to…                                              | Read                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Navigate the app, import a book or review its contents       | [Library and workflow](docs/workflow.md)                                       |
| Correct scripts, use history or rerun completed chapters     | [Scripting, history and bulk reruns](docs/scripting.md)                        |
| Review retakes, configure expressions or understand playback | [Audio review and playback](docs/audio.md)                                     |
| Plan, build or update an audiobook                           | [Export](docs/exports.md)                                                      |
| Export a book's script, or import one into another copy      | [Script export and import](docs/script-transfer.md)                            |
| Configure endpoints or inspect queue activity                | [Endpoints and queue](docs/endpoints.md)                                       |
| Understand billing units, discounts, cache usage and budgets | [Pricing and usage](docs/pricing.md)                                           |
| Try a situation without paying for AI calls                  | [Seeded demo and walkthroughs](docs/demo.md)                                   |
| Understand how the server works and why                      | [Backend](docs/backend.md)                                                     |
| Serve a local speech model the app can send batches to       | [Batch speech API](docs/speech-batch-api.md)                                   |
| Work on the code, run checks or follow UI conventions        | [Development](docs/development.md) and [store ownership](src/stores/README.md) |
| Understand earlier design choices                            | [Design history](docs/design-history.md)                                       |
