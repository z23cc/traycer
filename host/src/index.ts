import { HOST_PACKAGE_VERSION, loadRuntimeConfig } from "./config";
import { publishPidMetadata, removePidMetadata } from "./pid";
import { startHostServer } from "./server";

async function main(): Promise<void> {
  const config = await loadRuntimeConfig(process.env);
  const server = await startHostServer(config.port, config.hostId, {
    runner: undefined,
    hostHome: config.hostHome,
  });
  const pidPath = await publishPidMetadata({
    hostHome: config.hostHome,
    hostId: config.hostId,
    version: HOST_PACKAGE_VERSION,
    websocketUrl: server.websocketUrl,
  });
  const shutdown = (): void => {
    void (async () => {
      await removePidMetadata(config.hostHome);
      await server.close();
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.write(
    `[traycer-host] ${config.hostId} listening on ${server.websocketUrl}\n`,
  );
  process.stdout.write(`[traycer-host] pid metadata ${pidPath}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[traycer-host] failed to start: ${message}\n`);
  process.exit(1);
});
