// Proves the whole loop with one real call to your own phone:
// server -> ElevenLabs places the call -> agent hits the tool route ->
// call ends -> post-call webhook -> quotes and transcript -> receipt (if SMTP is set).
//   npx tsx <path>/calls-module/scripts/flow-check.ts +15551234567
// It serves the calls routes itself on PORT, so the tunnel's webhooks land in
// this process: stop your own server first and keep scripts/tunnel.ts running.
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { z } from "zod";
import { config, requireConfig } from "../config.js";
import type { OptionalConfigKey } from "../config.js";
import { createCallsModule } from "../index.js";
import type { CallsEvent } from "../events.js";
import type { CallContext, CallResult, DecisionRecord, PriceSource, ReceiptResult, RunReport, Task } from "../types.js";

const e164Schema = z.string().regex(/^\+[1-9]\d{6,14}$/, "use E.164, for example +15551234567");

const CALL_KEYS: OptionalConfigKey[] = [
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_AGENT_ID",
  "ELEVENLABS_AGENT_PHONE_NUMBER_ID",
  "ELEVENLABS_WEBHOOK_SECRET",
  "ELEVENLABS_TOOL_SECRET",
  "PUBLIC_URL",
];
const RECEIPT_KEYS: OptionalConfigKey[] = ["SMTP_USER", "SMTP_PASS", "RECEIPT_TEST_TO"];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------- setup ----------

function readTarget(): string {
  const raw = process.argv[2];
  if (raw === undefined) {
    throw new Error("usage: npx tsx scripts/flow-check.ts +15551234567");
  }
  return e164Schema.parse(raw);
}

function missingKeys(keys: OptionalConfigKey[]): OptionalConfigKey[] {
  return keys.filter((key) => config[key] === undefined);
}

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
}

// A placeholder stay two weeks out, so the agent has something to ask about.
function sampleContext(toNumber: string): CallContext {
  let receiptEmail = "guest@example.com";
  if (config.RECEIPT_TEST_TO !== undefined) {
    receiptEmail = config.RECEIPT_TEST_TO;
  }
  const task: Task = {
    taskId: "flow-check",
    city: "Test City",
    checkIn: isoDay(14),
    checkOut: isoDay(16),
    nights: 2,
    guests: 2,
    rooms: 1,
    guestName: "Test Guest",
    receiptEmail,
  };
  const ctx: CallContext = {
    callId: crypto.randomUUID(),
    runId: `flow-check-${crypto.randomUUID().slice(0, 8)}`,
    task,
    hotel: { id: "flow-check-hotel", name: "Flow Check Hotel", phone: toNumber },
  };
  return ctx;
}

// Counts what actually reached this process, so a PASS proves the tunnel and
// webhooks point here and not at another server.
type Arrivals = { health: number; postCall: number; tools: number };

function countArrivals(server: http.Server): Arrivals {
  const arrivals: Arrivals = { health: 0, postCall: 0, tools: 0 };
  server.on("request", (req: http.IncomingMessage) => {
    let url = "";
    if (req.url !== undefined) {
      url = req.url;
    }
    if (url.startsWith("/health")) {
      arrivals.health += 1;
    } else if (url.startsWith("/elevenlabs/post-call")) {
      arrivals.postCall += 1;
    } else if (url.startsWith("/elevenlabs/tools/")) {
      arrivals.tools += 1;
    }
  });
  return arrivals;
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.PORT, () => {
      resolve();
    });
  });
}

async function tunnelReachesUs(publicUrl: string, arrivals: Arrivals): Promise<boolean> {
  const before = arrivals.health;
  try {
    const response = await fetch(`${publicUrl}/health`, {
      headers: { "ngrok-skip-browser-warning": "1" },
      signal: AbortSignal.timeout(10000),
    });
    return response.ok && arrivals.health > before;
  } catch {
    return false;
  }
}

// ---------- live event log ----------

function describe(event: CallsEvent): string {
  if (event.type === "call_started") {
    return `call_started      hotel ${event.hotelId}`;
  }
  if (event.type === "call_placed") {
    return `call_placed       conversation ${event.conversationId}`;
  }
  if (event.type === "call_status") {
    return `call_status       ${event.status}`;
  }
  if (event.type === "tool_call") {
    return `tool_call         ${event.name} ${JSON.stringify(event.args)} ok=${event.ok} ${event.ms}ms`;
  }
  if (event.type === "quote") {
    return `quote             $${event.quote.price} (${event.quote.trigger})`;
  }
  if (event.type === "note") {
    return `note              ${event.text}`;
  }
  if (event.type === "market_update") {
    return `market_update     ${JSON.stringify(event.update)}`;
  }
  if (event.type === "transcript_ready") {
    return `transcript_ready  ${event.lines} lines`;
  }
  if (event.type === "call_ended") {
    return `call_ended        ${event.result.status}, ended by ${event.result.endedBy}`;
  }
  return `receipt_sent      ok=${event.result.ok}`;
}

// ---------- receipt ----------

function priceOf(result: CallResult): { price: number; source: PriceSource } | null {
  if (result.extracted !== undefined && result.extracted.lowestTotalPrice !== undefined) {
    return { price: result.extracted.lowestTotalPrice, source: "transcript" };
  }
  if (result.quotedPrice !== undefined) {
    return { price: result.quotedPrice, source: "reported" };
  }
  return null;
}

function oneCallReport(ctx: CallContext, result: CallResult, startedAt: number): RunReport {
  const report: RunReport = { runId: ctx.runId, task: ctx.task, startedAt, endedAt: Date.now(), calls: [result] };
  const priced = priceOf(result);
  if (priced === null) {
    return report;
  }
  const decision: DecisionRecord = {
    runId: ctx.runId,
    at: Date.now(),
    winnerHotelId: ctx.hotel.id,
    winnerCallId: ctx.callId,
    price: priced.price,
    priceSource: priced.source,
    reason: "flow check, one call",
    ranking: [{ hotelId: ctx.hotel.id, hotelName: ctx.hotel.name, callId: ctx.callId, price: priced.price, priceSource: priced.source }],
    boardSnapshot: [{ hotelId: ctx.hotel.id, hotelName: ctx.hotel.name, callId: ctx.callId, status: "done", bestPrice: result.quotedPrice, priceHistory: result.quotes, notes: result.notes, attempts: 1 }],
  };
  report.decision = decision;
  report.winner = result;
  return report;
}

// ---------- checklist ----------

type Check = { label: string; pass: boolean; detail: string; hint: string };

function buildChecklist(result: CallResult, seen: CallsEvent[], arrivals: Arrivals, receipt: ReceiptResult | null, receiptSkip: string): Check[] {
  const toolCalls = seen.filter((event) => event.type === "tool_call").length;
  const quotes = seen.filter((event) => event.type === "quote").length;
  const webhookArrived = arrivals.postCall > 0 && result.status === "completed";
  let receiptPass = false;
  let receiptDetail = receiptSkip;
  if (receipt !== null) {
    receiptPass = receipt.ok;
    receiptDetail = `to ${receipt.to}`;
    if (receipt.error !== undefined) {
      receiptDetail = receipt.error;
    }
  }
  return [
    {
      label: "call placed (conversation_id received)",
      pass: result.conversationId !== undefined,
      detail: String(result.conversationId),
      hint: "Run scripts/check.ts and read the error above.",
    },
    {
      label: "at least one tool call reached the server",
      pass: toolCalls > 0,
      detail: `${toolCalls} tool call(s), ${arrivals.tools} request(s)`,
      hint: "Check the tool URLs match scripts/tunnel.ts and X-Tool-Secret matches ELEVENLABS_TOOL_SECRET (rerun scripts/setup-agent.ts).",
    },
    {
      label: "at least one quote recorded",
      pass: quotes > 0,
      detail: `${quotes} quote(s), transcript price ${JSON.stringify(result.extracted)}`,
      hint: "Give the agent a total price when it asks.",
    },
    {
      label: "post-call webhook received and transcript non-empty",
      pass: webhookArrived && result.transcript.length > 0,
      detail: `${arrivals.postCall} webhook(s), ${result.transcript.length} lines, status ${result.status}`,
      hint: "Check the post-call webhook points at the tunnel and ELEVENLABS_WEBHOOK_SECRET is its secret.",
    },
    { label: "receipt sent", pass: receiptPass, detail: receiptDetail, hint: "Set SMTP_USER, SMTP_PASS, RECEIPT_TEST_TO to test the receipt." },
  ];
}

function printChecklist(checks: Check[]): boolean {
  console.log("\n--- flow check ---");
  for (const check of checks) {
    let mark = "FAIL";
    if (check.pass) {
      mark = "PASS";
    }
    console.log(`${mark}  ${check.label}  (${check.detail})`);
    if (check.pass === false) {
      console.log(`      hint: ${check.hint}`);
    }
  }
  return checks.every((check) => check.pass);
}

// ---------- main ----------

async function main(): Promise<void> {
  const target = readTarget();
  const missing = missingKeys(CALL_KEYS);
  if (missing.length > 0) {
    console.error(`[calls] can't place a call, missing in .env: ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const publicUrl = requireConfig("PUBLIC_URL");

  const calls = createCallsModule();
  const app = express();
  calls.registerRoutes(app);
  app.get("/health", (req, res) => {
    res.json({ ok: true, flowCheck: true });
  });
  const server = http.createServer(app);
  const arrivals = countArrivals(server);
  try {
    await listen(server);
  } catch (err) {
    if (err instanceof Error && err.message.includes("EADDRINUSE")) {
      console.error(`[calls] port ${config.PORT} is in use. Stop your server (keep the tunnel running), then try again.`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if ((await tunnelReachesUs(publicUrl, arrivals)) === false) {
    console.error(`[calls] ${publicUrl}/health didn't reach this process. Is scripts/tunnel.ts running? No call placed.`);
    server.close();
    process.exitCode = 1;
    return;
  }
  console.log(`[calls] tunnel ok: ${publicUrl} reaches this process`);

  const ctx = sampleContext(target);
  const startedAt = Date.now();
  const seen: CallsEvent[] = [];
  const stop = calls.onEvent((event) => {
    seen.push(event);
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(5, " ");
    console.log(`  ${secs}s  ${describe(event)}`);
  });

  console.log(`\n[calls] callId=${ctx.callId} the agent is calling ${target}. Answer, play the hotel, give a total price.\n`);
  const result = await calls.startCall(ctx);

  let receipt: ReceiptResult | null = null;
  let receiptSkip = "";
  const missingReceipt = missingKeys(RECEIPT_KEYS);
  if (missingReceipt.length > 0) {
    receiptSkip = `skipped, missing in .env: ${missingReceipt.join(", ")}`;
  } else {
    receipt = await calls.sendReceipt(oneCallReport(ctx, result, startedAt), requireConfig("RECEIPT_TEST_TO"));
  }
  stop();

  const allPassed = printChecklist(buildChecklist(result, seen, arrivals, receipt, receiptSkip));
  if (allPassed === false) {
    process.exitCode = 1;
  }
  server.close();
}

main().catch((err: unknown) => {
  let message = String(err);
  if (err instanceof z.ZodError) {
    message = err.issues.map((issue) => issue.message).join("; ");
  } else if (err instanceof Error) {
    message = err.message;
  }
  console.error(`[calls] flow check failed: ${message}`);
  process.exitCode = 1;
});
