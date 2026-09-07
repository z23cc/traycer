import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  OsScript,
  WorktreeEntryScripts,
} from "@traycer/protocol/host/worktree-schemas";
import type { HostRuntime } from "../runtime";
import { holdersForWorktreePath } from "./holders";
import { deleteWorktree } from "./service";

/**
 * The path-keyed delete pipeline both delete streams drive:
 * busy check -> teardown -> `git worktree remove --force`.
 *
 * The busy check is a REFUSAL, not a warning: an owner holding the worktree
 * has files open in it, and `stopOwners` (absent or false) is the client
 * saying it has not asked the user to give those up.
 */

export type DeleteEvent =
  | { readonly kind: "started"; readonly hasTeardown: boolean }
  | { readonly kind: "phase"; readonly phase: "teardown" | "remove" }
  | {
      readonly kind: "output";
      readonly channel: "stdout" | "stderr";
      readonly chunk: string;
    }
  | { readonly kind: "complete"; readonly deleted: boolean }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly busy: boolean;
      readonly holders: readonly unknown[];
    };

export type DeleteTarget = {
  readonly worktreePath: string;
  readonly scripts: WorktreeEntryScripts | null;
  readonly stopOwners: boolean;
};

const TEARDOWN_TIMEOUT_MS = 120_000;

export async function runWorktreeDelete(
  runtime: HostRuntime,
  target: DeleteTarget,
  emit: (event: DeleteEvent) => void,
): Promise<void> {
  const binding = bindingFor(runtime, target.worktreePath);
  if (binding === null) {
    // The one guard that matters on this stream: an unregistered path must
    // never reach the remover, whose fallback is `rm -rf` on whatever it was
    // handed.
    emit({
      kind: "failed",
      reason: "That path is not a worktree this host manages.",
      busy: false,
      holders: [],
    });
    return;
  }
  const holders = holdersForWorktreePath(runtime, target.worktreePath);
  if (holders.length > 0 && !target.stopOwners) {
    emit({
      kind: "failed",
      reason: "The worktree is in use.",
      busy: true,
      holders,
    });
    return;
  }
  const teardown = await teardownCommand(target);
  emit({ kind: "started", hasTeardown: teardown !== null });
  if (teardown !== null) {
    emit({ kind: "phase", phase: "teardown" });
    await runTeardown(teardown, target.worktreePath, emit);
  }
  emit({ kind: "phase", phase: "remove" });
  const deleted = await deleteWorktree(
    runtime,
    binding.workspacePath,
    target.worktreePath,
  );
  emit({ kind: "complete", deleted });
}

function bindingFor(
  runtime: HostRuntime,
  worktreePath: string,
): { readonly workspacePath: string } | null {
  for (const row of runtime.store.snapshot().bindings) {
    for (const entry of row.binding.entries) {
      if (entry.worktreePath === worktreePath) {
        return { workspacePath: entry.workspacePath };
      }
    }
  }
  return null;
}

/**
 * The request's own override, else the worktree's `.traycer/environment.json`
 * - which is what `null` means on the wire.
 */
async function teardownCommand(target: DeleteTarget): Promise<string | null> {
  if (target.scripts !== null) {
    return forThisOs(target.scripts.teardown);
  }
  try {
    const raw = await readFile(
      join(target.worktreePath, ".traycer", "environment.json"),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    const script = Reflect.get(parsed, "teardown");
    return script === null || typeof script !== "object"
      ? null
      : forThisOs(script as OsScript);
  } catch {
    return null;
  }
}

function forThisOs(script: OsScript): string | null {
  const chosen =
    process.platform === "darwin"
      ? script.macos
      : process.platform === "win32"
        ? script.windows
        : script.linux;
  const command = chosen ?? script.default;
  return command.trim().length === 0 ? null : command;
}

/**
 * Teardown output is streamed rather than collected: the modal shows it while
 * it runs, and a script that hangs must still be visibly doing something.
 */
function runTeardown(
  command: string,
  cwd: string,
  emit: (event: DeleteEvent) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, TEARDOWN_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      emit({
        kind: "output",
        channel: "stdout",
        chunk: chunk.toString("utf8"),
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      emit({
        kind: "output",
        channel: "stderr",
        chunk: chunk.toString("utf8"),
      });
    });
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.on("close", finish);
    // A teardown that cannot be spawned is not a reason to keep the worktree:
    // removal is what the caller asked for, and the failure is already visible
    // in the output frames.
    child.on("error", (error: Error) => {
      emit({ kind: "output", channel: "stderr", chunk: error.message });
      finish();
    });
  });
}
