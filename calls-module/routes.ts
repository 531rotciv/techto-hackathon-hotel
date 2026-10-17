import crypto from "node:crypto";
import type http from "node:http";
import express from "express";
import type { Request, Response, Router } from "express";
import { z } from "zod";
import { conversationSchema } from "./elevenlabs.js";
import type { EventBus } from "./events.js";
import type { HandleToolCall } from "./hooks.js";
import type { Registry } from "./registry.js";
import { applyConversation, endedByFromReason } from "./transcript.js";
import type { CallStatus } from "./types.js";

export type RoutesOptions = {
  registry: Registry;
  bus: EventBus;
  handleToolCall: HandleToolCall;
  toolSecret: string | undefined;
  webhookSecret: string | undefined;
  toolResponseBudgetMs: number;
  onVerifiedPayload?: (rawBody: string) => void; // lets scripts save real payloads
};

type RequestWithRawBody = http.IncomingMessage & { rawBody?: Buffer };

// ---------- shared ----------

function safeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, "utf8");
  const bBytes = Buffer.from(b, "utf8");
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBytes, bBytes);
}

function keepRawBody(req: http.IncomingMessage, res: http.ServerResponse, buf: Buffer): void {
  const withRaw = req as RequestWithRawBody;
  withRaw.rawBody = buf;
}

// ---------- signature ----------

// ElevenLabs signs each webhook as `t=<unix seconds>,v0=<hex>`, where the hex is
// HMAC-SHA256 of "<t>.<raw body>" with the webhook secret. During secret
// rotation the header can carry several v0 values, so any match counts.
const SIGNATURE_TOLERANCE_MS = 30 * 60 * 1000;

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

function hmacHex(rawBody: string, secret: string, timestampSecs: number): string {
  return crypto.createHmac("sha256", secret).update(`${timestampSecs}.${rawBody}`).digest("hex");
}

export function signElevenLabsPayload(rawBody: string, secret: string, timestampSecs: number): string {
  return `t=${timestampSecs},v0=${hmacHex(rawBody, secret, timestampSecs)}`;
}

export function verifyElevenLabsSignature(rawBody: string, header: string | undefined, secret: string | undefined, nowMs: number): SignatureCheck {
  if (secret === undefined) {
    return { ok: false, reason: "ELEVENLABS_WEBHOOK_SECRET is not set" };
  }
  if (header === undefined || header === "") {
    return { ok: false, reason: "missing elevenlabs-signature header" };
  }
  const parts = header.split(",").map((part) => part.trim());
  const timestampPart = parts.find((part) => part.startsWith("t="));
  const signatures = parts.filter((part) => part.startsWith("v0=")).map((part) => part.slice(3));
  if (timestampPart === undefined || signatures.length === 0) {
    return { ok: false, reason: "signature header has no t= or v0= part" };
  }
  const timestampSecs = Number(timestampPart.slice(2));
  if (Number.isFinite(timestampSecs) === false) {
    return { ok: false, reason: "signature timestamp is not a number" };
  }
  if (timestampSecs * 1000 < nowMs - SIGNATURE_TOLERANCE_MS) {
    return { ok: false, reason: "signature timestamp is older than 30 minutes" };
  }
  const expected = hmacHex(rawBody, secret, timestampSecs);
  const matches = signatures.some((signature) => safeEqual(signature, expected));
  if (matches === false) {
    return { ok: false, reason: "signature does not match" };
  }
  return { ok: true };
}

// ---------- post-call webhook ----------

const transcriptionEventSchema = z.object({
  type: z.literal("post_call_transcription"),
  data: conversationSchema,
});

const initiationFailureEventSchema = z.object({
  type: z.literal("call_initiation_failure"),
  data: z.object({
    conversation_id: z.string(),
    failure_reason: z.string().nullish(),
  }),
});

const eventTypeSchema = z.object({ type: z.string() });

export function failureStatus(reason: string | null | undefined): CallStatus {
  if (reason === "busy") {
    return "busy";
  }
  if (reason === "no-answer") {
    return "no_answer";
  }
  return "failed";
}

function handleTranscription(options: RoutesOptions, body: unknown): void {
  const parsed = transcriptionEventSchema.safeParse(body);
  if (parsed.success === false) {
    console.error(`[calls] post-call transcription payload didn't validate: ${parsed.error.message}`);
    return;
  }
  const conversation = parsed.data.data;
  const state = options.registry.getByConversation(conversation.conversation_id);
  if (state === undefined) {
    console.log(`[calls] post-call transcription for unknown conversation ${conversation.conversation_id}, ignored`);
    return;
  }
  if (state.finished) {
    console.log(`[calls] callId=${state.ctx.callId} post-call transcription arrived after the call finished, ignored`);
    return;
  }
  applyConversation(state.result, conversation);
  options.bus.emit({
    type: "transcript_ready",
    runId: state.ctx.runId,
    callId: state.ctx.callId,
    lines: state.result.transcript.length,
    at: Date.now(),
  });
  options.registry.finish(state.ctx.callId, "completed", endedByFromReason(state.result.terminationReason));
}

function handleInitiationFailure(options: RoutesOptions, body: unknown): void {
  const parsed = initiationFailureEventSchema.safeParse(body);
  if (parsed.success === false) {
    console.error(`[calls] call initiation failure payload didn't validate: ${parsed.error.message}`);
    return;
  }
  const data = parsed.data.data;
  const state = options.registry.getByConversation(data.conversation_id);
  if (state === undefined) {
    console.log(`[calls] initiation failure for unknown conversation ${data.conversation_id}, ignored`);
    return;
  }
  let reason = "unknown";
  if (typeof data.failure_reason === "string") {
    reason = data.failure_reason;
  }
  options.registry.finish(state.ctx.callId, failureStatus(data.failure_reason), "system", `call initiation failure: ${reason}`);
}

function handlePostCallEvent(options: RoutesOptions, body: unknown): void {
  const typed = eventTypeSchema.safeParse(body);
  if (typed.success === false) {
    console.error("[calls] post-call webhook without a type, ignored");
    return;
  }
  if (typed.data.type === "post_call_transcription") {
    handleTranscription(options, body);
    return;
  }
  if (typed.data.type === "call_initiation_failure") {
    handleInitiationFailure(options, body);
    return;
  }
  console.log(`[calls] post-call webhook type ${typed.data.type} ignored`);
}

function postCallHandler(options: RoutesOptions) {
  return (req: Request, res: Response): void => {
    const withRaw = req as Request & RequestWithRawBody;
    if (withRaw.rawBody === undefined) {
      console.warn("[calls] post-call webhook rejected: no raw body. Call registerRoutes(app) before your own express.json().");
      res.status(401).json({ ok: false, error: "invalid signature" });
      return;
    }
    const rawBody = withRaw.rawBody.toString("utf8");
    const check = verifyElevenLabsSignature(rawBody, req.get("elevenlabs-signature"), options.webhookSecret, Date.now());
    if (check.ok === false) {
      console.warn(`[calls] post-call webhook rejected: ${check.reason}`);
      res.status(401).json({ ok: false, error: "invalid signature" });
      return;
    }

    // ElevenLabs only needs to know we got it. Processing happens after.
    res.status(200).json({ ok: true });
    if (options.onVerifiedPayload !== undefined) {
      try {
        options.onVerifiedPayload(rawBody);
      } catch (err) {
        console.error("[calls] saving the webhook payload failed", err);
      }
    }
    const body: unknown = req.body;
    setImmediate(() => {
      try {
        handlePostCallEvent(options, body);
      } catch (err) {
        console.error("[calls] post-call webhook processing failed", err);
      }
    });
  };
}

// ---------- server tools ----------

// The agent is waiting on the line, so a slow handler gets a fast "carry on"
// instead of dead air.
async function withinBudget(work: Promise<Record<string, unknown>>, budgetMs: number): Promise<Record<string, unknown>> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<Record<string, unknown>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, error: "tool timed out, carry on with the call" });
    }, budgetMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

async function runHandler(options: RoutesOptions, name: string, args: unknown, callId: string): Promise<Record<string, unknown>> {
  try {
    return await withinBudget(options.handleToolCall(name, args, callId), options.toolResponseBudgetMs);
  } catch (err) {
    console.error(`[calls] callId=${callId} tool ${name} handler threw`, err);
    return { ok: false, error: "tool failed, carry on with the call" };
  }
}

function secretMatches(given: string | undefined, expected: string | undefined): boolean {
  if (expected === undefined || given === undefined) {
    return false;
  }
  return safeEqual(given, expected);
}

function toolHandler(options: RoutesOptions) {
  return async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    if (secretMatches(req.get("x-tool-secret"), options.toolSecret) === false) {
      console.warn("[calls] tool call rejected: X-Tool-Secret missing or wrong");
      res.status(401).json({ ok: false, error: "invalid tool secret" });
      return;
    }

    const name = String(req.params.name);
    let callId = "";
    const callIdHeader = req.get("x-call-id");
    if (callIdHeader !== undefined) {
      callId = callIdHeader;
    }
    const state = options.registry.get(callId);
    if (state === undefined) {
      console.warn(`[calls] callId=${callId} tool ${name} for unknown call`);
      res.json({ ok: false, error: "unknown call" });
      return;
    }

    let args: unknown = {};
    if (req.body !== undefined) {
      args = req.body;
    }
    const output = await runHandler(options, name, args, callId);
    const ok = output.ok !== false;
    const ms = Date.now() - startedAt;
    options.bus.emit({ type: "tool_call", runId: state.ctx.runId, callId, name, args, ok, ms, at: Date.now() });
    res.json(output);
  };
}

// ---------- router ----------

// The router parses its own JSON so the raw bytes survive for the signature
// check, which is why it has to be mounted before the host's body parser.
export function createRoutes(options: RoutesOptions): Router {
  const router = express.Router();
  const parseJson = express.json({ verify: keepRawBody });
  router.post("/elevenlabs/post-call", parseJson, postCallHandler(options));
  router.post("/elevenlabs/tools/:name", parseJson, toolHandler(options));
  return router;
}
