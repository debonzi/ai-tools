import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type ContextMeterDetails = {
  available: boolean;
  tokensUsed: number | null;
  contextWindow: number | null;
  tokensRemaining: number | null;
  percentUsed: number | null;
  reason?: "context_usage_unavailable" | "tokens_unavailable";
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "pi-context-meter",
    label: "Pi Context Meter",
    description: "Report the active model's current context-window usage and remaining capacity.",
    promptSnippet: "Inspect your current context-window usage, total capacity, and remaining tokens",
    promptGuidelines: [
      "Use pi-context-meter when the user asks about context-window usage, total capacity, or remaining context.",
      "Use pi-context-meter when you need to determine whether enough context remains for a task, but do not call it routinely or on every turn.",
      "When explicitly instructed to check your context window, call pi-context-meter instead of estimating it yourself.",
    ],
    parameters: Type.Object({}, { additionalProperties: false }),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const usage = ctx.getContextUsage();

      if (!usage) {
        const details: ContextMeterDetails = {
          available: false,
          tokensUsed: null,
          contextWindow: null,
          tokensRemaining: null,
          percentUsed: null,
          reason: "context_usage_unavailable",
        };

        return {
          content: [
            {
              type: "text",
              text: "Context usage is currently unavailable. Used tokens, total context-window size, remaining tokens, and percentage used could not be determined.",
            },
          ],
          details,
        };
      }

      if (usage.tokens == null) {
        const details: ContextMeterDetails = {
          available: false,
          tokensUsed: null,
          contextWindow: usage.contextWindow,
          tokensRemaining: null,
          percentUsed: null,
          reason: "tokens_unavailable",
        };

        return {
          content: [
            {
              type: "text",
              text: `Used tokens are currently unavailable. Total context-window size: ${usage.contextWindow} tokens. Remaining tokens and percentage used cannot be determined until token usage is available.`,
            },
          ],
          details,
        };
      }

      const tokensRemaining = Math.max(usage.contextWindow - usage.tokens, 0);
      const details: ContextMeterDetails = {
        available: true,
        tokensUsed: usage.tokens,
        contextWindow: usage.contextWindow,
        tokensRemaining,
        percentUsed: usage.percent,
      };
      const percentUsed = usage.percent == null ? "unavailable" : `${usage.percent.toFixed(2)}%`;

      return {
        content: [
          {
            type: "text",
            text: [
              `Tokens used: ${usage.tokens}`,
              `Total context-window size: ${usage.contextWindow}`,
              `Tokens remaining: ${tokensRemaining}`,
              `Percentage used: ${percentUsed}`,
            ].join("\n"),
          },
        ],
        details,
      };
    },
  });
}
