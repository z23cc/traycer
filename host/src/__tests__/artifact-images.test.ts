import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  abortStagedImage,
  commitStagedImage,
  readAttachment,
  stageImage,
} from "../epic/attachments";
import {
  seedXmlFragmentFromMarkdown,
  xmlFragmentToMarkdown,
} from "../epic/artifact-body";
import { startHost, type StartedHost } from "../start-host";

// A 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("artifact images", () => {
  let started: StartedHost | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (started !== null) {
      await started.close();
      started = null;
    }
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("stages, commits, and serves an image by its content hash", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const staged = stageImage("epic-1", PNG);
    expect(staged).not.toBeNull();
    const hash = createHash("sha256").update(PNG).digest("hex");
    expect(staged?.hash).toBe(hash);
    expect(staged?.mediaType).toBe("image/png");
    expect(staged?.src).toBe(`attachments/${hash}.png`);
    // Uncommitted bytes are not servable.
    expect(await readAttachment(started.runtime, "epic-1", hash)).toBeNull();

    expect(
      await commitStagedImage(started.runtime, staged?.operationId ?? ""),
    ).toBe(true);
    const found = await readAttachment(started.runtime, "epic-1", hash);
    expect(found?.mediaType).toBe("image/png");
    expect(found?.bytes.equals(PNG)).toBe(true);
    // A second commit of the same operation is unknown, not a double write.
    expect(
      await commitStagedImage(started.runtime, staged?.operationId ?? ""),
    ).toBe(false);
  });

  it("drops the staged bytes on abort", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const staged = stageImage("epic-1", PNG);
    expect(abortStagedImage(staged?.operationId ?? "")).toBe(true);
    // Nothing was ever written, and the operation is gone for good.
    expect(
      await commitStagedImage(started.runtime, staged?.operationId ?? ""),
    ).toBe(false);
    expect(abortStagedImage(staged?.operationId ?? "")).toBe(false);
  });

  it("rejects bytes that are not a supported image", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    expect(stageImage("epic-1", Buffer.from("not an image"))).toBeNull();
  });

  it("recovers the attachment hash when a body is re-read from disk", () => {
    const hash = "a".repeat(64);
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("artifact-body:one");
    const markdown = `![shot](attachments/${hash}.png)`;
    seedXmlFragmentFromMarkdown(fragment, markdown);
    const image = fragment.get(0);
    if (!(image instanceof Y.XmlElement)) {
      throw new Error("expected an image element");
    }
    expect(image.nodeName).toBe("image");
    expect(JSON.stringify(image.getAttributes())).toBe(
      JSON.stringify({
        src: `attachments/${hash}.png`,
        alt: "shot",
        attachmentHash: hash,
        mediaType: "image/png",
      }),
    );
    expect(xmlFragmentToMarkdown(fragment)).toBe(markdown);
  });

  it("leaves a non-addressed image without a hash", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("artifact-body:one");
    seedXmlFragmentFromMarkdown(fragment, "![web](https://example.dev/a.png)");
    const image = fragment.get(0);
    if (!(image instanceof Y.XmlElement)) {
      throw new Error("expected an image element");
    }
    expect(JSON.stringify(image.getAttributes())).toBe(
      JSON.stringify({ src: "https://example.dev/a.png", alt: "web" }),
    );
  });
});

async function boot(): Promise<{
  readonly started: StartedHost;
  readonly tempDir: string;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
  const started = await startHost({
    argv: ["--host-data-dir", tempDir],
    listenHost: "127.0.0.1",
    listenPort: 0,
  });
  return { started, tempDir };
}
