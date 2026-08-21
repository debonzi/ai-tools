import { LIMITS } from "../protocol/limits.ts";

const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|authorization|credential|password|secret|session[_-]?token|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const URL_USERINFO = /\b(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;
const TOKEN_SHAPES = /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g;

export interface RedactionOptions {
  homeDirectory?: string;
  maximumLength?: number;
}

/** Redact common secret shapes and bound one human-visible diagnostic. */
export function redactDiagnostic(input: unknown, options: RedactionOptions = {}): string {
  const maximumLength = Math.min(
    Math.max(options.maximumLength ?? LIMITS.diagnosticLength, 1),
    LIMITS.diagnosticLength,
  );
  let value = typeof input === "string" ? input : "A private operation failed.";
  value = value.replace(PRIVATE_KEY, "[REDACTED PRIVATE KEY]");
  value = value.replace(BEARER, "Bearer-[REDACTED]");
  value = value.replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[REDACTED]`);
  value = value.replace(URL_USERINFO, "$1[REDACTED]@");
  value = value.replace(TOKEN_SHAPES, "[REDACTED]");
  if (options.homeDirectory) {
    value = value.split(options.homeDirectory).join("~");
  }
  value = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "?");
  value = value.replace(/\s+/g, " ").trim();
  if (!value) return "A private operation failed.";
  if (value.length <= maximumLength) return value;
  return `${value.slice(0, Math.max(1, maximumLength - 1))}…`;
}
