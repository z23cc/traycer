import type { RpcHandler } from "./types";

export function floorUnavailable(method: string): RpcHandler {
  return () => ({
    ok: false,
    code: "RPC_ERROR",
    message: `OSS host has no local analog for ${method}`,
  });
}
