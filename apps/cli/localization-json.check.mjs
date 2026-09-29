import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLocalizationJson,
  patchLocalizationJson,
} from "./dist/local/localization-json.js";

test("nested JSON discovery flattens leaf keys and preserves target formatting", () => {
  const source =
    '{\n  "actions": {\n    "cancel": "Cancel",\n    "save": "Save"\n  },\n  "brand": "App"\n}\n';
  const target =
    '{\n  "actions": {\n    "save": "Speichern"\n  },\n  "brand": "App"\n}\n';
  assert.deepEqual(parseLocalizationJson(source, "en.json").entries, [
    { key: "actions.cancel", text: "Cancel" },
    { key: "actions.save", text: "Save" },
    { key: "brand", text: "App" },
  ]);
  assert.equal(
    patchLocalizationJson(
      target,
      source,
      [
        { key: "actions.cancel", targetBefore: null, targetAfter: "Abbrechen" },
        {
          key: "actions.save",
          targetBefore: "Speichern",
          targetAfter: "Sichern",
        },
      ],
      "de.json",
    ),
    '{\n  "actions": {\n    "save": "Sichern",\n    "cancel": "Abbrechen"\n  },\n  "brand": "App"\n}\n',
  );
});

test("nested additions create missing parents without changing other entries", () => {
  const source =
    '{\n  "home": {\n    "title": "Home",\n    "new": {\n      "label": "New"\n    }\n  }\n}\n';
  const target = '{\n  "home": {\n    "title": "Start"\n  }\n}\n';
  const updated = patchLocalizationJson(
    target,
    source,
    [{ key: "home.new.label", targetBefore: null, targetAfter: "Neu" }],
    "de.json",
  );
  assert.deepEqual(JSON.parse(updated), {
    home: { title: "Start", new: { label: "Neu" } },
  });
  assert.match(updated, /"title": "Start"/);
});

test("ambiguous keys, unsupported values, and conflicting target shapes fail closed", () => {
  assert.throws(
    () => parseLocalizationJson('{"a":{"b":"one","\\u0062":"two"}}', "en.json"),
    { code: "DUPLICATE_LOCALE_KEY" },
  );
  assert.throws(
    () => parseLocalizationJson('{"a.b":"one","a":{"b":"two"}}', "en.json"),
    { code: "DUPLICATE_LOCALE_KEY" },
  );
  assert.throws(() => parseLocalizationJson('{"a":["one"]}', "en.json"), {
    code: "UNSUPPORTED_LOCALE_FORMAT",
  });
  assert.throws(
    () =>
      patchLocalizationJson(
        '{"a":"Other"}',
        '{"a":{"b":"Source"}}',
        [{ key: "a.b", targetBefore: null, targetAfter: "Ziel" }],
        "de.json",
      ),
    { code: "PATCH_CONFLICT" },
  );
  assert.throws(
    () =>
      patchLocalizationJson(
        '{"a.b":"Old"}',
        '{"a":{"b":"Source"}}',
        [{ key: "a.b", targetBefore: "Old", targetAfter: "Neu" }],
        "de.json",
      ),
    { code: "PATCH_CONFLICT" },
  );
});
