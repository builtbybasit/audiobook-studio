// The machine's NVIDIA GPUs from `nvidia-smi`, which comes with the driver on Windows and Linux.
// No NVIDIA GPU or no driver: no GPUs.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GpuInfo } from "@/types";

const QUERY = [
  "--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu",
  "--format=csv,noheader,nounits",
];

/** `[N/A]` and `[Not Supported]` are what the driver says it doesn't know */
const num = (s: string | undefined): number | null =>
  s && /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;

/** One GPU per line; a line without its index and memory is skipped. */
export function parseGpus(csv: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const [index, name, used, total, utilization, temperature] = line
      .split(",")
      .map((s) => s.trim());
    const i = num(index);
    const memoryUsedMb = num(used);
    const memoryTotalMb = num(total);
    if (i === null || !name || memoryUsedMb === null || memoryTotalMb === null) continue;
    gpus.push({
      index: i,
      name,
      memoryUsedMb,
      memoryTotalMb,
      utilization: num(utilization),
      temperature: num(temperature),
    });
  }
  return gpus;
}

const nvidiaSmi = async (): Promise<string> =>
  (await promisify(execFile)("nvidia-smi", QUERY, { timeout: 2000, windowsHide: true })).stdout;

/** A reader that asks `run` at most once per `maxAgeMs` (default 1 s: the page polls). */
export function createGpuReader(
  run: () => Promise<string> = nvidiaSmi,
): (maxAgeMs?: number) => Promise<GpuInfo[]> {
  let last: { at: number; gpus: Promise<GpuInfo[]> } | undefined;
  return (maxAgeMs = 1000) => {
    if (!last || Date.now() - last.at >= maxAgeMs)
      last = { at: Date.now(), gpus: run().then(parseGpus, () => []) };
    return last.gpus;
  };
}

export const readGpus = createGpuReader();
