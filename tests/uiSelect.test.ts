// What a closed UiSelect shows for its value (`selectLabel`): the option's label, the null option,
// or — for a value no option has — the placeholder, marked as missing, and never the raw value.
import { expect, test } from "bun:test";

import { selectLabel } from "@/ui/select";

const options = [
  { value: "local", label: "Local speech" },
  { value: 128, label: "128 kbps" },
  { value: "", label: "None" },
];

test("a value an option has shows that option's label, matched the way the list matches it", () => {
  expect(selectLabel("local", options)).toEqual({ label: "Local speech", missing: false });
  expect(selectLabel("128", options)).toEqual({ label: "128 kbps", missing: false });
  expect(selectLabel("", options)).toEqual({ label: "None", missing: false });
});

test("a value no option has is missing, and its id is not shown as though it were a choice", () => {
  // an endpoint removed since it was picked
  expect(selectLabel("openai", options)).toEqual({ label: "", missing: true });
  expect(selectLabel("openai", [])).toEqual({ label: "", missing: true });
});

test("no value is the null option when there is one, and otherwise the placeholder", () => {
  expect(selectLabel(null, options, "Model default")).toEqual({
    label: "Model default",
    missing: false,
  });
  expect(selectLabel(undefined, options)).toEqual({ label: "", missing: false });
});
