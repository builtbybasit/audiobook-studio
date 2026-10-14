# Batch speech API

An extension of OpenAI's `POST /v1/audio/speech` for a speech server that renders many lines at once. Any model (OmniVoice, Kokoro, Qwen-TTS…) can implement it. A server that doesn't is sent one line per request, as before.

Add it on the Endpoints page as an OpenAI-compatible endpoint (base URL ending in `/v1`). **Test** and every narration run ask what it can do.

## Rules

- JSON, `snake_case`, optional `Authorization: Bearer <key>`.
- Unknown fields are ignored in both directions.
- Keep answering `POST /v1/audio/speech` for single lines.

## `GET /v1/audio/speech/capabilities`

```json
{
  "object": "speech.capabilities",
  "version": 1,
  "models": [
    {
      "id": "omnivoice",
      "batch": { "max_items": 16, "max_input_chars": 12000 },
      "max_item_chars": 1500,
      "response_formats": ["wav", "mp3", "pcm"],
      "sample_rates": [24000],
      "instructions": true,
      "speed": { "min": 0.5, "max": 2.0 },
      "languages": null,
      "tags": { "open": "[", "close": "]", "known": ["laughter", "sigh"] },
      "extra": { "num_step": { "type": "integer", "default": 32 } }
    }
  ]
}
```

No `batch` (or a `404` here) means one line per request. `null` means no limit, or "not supported".

## `POST /v1/audio/speech/batch`

```json
{
  "model": "omnivoice",
  "response_format": "wav",
  "items": [
    { "id": "0", "input": "We are short again.", "voice": "mara", "instructions": "Tired, flat." },
    { "id": "1", "input": "Then we count it twice.", "voice": "tobin" }
  ]
}
```

Item fields: `id` (unique, echoed back), `input`, `voice` (required); `instructions`, `speed`, `language`, `extra` (optional). Top-level `sample_rate` and `extra` apply to every item.

- **Whole request refused** (before streaming, OpenAI error shape): bad JSON, too many items/chars, unknown model or format → `400`/`404`. Busy → `429`/`503` with `Retry-After`; the client resends the batch.
- **One item fails alone**: unknown voice, too long, empty, render error. The rest still render.

## The answer: NDJSON stream

`Content-Type: application/x-ndjson`, one line per item as it finishes, any order, then `done`:

```json
{"type":"item","id":"1","index":1,"status":"done","format":"wav","sample_rate":24000,"duration":1.42,"audio":"<base64>","usage":{"input_characters":23,"audio_seconds":1.42}}
{"type":"item","id":"0","index":0,"status":"failed","error":{"code":"voice_not_found","message":"No voice 'mara'","retryable":false}}
{"type":"done","items":{"done":1,"failed":1}}
```

- Send `{"type":"ping"}` at least every 10 s while nothing is ready. The client gives up after its timeout (60 s by default) of silence.
- A stream that ends without `done` counts as dropped: unanswered items get resent. Rendering has no side effects, so resending is safe.
- Error codes: `invalid_request`, `model_not_found`, `too_many_items`, `unsupported`, `overloaded` (request); `voice_not_found`, `input_too_long`, `empty_input`, `render_failed`, `out_of_memory` (item; the last two are retryable).

## Voices

- `GET /v1/audio/voices` → `{"voices":[{"id":"mara","name":"Mara","gender":"f","language":"en"}]}`. Only `id` is required.
- Optional `POST /v1/audio/voices` (multipart: `name`, `samples`, `transcript`, `description`) → `201` with the voice. The app sends it once, with no retries. Return `404`/`405` if voice creation isn't supported.

## What the app sends

`model`, `response_format`, and per item `id`, `input`, `voice`, `instructions`. No `sample_rate`, `speed`, `language` or `extra` yet. Each item is its own clip and its own ledger row. Each batch takes one of the endpoint's concurrency slots.
