// Whether a key press is the sheet's. The sheet listens on the window (a sliding view takes the
// focus with it), so a dialog or popover opened over it keeps its own keys.
export const sheetOnTop = (): boolean => document.querySelectorAll("[role=dialog]").length <= 1;
