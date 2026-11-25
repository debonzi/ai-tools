import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextUsage, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";

function runTool(usage?: ContextUsage) {
  const tools: ToolDefinition[] = [];
  register({ registerTool: (tool) => tools.push(tool) } satisfies Pick<ExtensionAPI, "registerTool"> as ExtensionAPI);
  assert.equal(tools.length, 1);
  const [tool] = tools;
  assert.equal(tool.name, "pi-context-meter");
  const ctx = { getContextUsage: () => usage } satisfies Pick<ExtensionContext, "getContextUsage">;
  return tool.execute("test-call", {}, undefined, undefined, ctx as ExtensionContext);
}

test("reports the active model's context-window usage", async () => {
  const result = await runTool({ tokens: 1_234, contextWindow: 10_000, percent: 12.34 });
  assert.deepEqual(result.details, {
    available: true,
    tokensUsed: 1_234,
    contextWindow: 10_000,
    tokensRemaining: 8_766,
    percentUsed: 12.34,
  });
  assert.deepEqual(result.content, [{
    type: "text",
    text: "Tokens used: 1234\nTotal context-window size: 10000\nTokens remaining: 8766\nPercentage used: 12.34%",
  }]);
});

test("clamps remaining tokens to zero when usage exceeds capacity", async () => {
  const result = await runTool({ tokens: 105, contextWindow: 100, percent: 105 });
  const [content] = result.content;
  assert.ok(content?.type === "text");
  assert.match(content.text, /Tokens remaining: 0/);
});

test("does not invent usage data when Pi has none", async (t) => {
  await t.test("no active context usage", async () => {
    const result = await runTool();
    assert.deepEqual(result.details, {
      available: false,
      tokensUsed: null,
      contextWindow: null,
      tokensRemaining: null,
      percentUsed: null,
      reason: "context_usage_unavailable",
    });
  });

  await t.test("known capacity but unknown usage", async () => {
    const result = await runTool({ tokens: null, contextWindow: 10_000, percent: null });
    assert.deepEqual(result.details, {
      available: false,
      tokensUsed: null,
      contextWindow: 10_000,
      tokensRemaining: null,
      percentUsed: null,
      reason: "tokens_unavailable",
    });
  });
});
