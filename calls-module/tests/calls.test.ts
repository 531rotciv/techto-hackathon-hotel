// The module end to end with ElevenLabs and Twilio faked: routes, webhook,
// tools, default hooks, timeout. Secrets are set before the module loads.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

process.env.ELEVENLABS_WEBHOOK_SECRET = "test-webhook-secret";
process.env.ELEVENLABS_TOOL_SECRET = "test-tool-secret";

const { createCallsModule } = await import("../index.js");
const { signElevenLabsPayload } = await import("../routes.js");
type CallsModule = ReturnType<typeof createCallsModule>;
type CallDeps = import("../index.js").CallDeps;
type CallContext = import("../types.js").CallContext;
type CallsEvent = import("../events.js").CallsEvent;

// ---------- helpers ----------

function sampleContext(hotelName: string): CallContext {
  return {
    callId: crypto.randomUUID(),
    runId: `test-${crypto.randomUUID().slice(0, 8)}`,
    task: { taskId: "t", city: "Test City", checkIn: "2026-11-05", checkOut: "2026-11-07", nights: 2, guests: 2, rooms: 1, guestName: "Test Guest", receiptEmail: "guest@example.com" },
    hotel: { id: hotelName.toLowerCase().replace(/\s+/g, "-"), name: hotelName, phone: "+15555550102" },
  };
}

function fakeDeps(conversationId: string, overrides: Partial<CallDeps>): Partial<CallDeps> {
  return {
    placeCall: async () => ({ success: true, message: "Success", conversation_id: conversationId, callSid: `CA${conversationId}` }),
    getConversation: async (id: string) => ({ conversation_id: id, status: "done" }),
    endTwilioCall: async () => "completed",
    transcriptRetryMs: 10,
    transcriptWaitMs: 50,
    ...overrides,
  };
}

function readFixture(name: string): string {
  return fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function serve(calls: CallsModule): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  calls.registerRoutes(app);
  app.use(express.json()); // the host's own parser comes after, as the README says
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return { baseUrl, close };
}

function signed(rawBody: string): string {
  return signElevenLabsPayload(rawBody, "test-webhook-secret", Math.floor(Date.now() / 1000));
}

async function postWebhook(baseUrl: string, rawBody: string, signature: string | null): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature !== null) {
    headers["elevenlabs-signature"] = signature;
  }
  return fetch(`${baseUrl}/elevenlabs/post-call`, { method: "POST", headers, body: rawBody });
}

async function postTool(baseUrl: string, name: string, secret: string, callId: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/elevenlabs/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tool-Secret": secret, "X-Call-Id": callId },
    body: JSON.stringify(body),
  });
}

// ---------- tests ----------

test("a call runs end to end: tool call, quote, signed webhook, result", async () => {
  const calls = createCallsModule({ deps: fakeDeps("conv_fixture_transcription", {}) });
  const server = await serve(calls);
  const seen: CallsEvent["type"][] = [];
  const stop = calls.onEvent((event) => {
    seen.push(event.type);
  });
  try {
    const ctx = sampleContext("Maple Suites");
    const resultPromise = calls.startCall(ctx);
    await flush();
    assert.equal(calls.isLive(ctx.callId), true);

    const tool = await postTool(server.baseUrl, "report_quote", "test-tool-secret", ctx.callId, { total_price: 154, includes_taxes: true, trigger: "initial" });
    assert.deepEqual(await tool.json(), { ok: true });

    const rawBody = readFixture("post-call-transcription.json");
    assert.equal((await postWebhook(server.baseUrl, rawBody, signed(rawBody))).status, 200);

    const result = await resultPromise;
    assert.equal(result.status, "completed");
    assert.equal(result.endedBy, "agent");
    assert.equal(result.quotedPrice, 154);
    assert.equal(result.transcript.length, 8, "tool-call turns without a message are skipped");
    assert.deepEqual(result.transcript[0], { speaker: "hotel", text: "Good afternoon, Maple Suites.", atSecs: 1 });
    assert.equal(result.durationSecs, 26);
    assert.deepEqual(result.extracted, { lowestTotalPrice: 139, includesTaxes: true, rateConditions: "non-refundable", priceQuote: "Yes, $139 total, non-refundable." });
    assert.equal(calls.isLive(ctx.callId), false);

    const order = seen.filter((type) => ["call_started", "call_placed", "quote", "tool_call", "transcript_ready", "call_ended"].includes(type));
    assert.deepEqual(order, ["call_started", "call_placed", "quote", "tool_call", "transcript_ready", "call_ended"]);
  } finally {
    stop();
    await server.close();
  }
});

for (const [fixture, conversationId, expected] of [
  ["initiation-failure-busy.json", "conv_fixture_busy", "busy"],
  ["initiation-failure-no-answer.json", "conv_fixture_no_answer", "no_answer"],
] as const) {
  test(`initiation failure resolves with status ${expected}`, async () => {
    const calls = createCallsModule({ deps: fakeDeps(conversationId, {}) });
    const server = await serve(calls);
    try {
      const resultPromise = calls.startCall(sampleContext("Harbor Inn"));
      await flush();
      const rawBody = readFixture(fixture);
      assert.equal((await postWebhook(server.baseUrl, rawBody, signed(rawBody))).status, 200);
      const result = await resultPromise;
      assert.equal(result.status, expected);
      assert.equal(result.endedBy, "system");
    } finally {
      await server.close();
    }
  });
}

test("bad, stale, tampered or missing signatures get 401", async () => {
  const calls = createCallsModule({ deps: fakeDeps("conv_fixture_transcription", {}), callTimeoutMs: 60000 });
  const server = await serve(calls);
  const ctx = sampleContext("Grand Central");
  const resultPromise = calls.startCall(ctx);
  try {
    await flush();
    const rawBody = readFixture("post-call-transcription.json");
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await postWebhook(server.baseUrl, rawBody, signElevenLabsPayload(rawBody, "wrong", now))).status, 401);
    assert.equal((await postWebhook(server.baseUrl, rawBody.replace("139", "99"), signed(rawBody))).status, 401);
    assert.equal((await postWebhook(server.baseUrl, rawBody, signElevenLabsPayload(rawBody, "test-webhook-secret", now - 31 * 60))).status, 401);
    assert.equal((await postWebhook(server.baseUrl, rawBody, null)).status, 401);
    await flush();
    assert.equal(calls.isLive(ctx.callId), true);
  } finally {
    // Ends the call through the normal webhook path so its timer is cleared.
    const rawBody = readFixture("post-call-transcription.json");
    await postWebhook(server.baseUrl, rawBody, signed(rawBody));
    await resultPromise;
    await server.close();
  }
});

test("tool route: wrong secret 401, unknown call ok false, slow handler answered in budget", async () => {
  const slow = () => new Promise<Record<string, unknown>>(() => {
    // never resolves
  });
  const calls = createCallsModule({ deps: fakeDeps("conv_fixture_transcription", {}), handleToolCall: slow, toolResponseBudgetMs: 50 });
  const server = await serve(calls);
  const ctx = sampleContext("Harbor Inn");
  const resultPromise = calls.startCall(ctx);
  try {
    await flush();
    assert.equal((await postTool(server.baseUrl, "check_market", "wrong", ctx.callId, {})).status, 401);
    assert.deepEqual(await (await postTool(server.baseUrl, "check_market", "test-tool-secret", "no-such-call", {})).json(), { ok: false, error: "unknown call" });
    const startedAt = Date.now();
    const body = (await (await postTool(server.baseUrl, "check_market", "test-tool-secret", ctx.callId, {})).json()) as { ok: boolean };
    assert.equal(body.ok, false);
    assert.ok(Date.now() - startedAt < 1000);
  } finally {
    const rawBody = readFixture("post-call-transcription.json");
    await postWebhook(server.baseUrl, rawBody, signed(rawBody));
    await resultPromise;
    await server.close();
  }
});

test("default hooks: report_note emits a note, check_market returns keep_going", async () => {
  const calls = createCallsModule({ deps: fakeDeps("conv_fixture_transcription", {}) });
  const server = await serve(calls);
  const ctx = sampleContext("Maple Suites");
  const resultPromise = calls.startCall(ctx);
  try {
    await flush();
    assert.deepEqual(await (await postTool(server.baseUrl, "report_note", "test-tool-secret", ctx.callId, { text: "resort fee included" })).json(), { ok: true });
    assert.deepEqual(await (await postTool(server.baseUrl, "check_market", "test-tool-secret", ctx.callId, {})).json(), { action: "keep_going" });
    const bad = (await (await postTool(server.baseUrl, "report_quote", "test-tool-secret", ctx.callId, { total_price: "lots" })).json()) as { ok: boolean };
    assert.equal(bad.ok, false);
  } finally {
    const rawBody = readFixture("post-call-transcription.json");
    await postWebhook(server.baseUrl, rawBody, signed(rawBody));
  }
  const result = await resultPromise;
  assert.deepEqual(result.notes, ["resort fee included"]);
  await server.close();
});

test("a custom getMarketFor reaches the agent through check_market", async () => {
  const calls = createCallsModule({
    deps: fakeDeps("conv_fixture_transcription", {}),
    getMarketFor: () => ({ action: "wrap_up", bestCompetingQuote: { hotelName: "Harbor Inn", price: 145 } }),
  });
  const server = await serve(calls);
  const ctx = sampleContext("Maple Suites");
  const resultPromise = calls.startCall(ctx);
  try {
    await flush();
    const body = await (await postTool(server.baseUrl, "check_market", "test-tool-secret", ctx.callId, {})).json();
    assert.deepEqual(body, { action: "wrap_up", best_competing_price: 145, best_competing_hotel: "Harbor Inn" });
  } finally {
    const rawBody = readFixture("post-call-transcription.json");
    await postWebhook(server.baseUrl, rawBody, signed(rawBody));
    await resultPromise;
    await server.close();
  }
});

test("timeout ends the call through Twilio, reads the conversation back, resolves timeout", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const endedSids: string[] = [];
  const calls = createCallsModule({
    callTimeoutMs: 1000,
    deps: fakeDeps("conv_timeout", {
      endTwilioCall: async (sid: string) => {
        endedSids.push(sid);
        return "completed";
      },
      getConversation: async () => ({
        conversation_id: "conv_timeout",
        status: "done",
        transcript: [{ role: "user", message: "Please hold.", time_in_call_secs: 4 }],
      }),
    }),
  });
  const statuses: string[] = [];
  const stop = calls.onEvent((event) => {
    if (event.type === "call_status") {
      statuses.push(event.status);
    }
  });
  try {
    const resultPromise = calls.startCall(sampleContext("Grand Central"));
    await flush();
    mock.timers.tick(1000);
    const result = await resultPromise;
    assert.equal(result.status, "timeout");
    assert.equal(result.endedBy, "timeout");
    assert.deepEqual(endedSids, ["CAconv_timeout"]);
    assert.deepEqual(result.transcript, [{ speaker: "hotel", text: "Please hold.", atSecs: 4 }]);
    assert.deepEqual(statuses, ["force-ended"]);
  } finally {
    stop();
    mock.timers.reset();
  }
});

test("failed placement resolves failed; endCall never throws without Twilio", async () => {
  const failing = createCallsModule({
    deps: fakeDeps("unused", {
      placeCall: async () => {
        throw new Error("HTTP 422");
      },
    }),
  });
  const failed = await failing.startCall(sampleContext("Harbor Inn"));
  assert.equal(failed.status, "failed");
  assert.equal(failed.endedBy, "system");

  const noTwilio = createCallsModule({
    deps: fakeDeps("conv_fixture_transcription", {
      endTwilioCall: async () => {
        throw new Error("missing TWILIO_API_KEY_SID");
      },
    }),
  });
  const server = await serve(noTwilio);
  const ctx = sampleContext("Maple Suites");
  const resultPromise = noTwilio.startCall(ctx);
  await flush();
  assert.equal(await noTwilio.endCall(ctx.callId), false);
  assert.equal(await noTwilio.endCall("no-such-call"), false);
  const rawBody = readFixture("post-call-transcription.json");
  await postWebhook(server.baseUrl, rawBody, signed(rawBody));
  await resultPromise;
  await server.close();
});

test("two module instances keep separate calls and events", async () => {
  const first = createCallsModule({ deps: fakeDeps("conv_a", {}) });
  const second = createCallsModule({ deps: fakeDeps("conv_b", {}) });
  const secondEvents: string[] = [];
  const stop = second.onEvent((event) => {
    secondEvents.push(event.type);
  });
  const ctx = sampleContext("Maple Suites");
  const pending = first.startCall(ctx);
  await flush();
  assert.equal(first.isLive(ctx.callId), true);
  assert.equal(second.isLive(ctx.callId), false);
  assert.deepEqual(secondEvents, []);
  stop();
  // Finish the first call through its own routes.
  const server = await serve(first);
  const rawBody = readFixture("post-call-transcription.json").replace("conv_fixture_transcription", "conv_a");
  await postWebhook(server.baseUrl, rawBody, signed(rawBody));
  await pending;
  await server.close();
});
