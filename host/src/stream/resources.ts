import { totalmem } from "node:os";
import type { WebSocket } from "ws";
import {
  resourcesSubscribeOpenRequestV11Schema,
  type ResourcesSubscribeScopeWire,
} from "@traycer/protocol/host/resources/subscribe";
import {
  CpuRates,
  ownerRoots,
  readProcesses,
  treeOf,
  type OwnerRoot,
  type ProcessRow,
} from "../gui/resources";
import type { HostRuntime } from "../runtime";

/**
 * `resources.subscribe` - what this host's own process trees are using.
 *
 * The owners are the PTYs it spawned and the children of its GUI chat turns.
 * A `managed-command` owner is never produced: this host serves no managed
 * commands, so a row for one would be invented rather than measured.
 *
 * Every field with no local source is `null`, which the contract already
 * carries as a first-class answer - `app.process` for a process this host
 * cannot see, `epic` for "not currently tracked" as distinct from an aggregate
 * that happens to be zero.
 */

/** `hostTree` and `other` land at `@1.2`; below it the projection is frozen. */
const TREE_MINOR = 2;
/** Owners gain `harnessId` at `@1.3`. */
const HARNESS_MINOR = 3;
/** Owners gain the widened kind and `managedCommand` at `@1.4`. */
const MANAGED_MINOR = 4;
/**
 * `@1.5` is two changes at once: the client may ask for a faster cadence, and
 * every reading gains the nullable memory detail (`pssBytes`, `privateBytes`)
 * plus a Chromium `descriptor` on each process and a `restricted` aggregate on
 * the projection. All of those are REQUIRED fields, so a frame that omits them
 * is dropped whole by a client that negotiated this minor - which is how the
 * omission announced itself, as "frame failed its negotiated schema @1.5" in
 * the app console while the panel stayed empty.
 */
const DEMAND_MINOR = 5;

const BACKGROUND_MS = 5_000;
const INTERACTIVE_MS = 1_000;

export class ResourcesSubscriber {
  private readonly rates = new CpuRates();
  private timer: NodeJS.Timeout | null = null;
  private everySent = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly runtime: HostRuntime,
    private readonly scope: ResourcesSubscribeScopeWire,
    private readonly minor: number,
  ) {}

  /** Opens at background cadence, which is what a client that never asks gets. */
  start(): void {
    this.publish();
    this.setCadence(BACKGROUND_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  handleFrame(frame: unknown): boolean {
    if (frame === null || typeof frame !== "object") {
      return false;
    }
    const kind = Reflect.get(frame, "kind");
    if (kind === "ping") {
      this.send({ kind: "pong", hasBinaryPayload: false });
      return true;
    }
    if (kind !== "setDemand" || this.minor < DEMAND_MINOR) {
      return false;
    }
    this.setCadence(
      Reflect.get(frame, "demand") === "interactive"
        ? INTERACTIVE_MS
        : BACKGROUND_MS,
    );
    return true;
  }

  private setCadence(everyMs: number): void {
    this.stop();
    const timer = setInterval(() => {
      this.publish();
    }, everyMs);
    // Sampling must never be the reason this process stays alive.
    timer.unref();
    this.timer = timer;
  }

  private publish(): void {
    if (this.socket.readyState !== this.socket.OPEN) {
      this.stop();
      return;
    }
    const now = Date.now();
    const rows = readProcesses();
    const rates = this.rates.measure(rows, now);
    const roots = ownerRoots(this.runtime, scopeOf(this.scope));
    const owners = roots.map((root) => this.ownerFrame(root, rows, rates, now));
    const chargedPids = new Set(
      owners.flatMap((owner) => owner.processes.map((row) => row.pid)),
    );
    // The first frame is the snapshot; every later one is an update of the
    // same projection.
    const kind = this.everySent ? "update" : "snapshot";
    this.everySent = true;
    this.send({
      kind,
      hasBinaryPayload: false,
      epicId: this.scope.kind === "epic" ? this.scope.epicId : "",
      sampledAt: now,
      app: this.appFrame(now),
      owners,
      epic: this.epicFrame(owners, now),
      ...(this.minor >= TREE_MINOR
        ? {
            hostTree: this.hostTreeFrame(rows, rates, now),
            other: this.otherFrame(rows, rates, chargedPids, now),
          }
        : {}),
      // Every owner this host sees is reported in full, so there is no hidden
      // tree for the aggregate to stand in for. The projection itself carries
      // no reading of its own - the memory detail belongs to the snapshots
      // nested inside it.
      ...(this.minor >= DEMAND_MINOR ? { restricted: null } : {}),
    });
  }

  private ownerFrame(
    root: OwnerRoot,
    rows: readonly ProcessRow[],
    rates: ReadonlyMap<number, number>,
    now: number,
  ): {
    readonly processes: readonly { readonly pid: number }[];
    readonly [key: string]: unknown;
  } {
    const tree = treeOf(rows, root.rootPid);
    return {
      owner: {
        // The widened kind only exists from `@1.4`; below it every kind this
        // host produces is already in the frozen set, so nothing is narrowed.
        kind: root.kind,
        hostId: this.runtime.hostId,
        epicId: root.epicId,
        ownerId: root.ownerId,
      },
      sampledAt: now,
      rootPids: [root.rootPid],
      activeProcessName: root.activeProcessName,
      processCount: tree.length,
      cpuPercent: sumCpu(tree, rates),
      rssBytes: sumRss(tree),
      processes: tree.map((row) =>
        processFrame(row, root.rootPid, rates, this.minor),
      ),
      ...memoryDetail(this.minor),
      ...(this.minor >= HARNESS_MINOR ? { harnessId: root.harnessId } : {}),
      ...(this.minor >= MANAGED_MINOR ? { managedCommand: null } : {}),
    };
  }

  private appFrame(now: number): unknown {
    return {
      sampledAt: now,
      hostTotalMemoryBytes: totalmem(),
      // The desktop app is a separate process this host did not start and
      // cannot attribute; the client measures its own.
      process: null,
      processCount: 0,
      cpuPercent: 0,
      rssBytes: 0,
      ...memoryDetail(this.minor),
    };
  }

  private epicFrame(
    owners: readonly { readonly [key: string]: unknown }[],
    now: number,
  ): unknown {
    if (this.scope.kind !== "epic" || owners.length === 0) {
      // `null` is "not currently tracked", which is a different statement from
      // an aggregate whose totals are zero.
      return null;
    }
    return {
      hostId: this.runtime.hostId,
      epicId: this.scope.epicId,
      sampledAt: now,
      ownerCount: owners.length,
      processCount: owners.reduce(
        (total, owner) => total + Number(owner.processCount),
        0,
      ),
      cpuPercent: owners.reduce(
        (total, owner) => total + Number(owner.cpuPercent),
        0,
      ),
      rssBytes: owners.reduce(
        (total, owner) => total + Number(owner.rssBytes),
        0,
      ),
      ...memoryDetail(this.minor),
    };
  }

  private hostTreeFrame(
    rows: readonly ProcessRow[],
    rates: ReadonlyMap<number, number>,
    now: number,
  ): unknown {
    const tree = treeOf(rows, process.pid);
    return {
      sampledAt: now,
      processCount: tree.length,
      cpuPercent: sumCpu(tree, rates),
      rssBytes: sumRss(tree),
      ...memoryDetail(this.minor),
    };
  }

  private otherFrame(
    rows: readonly ProcessRow[],
    rates: ReadonlyMap<number, number>,
    charged: ReadonlySet<number>,
    now: number,
  ): unknown {
    const rest = treeOf(rows, process.pid).filter(
      (row) => !charged.has(row.pid),
    );
    return {
      sampledAt: now,
      rootPids: [process.pid],
      processCount: rest.length,
      cpuPercent: sumCpu(rest, rates),
      rssBytes: sumRss(rest),
      processes: rest.map((row) =>
        processFrame(row, process.pid, rates, this.minor),
      ),
      ...memoryDetail(this.minor),
    };
  }

  private send(frame: unknown): void {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }
}

/** `@1.0` opens with an epic id alone; `scope` arrives at `@1.1`. */
export function readScope(
  params: unknown,
  minor: number,
): ResourcesSubscribeScopeWire | null {
  const wide = resourcesSubscribeOpenRequestV11Schema.safeParse(params);
  if (minor >= 1 && wide.success) {
    return wide.data.scope;
  }
  const epicId =
    params !== null && typeof params === "object"
      ? Reflect.get(params, "epicId")
      : null;
  return typeof epicId === "string" && epicId.length > 0
    ? { kind: "epic", epicId }
    : null;
}

/** Process readings are SELF values; consumers derive subtree totals. */
function processFrame(
  row: ProcessRow,
  rootPid: number,
  rates: ReadonlyMap<number, number>,
  minor: number,
): { readonly pid: number; readonly [key: string]: unknown } {
  return {
    pid: row.pid,
    parentPid: row.parentPid,
    rootPid,
    name: row.name,
    command: row.command,
    cpuPercent: rates.get(row.pid) ?? 0,
    rssBytes: row.rssBytes,
    ...memoryDetail(minor),
    // The contract's descriptor is Chromium-only, and this host starts agents
    // and shells; `null` is the schema's own word for "no safely joined
    // semantic label", not a gap.
    ...(minor >= DEMAND_MINOR ? { descriptor: null } : {}),
  };
}

/**
 * `ps` reports resident set and nothing finer, so proportional and private
 * memory are genuinely unmeasured here - which is exactly what the minor made
 * these fields nullable to say.
 */
function memoryDetail(minor: number): object {
  return minor >= DEMAND_MINOR ? { pssBytes: null, privateBytes: null } : {};
}

function sumCpu(
  rows: readonly ProcessRow[],
  rates: ReadonlyMap<number, number>,
): number {
  return rows.reduce((total, row) => total + (rates.get(row.pid) ?? 0), 0);
}

function sumRss(rows: readonly ProcessRow[]): number {
  return rows.reduce((total, row) => total + row.rssBytes, 0);
}

function scopeOf(
  scope: ResourcesSubscribeScopeWire,
):
  | { readonly kind: "epic"; readonly epicId: string }
  | { readonly kind: "global" } {
  return scope.kind === "epic"
    ? { kind: "epic", epicId: scope.epicId }
    : { kind: "global" };
}
