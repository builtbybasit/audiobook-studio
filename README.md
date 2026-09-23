# Audiobook Studio

A personal audiobook app for turning books into reviewed, multi-voice narration. This checkout is a **Vue 3 frontend prototype with a permanent seeded demo**: use it to test the workflow without paid AI requests. A backend has been started in [server/](server/): it reads real EPUBs, stores the library, runs scripting, narration and export as queued jobs, holds each chapter's script, its history and the book's cast, and writes audio files you can play and audiobooks you can download; endpoints and pricing are still simulated.

Import → review contents → script → assign voices → narrate and review → export.

## Run locally

Use Node.js, pnpm and Bun (the test runner). The repository includes `pnpm-lock.yaml`.

```sh
pnpm install
pnpm dev
```

That starts the API on :8787 and the frontend beside it, proxying `/api` to it, in one terminal. Open the URL Vite prints, normally `http://localhost:5173`. No provider credentials are needed: the server starts on fake models. See [development and verification](docs/development.md) for prerequisites and all commands.

`pnpm dev:server` and `pnpm dev:web` start the two halves on their own.

**The library, Scripting, Cast, Narration, Export and Queue screens use it.** `VITE_MODE=backend` selects the real services at the seam in [src/services/](src/services/), and the stores read and write through them: the shelf, the import, the contents review and removal are the server's; a chapter's prose is the one the EPUB contained; scripting a chapter queues a job the server runs, which writes the script, the speakers it found and a version in the chapter's history; editing a line, renaming a speaker or saving a checkpoint is a request; and the Queue page shows the server's jobs. Narrating a chapter renders a real audio file the player plays, and building an audiobook stitches those files into one you can download. Reads go through queries ([src/queries/](src/queries/), on Pinia Colada), which ask the server in that mode and the seeded world in the demo. In backend mode the library, the queue and the cast start empty rather than on the seeded shelf, because a real library is not something the demo can stand in for. Endpoints and pricing are still the seeded world in both modes, and the only speech and scripting models the server can be started with are fakes that never reach the network. What the server itself does is in [backend](docs/backend.md). The seeded demo (Vite without `VITE_MODE`) needs none of this.

## What works in this prototype

- **Library and Contents:** sample EPUB import, volume organization, chapter previews and decisions about notices or other non-story material.
- **Scripting and Cast:** endpoint configuration, script editing, speaker/voice assignments, pronunciation, expression annotations and bulk corrections.
- **Script history and reruns:** named checkpoints, preview/compare/restore, bulk re-scripting and re-narration that preserve usable results while replacements run.
- **Narration and Review:** simulated queues, failed clips, stale audio, flags, retake comparison and a list of decisions needing attention.
- **Endpoints and pricing:** request history and charts, concurrency, cached-token pricing, TTS billing models, schedules, promotions, budgets and recorded usage.
- **Export:** M4B/MP3 planning, file layouts, chapter marks, loudness previews and version/update workflows.

## What is simulated

In demo mode EPUB parsing, provider requests, generated audio, encoding, output files and loudness measurements are all simulated. (The backend parses EPUBs for real, writes real — if synthetic — audio files, and stitches them into real audiobooks on disk; with `EXPORT_ENCODER=ffmpeg` those are M4Bs with chapter marks and measured loudness. Pricing is simulated in both modes.) Configured rates drive simulated costs; provider names and prices in fixtures are examples, not current pricing guarantees. Seeded audio playback is timed rather than heard, and waveform previews are illustrative. Voice auditions may use the browser’s speech synthesis.

Books, edits, history, jobs and credentials are in memory and reset on reload. A few UI preferences persist in localStorage; see [state that survives a reload](docs/development.md#state-that-survives-a-reload).

## Try a workflow

Open **Demo** in the header. The drawer offers repeatable scenarios, suggested steps, simulation speed, a one-shot export failure and reset. Applying a scenario restores the seeded world first; reset discards session changes and abandons simulated work.

Start with a chapter with script history, a failed replacement, a book with missing voices, or an export that needs updating. The [demo guide](docs/demo.md) contains the scenario map and detailed walkthroughs.

**Keep this demo when the backend is added.** The first five backend slices — reading EPUBs and storing the library, a job queue that scripts chapters with a fake model, the script, history and cast a scripted chapter owns, narration that renders real audio files with a fake speech model, and export that stitches them into an audiobook on disk — are in [server/](server/); real-provider integration is still future work. The testing requirements are recorded in [future backend integration requirements](docs/demo.md#future-backend-integration-requirements).

## Documentation

| If you want to…                                              | Read                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Navigate the app, import a book or review its contents       | [Library and workflow](docs/workflow.md)                                       |
| Correct scripts, use history or rerun completed chapters     | [Scripting, history and bulk reruns](docs/scripting.md)                        |
| Review retakes, configure expressions or understand playback | [Audio review and playback](docs/audio.md)                                     |
| Plan, build or update an audiobook                           | [Export](docs/exports.md)                                                      |
| Configure endpoints or inspect queue activity                | [Endpoints and queue](docs/endpoints.md)                                       |
| Understand billing units, discounts, cache usage and budgets | [Pricing and usage](docs/pricing.md)                                           |
| Reproduce a situation without paying for AI calls            | [Seeded demo and walkthroughs](docs/demo.md)                                   |
| Run the server, import a real EPUB or add an endpoint        | [Backend](docs/backend.md)                                                     |
| Work on the code, run checks or follow UI conventions        | [Development](docs/development.md) and [store ownership](src/stores/README.md) |
| Understand earlier design choices                            | [Design history](docs/design-history.md)                                       |
