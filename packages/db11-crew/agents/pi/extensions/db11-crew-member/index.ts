import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installMemberCompanion } from "../../../../src/companion/extension.ts";

export default function db11CrewMember(pi: ExtensionAPI): void {
  installMemberCompanion(pi, { extensionPath: fileURLToPath(import.meta.url) });
}
