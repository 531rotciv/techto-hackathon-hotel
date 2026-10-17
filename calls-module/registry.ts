import type { EventBus } from "./events.js";
import { emptyResult } from "./types.js";
import type { CallContext, CallResult, CallStatus, EndedBy } from "./types.js";

export type CallState = {
  ctx: CallContext;
  result: CallResult;
  conversationId?: string;
  twilioCallSid?: string;
  resolve: (r: CallResult) => void;
  timeout: NodeJS.Timeout | null;
  finished: boolean;
};

export type Registry = {
  register: (ctx: CallContext, resolve: (r: CallResult) => void) => CallState;
  get: (callId: string) => CallState | undefined;
  getByConversation: (conversationId: string) => CallState | undefined;
  link: (state: CallState, conversationId: string, twilioCallSid: string | undefined) => void;
  isLive: (callId: string) => boolean;
  finish: (callId: string, status: CallStatus, endedBy: EndedBy | undefined, error?: string) => void;
};

function lowestQuote(result: CallResult): number | undefined {
  if (result.quotes.length === 0) {
    return undefined;
  }
  const prices = result.quotes.map((quote) => quote.price);
  return Math.min(...prices);
}

// Many calls run at once, so everything is keyed by callId, and by
// conversationId for webhooks that only know ElevenLabs' id.
export function createRegistry(bus: EventBus): Registry {
  const calls = new Map<string, CallState>();
  const callIdByConversation = new Map<string, string>();

  // Quotes and notes reach the bus from the tool handlers. Collecting them here
  // lets the resolved CallResult carry them without the handlers knowing about us.
  bus.onEvent((event) => {
    if (event.type !== "quote" && event.type !== "note") {
      return;
    }
    const state = calls.get(event.callId);
    if (state === undefined || state.finished) {
      return;
    }
    if (event.type === "quote") {
      state.result.quotes.push(event.quote);
    } else {
      state.result.notes.push(event.text);
    }
  });

  const register = (ctx: CallContext, resolve: (r: CallResult) => void): CallState => {
    const state: CallState = { ctx, result: emptyResult(ctx), resolve, timeout: null, finished: false };
    calls.set(ctx.callId, state);
    return state;
  };

  const get = (callId: string): CallState | undefined => {
    return calls.get(callId);
  };

  const getByConversation = (conversationId: string): CallState | undefined => {
    const callId = callIdByConversation.get(conversationId);
    if (callId === undefined) {
      return undefined;
    }
    return calls.get(callId);
  };

  const link = (state: CallState, conversationId: string, twilioCallSid: string | undefined): void => {
    state.conversationId = conversationId;
    state.result.conversationId = conversationId;
    if (twilioCallSid !== undefined) {
      state.twilioCallSid = twilioCallSid;
      state.result.twilioCallSid = twilioCallSid;
    }
    callIdByConversation.set(conversationId, state.ctx.callId);
  };

  const isLive = (callId: string): boolean => {
    const state = calls.get(callId);
    if (state === undefined) {
      return false;
    }
    return state.finished === false;
  };

  // The only place a call resolves. The first caller wins: a late webhook after
  // a timeout, or a timeout after the webhook, changes nothing.
  const finish = (callId: string, status: CallStatus, endedBy: EndedBy | undefined, error?: string): void => {
    const state = calls.get(callId);
    if (state === undefined || state.finished) {
      return;
    }
    state.finished = true;
    if (state.timeout !== null) {
      clearTimeout(state.timeout);
      state.timeout = null;
    }

    const result = state.result;
    result.status = status;
    if (endedBy !== undefined) {
      result.endedBy = endedBy;
    }
    if (error !== undefined) {
      result.error = error;
    }
    result.quotedPrice = lowestQuote(result);
    result.endedAt = Date.now();

    console.log(`[calls] callId=${callId} finished: ${status}`);
    bus.emit({ type: "call_ended", runId: state.ctx.runId, result, at: result.endedAt });
    state.resolve(result);
  };

  return { register, get, getByConversation, link, isLive, finish };
}
