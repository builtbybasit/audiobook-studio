/** One row in the UiSelect / UiCombobox / UiToggleGroup pickers. */
export interface UiOption {
  value: string | number | null;
  label: string;
  /** heading the option is filed under in the dropdown */
  group?: string;
  /** dimmed text on the right of the row */
  hint?: string;
  /** swatch colour, e.g. a character's colour */
  color?: string;
  /** extra text the combobox search matches against */
  keywords?: string;
  disabled?: boolean;
  /** extra classes, used by UiToggleGroup */
  class?: string;
}
