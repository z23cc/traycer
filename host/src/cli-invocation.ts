import { readFile, readdir } from "node:fs/promises";
import {
  CLI_INVOCATION_RECORD_STALE_FILENAME,
  cliInvocationRecordPath,
  cliInvocationStateDir,
  isCliInvocationTransactionMarkerBasename,
  parseCliInvocationRecord,
  type CliInvocationRecord,
} from "@traycer/protocol/config/cli-invocation-record";

/**
 * The `{ command, args }` vector the CLI recorded for this host home, or
 * `null` when there is nothing this host may honestly spawn.
 *
 * The record is only a cache of a registration the CLI performed, so a
 * transaction or stale marker in the authority directory means a CLI
 * mutation is in flight or the record is known-suspect - both read as
 * absent here rather than as a vector to run, which is what makes the
 * maintenance methods answer `cli-unavailable` instead of executing a
 * stale command line.
 */
export async function readCliInvocation(
  dataDir: string,
): Promise<CliInvocationRecord | null> {
  const dir = cliInvocationStateDir(dataDir);
  let entries: readonly string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const contended = entries.some(
    (name) =>
      name === CLI_INVOCATION_RECORD_STALE_FILENAME ||
      isCliInvocationTransactionMarkerBasename(name),
  );
  if (contended) {
    return null;
  }
  try {
    const raw = await readFile(cliInvocationRecordPath(dataDir), "utf8");
    return parseCliInvocationRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}
