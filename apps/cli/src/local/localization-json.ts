import { LocalError } from "./errors.js";

type Leaf = {
  key: string;
  text: string;
  segments: string[];
  start: number;
  end: number;
};
type ObjectSpan = {
  segments: string[];
  open: number;
  lastValueEnd: number;
  size: number;
};
type JsonEdit = { start: number; end: number; value: string };
type PatchOperation = {
  key: string;
  targetBefore: string | null;
  targetAfter: string;
};

const identity = (segments: string[]) => JSON.stringify(segments);
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Parse only objects and string leaves, keeping their exact source spans. */
export function parseLocalizationJson(content: string, path: string) {
  try {
    JSON.parse(content);
  } catch {
    throw new LocalError(
      "INVALID_LOCALE_FILE",
      `Configured locale file ${path} is not valid JSON.`,
    );
  }
  const unsupported = (): never => {
    throw new LocalError(
      "UNSUPPORTED_LOCALE_FORMAT",
      `Configured locale file ${path} must contain only nested objects and string translations.`,
    );
  };
  let cursor = 0;
  const leaves = new Map<string, Leaf>();
  const objects = new Map<string, ObjectSpan>();
  const skip = () => {
    while (/[ \t\r\n]/.test(content[cursor] ?? "")) cursor++;
  };
  const readString = () => {
    const start = cursor;
    if (content[cursor++] !== '"') unsupported();
    while (cursor < content.length) {
      if (content[cursor] === "\\") cursor += 2;
      else if (content[cursor++] === '"')
        return {
          value: JSON.parse(content.slice(start, cursor)) as string,
          start,
          end: cursor,
        };
    }
    return unsupported();
  };
  const parseObject = (segments: string[]): void => {
    if (segments.length > 20) unsupported();
    const open = cursor;
    if (content[cursor++] !== "{") unsupported();
    const children = new Set<string>();
    let lastValueEnd = cursor;
    skip();
    while (content[cursor] !== "}") {
      const property = readString();
      if (!property.value) unsupported();
      if (children.has(property.value))
        throw new LocalError(
          "DUPLICATE_LOCALE_KEY",
          `Configured locale file ${path} contains a duplicate key.`,
        );
      children.add(property.value);
      skip();
      if (content[cursor++] !== ":") unsupported();
      skip();
      const childPath = [...segments, property.value];
      if (content[cursor] === "{") {
        parseObject(childPath);
      } else if (content[cursor] === '"') {
        const value = readString();
        const key = childPath.join(".");
        if (leaves.has(key))
          throw new LocalError(
            "DUPLICATE_LOCALE_KEY",
            `Configured locale file ${path} has ambiguous nested keys.`,
          );
        if (key.length > 512 || value.value.length > 100_000) unsupported();
        leaves.set(key, {
          key,
          text: value.value,
          segments: childPath,
          start: value.start,
          end: value.end,
        });
        if (leaves.size > 10_000) unsupported();
      } else unsupported();
      lastValueEnd = cursor;
      skip();
      if (content[cursor] === ",") {
        cursor++;
        skip();
      } else break;
    }
    skip();
    if (content[cursor++] !== "}") unsupported();
    objects.set(identity(segments), {
      segments,
      open,
      lastValueEnd,
      size: children.size,
    });
  };
  skip();
  parseObject([]);
  skip();
  if (cursor !== content.length) unsupported();
  return {
    entries: [...leaves.values()]
      .sort((a, b) => order(a.key, b.key))
      .map(({ key, text }) => ({ key, text })),
    leaves,
    objects,
  };
}

type AdditionTree = Map<string, string | AdditionTree>;

/** Change only reviewed string spans or insert reviewed nested keys. */
export function patchLocalizationJson(
  content: string,
  sourceContent: string,
  operations: PatchOperation[],
  path: string,
): string {
  const source = parseLocalizationJson(sourceContent, path);
  const target = parseLocalizationJson(content, path);
  const edits: JsonEdit[] = [];
  const additions = new Map<
    string,
    { object: ObjectSpan; tree: AdditionTree }
  >();
  const seen = new Set<string>();
  for (const operation of operations) {
    if (seen.has(operation.key))
      throw new LocalError(
        "PATCH_CONFLICT",
        "Patch repeats a translation key.",
      );
    seen.add(operation.key);
    const sourceLeaf = source.leaves.get(operation.key);
    const targetLeaf = target.leaves.get(operation.key);
    if (
      !sourceLeaf ||
      (targetLeaf?.text ?? null) !== operation.targetBefore ||
      (targetLeaf &&
        identity(targetLeaf.segments) !== identity(sourceLeaf.segments))
    )
      throw new LocalError(
        "PATCH_CONFLICT",
        "Translation structure differs from the reviewed baseline.",
      );
    if (targetLeaf) {
      edits.push({
        start: targetLeaf.start,
        end: targetLeaf.end,
        value: JSON.stringify(operation.targetAfter),
      });
      continue;
    }
    const segments = sourceLeaf.segments;
    let parentLength = segments.length - 1;
    while (!target.objects.has(identity(segments.slice(0, parentLength)))) {
      if (target.leaves.has(segments.slice(0, parentLength).join(".")))
        throw new LocalError(
          "PATCH_CONFLICT",
          "Target translation parent is a string instead of an object.",
        );
      parentLength--;
    }
    const object = target.objects.get(
      identity(segments.slice(0, parentLength)),
    )!;
    const bucket = additions.get(identity(object.segments)) ?? {
      object,
      tree: new Map<string, string | AdditionTree>(),
    };
    let node = bucket.tree;
    for (let index = parentLength; index < segments.length - 1; index++) {
      const key = segments[index];
      const current = node.get(key);
      if (typeof current === "string")
        throw new LocalError("PATCH_CONFLICT", "Translation paths overlap.");
      if (!current) node.set(key, new Map<string, string | AdditionTree>());
      node = node.get(key) as AdditionTree;
    }
    const leafKey = segments.at(-1)!;
    if (node.has(leafKey))
      throw new LocalError("PATCH_CONFLICT", "Translation paths overlap.");
    node.set(leafKey, operation.targetAfter);
    additions.set(identity(object.segments), bucket);
  }
  if (
    target.leaves.size +
      operations.filter((operation) => !target.leaves.has(operation.key))
        .length >
    10_000
  )
    throw new LocalError(
      "PATCH_CONFLICT",
      "Configured locale file would exceed the supported entry limit.",
    );
  const pretty = content.includes("\n");
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const unit = /\n([ \t]+)"/.exec(content)?.[1] ?? "  ";
  const indent = (depth: number) => unit.repeat(depth);
  const renderPair = (
    key: string,
    value: string | AdditionTree,
    depth: number,
  ): string =>
    `${JSON.stringify(key)}:${pretty ? " " : ""}${typeof value === "string" ? JSON.stringify(value) : renderObject(value, depth)}`;
  const renderObject = (tree: AdditionTree, depth: number): string => {
    const pairs = [...tree].sort(([a], [b]) => order(a, b));
    if (!pretty)
      return `{${pairs.map(([key, value]) => renderPair(key, value, depth + 1)).join(",")}}`;
    return `{${newline}${indent(depth + 1)}${pairs
      .map(([key, value]) => renderPair(key, value, depth + 1))
      .join(`,${newline}${indent(depth + 1)}`)}${newline}${indent(depth)}}`;
  };
  for (const { object, tree } of additions.values()) {
    const depth = object.segments.length;
    const pairs = [...tree]
      .sort(([a], [b]) => order(a, b))
      .map(([key, value]) => renderPair(key, value, depth + 1))
      .join(pretty ? `,${newline}${indent(depth + 1)}` : ",");
    const prefix = object.size ? "," : "";
    const value = pretty
      ? `${prefix}${newline}${indent(depth + 1)}${pairs}${object.size ? "" : `${newline}${indent(depth)}`}`
      : `${prefix}${pairs}`;
    const position = object.size ? object.lastValueEnd : object.open + 1;
    edits.push({ start: position, end: position, value });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    content =
      content.slice(0, edit.start) + edit.value + content.slice(edit.end);
  return content;
}
