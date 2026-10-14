// A voice's gender as the Voices tab shows it: picker words and list icons.
import type { Component } from "vue";
import { Dot as NeutralIcon, Mars as MaleIcon, Venus as FemaleIcon } from "@lucide/vue";
import { GENDER } from "@/lib/scriptReview";
import type { Gender } from "@/types";

export const GENDERS = (["f", "m", "n", "?"] as Gender[]).map((value) => ({
  value,
  label: GENDER[value] ?? "unknown",
}));

export const GENDER_ICON: Record<Gender, Component> = {
  m: MaleIcon,
  f: FemaleIcon,
  n: NeutralIcon,
  "?": NeutralIcon,
};
