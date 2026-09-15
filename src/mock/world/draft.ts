// The world as it is being assembled: everything except the finished exports, which are built last
// because their chapter fingerprints depend on the audio seeded above them.
import type { World } from "@/types";

export type WorldDraft = Omit<World, "exports">;
