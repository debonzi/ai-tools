import { spawn } from "node:child_process";

import { LIMITS } from "../protocol/limits.ts";
import { redactDiagnostic } from "../security/redaction.ts";

export type AdapterErrorCode =
  | "capture_race"
  | "command_failed"
  | "command_timeout"
  | "invalid_argument"
  | "invalid_json"
  | "output_oversized"
  | "repository_collision"
  | "repository_dirty"
  | "repository_identity"
  | "repository_operation"
  | "repository_scope"
  | "repository_state"
  | "revision_conflict"
  | "scope_conflict"
  | "scope_unknown"
  | "snapshot_violation"
  | "wyrd_scope";

const SAFE_MESSAGES: Record<AdapterErrorCode, string> = {
  capture_race: "The repository changed while the read snapshot was captured.",
  command_failed: "A bounded local adapter command failed.",
  command_timeout: "A bounded local adapter command exceeded its time limit.",
  invalid_argument: "A structured adapter argument was rejected.",
  invalid_json: "A local adapter returned invalid bounded JSON.",
  output_oversized: "A local adapter command returned too much output.",
  repository_collision: "An owned repository path or ref collides with existing state.",
  repository_dirty: "The Builder source worktree is not clean.",
  repository_identity: "The exact repository identity could not be verified.",
  repository_operation: "A Git operation is already in progress.",
  repository_scope: "A repository path is outside the assigned root.",
  repository_state: "The repository does not satisfy the required isolation state.",
  revision_conflict: "The expected Wyrd revision is stale.",
  scope_conflict: "The requested mutable repository scope overlaps another run.",
  scope_unknown: "A mutable repository scope is unknown and cannot be assumed disjoint.",
  snapshot_violation: "The detached read snapshot changed after capture.",
  wyrd_scope: "The requested Wyrd operation is outside the assigned scope.",
};

/** A bounded, path-free adapter error suitable for protocol diagnostics. */
export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly detail?: string;

  constructor(code: AdapterErrorCode, detail?: unknown, options?: ErrorOptions) {
    super(SAFE_MESSAGES[code], options);
    this.name = "AdapterError";
    this.code = code;
    this.detail = detail === undefined ? undefined : redactDiagnostic(detail);
  }
}

export function adapterError(
  code: AdapterErrorCode,
  detail?: unknown,
  cause?: unknown,
): AdapterError {
  return new AdapterError(
    code,
    detail,
    cause === undefined ? undefined : { cause },
  );
}

export interface CommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface CommandOptions {
  cwd: string;
  input?: string | Buffer;
  environment?: NodeJS.ProcessEnv;
  timeoutMilliseconds?: number;
  maximumOutputBytes?: number;
  acceptedExitCodes?: readonly number[];
}

/** Run one argv-only local command with bounded output and no shell interpretation. */
export async function runBoundedCommand(
  executable: string,
  arguments_: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const maximumOutputBytes = Math.min(
    Math.max(options.maximumOutputBytes ?? LIMITS.adapterOutputBytes, 1),
    LIMITS.adapterOutputBytes,
  );
  const timeoutMilliseconds = Math.min(
    Math.max(options.timeoutMilliseconds ?? LIMITS.adapterCommandMilliseconds, 1),
    LIMITS.adapterCommandMilliseconds,
  );
  const accepted = new Set(options.acceptedExitCodes ?? [0]);

  return new Promise<CommandResult>((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(executable, [...arguments_], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const finishError = (error: AdapterError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) {
        finishError(adapterError("output_oversized"));
        return;
      }
      target.push(chunk);
    };

    child.stdout!.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr!.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => finishError(adapterError("command_failed", undefined, error)));
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? (signal === null ? 1 : 128);
      const result = {
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (!accepted.has(exitCode)) {
        reject(adapterError("command_failed", result.stderr.toString("utf8")));
        return;
      }
      resolve(result);
    });

    const timer = setTimeout(() => {
      finishError(adapterError("command_timeout"));
    }, timeoutMilliseconds);
    timer.unref();

    if (options.input !== undefined) {
      child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") finishError(adapterError("command_failed", undefined, error));
      });
      child.stdin!.end(options.input);
    }
  });
}

export function minimalCommandEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: "/nonexistent/db11-crew-tool-home",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...overrides,
  };
}
