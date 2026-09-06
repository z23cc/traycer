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
