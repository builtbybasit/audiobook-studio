// Whether a key press is the sheet's to take. The sheet listens on the window, since a view that
// slides out takes the focus with it; but a dialog or a popover opened over the sheet (Paste
// Python, Delete, the ⋯ menu, Add step) is another `role=dialog`, and its keys are its own.
export const sheetOnTop = (): boolean => document.querySelectorAll("[role=dialog]").length <= 1;
