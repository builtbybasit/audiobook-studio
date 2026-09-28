// One voice's folder in a script file — `voices/<slug>/`, its recordings and their `consent.json` —
// judged whole: usable, or refused saying why. See docs/script-transfer.md, slice 3.
//
// **Held to the clone route's own limits.** These recordings exist to be cloned from, and the clone
// route refuses more than it takes (`server/routes/endpoints.ts`); a folder it would refuse is one
// that could never become a voice, so it is refused here, before a byte of it is kept. Every file
// is checked by its first bytes (`sniffRecording`) — a name ending `.wav` is a claim, not a format.
//
// **Refused whole, and alone.** One file that is not audio, or one too many, refuses that voice's
// recordings and nothing else: the lines, the cast and every other voice still import.
import * as v from "valibot";

import type { ScriptFileVoice, VoiceRowSamples } from "@/types";
import { MAX_CLONE_CLIPS } from "@/lib/endpointShapes";
import { sniffRecording, type RecordingFormat } from "~/providers/clone";

const MB = 1024 * 1024;

export interface SampleLimits {
  /** any one recording, in bytes */
  clip: number;
  /** one voice's recordings together, in bytes */
  voice: number;
  /** how many recordings one voice may have */
  clips: number;
}

/** The clone route's: 20 MB a recording, 100 MB a voice, and `MAX_CLONE_CLIPS` of them. */
export const SAMPLE_LIMITS: SampleLimits = {
  clip: 20 * MB,
  voice: 100 * MB,
  clips: MAX_CLONE_CLIPS,
};

export const VOICE_SAMPLES_FORMAT = "audiobook-studio/voice-samples";

const ScriptFileVoiceSchema = v.object({
  format: v.literal(VOICE_SAMPLES_FORMAT),
  version: v.literal(1),
  title: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty")),
  consentAt: v.pipe(
    v.string(),
    v.check((s) => !Number.isNaN(Date.parse(s)), "must be a date"),
  ),
  consentText: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty")),
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

/**
 * One entry of a voice's folder, as the zip guard measured it: `bytes` when it was kept, and
 * `partial` when only its first bytes were — enough to judge it by, not enough to keep.
 */
export interface FolderEntry {
  size: number;
  bytes?: Uint8Array;
  partial?: boolean;
}

/** A recording that passed, as it will be kept — or, from a read that held only heads, judged. */
export interface JudgedClip {
  name: string;
  format: RecordingFormat;
  bytes: Uint8Array;
  /** only the head of the recording is in `bytes`: judged, and not to be kept */
  partial?: boolean;
}

export type JudgedVoice =
  | { ok: true; voice: ScriptFileVoice; clips: JudgedClip[]; bytes: number }
  | { ok: false; reason: string };

/**
 * The folder a cast entry names, as a path inside the zip relative to the manifest — `voices/vex/`
 * — or null when it names nothing that could be one: an absolute path, a `..`, or nothing at all.
 */
export function folderOf(samples: unknown): string | null {
  if (typeof samples !== "string") return null;
  const path = samples.trim().replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return null;
  return path.endsWith("/") ? path : `${path}/`;
}

const decoder = new TextDecoder("utf-8");

/**
 * Judge the recordings in `folder`: `entries` holds every file of the zip under the manifest's
 * folder, by its path relative to it. A folder is usable when its `consent.json` reads, and every
 * recording it names is there, is audio, and fits the limits.
 */
export function judgeVoiceFolder(
  folder: string,
  entries: ReadonlyMap<string, FolderEntry>,
  limits: SampleLimits = SAMPLE_LIMITS,
): JudgedVoice {
  const refused = (reason: string): JudgedVoice => ({ ok: false, reason });
  const consent = entries.get(`${folder}consent.json`);
  if (!consent) return refused(`${folder} has no consent.json saying what the recordings are`);
  if (!consent.bytes) return refused(`${folder}consent.json could not be unzipped`);
  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(consent.bytes).replace(/^﻿/, ""));
  } catch {
    return refused(`${folder}consent.json is not valid JSON`);
  }
  const parsed = v.safeParse(ScriptFileVoiceSchema, json);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    return refused(
      `${folder}consent.json could not be read: ${[v.getDotPath(issue), issue.message].filter(Boolean).join(": ")}`,
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
    if (!entry) return refused(`${s.file} is named in consent.json but is not in ${folder}`);
    if (entry.size > limits.clip)
      return refused(
        `${s.file} is ${mb(entry.size)}, over the ${mb(limits.clip)} limit on one recording`,
      );
    total += entry.size;
    if (total > limits.voice)
      return refused(`the recordings come to over ${mb(limits.voice)}, the limit for one voice`);
    if (!entry.bytes) return refused(`${s.file} could not be unzipped`);
    const format = sniffRecording(entry.bytes.subarray(0, 512));
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

/** What a voice row says of a judged folder. */
export function rowSamples(judged: JudgedVoice): VoiceRowSamples {
  if (!judged.ok) return { kind: "refused", reason: judged.reason };
  return {
    kind: "ok",
    count: judged.clips.length,
    bytes: judged.bytes,
    consentAt: judged.voice.consentAt,
    consentText: judged.voice.consentText,
  };
}

const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;
