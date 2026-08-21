import { createConnection, type Socket } from "node:net";

import { parseBoundedJson } from "../../security/json.ts";
import { HerdrAdapterError, herdrError, type HerdrGapReason } from "./contracts.ts";

export interface HerdrTransportOptions {
  socketPath: string;
  requestTimeoutMilliseconds?: number;
  maximumFrameBytes?: number;
  reconnectInitialMilliseconds?: number;
  reconnectMaximumMilliseconds?: number;
  maximumReconnectAttempts?: number;
  connect?: (path: string) => Socket;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface StreamCallbacks {
  subscriptions: readonly Record<string, unknown>[];
  onEvent(frame: unknown): void;
  onSnapshot(result: unknown, generation: number): void | Promise<void>;
  onGap?(reason: HerdrGapReason): void;
}

const DEFAULT_TIMEOUT = 5_000;
const DEFAULT_FRAME_BYTES = 1024 * 1024;

function boundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function safeSocketPath(path: string): void {
  if (!path.startsWith("/") || path.length > 512 || path.includes("\0") || /[\r\n]/.test(path)) {
    throw herdrError("invalid_argument");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Correlated newline-delimited JSON transport for one local Herdr Unix socket.
 * Protocol violations are fatal; ordinary disconnects use bounded exponential
 * reconnect and reconcile through a fresh session snapshot.
 */
export class HerdrSocketTransport {
  private readonly socketPath: string;
  private readonly requestTimeoutMilliseconds: number;
  private readonly maximumFrameBytes: number;
  private readonly reconnectInitialMilliseconds: number;
  private readonly reconnectMaximumMilliseconds: number;
  private readonly maximumReconnectAttempts: number;
  private readonly connectSocket: (path: string) => Socket;
  private socket?: Socket;
  private connectPromise?: Promise<void>;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, PendingRequest>();
  private nextRequest = 1;
  private stream?: StreamCallbacks;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private generation = 0;
  private reconciling = false;
  private bufferedEvents: unknown[] = [];
  private stopped = false;
  private fatal = false;

  constructor(options: HerdrTransportOptions) {
    safeSocketPath(options.socketPath);
    const timeout = options.requestTimeoutMilliseconds ?? DEFAULT_TIMEOUT;
    const frameBytes = options.maximumFrameBytes ?? DEFAULT_FRAME_BYTES;
    const initial = options.reconnectInitialMilliseconds ?? 100;
    const maximum = options.reconnectMaximumMilliseconds ?? 5_000;
    const attempts = options.maximumReconnectAttempts ?? 8;
    if (
      !boundedInteger(timeout, 10, 300_000) ||
      !boundedInteger(frameBytes, 1_024, 4 * 1024 * 1024) ||
      !boundedInteger(initial, 1, 60_000) ||
      !boundedInteger(maximum, initial, 60_000) ||
      !boundedInteger(attempts, 0, 32)
    ) {
      throw herdrError("invalid_argument");
    }
    this.socketPath = options.socketPath;
    this.requestTimeoutMilliseconds = timeout;
    this.maximumFrameBytes = frameBytes;
    this.reconnectInitialMilliseconds = initial;
    this.reconnectMaximumMilliseconds = maximum;
    this.maximumReconnectAttempts = attempts;
    this.connectSocket = options.connect ?? ((path) => createConnection({ path }));
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!/^[a-z][a-z_.]+$/.test(method) || !isRecord(params)) throw herdrError("invalid_argument");
    if (this.stopped || this.fatal) throw herdrError("connection_failed");
    const transport = new HerdrSocketTransport({
      socketPath: this.socketPath,
      requestTimeoutMilliseconds: this.requestTimeoutMilliseconds,
      maximumFrameBytes: this.maximumFrameBytes,
      reconnectInitialMilliseconds: this.reconnectInitialMilliseconds,
      reconnectMaximumMilliseconds: this.reconnectMaximumMilliseconds,
      maximumReconnectAttempts: 0,
      connect: this.connectSocket,
    });
    try {
      await transport.ensureConnected();
      return await transport.requestConnected(method, params);
    } finally {
      transport.stop();
    }
  }

  async startStream(callbacks: StreamCallbacks): Promise<void> {
    if (this.stream) throw herdrError("invalid_argument");
    this.stream = callbacks;
    try {
      await this.establishStream();
    } catch (error) {
      this.stream = undefined;
      throw error;
    }
  }

  stop(): void {
    this.stopped = true;
    this.stream = undefined;
    this.bufferedEvents = [];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.rejectPending(herdrError("connection_lost"));
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
  }

  private async ensureConnected(): Promise<void> {
    if (this.stopped || this.fatal) throw herdrError("connection_failed");
    if (this.socket && !this.socket.destroyed) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let socket: Socket;
      try {
        socket = this.connectSocket(this.socketPath);
      } catch (error) {
        reject(herdrError("connection_failed", { cause: error }));
        return;
      }
      this.socket = socket;
      this.buffer = Buffer.alloc(0);
      const failConnect = (error: unknown) => {
        if (settled) return;
        settled = true;
        if (this.socket === socket) this.socket = undefined;
        socket.destroy();
        reject(herdrError("connection_failed", { cause: error }));
      };
      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        socket.removeListener("error", failConnect);
        this.installSocketHandlers(socket);
        resolve();
      });
      socket.once("error", failConnect);
    }).finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private installSocketHandlers(socket: Socket): void {
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", () => {
      // close is the single recovery path
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.buffer = Buffer.alloc(0);
      this.rejectPending(herdrError("connection_lost"));
      if (!this.stopped && !this.fatal && this.stream) {
        this.stream.onGap?.("connection_lost");
        this.scheduleReconnect();
      }
    });
  }

  private receive(chunk: Buffer): void {
    if (this.fatal || this.stopped) return;
    if (this.buffer.length + chunk.length > this.maximumFrameBytes) {
      this.protocolFailure();
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      let line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0 || line.length > this.maximumFrameBytes) {
        this.protocolFailure();
        return;
      }
      let frame: unknown;
      try {
        frame = parseBoundedJson(line, this.maximumFrameBytes);
      } catch {
        this.protocolFailure();
        return;
      }
      if (!isRecord(frame)) {
        this.protocolFailure();
        return;
      }
      if (typeof frame.id === "string") {
        this.receiveResponse(frame);
      } else if (typeof frame.event === "string" && isRecord(frame.data)) {
        if (!this.stream) {
          this.protocolFailure();
          return;
        }
        if (this.reconciling) {
          this.bufferedEvents.push(frame);
        } else {
          try {
            this.stream.onEvent(frame);
          } catch {
            this.protocolFailure();
            return;
          }
        }
      } else {
        this.protocolFailure();
        return;
      }
    }
  }

  private receiveResponse(frame: Record<string, unknown>): void {
    const keys = Object.keys(frame);
    const success = keys.length === 2 && "result" in frame;
    const failure = keys.length === 2 && isRecord(frame.error);
    if (!success && !failure) {
      this.protocolFailure();
      return;
    }
    const pending = this.pending.get(frame.id as string);
    if (!pending) {
      this.protocolFailure();
      return;
    }
    this.pending.delete(frame.id as string);
    clearTimeout(pending.timer);
    if (failure) {
      const error = frame.error as Record<string, unknown>;
      if (typeof error.code !== "string" || typeof error.message !== "string") {
        this.protocolFailure();
        return;
      }
      pending.reject(herdrError("server_error"));
      return;
    }
    pending.resolve(frame.result);
  }

  private async requestConnected(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw herdrError("connection_lost");
    const id = `db11-crew:${this.nextRequest++}`;
    const encoded = Buffer.from(`${JSON.stringify({ id, method, params })}\n`, "utf8");
    if (encoded.length > this.maximumFrameBytes) throw herdrError("invalid_argument");
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(herdrError("request_timeout"));
        // Fence any late response for the timed-out correlation ID by replacing
        // the connection instead of accepting an orphaned response later.
        this.socket?.destroy();
      }, this.requestTimeoutMilliseconds);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      socket.write(encoded, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(herdrError("connection_lost", { cause: error }));
      });
    });
  }

  private async establishStream(): Promise<void> {
    const stream = this.stream;
    if (!stream) return;
    await this.ensureConnected();
    this.reconciling = true;
    this.bufferedEvents = [];
    try {
      const started = await this.requestConnected("events.subscribe", {
        subscriptions: stream.subscriptions,
      });
      if (!isRecord(started) || Object.keys(started).length !== 1 || started.type !== "subscription_started") {
        throw herdrError("schema_mismatch");
      }
      const snapshot = await this.request("session.snapshot", {});
      this.generation += 1;
      await stream.onSnapshot(snapshot, this.generation);
      this.reconnectAttempts = 0;
      this.reconciling = false;
      const events = this.bufferedEvents;
      this.bufferedEvents = [];
      for (const event of events) {
        try {
          stream.onEvent(event);
        } catch {
          this.protocolFailure();
          throw herdrError("schema_mismatch");
        }
      }
    } catch (error) {
      this.reconciling = false;
      this.bufferedEvents = [];
      throw error;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.stream) return;
    if (this.reconnectAttempts >= this.maximumReconnectAttempts) {
      this.stream.onGap?.("reconnect_exhausted");
      return;
    }
    const delay = Math.min(
      this.reconnectInitialMilliseconds * 2 ** this.reconnectAttempts,
      this.reconnectMaximumMilliseconds,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.establishStream().catch((error: unknown) => {
        if (
          error instanceof HerdrAdapterError &&
          ["malformed_frame", "schema_mismatch", "unsupported_protocol", "unsupported_schema"].includes(error.code)
        ) {
          this.protocolFailure();
          return;
        }
        if (this.stream && !this.stopped && !this.fatal) this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private protocolFailure(): void {
    if (this.fatal) return;
    this.fatal = true;
    this.stream?.onGap?.("protocol_error");
    this.rejectPending(herdrError("malformed_frame"));
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
  }
}
