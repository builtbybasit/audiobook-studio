# Batch speech API

[Back to README](../README.md) · [Endpoints](endpoints.md) · [Backend](backend.md)

A small extension of OpenAI's `POST /v1/audio/speech` for a speech server that renders many lines
at once — a local model that batches on the GPU, or a hosted one that is cheaper or faster per line
in bulk. It is written for this app's narration, but nothing in it belongs to one model: a server
for OmniVoice, Kokoro, Orpheus, Qwen-TTS, VibeVoice or anything else implements the same four
routes, and says what it can do rather than being assumed to do it.

A server that implements it is added on the Endpoints page like any OpenAI-compatible server — its
base URL ending in `/v1`, its model id, a key if it wants one. The app asks it what it can do when
the endpoint is tested and before each narration run, and when it answers, a run sends that
endpoint's lines in batches instead of one at a time. A server that does not answer is sent one line
per request, as before.

## Contents

- [Conventions](#conventions)
- [What the server can do](#what-the-server-can-do) — `GET /v1/audio/speech/capabilities`
- [Rendering a batch](#rendering-a-batch) — `POST /v1/audio/speech/batch`
- [The answer, as a stream](#the-answer-as-a-stream)
- [Errors](#errors)
- [Voices](#voices) — `GET /v1/audio/voices`, and optionally `POST /v1/audio/voices`
- [How this app uses it](#how-this-app-uses-it)
- [Implementing it on OmniVoice](#implementing-it-on-omnivoice)

## Conventions

- JSON in and out, UTF-8, `snake_case` fields, as OpenAI's own API.
- Auth, when the server wants it, is `Authorization: Bearer <key>`. A server with no key ignores the
  header.
- **Unknown fields are ignored**, in both directions. A client may send a field a server does not
  know, and a server may answer one the client does not; neither is an error. That is what lets a
  server add a model's own options, and a later version add fields, without breaking anyone.
- Every route here lives beside `POST /v1/audio/speech`, which a server should keep answering: a
  client with one line, or one that does not know this document, still works.
- `version` is `1`. A change that would break a version-1 client gets a new number.

## What the server can do

```http
GET /v1/audio/speech/capabilities
```

```json
{
  "object": "speech.capabilities",
  "version": 1,
  "models": [
    {
      "id": "omnivoice",
      "batch": { "max_items": 16, "max_input_chars": 12000 },
      "max_item_chars": 1500,
      "response_formats": ["wav", "mp3", "opus", "flac", "pcm"],
      "sample_rates": [24000],
      "instructions": true,
      "speed": { "min": 0.5, "max": 2.0 },
      "languages": null,
      "tags": { "open": "[", "close": "]", "known": ["laughter", "sigh"] },
      "extra": {
        "num_step": { "type": "integer", "default": 32, "description": "Decoding steps" }
      }
    }
  ]
}
```

One entry per model the server serves; a client picks the one its endpoint names.

| Field              | Meaning                                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `batch`            | Present when the model takes batches. `max_items` lines per request; `max_input_chars` the most characters of `input` across them all. Each is a whole number of at least 1, or `null` for no limit. Absent: send one line per request. |
| `max_item_chars`   | The longest `input` one item may have; `null` for none. A client splits a longer line itself.                                                                                                                                           |
| `response_formats` | The formats it can answer in, from `wav`, `mp3`, `opus`, `flac`, `aac`, `pcm` (OpenAI's list). `pcm` is raw 16-bit little-endian mono at the answer's `sample_rate`.                                                                    |
| `sample_rates`     | The rates it can be asked for, in Hz; `null` when it renders at its model's own rate and cannot be asked for another.                                                                                                                   |
| `instructions`     | Whether it reads `instructions` — delivery, emotion, a voice described in words. A server that says `false` ignores the field.                                                                                                          |
| `speed`            | The range `speed` may take, or `null` when it takes none.                                                                                                                                                                               |
| `languages`        | The language codes it takes (BCP 47, `en`, `zh`…), or `null` for "works it out from the text".                                                                                                                                          |
| `tags`             | How it reads non-verbal tags written into the text, if it does: the brackets, and the tags it knows. `null` when a bracketed word is read out as a word.                                                                                |
| `extra`            | The model's own options a client may send in `extra`, each with a JSON type, a default and a description, so a page can offer them. Informational: a server takes an option it does not list and ignores one it cannot use.             |

A server may answer `404` here, which a client reads as "no batches, no promises", and falls back to
`POST /v1/audio/speech` one line at a time.

## Rendering a batch

```http
POST /v1/audio/speech/batch
Content-Type: application/json
Accept: application/x-ndjson
```

```json
{
  "model": "omnivoice",
  "response_format": "wav",
  "sample_rate": 24000,
  "extra": { "num_step": 16 },
  "items": [
    {
      "id": "b7/ch3/l12",
      "input": "We are short again.",
      "voice": "mara",
      "instructions": "Tired, flat, under her breath.",
      "speed": 1.0,
      "language": "en",
      "extra": { "guidance_scale": 2.5 }
    },
    { "id": "b7/ch3/l13", "input": "Then we count it twice.", "voice": "tobin" }
  ]
}
```

| Field                  | Required | Meaning                                                                                                                                                                                    |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`                | yes      | One of the capabilities' `models[].id`.                                                                                                                                                    |
| `response_format`      | no       | For every item; `wav` when absent.                                                                                                                                                         |
| `sample_rate`          | no       | For every item, one of `sample_rates`; the model's own rate when absent.                                                                                                                   |
| `extra`                | no       | Model options for every item. An item's own `extra` is merged over it, key by key.                                                                                                         |
| `items`                | yes      | One to `batch.max_items` lines.                                                                                                                                                            |
| `items[].id`           | yes      | The client's name for the line: a string of 1–200 characters, unique in the request (two with one id are a `400`). Answered back exactly as it was sent; the server reads nothing into it. |
| `items[].input`        | yes      | The text to say, tags written in as the capabilities' `tags` spell them.                                                                                                                   |
| `items[].voice`        | yes      | A voice id from [`GET /v1/audio/voices`](#voices). Voices live on the server; a request never carries reference audio.                                                                     |
| `items[].instructions` | no       | How to say it, in words. Ignored by a model whose capabilities say `instructions: false`.                                                                                                  |
| `items[].speed`        | no       | Within the capabilities' `speed`; `1.0` when absent.                                                                                                                                       |
| `items[].language`     | no       | A code from `languages`; the server's own guess when absent.                                                                                                                               |
| `items[].extra`        | no       | Model options for this item alone.                                                                                                                                                         |

**The request is refused whole only when it cannot be read**: not JSON, no `items` or more than
`max_items`, two items with one `id`, an unknown `model`, a `response_format` or `sample_rate` it
cannot answer in, more than `max_input_chars` across the items. Those answer a `400` (or `404` for
the model) in the [error shape](#errors) before anything is rendered. A server too busy to take the
batch answers `429` or `503`, with `Retry-After` when it knows how long; the client waits and sends
the whole batch again.

**Anything about one item fails that item alone**: a voice it does not have, an `input` over
`max_item_chars`, an empty `input`, a render that went wrong. The other items are rendered.

Rendering has no side effects, so sending an item again — after a dropped connection, say — is
always safe.

## The answer, as a stream

```http
HTTP/1.1 200 OK
Content-Type: application/x-ndjson
```

One JSON object per line, `\n`-terminated, written as each item finishes — in whatever order the
server finishes them, not the order they were sent — and a last line when every item has been
answered:

```json
{"type":"item","id":"b7/ch3/l13","index":1,"status":"done","format":"wav","sample_rate":24000,"duration":1.42,"audio":"UklGRiQ…","usage":{"input_characters":23,"audio_seconds":1.42}}
{"type":"item","id":"b7/ch3/l12","index":0,"status":"failed","error":{"code":"voice_not_found","message":"No voice 'mara' on this server","retryable":false}}
{"type":"done","items":{"done":1,"failed":1},"usage":{"input_characters":23,"audio_seconds":1.42}}
```

| Line                  | Fields                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item`, `done` status | `id` and `index` (its place in `items`, from 0); `format`; `sample_rate` of the audio; `duration` in seconds; `audio`, the whole file base64-encoded (standard alphabet, padded); `usage` — `input_characters` and `audio_seconds` at least, and whatever else the model counts (`input_tokens`, `output_audio_tokens`…). |
| `item`, `failed`      | `id`, `index`, `error` — `code`, `message`, and `retryable`: whether sending that item again could go differently.                                                                                                                                                                                                        |
| `done`                | How many items were `done` and `failed`, and the `usage` summed over the batch. Nothing follows it.                                                                                                                                                                                                                       |
| `ping`                | Nothing but `type`. A server whose first item may take a while sends one every few seconds, so a client can tell a slow batch from a dead connection.                                                                                                                                                                     |

Every item is answered exactly once, and a client matches an answer to its item by `id`; `index`
is a convenience a server should send and a client may fall back on. A second answer for an item,
or one naming an item that was not sent, is ignored. `done`'s counts are for a person reading a log;
a client goes by the item lines it saw.

A client reads a stream that ends without `done` as a dropped connection: the items it was not told
about were not rendered, as far as it knows, and it may send them again. One that ends without
`done` after every item was answered lost nothing, and is complete. A `done` that arrives with items
still unanswered leaves those unanswered, as a dropped connection does. A client that closes the
connection is cancelling the batch; the server should stop rendering what is left, and whatever it
had finished is lost.

Once the `200` is sent, a refusal of the whole request is too late: it belongs before the stream.
A server that finds one afterwards fails each item still unanswered instead. A client that meets a
line that is an error object rather than an `item` treats it as a refusal of everything unanswered.

**How long a client waits.** A client gives up on a batch when nothing — an item or a `ping` — has
arrived for its endpoint's timeout (60 seconds by default in this app; a person can change it), not
when the whole batch has taken that long, so a long batch that keeps talking is never cut off. A
server should send a `ping` at least every 10 seconds while nothing else is ready.

Why a stream of JSON rather than one answer or multipart: lines land as they finish, so a person
watching a chapter sees it fill in; one item's failure is one line, not a failed request; and it is
plain HTTP any server framework can write. Base64 costs a third more bytes, which does not matter on
a local network and is small beside what a model spends rendering the audio.

## Errors

A refusal of the whole request is OpenAI's error shape, so a client already reading OpenAI's errors
reads these:

```json
{
  "error": {
    "message": "No model 'omni'",
    "type": "invalid_request_error",
    "code": "model_not_found",
    "param": "model"
  }
}
```

An item's `error` has the same `code` and `message`, and `retryable` beside them. The codes a client
may act on — any other is shown as its message:

| Code              | Where         | Retryable | Meaning                                                              |
| ----------------- | ------------- | --------- | -------------------------------------------------------------------- |
| `invalid_request` | request       | no        | Not JSON, a field of the wrong type, duplicate ids                   |
| `model_not_found` | request       | no        | `model` is not one the server serves                                 |
| `too_many_items`  | request       | no        | Over `batch.max_items` or `batch.max_input_chars`                    |
| `unsupported`     | request       | no        | A `response_format` or `sample_rate` it cannot answer in             |
| `overloaded`      | request (503) | yes       | Busy; try the batch again, after `Retry-After`                       |
| `voice_not_found` | item          | no        | No voice with that id                                                |
| `input_too_long`  | item          | no        | Over `max_item_chars`                                                |
| `empty_input`     | item          | no        | Nothing to say                                                       |
| `render_failed`   | item          | yes       | The model failed on this item                                        |
| `out_of_memory`   | item          | yes       | Too big for the device at the moment; smaller batches may go through |

## Voices

```http
GET /v1/audio/voices
```

```json
{
  "voices": [
    {
      "id": "mara",
      "name": "Mara",
      "gender": "f",
      "language": "en",
      "description": "Cloned from the author's reading"
    }
  ]
}
```

`id` is what an item's `voice` names; the rest is for a person choosing one, and all of it is
optional. It is the list Kokoro-FastAPI answers, which this app already reads for any
OpenAI-compatible endpoint (the Voices tab's **Fetch from server**).

A server that makes voices — cloned from a recording, or designed from a description — may also take:

```http
POST /v1/audio/voices
Content-Type: multipart/form-data
```

| Part          | Meaning                                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| `name`        | What to call it; the server makes an id from it                                 |
| `samples`     | One or more recordings (WAV, MP3, FLAC, M4A, Opus); absent for a designed voice |
| `transcript`  | What the samples say, when known; a model that needs it may work it out         |
| `description` | A voice in words — "female, low, British" — for a model that designs voices     |

It answers `201` with the voice as the list shows it. Making a voice is not safe to repeat, so a
client sends it once, with no retries. A server that does not make voices answers `404` or `405`.

## How this app uses it

- **The Requests tab** has a **Batches** switch, on by default, and says what the server answered —
  how many lines a request it takes, or that it takes none (`POST /api/endpoints/batch`). Off, a run
  sends one line a request whatever the server takes. The **OmniVoice server** preset fills in
  omnivoice-fastapi's address and model.
- **Test** asks for the capabilities and says what it found — "… · takes batches of up to 16 lines" —
  beside the usual check that the host and key answer.
- **A narration run** asks again when it starts (the answer is kept for a few minutes), and when the
  endpoint's model takes batches, gathers that endpoint's waiting lines into batches of up to
  `max_items` and `max_input_chars`, in the chapter's order. Each batch takes one of the endpoint's
  concurrency slots, so concurrency 2 with batches of 16 is up to 32 lines rendering at once.
- **A line longer than the endpoint's max characters** goes as several items, one per part, and the
  parts are joined when they have all come back — as a split line is today.
- **Each item is its own line**: its own clip, its own row in the usage ledger (priced on the
  endpoint's rate card, from what it counted), its own failure. A batch the server refused whole is
  retried whole, with the endpoint's retries and cooldown; an item that failed `retryable` goes into
  a later batch, up to the endpoint's retries; one that did not, fails its line.
- **A retake** of one line is a batch of one.
- **What it sends**: `model`, `response_format`, and per item `id` (its place in the batch, as a
  string), `input`, `voice` and `instructions` when the line has any — whether or not the
  capabilities say the model reads them; a server that does not ignores them. It sends no
  `sample_rate`, `speed`, `language` or `extra` yet: an OpenAI-compatible endpoint that names a
  sample rate is still refused before any request, as it is for one line.
- The endpoint's `concurrency`, pause and rate-limit cooldown apply as they do to any endpoint (see
  [backend.md](backend.md#narration)).

## Implementing it on OmniVoice

An example of the mapping, not part of the contract. OmniVoice's `generate()` takes lists — a text,
a voice prompt, an instruction, a language, a speed or a duration per item — and returns one 24 kHz
array per item, so a batch is close to one call:

| This API                              | OmniVoice                                                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `items[].input`                       | `text[i]`; its `[laughter]`-style tags pass through (`tags.open`/`close` = `[`/`]`)                                                                        |
| `items[].voice`                       | a stored `voice_clone_prompt` (from `create_voice_clone_prompt(ref_audio, ref_text)` when the voice was made), or a stored `instruct` for a designed voice |
| `items[].instructions`                | `instruct[i]`, for a designed voice                                                                                                                        |
| `items[].speed`, `language`           | `speed[i]`, `language[i]`                                                                                                                                  |
| `extra.num_step`, `guidance_scale`, … | the matching `generate()` keyword arguments                                                                                                                |
| `sample_rates`                        | `[24000]`; resample to offer others                                                                                                                        |
| `batch.max_items`                     | whatever fits the GPU; the README reports its FlashInfer path 2.6× faster at batch size 8                                                                  |

Items with different `extra` cannot share one `generate()` call; a server groups them, or renders
the odd ones separately, and still answers every item in the one stream.
