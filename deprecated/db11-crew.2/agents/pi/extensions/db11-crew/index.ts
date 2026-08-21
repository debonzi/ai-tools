import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installCrewleadExtension } from "../../../../src/crewlead/extension.ts";

export default function db11Crew(pi: ExtensionAPI): void {
  installCrewleadExtension(pi, { extensionPath: fileURLToPath(import.meta.url) });
}
