#!/usr/bin/env node
import { startHost } from "./start-host";

const started = await startHost({
  argv: process.argv.slice(2),
  listenHost: "127.0.0.1",
  listenPort: 0,
});

const shutdown = (): void => {
  void started.close().finally(() => {
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
