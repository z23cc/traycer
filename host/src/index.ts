#!/usr/bin/env node
import { startHost } from "./start-host";
import { SNAPSHOT_HOOK_FLAG, runSnapshotHook } from "./snapshots/snapshots";

// Re-entered by Claude as a tool hook, not started as a host: read what the
// hook was told, capture the file, exit. See `snapshots/snapshots.ts`.
const hookFlag = process.argv.indexOf(SNAPSHOT_HOOK_FLAG);
if (hookFlag >= 0) {
  const dir = process.argv[hookFlag + 1];
  if (dir !== undefined) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    await runSnapshotHook(Buffer.concat(chunks).toString("utf8"), dir);
  }
  process.exit(0);
}

const started = await startHost({
  argv: process.argv.slice(2),
  listenHost: "127.0.0.1",
  listenPort: 0,
});

process.on("SIGTERM", () => {
  started.shutdownOnSignal("SIGTERM");
});
process.on("SIGINT", () => {
  started.shutdownOnSignal("SIGINT");
});
process.on("SIGHUP", () => {
  started.shutdownOnSignal("SIGHUP");
});
