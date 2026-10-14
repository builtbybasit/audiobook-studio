// The world being assembled: everything but exports, built last as they fingerprint the audio.
import type { World } from "@/types";

export type WorldDraft = Omit<World, "exports">;
