import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  seedXmlFragmentFromMarkdown,
  splitFrontMatter,
  xmlFragmentToMarkdown,
} from "../epic/artifact-body";

describe("artifact markdown body", () => {
  it("splits YAML front matter from the body", () => {
    const raw = `---\ntitle: "Spec"\nkind: spec\n---\n\nHello\n\nWorld\n`;
    expect(splitFrontMatter(raw)).toEqual({
      frontMatter: '---\ntitle: "Spec"\nkind: spec\n---\n',
      body: "Hello\n\nWorld\n",
    });
  });

  it("seeds markdown headings as Tiptap heading nodes", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("artifact-body:one");
    seedXmlFragmentFromMarkdown(fragment, "# Title\n\nHello");
    expect(xmlFragmentToMarkdown(fragment)).toBe("# Title\n\nHello");
  });

  it("seeds empty Tiptap paragraphs from markdown and round-trips text", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("artifact-body:one");
    seedXmlFragmentFromMarkdown(
      fragment,
      '---\ntitle: "Spec"\nkind: spec\n---\n\nHello\n\nWorld',
    );
    expect(fragment.length).toBe(2);
    expect(xmlFragmentToMarkdown(fragment)).toBe("Hello\n\nWorld");
    expect(fragment.toJSON()).toContain("Hello");
  });

  it("does not overwrite a fragment the GUI already filled", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("artifact-body:one");
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, "live");
    paragraph.insert(0, [text]);
    fragment.insert(0, [paragraph]);
    seedXmlFragmentFromMarkdown(fragment, "disk");
    expect(xmlFragmentToMarkdown(fragment)).toBe("live");
  });

  it("emits markdown headings from Tiptap heading nodes", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("artifact-body:one");
    const heading = new Y.XmlElement("heading");
    heading.setAttribute("level", "2");
    const text = new Y.XmlText();
    text.insert(0, "Title");
    heading.insert(0, [text]);
    fragment.insert(0, [heading]);
    expect(xmlFragmentToMarkdown(fragment)).toBe("## Title");
  });
});

const ROUND_TRIP_FIXTURES: readonly (readonly [string, string])[] = [
  ["heading", "# Title\n\nBody text"],
  [
    "marks",
    "A **bold** and *italic* and `code` and ~~gone~~ and [link](https://x.dev).",
  ],
  ["bullet list", "- one\n- two\n  - nested"],
  ["ordered list", "3. three\n4. four"],
  ["task list", "- [ ] todo\n- [x] done"],
  ["blockquote", "> quoted **text**\n> more"],
  ["code block", "```ts\nconst a = 1;\n```"],
  ["mermaid", "```mermaid\ngraph TD;\n  A-->B;\n```"],
  ["wireframe", "```wireframe\n<div>hi</div>\n```"],
  ["table", "| a   | b   |\n| --- | --- |\n| 1   | 2   |"],
  ["horizontal rule", "before\n\n---\n\nafter"],
  ["image", "![alt text](attachments/x.png)"],
  [
    "mixed document",
    "# Spec\n\nIntro.\n\n## Steps\n\n1. first\n2. second\n\n| col | val |\n| --- | --- |\n| a   | 1   |\n\n```mermaid\nflowchart LR\n  X-->Y\n```\n\n> note\n\n- [x] shipped",
  ],
];

describe("artifact markdown round trip", () => {
  it.each(ROUND_TRIP_FIXTURES)("round-trips %s", (_name, markdown) => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("artifact-body:one");
    seedXmlFragmentFromMarkdown(fragment, markdown);
    expect(xmlFragmentToMarkdown(fragment)).toBe(markdown);
  });

  it("seeds attributes as the JSON values the GUI schema expects", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("artifact-body:one");
    seedXmlFragmentFromMarkdown(
      fragment,
      "### Deep\n\n- [x] done\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |",
    );
    const heading = elementAt(fragment, 0);
    const taskItem = elementAt(elementAt(fragment, 1), 0);
    const cell = elementAt(elementAt(elementAt(fragment, 2), 0), 0);
    expect(heading.nodeName).toBe("heading");
    expect(JSON.stringify(heading.getAttributes())).toBe('{"level":3}');
    expect(taskItem.nodeName).toBe("taskItem");
    expect(JSON.stringify(taskItem.getAttributes())).toBe('{"checked":true}');
    expect(cell.nodeName).toBe("tableHeader");
    expect(JSON.stringify(cell.getAttributes())).toBe(
      '{"colspan":1,"rowspan":1}',
    );
    // Cell content is `block+`: a bare text child is deleted by the GUI.
    expect(elementAt(cell, 0).nodeName).toBe("paragraph");
  });

  it("keeps GUI-authored atoms that carry no text", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("artifact-body:one");
    const mermaid = new Y.XmlElement("mermaidBlock");
    mermaid.setAttribute("code", "graph TD;\n  A-->B;");
    const rule = new Y.XmlElement("horizontalRule");
    const image = new Y.XmlElement("image");
    image.setAttribute("src", "attachments/x.png");
    image.setAttribute("alt", "shot");
    fragment.insert(0, [mermaid, rule, image]);
    expect(xmlFragmentToMarkdown(fragment)).toBe(
      "```mermaid\ngraph TD;\n  A-->B;\n```\n\n---\n\n![shot](attachments/x.png)",
    );
  });

  it("emits the marks the GUI stores as text formatting", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("artifact-body:one");
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    fragment.insert(0, [paragraph]);
    paragraph.insert(0, [text]);
    // `@tiptap/y-tiptap` writes marks exactly this way: one delta run per
    // mark set, the attribute key being the mark name.
    text.applyDelta([
      { insert: "plain " },
      { insert: "loud", attributes: { bold: {} } },
      { insert: " and " },
      { insert: "here", attributes: { link: { href: "https://x.dev" } } },
      // Overlapping marks (comment anchors) are keyed `name--<hash>`.
      {
        insert: " noted",
        attributes: { "threadAnchor--abc": { threadId: "t1" } },
      },
    ]);
    expect(xmlFragmentToMarkdown(fragment)).toBe(
      "plain **loud** and [here](https://x.dev) noted",
    );
  });
});

function elementAt(parent: Y.XmlFragment, index: number): Y.XmlElement {
  const child = parent.get(index);
  if (!(child instanceof Y.XmlElement)) {
    throw new Error(`expected an element at ${index}`);
  }
  return child;
}
