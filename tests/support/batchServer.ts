// A speech server that speaks the batch speech API (`docs/speech-batch-api.md`), as a `fetch` a
// provider can be handed: its capabilities, its voices, its batch route answered as a stream of JSON
// lines, and the one-line `/audio/speech` beside them. Every line is rendered as the fake provider
// renders one — a tone at the voice's pitch, as long as the words take to say — at 24 kHz.
//
// The knobs are the ways a real server behaves that a client has to cope with: limits, an item that
// fails (for good or for now), the whole batch refused as busy or unreadable, a stream cut off
// part-way or ended without its `done`, items finished out of order, a slow render with or without
// `ping`s, and audio that is not what was asked for. Every request is recorded, and the stream stops
// when the client closes the request, as a real connection would.
import { sleep } from "~/providers/fake";
import { fakeDuration, toneOf, toneWav } from "~/providers/fakeSpeech";

/** The rate every line is rendered at, as a model's own rate is. */
export const BATCH_RATE = 24000;

/** An item as the client sent it. */
export interface SentItem {
  id: string;
  input: string;
  voice: string;
  instructions?: string;
  [field: string]: unknown;
}

/** A batch request as the client sent it. */
export interface SentBatch {
  model: string;
  response_format?: string;
  items: SentItem[];
  [field: string]: unknown;
}

/** An item's failure, as the stream carries it. */
export interface ItemFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface BatchServerOptions {
  /** the model it serves; `omnivoice` */
  model?: string;
  /**
   * What its capabilities say of the model's batches: `max_items` and `max_input_chars`, 16 and
   * 12000 unless given; null for a model it serves one line at a time. `max_item_chars` beside it.
   */
  batch?: { max_items?: number | null; max_input_chars?: number | null } | null;
  maxItemChars?: number | null;
  /** answer the capabilities route with this status and nothing else: 404 for a server without it */
  capabilitiesStatus?: number;
  /** the voices it has; an item naming another fails `voice_not_found`. Any voice when absent. */
  voices?: string[];
  /** an item's failure, or null to render it */
  failItem?(item: SentItem, index: number): ItemFailure | null;
  /**
   * Refuse the first `times` batches whole with `status` — 429 or 503 as busy, 400 as unreadable —
   * in OpenAI's error shape, naming `retryAfter` seconds when given.
   */
  refuse?: { status: number; times: number; retryAfter?: string; code?: string };
  /** cut the connection after this many item lines, without a `done` */
  dropAfter?: number;
  /** end the stream cleanly after every item, but never write `done` */
  noDone?: boolean;
  /** the places of items it never writes a line for, as a server with a bug would not */
  forget?: number[];
  /** the order items are finished in; the order they were sent unless `reversed` */
  order?: "sent" | "reversed";
  /** how long each item takes to render, in ms */
  itemDelayMs?: number;
  /** while an item renders, a `ping` this often, in ms */
  pingEveryMs?: number;
  /** the `format` an item line claims, whatever was asked */
  answerFormat?: string;
  /** base64 to send for an item in place of its tone */
  audioFor?(item: SentItem, index: number): string | null;
  /** the `usage` an item line carries; the characters and the seconds unless given */
  usageFor?(item: SentItem, duration: number): Record<string, unknown> | undefined;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const refusal = (status: number, code: string, message: string, headers = {}): Response =>
  json({ error: { message, type: "invalid_request_error", code, param: null } }, status, headers);

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** The tone a line is rendered as, and how long it plays. */
function rendered(item: SentItem): { bytes: Uint8Array; duration: number } {
  const duration = fakeDuration(item.input);
  return { bytes: toneWav(toneOf(item.voice), duration, BATCH_RATE), duration };
}

export function batchServer(options: BatchServerOptions = {}) {
  const model = options.model ?? "omnivoice";
  const requests: RecordedRequest[] = [];
  let refused = 0;
  /** how many batch streams the client closed before they were done */
  const state = { cancelled: 0 };

  function capabilities(): Response {
    if (options.capabilitiesStatus) return new Response("", { status: options.capabilitiesStatus });
    const batch =
      options.batch === null
        ? undefined
        : {
            max_items: options.batch?.max_items === undefined ? 16 : options.batch.max_items,
            max_input_chars:
              options.batch?.max_input_chars === undefined ? 12000 : options.batch.max_input_chars,
          };
    return json({
      object: "speech.capabilities",
      version: 1,
      models: [
        {
          id: model,
          ...(batch ? { batch } : {}),
          max_item_chars: options.maxItemChars ?? 1500,
          response_formats: ["wav", "mp3", "opus"],
          sample_rates: [BATCH_RATE],
          instructions: true,
          a_field_from_a_later_version: { anything: true },
        },
      ],
    });
  }

  function batchAnswer(body: SentBatch, signal: AbortSignal | undefined): Response {
    if (options.refuse && refused < options.refuse.times) {
      refused++;
      const { status, retryAfter, code } = options.refuse;
      return refusal(
        status,
        code ?? (status === 400 ? "invalid_request" : "overloaded"),
        status === 400 ? "Two items share one id" : "Busy rendering another batch",
        retryAfter ? { "retry-after": retryAfter } : {},
      );
    }
    if (body.model !== model) return refusal(404, "model_not_found", `No model '${body.model}'`);
    const max = options.batch === null ? 1 : (options.batch?.max_items ?? 16);
    if (!Array.isArray(body.items) || !body.items.length || (max && body.items.length > max))
      return refusal(400, "too_many_items", `Between 1 and ${max} items`);

    const format = body.response_format ?? "wav";
    const order = body.items.map((_, i) => i);
    if (options.order === "reversed") order.reverse();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const gone = () => signal?.aborted ?? false;
        // nothing is written to a connection the client has closed
        const write = (line: unknown) =>
          gone() || controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
        signal?.addEventListener(
          "abort",
          () => {
            state.cancelled++;
            try {
              controller.error(signal.reason);
            } catch {
              // already closed
            }
          },
          { once: true },
        );
        const wait = async (ms: number) => {
          const until = Date.now() + ms;
          while (!gone() && Date.now() < until) {
            const step = Math.min(until - Date.now(), options.pingEveryMs ?? ms);
            await sleep(step, signal ?? new AbortController().signal).catch(() => {});
            if (!gone() && options.pingEveryMs && Date.now() < until) write({ type: "ping" });
          }
        };
        let done = 0;
        let failed = 0;
        let characters = 0;
        let seconds = 0;
        for (const [n, i] of order.entries()) {
          if (options.itemDelayMs) await wait(options.itemDelayMs);
          if (gone()) return;
          if (options.dropAfter !== undefined && n >= options.dropAfter) {
            // what was written reaches the client before the reset, as it would over a socket;
            // an errored stream would otherwise throw away what is still queued
            while ((controller.desiredSize ?? 1) < 1 && !gone())
              await new Promise((r) => setTimeout(r, 1));
            controller.error(new Error("connection reset by peer"));
            return;
          }
          if (options.forget?.includes(i)) continue;
          const item = body.items[i];
          const failure =
            options.failItem?.(item, i) ??
            (options.voices && !options.voices.includes(item.voice)
              ? {
                  code: "voice_not_found",
                  message: `No voice '${item.voice}' on this server`,
                  retryable: false,
                }
              : null);
          if (failure) {
            failed++;
            write({ type: "item", id: item.id, index: i, status: "failed", error: failure });
            continue;
          }
          const { bytes, duration } = rendered(item);
          const usage = options.usageFor
            ? options.usageFor(item, duration)
            : { input_characters: item.input.length, audio_seconds: duration };
          done++;
          characters += item.input.length;
          seconds += duration;
          write({
            type: "item",
            id: item.id,
            index: i,
            status: "done",
            format: options.answerFormat ?? format,
            sample_rate: BATCH_RATE,
            duration,
            audio: options.audioFor?.(item, i) ?? base64(bytes),
            ...(usage ? { usage } : {}),
            a_field_from_a_later_version: 1,
          });
        }
        if (!options.noDone)
          write({
            type: "done",
            items: { done, failed },
            usage: { input_characters: characters, audio_seconds: seconds },
          });
        if (!gone()) controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
  }

  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/v1/, "");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ method, path, headers: new Headers(init.headers), body });
    if (init.signal?.aborted) throw init.signal.reason;

    if (method === "GET" && path === "/audio/speech/capabilities") return capabilities();
    if (method === "GET" && path === "/models") return json({ data: [{ id: model }] });
    if (method === "GET" && path === "/audio/voices")
      return json({ voices: (options.voices ?? []).map((id) => ({ id, name: id })) });
    if (method === "POST" && path === "/audio/speech/batch")
      return batchAnswer(body as SentBatch, init.signal ?? undefined);
    if (method === "POST" && path === "/audio/speech") {
      const item = body as SentItem;
      if (options.voices && !options.voices.includes(item.voice))
        return refusal(400, "voice_not_found", `No voice '${item.voice}' on this server`);
      return new Response(rendered(item).bytes, { headers: { "content-type": "audio/wav" } });
    }
    return refusal(404, "not_found", `No route ${method} ${path}`);
  }) as typeof globalThis.fetch;

  return {
    fetch,
    requests,
    state,
    /** the batch requests it was sent, as the client sent them */
    batches: (): SentBatch[] =>
      requests.filter((r) => r.path === "/audio/speech/batch").map((r) => r.body as SentBatch),
  };
}
