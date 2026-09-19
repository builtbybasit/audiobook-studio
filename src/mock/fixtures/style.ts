// Presentation fixtures: the colours a cast is assigned from and the delivery notes the script
// generator and the direction picker both draw on.

// The palette itself is in `@/lib/cast`, where the server's scripting job can reach it too.
export { PALETTE } from "@/lib/cast";

export const DIRECTIONS: string[] = [
  "calm, measured",
  "urgent, breathless",
  "whispered, hesitant",
  "dry, amused",
  "cold and clipped",
  "warm, gentle",
  "rising anger",
  "weary, slow",
  "excited, quick",
  "sarcastic, flat",
  "gravely serious",
  "teasing, light",
  "trembling",
  "commanding",
  "muttered under breath",
];
