import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Y from "yjs";
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
  const blocks = body.split(/\n{2,}/u);
  const doc = fragment.doc;
  const insert = (): void => {
    for (const block of blocks) {
      const trimmed = block.trim();
      if (trimmed.length === 0) {
        continue;
      }
      fragment.push([xmlBlockFromMarkdown(trimmed)]);
    }
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
    if (child instanceof Y.XmlText) {
      const text = child.toString();
      if (text.length > 0) {
        blocks.push(text);
      }
      return;
    }
    const text = xmlElementText(child);
    if (text.length === 0) {
      return;
    }
    if (child.nodeName === "heading") {
      const level = headingLevel(child.getAttribute("level"));
      blocks.push(`${"#".repeat(level)} ${text}`);
      return;
    }
    blocks.push(text);
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

function xmlBlockFromMarkdown(trimmed: string): Y.XmlElement {
  let level = 0;
  while (level < trimmed.length && trimmed[level] === "#") {
    level += 1;
  }
  if (
    level >= 1 &&
    level <= 6 &&
    (trimmed.length === level || trimmed[level] === " ")
  ) {
    const heading = new Y.XmlElement("heading");
    heading.setAttribute("level", String(level));
    const text = new Y.XmlText();
    const content = trimmed.slice(level).trim();
    if (content.length > 0) {
      text.insert(0, content);
    }
    heading.insert(0, [text]);
    return heading;
  }
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  text.insert(0, trimmed);
  paragraph.insert(0, [text]);
  return paragraph;
}

function xmlElementText(element: Y.XmlElement): string {
  const parts: string[] = [];
  element.forEach((child: Y.XmlElement | Y.XmlText) => {
    if (child instanceof Y.XmlText) {
      parts.push(child.toString());
      return;
    }
    parts.push(xmlElementText(child));
  });
  return parts.join("");
}

function headingLevel(value: string | undefined): number {
  if (value === undefined) {
    return 1;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 1;
  }
  if (parsed > 6) {
    return 6;
  }
  return parsed;
}
