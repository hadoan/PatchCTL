import {
  parse,
  TYPE,
  type MessageFormatElement,
} from "@formatjs/icu-messageformat-parser";
import {
  localizationSourceRevision,
  type LocalizationEntry,
} from "./localization-entries.js";

export type LocalizationValidationError = {
  code: string;
  message: string;
  key: string;
  locale: string;
  line?: number;
  column?: number;
};

type Structure = {
  arguments: Map<string, number>;
  tags: Set<string>;
};
const supportedTags = new Set(["b", "strong", "i", "em", "u", "code", "link"]);

function error(
  entry: LocalizationEntry,
  code: string,
  message: string,
  location?: { line: number; column: number },
): LocalizationValidationError {
  return {
    code,
    message,
    key: entry.key,
    locale: entry.targetLocale,
    ...(location ? { line: location.line, column: location.column } : {}),
  };
}

function syntaxError(
  entry: LocalizationEntry,
  side: "SOURCE" | "TARGET",
  caught: unknown,
): LocalizationValidationError {
  const parser = caught as {
    message?: unknown;
    location?: { start?: { line?: unknown; column?: unknown } };
  };
  const reason =
    typeof parser?.message === "string" && /^[A-Z_]+$/.test(parser.message)
      ? parser.message
      : "INVALID_MESSAGE";
  const position = parser?.location?.start;
  const location =
    typeof position?.line === "number" && typeof position.column === "number"
      ? { line: position.line, column: position.column }
      : undefined;
  return error(
    entry,
    `${side}_ICU_SYNTAX`,
    `${side === "SOURCE" ? "Source" : "Proposed"} message has invalid ICU syntax: ${reason}.`,
    location,
  );
}

function structure(
  ast: MessageFormatElement[],
  entry: LocalizationEntry,
  side: "SOURCE" | "TARGET",
): { value: Structure; errors: LocalizationValidationError[] } {
  const value: Structure = { arguments: new Map(), tags: new Set() };
  const errors: LocalizationValidationError[] = [];
  const visit = (elements: MessageFormatElement[], depth: number) => {
    if (depth > 32) {
      errors.push(
        error(
          entry,
          "UNSUPPORTED_NESTING",
          "ICU messages may nest at most 32 levels.",
        ),
      );
      return;
    }
    for (const element of elements) {
      if (element.type === TYPE.tag) {
        if (!supportedTags.has(element.value))
          errors.push(
            error(
              entry,
              "UNSUPPORTED_TAG",
              `Tag <${element.value}> is not supported.`,
            ),
          );
        value.tags.add(element.value);
        visit(element.children, depth + 1);
      } else if (
        element.type === TYPE.argument ||
        element.type === TYPE.number ||
        element.type === TYPE.date ||
        element.type === TYPE.time ||
        element.type === TYPE.select ||
        element.type === TYPE.plural
      ) {
        const previous = value.arguments.get(element.value);
        if (previous !== undefined && previous !== element.type)
          errors.push(
            error(
              entry,
              "MIXED_PLACEHOLDER_TYPE",
              `${side === "SOURCE" ? "Source" : "Proposed"} message uses {${element.value}} with incompatible ICU types.`,
            ),
          );
        value.arguments.set(element.value, element.type);
        if (element.type === TYPE.select || element.type === TYPE.plural)
          for (const option of Object.values(element.options))
            visit(option.value, depth + 1);
      }
    }
  };
  visit(ast, 0);
  return { value, errors };
}

/** Validate structure only; language quality remains a human judgment. */
export function validateLocalizationProposal(
  entry: LocalizationEntry,
  proposedText: string,
  expectedSourceRevision = entry.sourceRevision,
): { valid: boolean; errors: LocalizationValidationError[] } {
  const errors: LocalizationValidationError[] = [];
  if (
    entry.sourceRevision !==
    localizationSourceRevision(entry.sourceLocale, entry.key, entry.sourceText)
  )
    errors.push(
      error(
        entry,
        "INVALID_SOURCE_REVISION",
        "Source revision does not match the current source text.",
      ),
    );
  if (expectedSourceRevision !== entry.sourceRevision)
    errors.push(
      error(
        entry,
        "SOURCE_CHANGED",
        "Source text changed since this translation was prepared; create and review a new Patch.",
      ),
    );
  if (proposedText.length > 100_000 || proposedText.trim().length === 0) {
    errors.push(
      error(
        entry,
        "INVALID_TARGET_TEXT",
        "Proposed translation must contain 1–100,000 non-whitespace characters.",
      ),
    );
    return { valid: false, errors };
  }
  let sourceAst: MessageFormatElement[];
  let targetAst: MessageFormatElement[];
  try {
    sourceAst = parse(entry.sourceText, {
      requiresOtherClause: true,
      captureLocation: true,
    });
  } catch (caught) {
    errors.push(syntaxError(entry, "SOURCE", caught));
    return { valid: false, errors };
  }
  try {
    targetAst = parse(proposedText, {
      requiresOtherClause: true,
      captureLocation: true,
    });
  } catch (caught) {
    errors.push(syntaxError(entry, "TARGET", caught));
    return { valid: false, errors };
  }
  const source = structure(sourceAst, entry, "SOURCE");
  const target = structure(targetAst, entry, "TARGET");
  errors.push(...source.errors, ...target.errors);
  for (const [name, type] of source.value.arguments) {
    const actual = target.value.arguments.get(name);
    if (actual === undefined)
      errors.push(
        error(
          entry,
          "MISSING_PLACEHOLDER",
          `Proposed message is missing {${name}}.`,
        ),
      );
    else if (actual !== type)
      errors.push(
        error(
          entry,
          "PLACEHOLDER_TYPE_CHANGED",
          `Proposed message changes the ICU type of {${name}}.`,
        ),
      );
  }
  for (const name of target.value.arguments.keys())
    if (!source.value.arguments.has(name))
      errors.push(
        error(
          entry,
          "EXTRA_PLACEHOLDER",
          `Proposed message adds unexpected {${name}}.`,
        ),
      );
  for (const tag of source.value.tags)
    if (!target.value.tags.has(tag))
      errors.push(
        error(
          entry,
          "MISSING_TAG",
          `Proposed message is missing <${tag}> markup.`,
        ),
      );
  for (const tag of target.value.tags)
    if (!source.value.tags.has(tag))
      errors.push(
        error(
          entry,
          "EXTRA_TAG",
          `Proposed message adds unexpected <${tag}> markup.`,
        ),
      );
  return { valid: errors.length === 0, errors };
}
