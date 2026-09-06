import type { HostRuntime } from "../../runtime";

export type RpcHandlerResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type RpcHandler = (
  params: unknown,
  runtime: HostRuntime,
) => RpcHandlerResult | Promise<RpcHandlerResult>;
