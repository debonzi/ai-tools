import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import {
  DEFAULT_CONFIGURATION,
  configurationPath,
  parseConfigurationText,
  type ConfigurationFailure,
  type EffectiveConfiguration,
} from "./config.ts";
import { canonicalJson } from "../security/json.ts";

export type ConfigurationInspection =
  | { status: "default"; path: string; configuration: EffectiveConfiguration }
  | { status: "valid"; path: string; configuration: EffectiveConfiguration }
  | { status: "invalid"; path: string; issues: ConfigurationFailure["issues"] }
  | { status: "unsafe"; path: string; code: string };

export interface ConfigurationWriteReceipt {
  path: string;
  changed: boolean;
  configuration: EffectiveConfiguration;
}

function privateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function sameEntry(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function safeIssues(error: unknown): ConfigurationFailure["issues"] {
  if (error !== null && typeof error === "object" && Array.isArray((error as { issues?: unknown }).issues)) {
    return (error as { issues: ConfigurationFailure["issues"] }).issues;
  }
  return [{ path: "/", code: "invalid" }];
}

/** Read and atomically write the fixed non-secret account configuration without following links. */
export class AccountConfigurationStore {
  readonly accountHome: string;
  readonly path: string;
  private readonly uid: number;

  constructor(accountHome: string, uid = process.getuid?.() ?? -1) {
    if (!isAbsolute(accountHome)) throw new Error("The account home must be absolute.");
    this.accountHome = accountHome;
    this.path = configurationPath(accountHome);
    this.uid = uid;
  }

  private async inspectDirectory(path: string, requirePrivate: boolean): Promise<{ dev: number | bigint; ino: number | bigint }> {
    const info = await lstat(path);
    if (
      !info.isDirectory() || info.isSymbolicLink() ||
      (this.uid >= 0 && info.uid !== this.uid) ||
      (requirePrivate ? !privateMode(info.mode) : (info.mode & 0o022) !== 0)
    ) {
      throw new Error("unsafe_directory");
    }
    const canonical = await realpath(path);
    if (canonical !== path) throw new Error("unsafe_directory");
    return { dev: info.dev, ino: info.ino };
  }

  private async fileIdentity(): Promise<{ dev: number | bigint; ino: number | bigint } | undefined> {
    try {
      const info = await lstat(this.path);
      return { dev: info.dev, ino: info.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async inspect(): Promise<ConfigurationInspection> {
    try {
      await this.inspectDirectory(this.accountHome, false);
      const configDirectory = dirname(this.path);
      const parent = dirname(configDirectory);
      try {
        await this.inspectDirectory(parent, false);
        await this.inspectDirectory(configDirectory, true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { status: "default", path: this.path, configuration: DEFAULT_CONFIGURATION };
        }
        throw error;
      }
      const info = await lstat(this.path);
      if (
        !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        (this.uid >= 0 && info.uid !== this.uid) || !privateMode(info.mode)
      ) {
        return { status: "unsafe", path: this.path, code: "unsafe_configuration_file" };
      }
      const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!sameEntry(info, opened) || opened.size > 16 * 1_024) {
          return { status: "unsafe", path: this.path, code: "unsafe_configuration_file" };
        }
        const parsed = parseConfigurationText(await handle.readFile());
        if (!parsed.ok) return { status: "invalid", path: this.path, issues: safeIssues(parsed.error) };
        return { status: "valid", path: this.path, configuration: parsed.value };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "default", path: this.path, configuration: DEFAULT_CONFIGURATION };
      }
      return {
        status: "unsafe",
        path: this.path,
        code: error instanceof Error && error.message === "unsafe_directory"
          ? "unsafe_configuration_parent"
          : "configuration_read_failed",
      };
    }
  }

  async writeText(text: string): Promise<ConfigurationWriteReceipt> {
    const parsed = parseConfigurationText(text);
    if (!parsed.ok) {
      const error = new Error("The DB11 Crew settings were rejected.") as Error & { issues?: ConfigurationFailure["issues"] };
      error.issues = parsed.error.issues;
      throw error;
    }
    const before = await this.inspect();
    if (before.status === "unsafe") throw new Error("The DB11 Crew configuration path is unsafe.");
    const beforeIdentity = await this.fileIdentity();

    await this.inspectDirectory(this.accountHome, false);
    const configDirectory = dirname(this.path);
    const parent = dirname(configDirectory);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await this.inspectDirectory(parent, false);
    try {
      await mkdir(configDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const directoryIdentity = await this.inspectDirectory(configDirectory, true);
    const serialized = `${canonicalJson(parsed.value, 16 * 1_024)}\n`;
    const unchanged = (before.status === "valid" || before.status === "default") &&
      canonicalJson(before.configuration, 16 * 1_024) === canonicalJson(parsed.value, 16 * 1_024) && before.status === "valid";
    if (unchanged) return { path: this.path, changed: false, configuration: parsed.value };

    const temporary = join(configDirectory, `.config.${process.pid}.${Date.now()}.tmp`);
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;

      const latestDirectory = await this.inspectDirectory(configDirectory, true);
      if (!sameEntry(directoryIdentity, latestDirectory)) throw new Error("The configuration directory changed during the write.");
      const current = await this.inspect();
      const currentIdentity = await this.fileIdentity();
      if (
        (beforeIdentity === undefined) !== (currentIdentity === undefined) ||
        (beforeIdentity !== undefined && currentIdentity !== undefined && !sameEntry(beforeIdentity, currentIdentity))
      ) {
        throw new Error("The configuration changed during the write.");
      }
      if (before.status === "valid" && current.status !== "valid") {
        throw new Error("The configuration changed during the write.");
      } else if (before.status === "default" && current.status !== "default") {
        throw new Error("The configuration appeared during the write.");
      } else if (before.status === "invalid" && current.status !== "invalid") {
        throw new Error("The invalid configuration changed during the write.");
      }
      await rename(temporary, this.path);
      const directoryHandle = await open(configDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      return { path: this.path, changed: true, configuration: parsed.value };
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}

export function serializeConfiguration(configuration: EffectiveConfiguration): string {
  return `${JSON.stringify(configuration, null, 2)}\n`;
}
