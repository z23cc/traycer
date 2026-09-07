/**
 * The two things both the scan and the import have to read out of a vendor's
 * message, kept in one place so the wizard's row and the chat it becomes never
 * disagree about what the user actually said.
 */

/** One top-level block: `<tag …>` through its own `</tag>`. */
const OPENING = /^<([a-z][a-z0-9_-]*)(\s[^>]*)?>/u;

/**
 * The readable text of a message: a bare string, or the text blocks of a
 * content list. Thinking and tool-call blocks are deliberately dropped - they
 * are the agent's working, not the conversation.
 */
export function messageText(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trim().length === 0 ? null : content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") {
      continue;
    }
    const type = Reflect.get(block, "type");
    if (type !== "text" && type !== "input_text" && type !== "output_text") {
      continue;
    }
    const text = Reflect.get(block, "text");
    if (typeof text === "string" && text.trim().length > 0) {
      parts.push(text);
    }
  }
  return parts.length === 0 ? null : parts.join("\n");
}

/**
 * Whether a `user` message is nothing but tag blocks - which is how a CLI
 * injects its own context (`<recommended_plugins>`, `<environment_context>`,
 * `<in-app-browser-context …>`) as a message it labels `user`, often several
 * of them concatenated into one.
 *
 * Codex has no structural marker for these the way Claude has `isMeta`, so
 * the shape is the only signal there is, and the test is deliberately
 * all-or-nothing: one word of prose outside the tags and the message is the
 * user's. ponytail: scaffolding that is NOT tag-wrapped (Codex also writes a
 * "# Files mentioned by the user" block) still comes through - it has no
 * shape to recognise, and guessing by heading would start dropping real
 * prompts.
 */
export function isHarnessPreamble(text: string): boolean {
  let rest = text.trim();
  if (!rest.startsWith("<")) {
    return false;
  }
  while (rest.length > 0) {
    const opening = OPENING.exec(rest);
    if (opening === null) {
      return false;
    }
    const closing = `</${opening[1]}>`;
    const end = rest.indexOf(closing, opening[0].length);
    if (end < 0) {
      return false;
    }
    rest = rest.slice(end + closing.length).trim();
  }
  return true;
}
