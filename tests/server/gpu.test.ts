// `nvidia-smi` answers read into GPUs, and none when it is missing.
import { describe, expect, test } from "bun:test";

import { createGpuReader, parseGpus } from "~/servers/gpu";

const LAPTOP = {
  index: 0,
  name: "NVIDIA GeForce RTX 4060 Laptop GPU",
  memoryUsedMb: 5612,
  memoryTotalMb: 8188,
  utilization: 37,
  temperature: 61,
};

describe("gpus", () => {
  test.each([
    ["one GPU", "0, NVIDIA GeForce RTX 4060 Laptop GPU, 5612, 8188, 37, 61\r\n", [LAPTOP]],
    [
      "what the driver doesn't know",
      "0, NVIDIA GeForce RTX 4060 Laptop GPU, 5612, 8188, [N/A], [Not Supported]\n",
      [{ ...LAPTOP, utilization: null, temperature: null }],
    ],
    [
      "two GPUs",
      "0, NVIDIA GeForce RTX 4060 Laptop GPU, 5612, 8188, 37, 61\n1, Tesla T4, 0, 15360, 0, 40\n",
      [
        LAPTOP,
        {
          index: 1,
          name: "Tesla T4",
          memoryUsedMb: 0,
          memoryTotalMb: 15360,
          utilization: 0,
          temperature: 40,
        },
      ],
    ],
    ["garbage", "NVIDIA-SMI has failed because it couldn't communicate with the driver", []],
  ])("nvidia-smi: %s", (_, csv, gpus) => {
    expect(parseGpus(csv)).toEqual(gpus);
  });

  test("no nvidia-smi, no GPUs", async () => {
    const read = createGpuReader(() => Promise.reject(new Error("spawn nvidia-smi ENOENT")));
    expect(await read()).toEqual([]);
  });
});
