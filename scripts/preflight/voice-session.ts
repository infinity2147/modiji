/**
 * A minimal client for the ElevenLabs Agent WebSocket (`wss://…/v1/convai/conversation`, AsyncAPI spec):
 * sends `conversation_initiation_client_data`, answers every `ping` with a `pong`, records every server event with
 * its arrival time, and lets the caller wait on conditions. Text only: no microphone audio is ever sent.
 *
 * The socket is injected (`WebSocketFactory`) so tests drive it with a scripted fake; `nodeWebSocketFactory` adapts
 * Node 22's global WebSocket.
 */

export type WebSocketHandlers = {
  open(): void;
  message(data: unknown): void;
  close(code: number, reason: string): void;
  error(message: string): void;
};

export type WebSocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type WebSocketFactory = (url: string, handlers: WebSocketHandlers) => WebSocketLike;

export const nodeWebSocketFactory: WebSocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => handlers.open());
  ws.addEventListener("message", (event) => handlers.message(event.data));
  ws.addEventListener("close", (event) => handlers.close(event.code, event.reason));
  // The error event carries no detail beyond its type in Node; the close that follows has the code.
  ws.addEventListener("error", () => handlers.error("WebSocket error"));
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
  };
};

export type ServerEvent = { type: string; at: number; body: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const CLOSE_WAIT_MS = 3_000;

export class VoiceSession {
  readonly events: ServerEvent[] = [];
  /** Protocol problems: undecodable frames, socket errors. */
  readonly errors: string[] = [];
  pongs = 0;
  opened = false;
  closed: { code: number; reason: string } | null = null;
  conversationId: string | null = null;
  private readonly socket: WebSocketLike;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  private constructor(factory: WebSocketFactory, url: string, now: () => number) {
    this.now = now;
    this.socket = factory(url, {
      open: () => {
        this.opened = true;
        this.notify();
      },
      message: (data) => this.onMessage(data),
      close: (code, reason) => {
        this.closed = { code, reason };
        this.notify();
      },
      error: (message) => {
        this.errors.push(message);
        this.notify();
      },
    });
  }

  /**
   * Connects, sends the initiation data and waits for `conversation_initiation_metadata`. On failure the socket is
   * closed and an Error says which step did not complete.
   */
  static async connect(input: {
    factory: WebSocketFactory;
    url: string;
    initiation: Record<string, unknown>;
    timeoutMs: number;
    now: () => number;
  }): Promise<VoiceSession> {
    const session = new VoiceSession(input.factory, input.url, input.now);
    const opened = await session.waitFor(() => session.opened || session.closed !== null, input.timeoutMs);
    if (!opened || !session.opened || session.closed !== null) {
      await session.close();
      throw new Error(`WebSocket did not open within ${input.timeoutMs} ms${session.closeSuffix()}`);
    }
    session.send({ type: "conversation_initiation_client_data", ...input.initiation });
    const started = await session.waitFor(() => session.conversationId !== null || session.closed !== null, input.timeoutMs);
    if (!started || session.conversationId === null) {
      await session.close();
      throw new Error(`no conversation_initiation_metadata within ${input.timeoutMs} ms${session.closeSuffix()}`);
    }
    return session;
  }

  send(message: Record<string, unknown>): void {
    if (this.closed !== null) throw new Error(`cannot send ${String(message.type)}: socket closed${this.closeSuffix()}`);
    this.socket.send(JSON.stringify(message));
  }

  /** Resolves true as soon as `predicate` holds (checked after every event), false after `timeoutMs`. */
  waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const check = (): void => {
        if (!predicate()) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        resolve(predicate());
      }, timeoutMs);
      this.listeners.add(check);
    });
  }

  /** Events of `type` received at or after index `from`. */
  since(from: number, type?: string): ServerEvent[] {
    return this.events.slice(from).filter((e) => type === undefined || e.type === type);
  }

  /** Closes with 1000 and waits briefly for the close handshake. Idempotent. */
  async close(): Promise<void> {
    if (this.closed !== null) return;
    try {
      this.socket.close(1000, "preflight done");
    } catch (error) {
      this.errors.push(`close failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await this.waitFor(() => this.closed !== null, CLOSE_WAIT_MS);
  }

  closeSuffix(): string {
    if (this.closed === null) return "";
    return ` (closed ${this.closed.code}${this.closed.reason ? ` ${this.closed.reason.slice(0, 120)}` : ""})`;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") {
      this.errors.push("received a non-text frame");
      this.notify();
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(data);
    } catch {
      this.errors.push("received a frame that is not JSON");
      this.notify();
      return;
    }
    if (!isRecord(body) || typeof body.type !== "string") {
      this.errors.push("received a frame without a string type");
      this.notify();
      return;
    }
    this.events.push({ type: body.type, at: this.now(), body });
    if (body.type === "ping") {
      const eventId = isRecord(body.ping_event) ? body.ping_event.event_id : undefined;
      if (typeof eventId === "number" && this.closed === null) {
        this.socket.send(JSON.stringify({ type: "pong", event_id: eventId }));
        this.pongs += 1;
      } else {
        this.errors.push("ping without a numeric ping_event.event_id");
      }
    } else if (body.type === "conversation_initiation_metadata") {
      const meta = body.conversation_initiation_metadata_event;
      if (isRecord(meta) && typeof meta.conversation_id === "string") this.conversationId = meta.conversation_id;
    }
    this.notify();
  }
}
