import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const HOST_DATA_DIR_FLAG = "--host-data-dir";
const HOST_DATA_DIR_EQUALS = "--host-data-dir=";

/**
 * Isolated default so an OSS host does not overwrite a registry install
 * under `~/.traycer/host`.
 */
export function defaultHostDataDir(): string {
  return join(homedir(), ".traycer", "host", "oss");
}

export function parseHostDataDirArg(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === HOST_DATA_DIR_FLAG) {
      const value = argv[index + 1];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
      return null;
    }
    if (token.startsWith(HOST_DATA_DIR_EQUALS)) {
      const value = token.slice(HOST_DATA_DIR_EQUALS.length);
      if (value.length > 0) {
        return value;
      }
      return null;
    }
  }
  return null;
}

export function resolveHostDataDir(argv: readonly string[]): string {
  const parsed = parseHostDataDirArg(argv);
  if (parsed === null) {
    return defaultHostDataDir();
  }
  if (!isAbsolute(parsed)) {
    throw new Error(
      `${HOST_DATA_DIR_FLAG} '${parsed}' must be an absolute path`,
    );
  }
  return resolve(parsed);
}
