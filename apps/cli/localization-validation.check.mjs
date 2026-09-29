import test from "node:test";
import assert from "node:assert/strict";
import { validateLocalizationProposal } from "./dist/local/localization-validation.js";
import { localizationSourceRevision } from "./dist/local/localization-entries.js";

const entry = (sourceText) => ({
  key: "checkout.payment_failed",
  namespace: "checkout",
  sourceLocale: "en",
  sourceText,
  sourcePath: "locales/en.json",
  sourceRevision: localizationSourceRevision(
    "en",
    "checkout.payment_failed",
    sourceText,
  ),
  sourceCommitSha: "b".repeat(40),
  targetLocale: "de",
  targetText: null,
  targetPath: "locales/de.json",
  targetBlobSha: "c".repeat(40),
  status: "missing",
});

const codes = (result) => result.errors.map((item) => item.code);

test("preserves named placeholders and ICU argument types", () => {
  const source = entry("Hello {name}, you have {count} messages.");
  assert.equal(
    validateLocalizationProposal(
      source,
      "Hallo {name}, du hast {count} Nachrichten.",
    ).valid,
    true,
  );
  assert.deepEqual(
    codes(validateLocalizationProposal(source, "Hallo {name}.")),
    ["MISSING_PLACEHOLDER"],
  );
  assert.deepEqual(
    codes(
      validateLocalizationProposal(source, "Hallo {name}, {count}, {other}."),
    ),
    ["EXTRA_PLACEHOLDER"],
  );
  assert.deepEqual(
    codes(
      validateLocalizationProposal(
        entry("Total {count, number}"),
        "Gesamt {count}",
      ),
    ),
    ["PLACEHOLDER_TYPE_CHANGED"],
  );
});

test("validates plural syntax and allows locale-specific plural selectors", () => {
  const source = entry("{count, plural, one {# item} other {# items}}");
  assert.equal(
    validateLocalizationProposal(
      source,
      "{count, plural, one {# Element} few {# Elemente} other {# Elemente}}",
    ).valid,
    true,
  );
  const invalid = validateLocalizationProposal(
    source,
    "{count, plural, one {# Element}}",
  );
  assert.deepEqual(codes(invalid), ["TARGET_ICU_SYNTAX"]);
  assert.equal(invalid.errors[0].key, source.key);
  assert.equal(invalid.errors[0].locale, "de");
  assert.equal(typeof invalid.errors[0].line, "number");
  assert.deepEqual(
    codes(
      validateLocalizationProposal(
        source,
        "{total, plural, other {# Elemente}}",
      ),
    ),
    ["MISSING_PLACEHOLDER", "EXTRA_PLACEHOLDER"],
  );
});

test("checks supported balanced markup, quoting, and source revision", () => {
  const source = entry("<b>Pay {amount, number}</b> and '{literal}'");
  assert.equal(
    validateLocalizationProposal(
      source,
      "<b>{amount, number} bezahlen</b> und '{literal}'",
    ).valid,
    true,
  );
  assert.deepEqual(
    codes(validateLocalizationProposal(source, "{amount, number} bezahlen")),
    ["MISSING_TAG"],
  );
  assert.deepEqual(
    codes(
      validateLocalizationProposal(source, "<script>{amount, number}</script>"),
    ),
    ["UNSUPPORTED_TAG", "MISSING_TAG", "EXTRA_TAG"],
  );
  assert.deepEqual(
    codes(validateLocalizationProposal(source, "<b>{amount, number}")),
    ["TARGET_ICU_SYNTAX"],
  );
  assert.deepEqual(
    codes(
      validateLocalizationProposal(
        source,
        "<b>{amount, number}</b>",
        "d".repeat(64),
      ),
    ),
    ["SOURCE_CHANGED"],
  );
});

test("rejects malformed ICU and blank translations without model calls", () => {
  assert.deepEqual(
    codes(
      validateLocalizationProposal(
        { ...entry("Hello"), sourceRevision: "a".repeat(64) },
        "Hallo",
      ),
    ),
    ["INVALID_SOURCE_REVISION"],
  );
  assert.deepEqual(
    codes(validateLocalizationProposal(entry("Hello {name"), "Hallo {name}")),
    ["SOURCE_ICU_SYNTAX"],
  );
  assert.deepEqual(
    codes(validateLocalizationProposal(entry("Hello {name}"), "  ")),
    ["INVALID_TARGET_TEXT"],
  );
});
