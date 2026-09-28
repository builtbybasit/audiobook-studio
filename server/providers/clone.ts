// A voice made from someone's recordings, kept by the provider as one more voice on the account.
//
// Only providers that keep a cloned voice and answer with an id for it are cloned through here — a
// voice made this way is then an ordinary voice: listed by "Fetch", cast like any other, and sent
// by id with every line, so the recordings go out once rather than with every request.
//
// Fish Audio is the one so far (https://docs.fish.audio/api-reference/endpoint/model/create-model):
// `POST /model` on the API's host, as multipart, with `type=tts`, a title, `train_mode=fast` — the
// model is usable at once — and 1 to 20 recordings under `voices`. With no `texts` Fish transcribes
// the recordings itself. The voice is made private: only the account that made it can use it. The
// answer is the new model, whose `_id` is the `reference_id` a line is spoken with.
import type { Voice } from "@/types";
import { fishApiRoot, isFishAudio } from "@/lib/endpointShapes";
import { call, ProviderError, requireKey, type CallOptions } from "~/providers/http";
import type { ProviderTarget } from "~/providers/target";

/** One recording to make the voice from. */
export interface CloneClip {
  name: string;
  /** its media type, as the browser sent it */
  type: string;
  bytes: Uint8Array;
}

export interface CloneRequest {
  /** what the voice is called, on the provider and on the endpoint */
  title: string;
  clips: CloneClip[];
}

/** The port the route clones through; a test hands over one that answers from memory. */
export interface VoiceCloner {
  clone(target: ProviderTarget, request: CloneRequest, signal: AbortSignal): Promise<Voice>;
}

/** Fish takes up to twenty recordings for one voice. */
export const MAX_CLONE_CLIPS = 20;

export function endpointVoiceCloner(options: Omit<CallOptions, "signal"> = {}): VoiceCloner {
  return {
    async clone(target, request, signal) {
      requireKey(target);
      if (!isFishAudio(target))
        throw new ProviderError(
          `${target.name} cannot make a voice from recordings here; only Fish Audio can, so far.`,
          0,
          false,
        );
      const form = new FormData();
      form.set("type", "tts");
      form.set("title", request.title);
      form.set("train_mode", "fast");
      form.set("visibility", "private");
      for (const clip of request.clips)
        form.append("voices", new Blob([clip.bytes], { type: clip.type }), clip.name);
      const res = await call(
        target,
        `${fishApiRoot(target.baseUrl)}/model`,
        {
          method: "POST",
          // no content-type: the multipart boundary is the form's to write
          headers: target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {},
          body: form,
        },
        { signal, ...options },
      );
      const body = (await res.json().catch(() => null)) as {
        _id?: unknown;
        title?: unknown;
      } | null;
      if (typeof body?._id !== "string" || !body._id)
        throw new ProviderError(
          `${target.name} answered ${res.status} without the new voice's id`,
          res.status,
          false,
        );
      const title =
        typeof body.title === "string" && body.title.trim() ? body.title.trim() : request.title;
      return { id: body._id, label: title, gender: "?" };
    },
  };
}
