import { createHash, timingSafeEqual } from "node:crypto";

import { LIMITS } from "../protocol/limits.ts";
import { stateError } from "./errors.ts";

function inspectJson(value: unknown): void {
  const seen = new Set<object>();
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > LIMITS.jsonNodes || current.depth > LIMITS.jsonDepth) {
      throw stateError("oversized");
    }
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) throw stateError("invalid_record");
      continue;
    }
    if (typeof current.value !== "object") throw stateError("invalid_record");
    if (seen.has(current.value)) throw stateError("invalid_record");
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw stateError("invalid_record");
    }
    const keys = Reflect.ownKeys(current.value);
    if (keys.some((key) => typeof key !== "string")) throw stateError("invalid_record");
    const descriptors = Object.getOwnPropertyDescriptors(current.value);
    for (const descriptor of Object.values(descriptors)) {
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        throw stateError("invalid_record");
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function canonicalJson(value: unknown, maximumBytes: number): string {
  inspectJson(value);
  const serialized = canonical(value);
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) throw stateError("oversized");
  return serialized;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestJson(value: unknown, maximumBytes: number): string {
  return sha256(canonicalJson(value, maximumBytes));
}

export function equalDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function parseBoundedJson(text: string | Buffer, maximumBytes: number): unknown {
  const bytes = typeof text === "string" ? Buffer.byteLength(text, "utf8") : text.byteLength;
  if (bytes > maximumBytes) throw stateError("oversized");
  let value: unknown;
  try {
    value = JSON.parse(text.toString());
  } catch (error) {
    throw stateError("invalid_record", error);
  }
  inspectJson(value);
  return value;
}
