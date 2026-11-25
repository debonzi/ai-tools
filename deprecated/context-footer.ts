import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const update = (ctx: any) => {
    const usage = ctx.getContextUsage();

    if (usage?.tokens == null) {
      ctx.ui.setStatus("context-tokens", undefined);
      return;
    }

    const tokens = `${(usage.tokens / 1000).toFixed(1)}k`;

    ctx.ui.setStatus(
      "context-tokens",
      `Session Tokens: ${tokens}`
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    update(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    update(ctx);
  });
}
