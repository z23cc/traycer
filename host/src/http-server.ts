import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { attachRpcConnection } from "./rpc/connection";
import { attachStreamConnection } from "./stream/connection";
import type { HostRuntime } from "./runtime";

export type HostHttpServer = {
  readonly server: Server;
  readonly port: number;
  readonly rpcUrl: string;
  close: () => Promise<void>;
};

export async function listenHostHttp(input: {
  readonly host: string;
  readonly port: number;
  readonly runtime: HostRuntime;
}): Promise<HostHttpServer> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${input.host}`);
    if (request.method === "GET" && url.pathname === "/activity") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ busy: false }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const rpcWss = new WebSocketServer({ noServer: true });
  const streamWss = new WebSocketServer({ noServer: true });
  rpcWss.on("connection", (socket) => {
    attachRpcConnection(socket, input.runtime);
  });
  streamWss.on("connection", (socket) => {
    attachStreamConnection(socket, input.runtime);
  });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${input.host}`);
    if (url.pathname === "/rpc") {
      rpcWss.handleUpgrade(request, socket, head, (websocket) => {
        rpcWss.emit("connection", websocket, request);
      });
      return;
    }
    if (url.pathname === "/stream") {
      streamWss.handleUpgrade(request, socket, head, (websocket) => {
        streamWss.emit("connection", websocket, request);
      });
      return;
    }
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(input.port, input.host, () => {
      resolve();
    });
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("host HTTP server did not bind a TCP port");
  }
  const port = address.port;
  return {
    server,
    port,
    rpcUrl: `ws://${input.host}:${String(port)}/rpc`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        rpcWss.close();
        streamWss.close();
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
