import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentPatch, redactSecrets, webhookToolConfig } from "../elevenlabs.js";
import { DATA_COLLECTION_FIELDS, DEFAULT_SYSTEM_PROMPT, TOOL_DEFINITIONS, defaultBuildDynamicVariables } from "../hooks.js";
import { parseExtracted, parsePrice } from "../transcript.js";

test("each tool posts to the module's route with the secret and the call id header", () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((definition) => definition.name), ["report_quote", "report_note", "check_market"]);
  for (const definition of TOOL_DEFINITIONS) {
    const apiSchema = webhookToolConfig(definition, "https://example.ngrok-free.app", "s3cret").api_schema as Record<string, unknown>;
    assert.equal(apiSchema.url, `https://example.ngrok-free.app/elevenlabs/tools/${definition.name}`);
    assert.equal(apiSchema.method, "POST");
    assert.deepEqual(apiSchema.request_headers, { "X-Tool-Secret": "s3cret", "X-Call-Id": { variable_name: "call_id" } });
    assert.ok(apiSchema.request_body_schema !== undefined, "ElevenLabs requires a body schema on POST tools");
  }
});

test("the agent patch keeps unrelated settings and replaces only ours", () => {
  const current = {
    conversation_config: {
      tts: { voice_id: "voice-1" },
      agent: { language: "en", first_message: "Hello", prompt: { prompt: "old", llm: "some-llm", tool_ids: ["other", "stale"], tools: [{ name: "legacy" }] } },
    },
    platform_settings: { data_collection: { keep_me: { type: "string" } }, widget: { color: "red" } },
  };
  const patch = buildAgentPatch(current, {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    firstMessage: "",
    fields: DATA_COLLECTION_FIELDS,
    ourToolIds: ["q", "n", "m"],
    replacedToolIds: ["stale"],
  });
  const conversation = patch.conversation_config as Record<string, any>;
  assert.deepEqual(conversation.tts, { voice_id: "voice-1" });
  assert.equal(conversation.agent.language, "en");
  assert.equal(conversation.agent.first_message, "");
  assert.equal(conversation.agent.prompt.llm, "some-llm");
  assert.deepEqual(conversation.agent.prompt.tool_ids, ["other", "q", "n", "m"]);
  assert.equal(conversation.agent.prompt.tools, undefined);
  assert.deepEqual(conversation.agent.prompt.built_in_tools.end_call, { type: "system", name: "end_call", params: { system_tool_type: "end_call" } });
  const platform = patch.platform_settings as Record<string, any>;
  assert.deepEqual(platform.widget, { color: "red" });
  assert.ok(platform.data_collection.keep_me !== undefined);
  assert.equal(platform.data_collection.lowest_total_price.type, "number");
});

test("error text never carries a secret", () => {
  const token = "0123456789abcdef".repeat(4);
  const echoed = `{"X-Tool-Secret":"${token}","key":"sk_0123456789abcdef0123","mine":"my-secret-value"}`;
  const redacted = redactSecrets(echoed, ["my-secret-value"]);
  assert.equal(redacted.includes(token), false);
  assert.equal(redacted.includes("sk_0123456789abcdef0123"), false);
  assert.equal(redacted.includes("my-secret-value"), false);
});

test("prices are read from spoken and odd formats", () => {
  assert.equal(parsePrice(139), 139);
  assert.equal(parsePrice("$1,234.50"), 1234.5);
  assert.equal(parsePrice("none"), undefined);
  assert.equal(parsePrice(-5), undefined);
  assert.deepEqual(parseExtracted({ lowest_total_price: { value: "139" }, includes_taxes: { value: "yes" }, price_quote: "null" }), {
    lowestTotalPrice: 139,
    includesTaxes: true,
  });
  assert.equal(parseExtracted({}), undefined);
});

test("default dynamic variables speak the dates", () => {
  const variables = defaultBuildDynamicVariables({
    callId: "c1",
    runId: "r1",
    task: { taskId: "t", city: "Test City", checkIn: "2026-11-05", checkOut: "2026-11-07", nights: 2, guests: 2, rooms: 1, guestName: "Test Guest", receiptEmail: "guest@example.com" },
    hotel: { id: "h", name: "Test Hotel", phone: "+15555550100" },
  });
  assert.equal(variables.check_in, "Thursday, November 5");
  assert.equal(variables.call_id, "c1");
  assert.equal(variables.nights, 2);
});
