import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  formatDarwinProcessStartIdentity,
  formatLinuxProcessStartIdentity,
  type ProcessStartIdentity,
} from "@traycer/protocol/host/lifecycle";

export function readProcessStartIdentity(
  pid: number,
): ProcessStartIdentity | null {
  if (process.platform === "darwin") {
    return readDarwinStartIdentity(pid);
  }
  if (process.platform === "linux") {
    return readLinuxStartIdentity(pid);
  }
  return null;
}

function readDarwinStartIdentity(pid: number): ProcessStartIdentity | null {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  return formatDarwinProcessStartIdentity(result.stdout);
}

function readLinuxStartIdentity(pid: number): ProcessStartIdentity | null {
  let stat: string;
  let bootId: string;
  try {
    stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
  } catch {
    return null;
  }
  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 0) {
    return null;
  }
  const fields = stat
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/u);
  // /proc/<pid>/stat field 22 is starttime; after comm the next field is
  // state (field 3), so starttime is index 19 in this split.
  const startTicks = Number(fields[19]);
  if (!Number.isInteger(startTicks)) {
    return null;
  }
  return formatLinuxProcessStartIdentity(bootId.trim(), startTicks);
}
