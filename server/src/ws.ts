import type { ServerWebSocket } from "bun";
import type { ServerMessage } from "../../shared/types.ts";

/** Tracks connected frontend WebSocket clients and broadcasts to them. */
export class Broadcaster {
  private clients = new Set<ServerWebSocket<unknown>>();

  add(ws: ServerWebSocket<unknown>): void {
    this.clients.add(ws);
  }

  remove(ws: ServerWebSocket<unknown>): void {
    this.clients.delete(ws);
  }

  get size(): number {
    return this.clients.size;
  }

  send(ws: ServerWebSocket<unknown>, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      this.clients.delete(ws);
    }
  }

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      try {
        ws.send(data);
      } catch {
        this.clients.delete(ws);
      }
    }
  }
}
