import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Y from "yjs";
import { mediaTypeForExtension } from "./attachments";
import type { HostRuntime } from "../runtime";
import type { StoredArtifact } from "../store/host-store";

export function artifactFolderSegments(
  artifacts: readonly StoredArtifact[],
  artifact: StoredArtifact,
): readonly string[] {
  const byId = new Map<string, StoredArtifact>();
  for (const row of artifacts) {
    if (row.epicId === artifact.epicId) {
      byId.set(row.artifactId, row);
    }
  }
  const segments: string[] = [];
  const seen = new Set<string>();
  let cursor: StoredArtifact | undefined = artifact;
  while (cursor !== undefined) {
    if (seen.has(cursor.artifactId)) {
      break;
    }
    seen.add(cursor.artifactId);
    segments.unshift(cursor.folderName);
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
  }
  return segments;
}

export function artifactIndexPath(
  runtime: HostRuntime,
  artifact: StoredArtifact,
): string {
  const rows = runtime.store
    .snapshot()
    .artifacts.filter((row) => row.epicId === artifact.epicId);
  return join(
    runtime.dataDir,
    "epics",
    artifact.epicId,
    "artifacts",
    ...artifactFolderSegments(rows, artifact),
    "index.md",
  );
}

export function splitFrontMatter(raw: string): {
  readonly frontMatter: string;
  readonly body: string;
} {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { frontMatter: "", body: raw };
  }
  const rest = raw.slice(4);
  const unix = rest.indexOf("\n---\n");
  const win = rest.indexOf("\r\n---\r\n");
  let close = -1;
  let markerLen = 0;
  if (unix >= 0 && (win < 0 || unix <= win)) {
    close = unix;
    markerLen = "\n---\n".length;
  } else if (win >= 0) {
    close = win;
    markerLen = "\r\n---\r\n".length;
  }
  if (close < 0) {
    return { frontMatter: "", body: raw };
  }
  const frontMatter = raw.slice(0, 4 + close + markerLen);
  return {
    frontMatter,
    body: rest.slice(close + markerLen).replace(/^\n+/u, ""),
  };
}

/**
 * Seeds a collaboration fragment from the artifact's `index.md`.
 *
 * The node names and attribute shapes here are the ones
 * `clients/gui-app/src/editor-core/artifact-document-bundle.ts` builds its
 * ProseMirror schema from, because `@tiptap/y-tiptap` feeds each element
 * straight into `schema.node(nodeName, attrs, children)` — and its catch
 * branch DELETES elements the schema rejects. A wrong node name or a cell
 * that skips its wrapping paragraph is not a rendering bug, it is data loss.
 */
export function seedXmlFragmentFromMarkdown(
  fragment: Y.XmlFragment,
  markdown: string,
): void {
  if (fragment.length > 0) {
    return;
  }
  const body = splitFrontMatter(markdown).body.replace(/\s+$/u, "");
  if (body.length === 0) {
    return;
  }
  const blocks = parseBlocks(body.replaceAll("\r\n", "\n").split("\n"));
  if (blocks.length === 0) {
    return;
  }
  const doc = fragment.doc;
  const insert = (): void => {
    fragment.push([...blocks]);
  };
  if (doc === null) {
    insert();
    return;
  }
  doc.transact(insert);
}

export function xmlFragmentToMarkdown(fragment: Y.XmlFragment): string {
  const blocks: string[] = [];
  fragment.forEach((child: Y.XmlElement | Y.XmlText) => {
    const text = blockToMarkdown(child);
    if (text.length > 0) {
      blocks.push(text);
    }
  });
  return blocks.join("\n\n");
}

export async function readArtifactMarkdown(
  runtime: HostRuntime,
  artifact: StoredArtifact,
): Promise<string> {
  try {
    return await readFile(artifactIndexPath(runtime, artifact), "utf8");
  } catch {
    return "";
  }
}

export async function writeArtifactMarkdownFile(
  runtime: HostRuntime,
  artifact: StoredArtifact,
  body: string,
): Promise<void> {
  const path = artifactIndexPath(runtime, artifact);
  await mkdir(dirname(path), { recursive: true });
  const title = artifact.title.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const frontMatter = `---\ntitle: "${title}"\nkind: ${artifact.kind}\n---\n`;
  const trimmed = body.replace(/^\n+/u, "").replace(/\s+$/u, "");
  const file =
    trimmed.length === 0 ? frontMatter : `${frontMatter}\n${trimmed}\n`;
  await writeFile(path, file, "utf8");
}

/** Attribute values `@tiptap/y-tiptap` writes verbatim into `node.attrs`. */
type AttrValue = string | number | boolean;
type AttrElement = Y.XmlElement<{ [key: string]: AttrValue }>;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/u;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u;
const RULE_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const QUOTE_RE = /^ {0,3}>\s?/u;
const LIST_RE = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/u;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/u;
const IMAGE_RE = /^!\[([^\]]*)\]\(\s*(\S*?)\s*(?:"[^"]*")?\)$/u;
const TABLE_DIVIDER_RE = /^ {0,3}\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/u;

const MERMAID_LANGUAGE = "mermaid";
const WIREFRAME_LANGUAGE = "wireframe";
const WIREFRAME_TITLE = "UI Preview";

function element(
  nodeName: string,
  attributes: Readonly<Record<string, AttrValue>>,
  children: readonly (Y.XmlElement | Y.XmlText)[],
): Y.XmlElement {
  const created = new Y.XmlElement(nodeName);
  // `setAttribute` is typed for string values only; the runtime (and the GUI
  // reading these back) wants real JSON — `level: 3`, `checked: true`.
  const typed: AttrElement = created;
  for (const [key, value] of Object.entries(attributes)) {
    typed.setAttribute(key, value);
  }
  if (children.length > 0) {
    created.insert(0, [...children]);
  }
  return created;
}

function attributeOf(node: Y.XmlElement, name: string): AttrValue | undefined {
  const typed: AttrElement = node;
  return typed.getAttribute(name);
}

function stringAttribute(node: Y.XmlElement, name: string): string {
  const value = attributeOf(node, name);
  return typeof value === "string" ? value : "";
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function startsBlock(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    RULE_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line)
  );
}

function isTableStart(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? "";
  const divider = lines[index + 1];
  return (
    line.includes("|") &&
    divider !== undefined &&
    divider.includes("-") &&
    TABLE_DIVIDER_RE.test(divider)
  );
}

function parseBlocks(lines: readonly string[]): readonly Y.XmlElement[] {
  const blocks: Y.XmlElement[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? "";
        index += 1;
        if (current.trim().startsWith(marker.slice(0, 3))) {
          break;
        }
        body.push(current);
      }
      blocks.push(fencedBlock(fence[2] ?? "", body.join("\n")));
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      blocks.push(
        element("heading", { level: (heading[1] ?? "#").length }, [
          inlineText(heading[2] ?? ""),
        ]),
      );
      index += 1;
      continue;
    }
    if (RULE_RE.test(line)) {
      blocks.push(element("horizontalRule", {}, []));
      index += 1;
      continue;
    }
    if (isTableStart(lines, index)) {
      const table = parseTable(lines, index);
      blocks.push(table.block);
      index = table.next;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE_RE.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(QUOTE_RE, ""));
        index += 1;
      }
      blocks.push(element("blockquote", {}, blockChildren(quoted)));
      continue;
    }
    if (LIST_RE.test(line)) {
      const list = parseList(lines, index);
      blocks.push(...list.blocks);
      index = list.next;
      continue;
    }
    const image = IMAGE_RE.exec(line.trim());
    if (image !== null) {
      blocks.push(imageBlock(image[2] ?? "", image[1] ?? ""));
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (current.trim().length === 0) {
        break;
      }
      if (
        paragraph.length > 0 &&
        (startsBlock(current) || isTableStart(lines, index))
      ) {
        break;
      }
      paragraph.push(current.trim());
      index += 1;
    }
    blocks.push(element("paragraph", {}, [inlineText(paragraph.join("\n"))]));
  }
  return blocks;
}

/** `listItem` / `tableCell` content is `block+` — never a bare text child. */
function blockChildren(lines: readonly string[]): readonly Y.XmlElement[] {
  const blocks = parseBlocks(lines);
  return blocks.length > 0 ? blocks : [element("paragraph", {}, [])];
}

const ATTACHMENT_SRC_RE = /(?:^|\/)([0-9a-f]{64})\.([a-z]+)$/u;

/**
 * An image the GUI pasted is addressed by its content hash
 * (`attachments/<sha256>.<ext>` - see `epic/attachments.ts`), so the hash the
 * renderer fetches by is recoverable from the markdown link alone. Without
 * this the node comes back from disk with no `attachmentHash` and renders as
 * "Image is unavailable" - the body would survive the round trip and the
 * picture would not.
 */
function imageBlock(src: string, alt: string): Y.XmlElement {
  const attributes: Record<string, AttrValue> = { src, alt };
  const addressed = ATTACHMENT_SRC_RE.exec(src);
  if (addressed !== null) {
    attributes.attachmentHash = addressed[1] ?? "";
    const mediaType = mediaTypeForExtension(addressed[2] ?? "");
    if (mediaType !== null) {
      attributes.mediaType = mediaType;
    }
  }
  return element("image", attributes, []);
}

function fencedBlock(language: string, code: string): Y.XmlElement {
  if (language === MERMAID_LANGUAGE) {
    return element("mermaidBlock", { code }, []);
  }
  if (language === WIREFRAME_LANGUAGE) {
    return element(
      "uiPreviewBlock",
      { htmlContent: code, title: WIREFRAME_TITLE },
      [],
    );
  }
  const text = new Y.XmlText();
  if (code.length > 0) {
    text.insert(0, code);
  }
  return element(
    "codeBlock",
    language.length > 0 ? { language } : {},
    code.length > 0 ? [text] : [],
  );
}

interface ListItemDraft {
  readonly kind: "bullet" | "ordered" | "task";
  readonly checked: boolean;
  readonly start: number;
  readonly lines: readonly string[];
}

function parseList(
  lines: readonly string[],
  from: number,
): { readonly blocks: readonly Y.XmlElement[]; readonly next: number } {
  const items: ListItemDraft[] = [];
  let index = from;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const match = LIST_RE.exec(line);
    if (match === null || (match[1] ?? "").length > 3) {
      break;
    }
    const rest = match[4] ?? "";
    const column = line.length - rest.length;
    const task = TASK_RE.exec(rest);
    const content: string[] = [task === null ? rest : (task[2] ?? "")];
    index += 1;
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (current.trim().length === 0) {
        const after = lines[index + 1] ?? "";
        if (after.trim().length === 0 || indentOf(after) < column) {
          break;
        }
        content.push("");
        index += 1;
        continue;
      }
      if (indentOf(current) >= column) {
        content.push(current.slice(column));
        index += 1;
        continue;
      }
      if (startsBlock(current)) {
        break;
      }
      content.push(current.trim());
      index += 1;
    }
    items.push({
      kind:
        task !== null ? "task" : match[2] !== undefined ? "bullet" : "ordered",
      checked: task !== null && (task[1] ?? " ").toLowerCase() === "x",
      start: match[3] === undefined ? 1 : Number.parseInt(match[3], 10),
      lines: content,
    });
  }
  const blocks: Y.XmlElement[] = [];
  let run: ListItemDraft[] = [];
  const flush = (): void => {
    const first = run[0];
    if (first === undefined) {
      return;
    }
    const children = run.map((item) =>
      element(
        first.kind === "task" ? "taskItem" : "listItem",
        first.kind === "task" ? { checked: item.checked } : {},
        blockChildren(item.lines),
      ),
    );
    if (first.kind === "bullet") {
      blocks.push(element("bulletList", {}, children));
    } else if (first.kind === "task") {
      blocks.push(element("taskList", {}, children));
    } else {
      blocks.push(element("orderedList", { start: first.start }, children));
    }
    run = [];
  };
  for (const item of items) {
    const first = run[0];
    if (first !== undefined && first.kind !== item.kind) {
      flush();
    }
    run.push(item);
  }
  flush();
  return { blocks, next: index };
}

function parseTable(
  lines: readonly string[],
  from: number,
): { readonly block: Y.XmlElement; readonly next: number } {
  const rows: (readonly string[])[] = [splitTableRow(lines[from] ?? "")];
  let index = from + 2;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || !line.includes("|")) {
      break;
    }
    rows.push(splitTableRow(line));
    index += 1;
  }
  const width = rows.reduce((max, row) => Math.max(max, row.length), 1);
  const children = rows.map((cells, row) =>
    element(
      "tableRow",
      {},
      Array.from({ length: width }, (_unused, column) =>
        element(
          row === 0 ? "tableHeader" : "tableCell",
          { colspan: 1, rowspan: 1 },
          blockChildren([cells[column] ?? ""]),
        ),
      ),
    ),
  );
  return { block: element("table", {}, children), next: index };
}

function splitTableRow(line: string): readonly string[] {
  const trimmed = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

interface InlinePattern {
  readonly mark: string;
  readonly regex: RegExp;
  readonly content: number;
  readonly href: number;
  readonly literal: boolean;
}

/**
 * Order matters twice: `code` wins because nothing nests inside it, and
 * `bold` precedes `italic` so `**x**` is not read as `*` + `*x*`.
 */
const INLINE_PATTERNS: readonly InlinePattern[] = [
  {
    mark: "code",
    regex: /(`+)([\s\S]+?)\1/u,
    content: 2,
    href: 0,
    literal: true,
  },
  {
    mark: "link",
    regex: /\[([^\]]*)\]\(\s*([^()\s]*)\s*(?:"[^"]*")?\)/u,
    content: 1,
    href: 2,
    literal: false,
  },
  {
    mark: "bold",
    regex: /\*\*(?=\S)([\s\S]*?\S)\*\*/u,
    content: 1,
    href: 0,
    literal: false,
  },
  {
    mark: "bold",
    regex: /(?<![\p{L}\p{N}])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}])/u,
    content: 1,
    href: 0,
    literal: false,
  },
  {
    mark: "strike",
    regex: /~~(?=\S)([\s\S]*?\S)~~/u,
    content: 1,
    href: 0,
    literal: false,
  },
  {
    mark: "italic",
    regex: /\*(?=\S)([^*\n]*\S)\*/u,
    content: 1,
    href: 0,
    literal: false,
  },
  {
    mark: "italic",
    regex: /(?<![\p{L}\p{N}])_(?=\S)([^_\n]*\S)_(?![\p{L}\p{N}])/u,
    content: 1,
    href: 0,
    literal: false,
  },
];

function inlineText(source: string): Y.XmlText {
  const text = new Y.XmlText();
  appendInline(text, source, {}, 0);
  return text;
}

/**
 * Returns the offset after the inserted run. A pre-integration `Y.XmlText`
 * reports `length === 0` forever, so the caller carries the cursor — reading
 * it back off the type inserts every run at 0 and writes the text backwards.
 */
function appendInline(
  target: Y.XmlText,
  source: string,
  marks: Readonly<Record<string, object>>,
  offset: number,
): number {
  if (source.length === 0) {
    return offset;
  }
  let chosen: InlinePattern | null = null;
  let found: RegExpExecArray | null = null;
  for (const pattern of INLINE_PATTERNS) {
    if (pattern.mark in marks) {
      continue;
    }
    const match = pattern.regex.exec(source);
    if (match === null) {
      continue;
    }
    if (found === null || match.index < found.index) {
      chosen = pattern;
      found = match;
    }
  }
  if (chosen === null || found === null) {
    target.insert(offset, source, marks);
    return offset + source.length;
  }
  let cursor = offset;
  if (found.index > 0) {
    cursor = appendInline(target, source.slice(0, found.index), marks, cursor);
  }
  const inner = found[chosen.content] ?? "";
  const next: Record<string, object> = { ...marks };
  next[chosen.mark] = chosen.href > 0 ? { href: found[chosen.href] ?? "" } : {};
  if (chosen.literal) {
    target.insert(cursor, inner, next);
    cursor += inner.length;
  } else {
    cursor = appendInline(target, inner, next, cursor);
  }
  return appendInline(
    target,
    source.slice(found.index + found[0].length),
    marks,
    cursor,
  );
}

function blockToMarkdown(node: Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    return textToMarkdown(node);
  }
  switch (node.nodeName) {
    case "heading":
      return `${"#".repeat(headingLevel(attributeOf(node, "level")))} ${inlineChildren(node)}`;
    case "codeBlock":
      return fenceMarkdown(stringAttribute(node, "language"), rawText(node));
    case "mermaidBlock":
      return fenceMarkdown(MERMAID_LANGUAGE, stringAttribute(node, "code"));
    case "uiPreviewBlock":
      return fenceMarkdown(
        WIREFRAME_LANGUAGE,
        stringAttribute(node, "htmlContent"),
      );
    case "horizontalRule":
      return "---";
    case "image":
      return `![${stringAttribute(node, "alt")}](${stringAttribute(node, "src")})`;
    case "blockquote":
      return childBlocks(node)
        .join("\n\n")
        .split("\n")
        .map((line) => (line.length === 0 ? ">" : `> ${line}`))
        .join("\n");
    case "bulletList":
    case "orderedList":
    case "taskList":
      return listToMarkdown(node);
    case "table":
      return tableToMarkdown(node);
    default:
      return inlineChildren(node);
  }
}

function childBlocks(node: Y.XmlElement): readonly string[] {
  const blocks: string[] = [];
  node.forEach((child: Y.XmlElement | Y.XmlText) => {
    const text = blockToMarkdown(child);
    if (text.length > 0) {
      blocks.push(text);
    }
  });
  return blocks;
}

/** Item bodies stay tight: a nested list hugs the paragraph above it. */
function itemBody(item: Y.XmlElement): string {
  const parts: string[] = [];
  let previousWasList = false;
  item.forEach((child: Y.XmlElement | Y.XmlText) => {
    const text = blockToMarkdown(child);
    const isList =
      !(child instanceof Y.XmlText) &&
      (child.nodeName === "bulletList" ||
        child.nodeName === "orderedList" ||
        child.nodeName === "taskList");
    if (text.length === 0) {
      previousWasList = isList;
      return;
    }
    if (parts.length > 0) {
      parts.push(isList || previousWasList ? "\n" : "\n\n");
    }
    parts.push(text);
    previousWasList = isList;
  });
  return parts.join("");
}

function listToMarkdown(list: Y.XmlElement): string {
  const ordered = list.nodeName === "orderedList";
  const startValue = attributeOf(list, "start");
  const start = typeof startValue === "number" ? startValue : 1;
  const rendered: string[] = [];
  let counter = start;
  list.forEach((child: Y.XmlElement | Y.XmlText) => {
    if (child instanceof Y.XmlText) {
      const text = child.toString();
      if (text.length > 0) {
        rendered.push(`- ${text}`);
      }
      return;
    }
    let marker = "- ";
    if (ordered) {
      marker = `${counter}. `;
      counter += 1;
    } else if (child.nodeName === "taskItem") {
      marker = attributeOf(child, "checked") === true ? "- [x] " : "- [ ] ";
    }
    const body = itemBody(child);
    const indent = " ".repeat(marker.length);
    const lines = body.split("\n");
    const head = lines[0] ?? "";
    const tail = lines
      .slice(1)
      .map((line) => (line.length === 0 ? "" : `${indent}${line}`));
    rendered.push([`${marker}${head}`, ...tail].join("\n"));
  });
  return rendered.join("\n");
}

function tableToMarkdown(table: Y.XmlElement): string {
  const rows: string[][] = [];
  table.forEach((row: Y.XmlElement | Y.XmlText) => {
    if (row instanceof Y.XmlText) {
      return;
    }
    const cells: string[] = [];
    row.forEach((cell: Y.XmlElement | Y.XmlText) => {
      const text =
        cell instanceof Y.XmlText
          ? textToMarkdown(cell)
          : childBlocks(cell).join(" ");
      cells.push(text.replaceAll("\n", " ").replaceAll("|", "\\|").trim());
    });
    rows.push(cells);
  });
  if (rows.length === 0) {
    return "";
  }
  const width = rows.reduce((max, row) => Math.max(max, row.length), 1);
  // Column padding matches what the GUI's own markdown serializer emits, so a
  // host rewrite of a table leaves no cosmetic diff behind.
  const columns = Array.from({ length: width }, (_unused, index) =>
    rows.reduce((max, row) => Math.max(max, (row[index] ?? "").length), 3),
  );
  const line = (cells: readonly string[]): string =>
    `| ${columns.map((size, index) => (cells[index] ?? "").padEnd(size)).join(" | ")} |`;
  const header = rows[0] ?? [];
  const divider = `| ${columns.map((size) => "-".repeat(size)).join(" | ")} |`;
  return [line(header), divider, ...rows.slice(1).map(line)].join("\n");
}

function fenceMarkdown(language: string, code: string): string {
  const longest = [...code.matchAll(/`+/gu)].reduce(
    (max, match) => Math.max(max, match[0].length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

function inlineChildren(node: Y.XmlElement): string {
  const parts: string[] = [];
  node.forEach((child: Y.XmlElement | Y.XmlText) => {
    if (child instanceof Y.XmlText) {
      parts.push(textToMarkdown(child));
      return;
    }
    if (child.nodeName === "hardBreak") {
      parts.push("\n");
      return;
    }
    if (child.nodeName === "image") {
      parts.push(
        `![${stringAttribute(child, "alt")}](${stringAttribute(child, "src")})`,
      );
      return;
    }
    parts.push(inlineChildren(child));
  });
  return parts.join("");
}

function rawText(node: Y.XmlElement): string {
  const parts: string[] = [];
  node.forEach((child: Y.XmlElement | Y.XmlText) => {
    parts.push(child instanceof Y.XmlText ? child.toString() : rawText(child));
  });
  return parts.join("");
}

interface TextDelta {
  readonly insert: unknown;
  readonly attributes: Readonly<Record<string, unknown>> | undefined;
}

// ponytail: emphasis markers in plain text are not escaped on the way out, so
// a literal `**` typed in the GUI comes back bold. Add escaping if that shows
// up in real artifacts.
function textToMarkdown(text: Y.XmlText): string {
  const deltas: readonly TextDelta[] = text.toDelta();
  const parts: string[] = [];
  for (const delta of deltas) {
    if (typeof delta.insert !== "string") {
      continue;
    }
    parts.push(applyMarks(delta.insert, delta.attributes));
  }
  return parts.join("");
}

function applyMarks(
  value: string,
  attributes: Readonly<Record<string, unknown>> | undefined,
): string {
  if (attributes === undefined) {
    return value;
  }
  const names = new Set<string>();
  for (const key of Object.keys(attributes)) {
    // Overlapping marks (`threadAnchor`) are stored as `name--<hash>`.
    names.add(key.split("--")[0] ?? key);
  }
  if (names.size === 0) {
    return value;
  }
  const leading = /^\s*/u.exec(value)?.[0] ?? "";
  const trailing = /\s*$/u.exec(value)?.[0] ?? "";
  let core = value.slice(leading.length, value.length - trailing.length);
  if (core.length === 0) {
    return value;
  }
  if (names.has("code")) {
    core = codeSpan(core);
  }
  if (names.has("italic")) {
    core = `*${core}*`;
  }
  if (names.has("bold")) {
    core = `**${core}**`;
  }
  if (names.has("strike")) {
    core = `~~${core}~~`;
  }
  if (names.has("link")) {
    core = `[${core}](${linkHref(attributes)})`;
  }
  return `${leading}${core}${trailing}`;
}

function linkHref(attributes: Readonly<Record<string, unknown>>): string {
  for (const [key, value] of Object.entries(attributes)) {
    if ((key.split("--")[0] ?? key) !== "link") {
      continue;
    }
    if (value === null || typeof value !== "object") {
      continue;
    }
    const href = Reflect.get(value, "href");
    if (typeof href === "string") {
      return href;
    }
  }
  return "";
}

function codeSpan(value: string): string {
  const longest = [...value.matchAll(/`+/gu)].reduce(
    (max, match) => Math.max(max, match[0].length),
    0,
  );
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

function headingLevel(value: AttrValue | undefined): number {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 1;
  }
  return parsed > 6 ? 6 : parsed;
}
