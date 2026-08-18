export const TRAYCER_LOCAL_HOST_ENV = "TRAYCER_LOCAL_HOST";

/**
 * `make dev-desktop` (this fork) runs the in-repo `@traycer/host` and sets
 * this flag so the desktop does not call `traycer host ensure`, which would
 * download the official signed host and overwrite the local pid.json.
 */
export function isLocalInRepoHost(env: NodeJS.ProcessEnv): boolean {
  return env[TRAYCER_LOCAL_HOST_ENV] === "1";
}
