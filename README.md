# Audiobook Studio

A personal audiobook app for turning books into reviewed, multi-voice narration. This checkout is a **Vue 3 frontend prototype with a permanent seeded demo**: use it to test the workflow without paid AI requests. A backend has been started in [server/](server/) and reads real EPUBs; everything else is still simulated.

Import → review contents → script → assign voices → narrate and review → export.

## Run locally

Use Node.js, pnpm and Bun (the test runner). The repository includes `pnpm-lock.yaml`.

```sh
pnpm install
pnpm dev
```

Open the URL Vite prints, normally `http://localhost:5173`. No backend or provider credentials are needed. See [development and verification](docs/development.md) for prerequisites and all commands.

The server can be run alongside the frontend:

```sh
pnpm dev:server                 # the API on :8787
VITE_MODE=backend pnpm dev      # the frontend, proxying /api to it
```

**The screens do not use it yet.** `VITE_MODE=backend` selects the real service at the seam in [src/services/](src/services/), and nothing above that seam calls it: every page still reads the seeded world, and wiring them up is the next slice. What the server itself does — importing real EPUBs, and storing a library you can drive over HTTP — is in [backend](docs/backend.md). Demo is the default and needs none of this.

## What works in this prototype

- **Library and Contents:** sample EPUB import, volume organization, chapter previews and decisions about notices or other non-story material.
- **Scripting and Cast:** endpoint configuration, script editing, speaker/voice assignments, pronunciation, expression annotations and bulk corrections.
- **Script history and reruns:** named checkpoints, preview/compare/restore, bulk re-scripting and re-narration that preserve usable results while replacements run.
- **Narration and Review:** simulated queues, failed clips, stale audio, flags, retake comparison and a list of decisions needing attention.
- **Endpoints and pricing:** request history and charts, concurrency, cached-token pricing, TTS billing models, schedules, promotions, budgets and recorded usage.
- **Export:** M4B/MP3 planning, file layouts, chapter marks, loudness previews and version/update workflows.

## What is simulated

In demo mode EPUB parsing, provider requests, generated audio, encoding, output files and loudness measurements are all simulated. (The backend parses EPUBs for real; the rest is simulated in both modes.) Configured rates drive simulated costs; provider names and prices in fixtures are examples, not current pricing guarantees. Seeded audio playback is timed rather than heard, and waveform previews are illustrative. Voice auditions may use the browser’s speech synthesis.

Books, edits, history, jobs and credentials are in memory and reset on reload. A few UI preferences persist in localStorage; see [state that survives a reload](docs/development.md#state-that-survives-a-reload).

## Try a workflow

Open **Demo** in the header. The drawer offers repeatable scenarios, suggested steps, simulation speed, a one-shot export failure and reset. Applying a scenario restores the seeded world first; reset discards session changes and abandons simulated work.

Start with a chapter with script history, a failed replacement, a book with missing voices, or an export that needs updating. The [demo guide](docs/demo.md) contains the scenario map and detailed walkthroughs.

**Keep this demo when the backend is added.** The first backend slice — reading EPUBs and storing the library — is in [server/](server/); real-provider integration is still future work. The testing requirements for both are recorded in [future backend integration requirements](docs/demo.md#future-backend-integration-requirements).

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
