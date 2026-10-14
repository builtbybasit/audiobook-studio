import type { Component } from "vue";

/** One row in the UiSelect / UiCombobox / UiToggleGroup pickers. */
export interface UiOption {
  value: string | number | null;
  label: string;
  /** group heading in the dropdown */
  group?: string;
  /** dimmed text on the right of the row */
  hint?: string;
  color?: string;
  /** extra text the combobox search matches */
  keywords?: string;
  disabled?: boolean;
  /** extra classes, used by UiToggleGroup */
  class?: string;
  /** leading icon, used by UiToggleGroup */
  icon?: Component;
}
