import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactCommand } from "../agent/artifact-command";

/**
 * The shell commands the agent may run on the epic's artifacts unasked, as
 * the released host reads them: one plain file command, every operand under
 * the artifact root, nothing for the shell itself to interpret.
 */
describe("artifact commands", () => {
  const cwd = "/work/proj";
  const root = "/data/epics/epic-1/artifacts";
  const spec = join(root, "overview", "index.md");
  const of = (toolName: string, input: unknown, description: string) =>
    artifactCommand(toolName, input, description, cwd, root);

  it("recognises a plain file command on artifact paths", () => {
    expect(of("Bash", { command: `cat ${spec}` }, "")).toEqual({
      verb: "cat",
      paths: [spec],
    });
    expect(
      of("Bash", { command: `rm -rf ${join(root, "overview")}` }, ""),
    ).toEqual({
      verb: "rm",
      paths: [join(root, "overview")],
    });
    expect(
      of("Bash", { command: `mkdir -p --mode=755 ${join(root, "new")}` }, ""),
    ).toEqual({
      verb: "mkdir",
      paths: [join(root, "new")],
    });
    expect(
      of(
        "Bash",
        { command: `mv "${spec}" '${join(root, "old", "index.md")}'` },
        "",
      ),
    ).toEqual({ verb: "mv", paths: [spec, join(root, "old", "index.md")] });
    // Unwrapped once through the shell; the command may also arrive as tokens,
    // or only in the description.
    expect(
      of("shell", { command: `sh -c "cp ${spec} ${root}/copy.md"` }, ""),
    ).toEqual({
      verb: "cp",
      paths: [spec, join(root, "copy.md")],
    });
    expect(of("Bash", { args: ["ls", "-la", root] }, "")).toMatchObject({
      verb: "ls",
    });
    expect(of("Bash", {}, `wc -l ${spec}`)).toMatchObject({ verb: "wc" });
    // A relative operand counts from the working directory.
    expect(
      artifactCommand(
        "Bash",
        { command: "cat artifacts/overview/index.md" },
        "",
        join(root, ".."),
        root,
      ),
    ).toMatchObject({ paths: [spec] });
  });

  it("leaves everything else to the user", () => {
    expect(of("Read", { file_path: spec }, "")).toBeNull();
    expect(
      of("Bash", { command: `cat ${spec} | tee /tmp/out` }, ""),
    ).toBeNull();
    expect(of("Bash", { command: `cat ${spec} > /tmp/out` }, "")).toBeNull();
    expect(of("Bash", { command: `rm ${root}/*` }, "")).toBeNull();
    expect(
      of("Bash", { command: `cat ${join(root, "..", "secrets")}` }, ""),
    ).toBeNull();
    expect(of("Bash", { command: `cat ${spec} /etc/passwd` }, "")).toBeNull();
    expect(
      of("Bash", { command: `find ${root} -exec rm {} +` }, ""),
    ).toBeNull();
    expect(of("Bash", { command: `git rm ${spec}` }, "")).toBeNull();
    expect(of("Bash", { command: "cat" }, "")).toBeNull();
    expect(
      of("Bash", { command: `mkdir -Z ${join(root, "x")}` }, ""),
    ).toBeNull();
    expect(of("Bash", { command: `sh -c "cat ${spec}" extra` }, "")).toBeNull();
    expect(
      of("Bash", { command: `sh -c 'sh -c "cat ${spec}"'` }, ""),
    ).toBeNull();
    expect(of("Bash", { command: `cat "${spec}` }, "")).toBeNull();
    expect(of("Bash", {}, "")).toBeNull();
  });
});
