// One voice's folder in a script file (`voices/<slug>/` and its `samples.json`), judged whole. Held
// to the clone route's limits, since a folder it would refuse can never become a voice. A refusal
// rejects that voice's recordings only; the lines, cast and other voices still import.
import * as v from "valibot";

import type { ScriptFileVoice, VoiceRowSamples } from "@/types";
import { MAX_VOICE_SAMPLES } from "@/lib/voiceSamples";
import { sniffSample, type SampleFormat } from "~/providers/clone";

const MB = 1024 * 1024;

export interface SampleLimits {
  /** bytes, one recording */
  clip: number;
  /** bytes, one voice's recordings together */
  voice: number;
  /** recordings per voice */
  clips: number;
}

/** The clone route's. */
export const SAMPLE_LIMITS: SampleLimits = {
  clip: 20 * MB,
  voice: 100 * MB,
  clips: MAX_VOICE_SAMPLES,
};

export const VOICE_SAMPLES_FORMAT = "audiobook-studio/voice-samples";

export const SAMPLES_MANIFEST = "samples.json";
/** Older exports' name; its consent fields are ignored. */
const OLD_SAMPLES_MANIFEST = "consent.json";

const ScriptFileVoiceSchema = v.object({
  format: v.literal(VOICE_SAMPLES_FORMAT),
  version: v.literal(1),
  title: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty")),
  samples: v.pipe(
    v.array(
      v.object({
        file: v.pipe(v.string(), v.nonEmpty()),
        name: v.string(),
        format: v.picklist(["wav", "mp3", "m4a", "opus", "flac"]),
      }),
    ),
    v.minLength(1, "must name at least one recording"),
  ),
}) satisfies v.GenericSchema<unknown, ScriptFileVoice>;

/** As the zip guard measured it; `partial`: only the head was kept, enough to judge, not keep. */
export interface FolderEntry {
  size: number;
  bytes?: Uint8Array;
  partial?: boolean;
}

export interface JudgedClip {
  name: string;
  format: SampleFormat;
  bytes: Uint8Array;
  /** only the head is in `bytes`: not to be kept */
  partial?: boolean;
}

export type JudgedVoice =
  | { ok: true; voice: ScriptFileVoice; clips: JudgedClip[]; bytes: number }
  | { ok: false; reason: string };

/** Relative to the manifest (`voices/vex/`); null for an absolute path, a `..`, or nothing. */
export function folderOf(samples: unknown): string | null {
  if (typeof samples !== "string") return null;
  const path = samples.trim().replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return null;
  return path.endsWith("/") ? path : `${path}/`;
}

const decoder = new TextDecoder("utf-8");

/** `entries` is keyed by path relative to the manifest's folder. Formats are sniffed, not named. */
export function judgeVoiceFolder(
  folder: string,
  entries: ReadonlyMap<string, FolderEntry>,
  limits: SampleLimits = SAMPLE_LIMITS,
): JudgedVoice {
  const refused = (reason: string): JudgedVoice => ({ ok: false, reason });
  const name = entries.has(`${folder}${SAMPLES_MANIFEST}`)
    ? SAMPLES_MANIFEST
    : OLD_SAMPLES_MANIFEST;
  const listing = entries.get(`${folder}${name}`);
  if (!listing)
    return refused(`${folder} has no ${SAMPLES_MANIFEST} saying what the recordings are`);
  if (!listing.bytes) return refused(`${folder}${name} could not be unzipped`);
  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(listing.bytes).replace(/^﻿/, ""));
  } catch {
    return refused(`${folder}${name} is not valid JSON`);
  }
  const parsed = v.safeParse(ScriptFileVoiceSchema, json);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    return refused(
      `${folder}${name} could not be read: ${[v.getDotPath(issue), issue.message].filter(Boolean).join(": ")}`,
    );
  }
  const voice = parsed.output;
  if (voice.samples.length > limits.clips)
    return refused(
      `${voice.samples.length} recordings, over the ${limits.clips} a voice can be cloned from`,
    );

  const clips: JudgedClip[] = [];
  let total = 0;
  for (const s of voice.samples) {
    const entry = entries.get(`${folder}${s.file}`);
    if (!entry) return refused(`${s.file} is named in ${name} but is not in ${folder}`);
    if (entry.size > limits.clip)
      return refused(
        `${s.file} is ${mb(entry.size)}, over the ${mb(limits.clip)} limit on one recording`,
      );
    total += entry.size;
    if (total > limits.voice)
      return refused(`the recordings come to over ${mb(limits.voice)}, the limit for one voice`);
    if (!entry.bytes) return refused(`${s.file} could not be unzipped`);
    const format = sniffSample(entry.bytes.subarray(0, 512));
    if (!format) return refused(`${s.file} is not a WAV, MP3, M4A, Opus or FLAC recording`);
    clips.push({
      name: s.name || s.file,
      format,
      bytes: entry.bytes,
      ...(entry.partial ? { partial: true } : {}),
    });
  }
  return { ok: true, voice, clips, bytes: total };
}

export function rowSamples(judged: JudgedVoice): VoiceRowSamples {
  if (!judged.ok) return { kind: "refused", reason: judged.reason };
  return {
    kind: "ok",
    count: judged.clips.length,
    bytes: judged.bytes,
  };
}

const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;
