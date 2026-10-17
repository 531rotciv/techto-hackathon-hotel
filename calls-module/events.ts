import { EventEmitter } from "node:events";
import type { CallResult, MarketUpdate, QuoteRecord, ReceiptResult } from "./types.js";

export type CallsEvent =
  | { type: "call_started"; runId: string; callId: string; hotelId: string; attempt: number; at: number }
  | { type: "call_placed"; runId: string; callId: string; conversationId: string; twilioCallSid?: string; at: number }
  | { type: "call_status"; runId: string; callId: string; status: string; at: number }
  | { type: "call_ended"; runId: string; result: CallResult; at: number }
  | { type: "transcript_ready"; runId: string; callId: string; lines: number; at: number }
  | { type: "tool_call"; runId: string; callId: string; name: string; args: unknown; ok: boolean; ms: number; at: number }
  | { type: "quote"; runId: string; callId: string; hotelId: string; quote: QuoteRecord; at: number }
  | { type: "note"; runId: string; callId: string; hotelId: string; text: string; at: number }
  | { type: "market_update"; runId: string; callId: string; update: MarketUpdate; at: number }
  | { type: "receipt_sent"; runId: string; result: ReceiptResult; at: number };

export type CallsEventListener = (event: CallsEvent) => void;

export type EventBus = {
  emit: (event: CallsEvent) => void;
  onEvent: (listener: CallsEventListener) => () => void;
};

// One bus per module instance. A broken listener must never break a call,
// so every listener is isolated and emit never throws.
export function createEventBus(): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  const emit = (event: CallsEvent): void => {
    try {
      emitter.emit("event", event);
    } catch (err) {
      console.error("[calls] event listener error", err);
    }
  };

  const onEvent = (listener: CallsEventListener): (() => void) => {
    const safeListener = (event: CallsEvent) => {
      try {
        listener(event);
      } catch (err) {
        console.error("[calls] event listener error", err);
      }
    };
    emitter.on("event", safeListener);
    const unsubscribe = () => {
      emitter.off("event", safeListener);
    };
    return unsubscribe;
  };

  return { emit, onEvent };
}
