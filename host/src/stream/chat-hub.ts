import type { WebSocket } from "ws";

export class ChatHub {
  private readonly subscribers = new Map<string, Set<WebSocket>>();

  add(epicId: string, chatId: string, socket: WebSocket): void {
    const key = sessionKey(epicId, chatId);
    const sockets = this.subscribers.get(key);
    if (sockets === undefined) {
      this.subscribers.set(key, new Set([socket]));
      return;
    }
    sockets.add(socket);
  }

  remove(socket: WebSocket): void {
    for (const [key, sockets] of this.subscribers) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.subscribers.delete(key);
      }
    }
  }

  sockets(epicId: string, chatId: string): readonly WebSocket[] {
    const sockets = this.subscribers.get(sessionKey(epicId, chatId));
    if (sockets === undefined) {
      return [];
    }
    return [...sockets];
  }
}

function sessionKey(epicId: string, chatId: string): string {
  return `${epicId}\0${chatId}`;
}
