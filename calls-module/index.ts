import type { Express } from "express";
import { config } from "./config.js";
import { getConversation, placeOutboundCall } from "./elevenlabs.js";
import type { ElevenLabsConversation, OutboundCallResponse } from "./elevenlabs.js";
import { createEventBus } from "./events.js";
import type { CallsEventListener, EventBus } from "./events.js";
import { createDefaultHandleToolCall, defaultBuildDynamicVariables, defaultGetMarketFor } from "./hooks.js";
import type { BuildDynamicVariables, GetMarketFor, HandleToolCall } from "./hooks.js";
import { composeReceipt, sendReceipt } from "./receipt.js";
import type { ComposedReceipt, ReceiptOptions } from "./receipt.js";
import { createRegistry } from "./registry.js";
import type { CallState, Registry } from "./registry.js";
import { createRoutes } from "./routes.js";
import { applyConversation } from "./transcript.js";
import { endTwilioCall } from "./twilio.js";
import type { CallContext, CallResult, ReceiptResult, RunReport, TranscriptLine } from "./types.js";

export type * from "./types.js";
export type { CallsEvent, CallsEventListener } from "./events.js";
export type { BuildDynamicVariables, GetMarketFor, HandleToolCall } from "./hooks.js";
export type { ComposedReceipt, ReceiptOptions } from "./receipt.js";

// Everything that touches the network is replaceable, so tests can drive a
// call without ElevenLabs or Twilio.
export type CallDeps = {
  placeCall: (ctx: CallContext, dynamicVariables: Record<string, string | number>) => Promise<OutboundCallResponse>;
  getConversation: (conversationId: string) => Promise<ElevenLabsConversation>;
  endTwilioCall: (callSid: string) => Promise<string>;
  transcriptRetryMs: number;
  transcriptWaitMs: number;
};

export type CallsModuleOptions = {
  buildDynamicVariables?: BuildDynamicVariables;
  handleToolCall?: HandleToolCall;
  getMarketFor?: GetMarketFor;
  callTimeoutMs?: number;             // default CALL_TIMEOUT_MS
  toolResponseBudgetMs?: number;      // default 900, under ElevenLabs' minimum tool timeout
  onVerifiedPayload?: (rawBody: string) => void;
  deps?: Partial<CallDeps>;
};

export type CallsModule = {
  registerRoutes: (app: Express) => void;
  startCall: (ctx: CallContext) => Promise<CallResult>;
  endCall: (callId: string) => Promise<boolean>;
  isLive: (callId: string) => boolean;
  fetchTranscript: (callId: string) => Promise<TranscriptLine[]>;
  onEvent: (listener: CallsEventListener) => () => void;
  composeReceipt: (report: RunReport, options?: ReceiptOptions) => ComposedReceipt;
  sendReceipt: (report: RunReport, to: string) => Promise<ReceiptResult>;
};

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveDeps(overrides: Partial<CallDeps> | undefined): CallDeps {
  const deps: CallDeps = {
    placeCall: placeOutboundCall,
    getConversation,
    endTwilioCall,
    transcriptRetryMs: 2000,
    transcriptWaitMs: 20000,
  };
  if (overrides !== undefined) {
    Object.assign(deps, overrides);
  }
  return deps;
}

type Lifecycle = {
  bus: EventBus;
  registry: Registry;
  deps: CallDeps;
  buildDynamicVariables: BuildDynamicVariables;
  timeoutMs: number;
};

// ---------- placing a call ----------

async function placeAndLink(life: Lifecycle, state: CallState): Promise<void> {
  const ctx = state.ctx;
  let response: OutboundCallResponse;
  try {
    response = await life.deps.placeCall(ctx, life.buildDynamicVariables(ctx));
  } catch (err) {
    console.error(`[calls] callId=${ctx.callId} outbound call request failed: ${errorMessage(err)}`);
    life.registry.finish(ctx.callId, "failed", "system", errorMessage(err));
    return;
  }

  const conversationId = response.conversation_id;
  if (response.success === false || typeof conversationId !== "string") {
    console.error(`[calls] callId=${ctx.callId} outbound call not placed: ${response.message}`);
    life.registry.finish(ctx.callId, "failed", "system", response.message);
    return;
  }

  let callSid: string | undefined = undefined;
  if (typeof response.callSid === "string") {
    callSid = response.callSid;
  }
  life.registry.link(state, conversationId, callSid);
  console.log(`[calls] callId=${ctx.callId} placed, conversation ${conversationId}`);
  life.bus.emit({ type: "call_placed", runId: ctx.runId, callId: ctx.callId, conversationId, twilioCallSid: callSid, at: Date.now() });
}

// ---------- reading a conversation back ----------

// Waits while ElevenLabs' analysis is still processing. Returns the final
// conversation, or the latest one seen if it never settled.
async function pollConversation(life: Lifecycle, conversationId: string): Promise<ElevenLabsConversation | null> {
  const giveUpAt = Date.now() + life.deps.transcriptWaitMs;
  let latest: ElevenLabsConversation | null = null;
  while (true) {
    try {
      latest = await life.deps.getConversation(conversationId);
      const settled = latest.status === "done" || latest.status === "failed";
      if (settled) {
        return latest;
      }
    } catch (err) {
      console.error(`[calls] conversation ${conversationId} fetch failed: ${errorMessage(err)}`);
    }
    if (Date.now() + life.deps.transcriptRetryMs > giveUpAt) {
      return latest;
    }
    await wait(life.deps.transcriptRetryMs);
  }
}

async function fetchConversationInto(life: Lifecycle, state: CallState): Promise<boolean> {
  const conversationId = state.conversationId;
  if (conversationId === undefined) {
    return false;
  }
  const conversation = await pollConversation(life, conversationId);
  if (conversation === null) {
    return false;
  }
  applyConversation(state.result, conversation);
  life.bus.emit({ type: "transcript_ready", runId: state.ctx.runId, callId: state.ctx.callId, lines: state.result.transcript.length, at: Date.now() });
  return true;
}

// ---------- ending a call ----------

// Never throws: a missing Twilio config or an API error just means false.
async function endCallWith(life: Lifecycle, callId: string): Promise<boolean> {
  const state = life.registry.get(callId);
  if (state === undefined || state.finished) {
    return false;
  }
  const callSid = state.twilioCallSid;
  if (callSid === undefined) {
    console.log(`[calls] callId=${callId} can't end: no Twilio callSid yet`);
    return false;
  }
  try {
    const status = await life.deps.endTwilioCall(callSid);
    console.log(`[calls] callId=${callId} ended through Twilio, status ${status}`);
  } catch (err) {
    console.error(`[calls] callId=${callId} Twilio end failed: ${errorMessage(err)}`);
    return false;
  }
  life.bus.emit({ type: "call_status", runId: state.ctx.runId, callId, status: "force-ended", at: Date.now() });
  return true;
}

async function handleTimeout(life: Lifecycle, callId: string): Promise<void> {
  const state = life.registry.get(callId);
  if (state === undefined || state.finished) {
    return;
  }
  console.log(`[calls] callId=${callId} hit the ${life.timeoutMs} ms cap, ending it`);
  await endCallWith(life, callId);
  await fetchConversationInto(life, state);
  life.registry.finish(callId, "timeout", "timeout");
}

// Resolves once the call has ended and ElevenLabs' post-call analysis is in,
// or at the timeout. Never rejects.
function startCallWith(life: Lifecycle, ctx: CallContext): Promise<CallResult> {
  return new Promise((resolve) => {
    const state = life.registry.register(ctx, resolve);
    life.bus.emit({ type: "call_started", runId: ctx.runId, callId: ctx.callId, hotelId: ctx.hotel.id, attempt: 1, at: Date.now() });

    state.timeout = setTimeout(() => {
      handleTimeout(life, ctx.callId).catch((err: unknown) => {
        console.error(`[calls] callId=${ctx.callId} timeout handling failed: ${errorMessage(err)}`);
        life.registry.finish(ctx.callId, "timeout", "timeout");
      });
    }, life.timeoutMs);

    placeAndLink(life, state).catch((err: unknown) => {
      life.registry.finish(ctx.callId, "failed", "system", errorMessage(err));
    });
  });
}

// ---------- the module ----------

export function createCallsModule(options: CallsModuleOptions = {}): CallsModule {
  const bus = createEventBus();
  const registry = createRegistry(bus);
  const deps = resolveDeps(options.deps);

  let getMarketFor: GetMarketFor = defaultGetMarketFor;
  if (options.getMarketFor !== undefined) {
    getMarketFor = options.getMarketFor;
  }
  let buildDynamicVariables: BuildDynamicVariables = defaultBuildDynamicVariables;
  if (options.buildDynamicVariables !== undefined) {
    buildDynamicVariables = options.buildDynamicVariables;
  }
  let handleToolCall: HandleToolCall = createDefaultHandleToolCall({ bus, registry, getMarketFor });
  if (options.handleToolCall !== undefined) {
    handleToolCall = options.handleToolCall;
  }
  let timeoutMs = config.CALL_TIMEOUT_MS;
  if (options.callTimeoutMs !== undefined) {
    timeoutMs = options.callTimeoutMs;
  }
  let toolResponseBudgetMs = 900;
  if (options.toolResponseBudgetMs !== undefined) {
    toolResponseBudgetMs = options.toolResponseBudgetMs;
  }

  const life: Lifecycle = { bus, registry, deps, buildDynamicVariables, timeoutMs };

  const registerRoutes = (app: Express): void => {
    app.use(
      createRoutes({
        registry,
        bus,
        handleToolCall,
        toolSecret: config.ELEVENLABS_TOOL_SECRET,
        webhookSecret: config.ELEVENLABS_WEBHOOK_SECRET,
        toolResponseBudgetMs,
        onVerifiedPayload: options.onVerifiedPayload,
      }),
    );
  };

  const fetchTranscript = async (callId: string): Promise<TranscriptLine[]> => {
    const state = registry.get(callId);
    if (state === undefined) {
      return [];
    }
    await fetchConversationInto(life, state);
    return state.result.transcript;
  };

  return {
    registerRoutes,
    startCall: (ctx) => startCallWith(life, ctx),
    endCall: (callId) => endCallWith(life, callId),
    isLive: (callId) => registry.isLive(callId),
    fetchTranscript,
    onEvent: (listener) => bus.onEvent(listener),
    composeReceipt: (report, receiptOptions) => composeReceipt(report, receiptOptions),
    sendReceipt: (report, to) => sendReceipt(report, to, bus),
  };
}
