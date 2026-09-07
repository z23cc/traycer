import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resourcesSubscribeServerFrameSchema,
  resourcesSubscribeServerFrameSchemaV12,
} from "@traycer/protocol/host/resources/subscribe";
import { CpuRates, treeOf, type ProcessRow } from "../gui/resources";
import { ResourcesSubscriber, readScope } from "../stream/resources";
import { startHost, type StartedHost } from "../start-host";

type Frame = { readonly kind: string; readonly [key: string]: unknown };

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Frame[] = [];

  constructor(private readonly minor: number) {}

  send(payload: string): void {
    // Each minor parses through its OWN union, so a field that belongs to a
    // later one cannot ride out on an earlier frame unnoticed.
    const schema =
      this.minor >= 2
        ? resourcesSubscribeServerFrameSchemaV12
        : resourcesSubscribeServerFrameSchema;
    this.frames.push(schema.parse(JSON.parse(payload)) as Frame);
  }
}

describe("resources.subscribe", () => {
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

  it("reports a rate from two samples, never a lifetime average", () => {
    const rates = new CpuRates();
    const row = (cpuSeconds: number): ProcessRow => ({
      pid: 7,
      parentPid: 1,
      name: "probe",
      command: "probe",
      cpuSeconds,
      rssBytes: 1024,
    });
    // A first sample has no predecessor, and 0 is the honest answer: a rate
    // needs two points.
    expect(rates.measure([row(120)], 1_000)?.get(7)).toBe(0);
    // Half a CPU-second burned over one wall second is 50%, whatever the
    // process did in the two minutes before that.
    expect(rates.measure([row(120.5)], 2_000)?.get(7)).toBeCloseTo(50, 5);
  });

  it("walks a tree through the parent links of one sample", () => {
    const rows: ProcessRow[] = [
      proc(10, 1),
      proc(11, 10),
      proc(12, 11),
      proc(20, 1),
    ];
    expect(treeOf(rows, 10).map((row) => row.pid)).toEqual([10, 11, 12]);
    expect(treeOf(rows, 99)).toEqual([]);
  });

  it("holds the pre-1.2 projection frozen and adds the trees at 1.2", async () => {
    const host = await boot();
    const old = new FakeSocket(1);
    new ResourcesSubscriber(
      old as never,
      host.runtime,
      { kind: "epic", epicId: "epic-1" },
      1,
    ).start();
    const before = old.frames[0];
    expect(before).toMatchObject({ kind: "snapshot", epicId: "epic-1" });
    // Frozen: a resolver on 1.0/1.1 must emit precisely that projection.
    expect(before.hostTree).toBeUndefined();
    expect(before.other).toBeUndefined();
    // No owner roots on a fresh host, and "not tracked" is not a zeroed row.
    expect(before.epic).toBeNull();
    expect(before.owners).toEqual([]);

    const current = new FakeSocket(2);
    const lane = new ResourcesSubscriber(
      current as never,
      host.runtime,
      { kind: "epic", epicId: "epic-1" },
      5,
    );
    lane.start();
    lane.stop();
    expect(current.frames[0].hostTree).toMatchObject({
      processCount: expect.any(Number),
    });
    expect(current.frames[0].other).not.toBeNull();
  });

  it("takes an epic id alone at 1.0 and a scope from 1.1", () => {
    expect(readScope({ epicId: "e-1" }, 0)).toEqual({
      kind: "epic",
      epicId: "e-1",
    });
    // A newer client downgrading to 1.0 still carries `epicId`, which is why
    // the field stayed on the wire.
    expect(readScope({ epicId: "e-1", scope: { kind: "global" } }, 1)).toEqual({
      kind: "global",
    });
    expect(readScope({}, 1)).toBeNull();
  });

  async function boot(): Promise<StartedHost> {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    return started;
  }
});

function proc(pid: number, parentPid: number): ProcessRow {
  return {
    pid,
    parentPid,
    name: `p${String(pid)}`,
    command: null,
    cpuSeconds: 0,
    rssBytes: 0,
  };
}
