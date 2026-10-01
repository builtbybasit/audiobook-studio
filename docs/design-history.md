# Design history

[Back to README](../README.md)

The app began as a browser-only prototype built in dated rounds, with a seeded demo simulated in the page, and then gained a server that took the work over. This page keeps that chronology and the approaches that were replaced. It is not a specification of current behavior: the topic guides linked from each row are.

## Initial layout decisions — 2026-09-12

Six structural variants were prototyped (three per screen) and compared via a `?variant=` switcher. The winners are folded into the current UI. Earlier notes point to a `prototype/all-variants` branch for the full set; that branch is not in this repository.

| Screen           | Winner                                                                                     | Why                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Scripting review | **Reader** — prose + dialogue cards, toggleable in-chapter cast rail, `Aa` typography menu | reads like the book; the grid and cast-first layouts were better for bulk fixes but worse for judging the script |
| Narration job    | **Ledger** — filterable per-segment log with sticky player                                 | failures and playback are the everyday task; the timeline and per-endpoint lanes were prettier but less useful   |

Ideas borrowed from the older narrata web UI: major/minor cast split with Narrator-voice fallback, auto-assign by gender, spoiler-hidden descriptions, a "This run" cost estimate with blockers, endpoint price / no-key badges, per-chapter segment counts, reader filters.

## The open book in the shell — 2026-09-19

The sidebar used to carry a numbered stage nav (Library, Scripting, Narration, Export), then Queue and Endpoints, then an "Open book" card with chips for Overview, Contents, Review, Cast and Search — the book's identity below the nav that depended on it, its pages split across two visual languages, no cover, no next step, and no way to switch books short of the Library. Eight shapes were prototyped on every route behind a `?variant=` switcher and compared in the browser at desktop and phone width; the full set was on a `prototype/sidebar-open-book` branch (commit `3c0f41c`), which is no longer in this repository.

| Variant | Shape                                                                               | Why it lost / won                                                                                                                            |
| ------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A       | the book heads one nav in two groups, Book and Stages, with a switch-book popover   | clean, but still a tall sidebar for three app rows and eight book rows                                                                       |
| B       | a vertical stepper — state dots, bars, the next step drawn on its step              | best "where am I", but reads as status, not navigation                                                                                       |
| C       | a stack of recent books, the open one expanded                                      | solves switching, but every book competes with the open one                                                                                  |
| D1      | **winner** — icon rail; book selector in the header's top row; tabs in a second row | gives the content the width back, the book reads left to right like the overview's stage cards, one selector replaces the Library round-trip |
| D2      | D1 with the pages as rail icons instead of a tab row                                | counts hide in tooltips; the rail duplicated the header once tabs were there                                                                 |
| D3      | D1 with the pipeline as a horizontal strip                                          | the strip repeated the overview's stage cards                                                                                                |
| E       | a to-do list of decisions in place of pages                                         | surfaced that the next-step chain and the review inbox can say the same thing twice; useful as a finding, not as a nav                       |

Folded in from D1: the rail is mini by default with a widening toggle (`uiStore.railExpanded`, not persisted — like the theme, that is the backend's to remember); under `lg` the drawer lists the book's pages with counts in place of the tab row; the header's chips drop their words under `sm` so the selector keeps its title on a phone; the selector's search appears from six books up.

## Prototype rounds

| Original milestone                                                           | Date recorded | Where its details live now                                                                                                  |
| ---------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Round three: chapter peek, re-script, undo, navigation and backend-shaped UI | 2026-09-14    | [Shared editing and navigation](workflow.md#shared-editing-and-navigation)                                                  |
| Round four: retakes and segment boundaries                                   | 2026-09-14    | [Audio review](audio.md#audio-review-and-segment-boundaries)                                                                |
| Round five: pronunciation and pacing                                         | 2026-09-14    | [Pronunciation and pacing](audio.md#pronunciation-and-pacing)                                                               |
| Round six: one player across the app                                         | 2026-09-15    | [Playback](audio.md#one-player-across-the-app)                                                                              |
| Round seven: bulk corrections                                                | 2026-09-15    | [Search corrections](scripting.md#bulk-corrections-in-search)                                                               |
| Round eight: export at book scale                                            | 2026-09-15    | [Export](exports.md)                                                                                                        |
| Round nine: import review, shelf redesign and inline editing                 | 2026-09-16    | [Contents and shelf](workflow.md#import-contents-and-the-library-shelf), [inline editing](audio.md#editing-a-line-in-place) |
| Round ten: chapter script history                                            | 2026-09-17    | [History](scripting.md#chapter-script-history)                                                                              |
| Round eleven: bulk reruns                                                    | 2026-09-17    | [Bulk reruns](scripting.md#bulk-re-scripting-and-re-narration)                                                              |
| Toastflow, queue activity and endpoint management                            | 2026-09-14    | [Toasts](development.md#toasts), [endpoints and queue](endpoints.md)                                                        |
| Cached pricing, schedules, promotions and expanded TTS billing               | 2026-09-17    | [Pricing](pricing.md)                                                                                                       |

## The server — 2026-09-19 to 2026-09-30

| Milestone                                                                                         | Date       | Where its details live now                                                                              |
| ------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| Real EPUB import and the library over HTTP                                                        | 2026-09-19 | [Importing an EPUB](backend.md#importing-an-epub)                                                       |
| Scripting and narration as server jobs, with fakes standing in for providers; export on 09-22     | 2026-09-19 | [Backend](backend.md)                                                                                   |
| Book settings, the dictionary, endpoints and covers kept on the server                            | 2026-09-23 | [Backend](backend.md)                                                                                   |
| Real providers, keys kept on the server, and the usage ledger with budgets                        | 2026-09-23 | [The providers](backend.md#the-providers-and-where-a-key-lives), [pricing](pricing.md)                  |
| Provider presets, more speech providers, voice cloning, the speech gate and batch speech          | 2026-09-28 | [Endpoints](endpoints.md), [batch speech API](speech-batch-api.md)                                      |
| Script export and import, with voice samples                                                      | 2026-09-28 | [Script export and import](script-transfer.md)                                                          |
| Simulated endpoints replace the server-wide fake switch; the demo becomes a library on the server | 2026-09-29 | [The demo](demo.md#how-the-demo-is-built), [two libraries](backend.md#two-libraries-yours-and-the-demo) |
| Editable scripting prompts and reasoning levels                                                   | 2026-09-29 | [The prompt](endpoints.md#scripting-endpoints)                                                          |

Moving the demo onto the server removed the browser's simulators, its in-memory key store and its local usage store: a demo tab is the same page talking to `/demo/api`, and no store has a demo branch.

Cloning a voice, and keeping its samples, asked for a consent tick until 2026-10-01; the sentence and its time were kept with the samples and carried in a script file's `consent.json`. The voices cloned here are made-up narrator voices, so the tick recorded an attestation nobody was making, and it went — the form, the columns (migration `0018_drop_clone_consent`) and the fields; the folder's list is `samples.json` now, and an older `consent.json` still reads as one.

## Historical measurements and references

The player notes originally reported a 12 kB gzip waveform chunk. That was a build-specific measurement, not a size guarantee; the playback guide retains the reason the component is lazy-loaded. Re-measure with the current build when size matters.

The original heading called this `audiobook-ui — PROTOTYPE` and a “throwaway” design exploration. The package is now `audiobook-studio`, and the seeded demo is kept for good, as the server's second library.
