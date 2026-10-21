// The Endpoints page's backup: `settings.json` plus every cloned voice's kept samples, zipped, so a
// fresh install can keep them again and remake a voice its server lost. A bare JSON file still
// reads, without samples.
import type { KeptSample, SettingsFile } from "@/types";

export const SETTINGS_ENTRY = "settings.json";

/** One voice's kept samples, as its folder of the zip names them. */
export interface BackupVoice {
  endpointId: string;
  voiceId: string;
  title: string;
  samples: (Pick<KeptSample, "name" | "format" | "transcript"> & { path: string })[];
}

export interface BackupSamples {
  endpointId: string;
  voiceId: string;
  samples: File[];
  transcripts: string[];
}

export interface PackVoice {
  endpointId: string;
  /** the folder its samples go in */
  endpointName: string;
  voiceId: string;
  /** what its samples are named after */
  title: string;
  samples: (KeptSample & { blob: Blob })[];
}

/** What a file name may not hold on any common system. */
const fileSafe = (name: string): string =>
  name
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");

/**
 * `voices/<endpoint>/<voice>.<ext>`, then `<voice> 2`, `<voice> 3`… for its other samples; a name
 * another voice in the folder holds becomes `<voice> (2)`. Case-blind, as macOS and Windows are.
 */
function samplePaths(voices: PackVoice[]): string[][] {
  const taken = new Set<string>();
  return voices.map((v) => {
    const folder = `voices/${fileSafe(v.endpointName) || fileSafe(v.endpointId) || "endpoint"}/`;
    const base = fileSafe(v.title) || "voice";
    for (let n = 1; ; n++) {
      const stem = n === 1 ? base : `${base} (${n})`;
      const stems = v.samples.map((_, j) => folder + (j ? `${stem} ${j + 1}` : stem));
      if (stems.some((s) => taken.has(s.toLowerCase()))) continue;
      for (const s of stems) taken.add(s.toLowerCase());
      return stems.map((s, j) => `${s}.${v.samples[j].format}`);
    }
  });
}

export async function packBackup(settings: SettingsFile, voices: PackVoice[]): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const listed: BackupVoice[] = [];
  const paths = samplePaths(voices);
  for (const [i, v] of voices.entries()) {
    const samples = v.samples.map((s, j) => {
      const path = paths[i][j];
      // stored, not deflated: audio barely compresses
      zip.file(path, s.blob, { compression: "STORE" });
      return {
        path,
        name: s.name,
        format: s.format,
        ...(s.transcript ? { transcript: s.transcript } : {}),
      };
    });
    listed.push({ endpointId: v.endpointId, voiceId: v.voiceId, title: v.title, samples });
  }
  zip.file(SETTINGS_ENTRY, JSON.stringify({ ...settings, voiceSamples: listed }, null, 2));
  return zip.generateAsync({ type: "blob", mimeType: "application/zip", compression: "DEFLATE" });
}

/** A zip from `packBackup` or a bare settings JSON. Throws on anything else. */
export async function unpackBackup(
  file: Blob,
): Promise<{ settings: SettingsFile; samples: BackupSamples[] }> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x50 || head[1] !== 0x4b)
    return { settings: JSON.parse(await file.text()) as SettingsFile, samples: [] };
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(file);
  const entry = zip.file(SETTINGS_ENTRY);
  if (!entry) throw new Error(`no ${SETTINGS_ENTRY} in the zip`);
  const { voiceSamples = [], ...settings } = JSON.parse(
    await entry.async("text"),
  ) as SettingsFile & {
    voiceSamples?: BackupVoice[];
  };
  const samples: BackupSamples[] = [];
  for (const v of voiceSamples) {
    const files: File[] = [];
    for (const s of v.samples) {
      const blob = await zip.file(s.path)?.async("blob");
      if (!blob) throw new Error(`${s.path} is missing from the zip`);
      files.push(new File([blob], s.name));
    }
    samples.push({
      endpointId: v.endpointId,
      voiceId: v.voiceId,
      samples: files,
      transcripts: v.samples.map((s) => s.transcript ?? ""),
    });
  }
  return { settings, samples };
}
