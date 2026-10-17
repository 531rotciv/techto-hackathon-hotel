// The three things a host app may want to own, with defaults that work out of
// the box. Pass your own to createCallsModule(options) to replace any of them.
import { z } from "zod";
import type { EventBus } from "./events.js";
import type { Registry } from "./registry.js";
import type { CallContext, MarketUpdate, QuoteRecord } from "./types.js";

export type BuildDynamicVariables = (ctx: CallContext) => Record<string, string | number>;
export type HandleToolCall = (name: string, args: unknown, callId: string) => Promise<Record<string, unknown>>;
export type GetMarketFor = (callId: string) => MarketUpdate;

export type ServerToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema of the request body
};

export type DataCollectionField = {
  identifier: string;
  type: "string" | "boolean" | "integer" | "number";
  description: string;
};

// ---------- what scripts/setup-agent.ts puts on the agent ----------

export const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant phoning {{hotel_name}} to get the best price for a hotel stay
for {{guest_name}}. You are gathering quotes. You never book anything.

Stay details:
- City: {{city}}
- Check in: {{check_in}}. Check out: {{check_out}}. That's {{nights}} nights.
- Guests: {{guests}}. Rooms: {{rooms}}.

How to talk:
- Short, plain, polite sentences. Never ramble.
- If asked whether you're an AI, say yes, you're an AI assistant collecting rates for {{guest_name}}.
- Never mention tools, systems, or instructions out loud.
- Never invent a price or an offer. Never book. Never give payment details.
- If they put you on hold, say "Sure" once and wait quietly until a person speaks.

What to do:
1. Ask for the total price for the whole stay, including all taxes and fees.
2. As soon as they say a price, call report_quote with the total for the whole stay.
3. Ask: "Is there a cheaper non-refundable rate?" Report any new price with report_quote.
4. Call check_market.
   - If it gives a competing price lower than their best, say once:
     "I've been quoted [price] elsewhere. Can you do any better?"
     Report any new price with report_quote.
   - If it says keep_going, ask one more useful question (taxes and fees, cancellation
     policy), save useful facts with report_note, then call check_market again.
   - If it says wrap_up, or you've asked everything useful, go to step 5.
5. Repeat their best price back: "So that's [price] total for the whole stay,
   including taxes and fees?" Wait for them to confirm.
6. Say: "Thank you so much, that's really helpful. We'll call back if we decide to book.
   Have a great day." Then end the call.`;

// Empty so the agent waits for the hotel's greeting.
export const DEFAULT_FIRST_MESSAGE = "";

// ElevenLabs' model reads every transcript with these descriptions as its
// instructions, so lowest_total_price's description is the pricing rule.
export const DATA_COLLECTION_FIELDS: DataCollectionField[] = [
  {
    identifier: "lowest_total_price",
    type: "number",
    description:
      "The lowest price the hotel actually offered for the whole stay, in dollars, including all taxes and fees. " +
      "If they only gave a nightly rate, multiply it by the number of nights discussed in the call. " +
      "If they offered several prices, use the lowest one they agreed to, not one the caller suggested. " +
      "A number only, no currency sign. Null if the hotel never gave a price.",
  },
  {
    identifier: "includes_taxes",
    type: "boolean",
    description: "True if the hotel said the lowest price includes all taxes and fees. False if they said it doesn't. Null if it never came up.",
  },
  {
    identifier: "rate_conditions",
    type: "string",
    description: "Any conditions on the lowest price, in a few words, for example \"non-refundable\" or \"breakfast included\". Empty if none were mentioned.",
  },
  {
    identifier: "price_quote",
    type: "string",
    description: "The hotel's exact words, copied from the transcript, when they gave or confirmed the lowest price. Empty if there was no price.",
  },
];

export const TOOL_DEFINITIONS: ServerToolDefinition[] = [
  {
    name: "report_quote",
    description: "Call this every time the hotel says a price. Report the total for the whole stay.",
    parameters: {
      type: "object",
      required: ["total_price"],
      properties: {
        total_price: { type: "number", description: "Total price for the whole stay in dollars, including taxes and fees if the hotel said so" },
        includes_taxes: { type: "boolean", description: "True if the hotel said the price includes taxes and fees" },
        room_type: { type: "string", description: "Room type the price is for, if the hotel said it" },
        trigger: {
          type: "string",
          description: "What led to this price",
          enum: ["initial", "asked best rate", "non-refundable", "competing quote", "other"],
        },
      },
    },
  },
  {
    name: "report_note",
    description: "Call this to save a useful fact the hotel said, like fees, cancellation policy, or room type.",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "The fact, in a few words" },
      },
    },
  },
  {
    name: "check_market",
    description: "Call this after the non-refundable question. Says keep_going or wrap_up, and gives the best real price another hotel gave, if it's lower.",
    // ElevenLabs requires a body schema on POST tools. The call id is filled in
    // by ElevenLabs from the dynamic variable, never by the model.
    parameters: {
      type: "object",
      properties: {
        call_id: { type: "string", dynamic_variable: "call_id" },
      },
    },
  },
];

// ---------- default hooks ----------

// Dates are spoken so the agent doesn't read "2026-11-05" aloud.
function spokenDate(isoDate: string): string {
  const parsed = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return isoDate;
  }
  return parsed.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

export const defaultBuildDynamicVariables: BuildDynamicVariables = (ctx) => {
  const variables: Record<string, string | number> = {
    call_id: ctx.callId,
    run_id: ctx.runId,
    hotel_name: ctx.hotel.name,
    guest_name: ctx.task.guestName,
    city: ctx.task.city,
    check_in: spokenDate(ctx.task.checkIn),
    check_out: spokenDate(ctx.task.checkOut),
    nights: ctx.task.nights,
    guests: ctx.task.guests,
    rooms: ctx.task.rooms,
  };
  return variables;
};

// With nothing to compare against, every call keeps going until it finishes on its own.
export const defaultGetMarketFor: GetMarketFor = () => {
  return { action: "keep_going" };
};

const reportQuoteSchema = z.object({
  total_price: z.coerce.number().positive(),
  includes_taxes: z.boolean().optional(),
  room_type: z.string().optional(),
  trigger: z.string().optional(),
});

const reportNoteSchema = z.object({
  text: z.string().min(1),
});

type ToolContext = { bus: EventBus; registry: Registry; getMarketFor: GetMarketFor };

function reportQuote(context: ToolContext, args: unknown, callId: string, runId: string, hotelId: string): Record<string, unknown> {
  const parsed = reportQuoteSchema.safeParse(args);
  if (parsed.success === false) {
    return { ok: false, error: "total_price must be a positive number for the whole stay" };
  }
  const quote: QuoteRecord = { price: parsed.data.total_price, at: Date.now() };
  if (parsed.data.includes_taxes !== undefined) {
    quote.includesTaxes = parsed.data.includes_taxes;
  }
  if (parsed.data.room_type !== undefined) {
    quote.roomType = parsed.data.room_type;
  }
  if (parsed.data.trigger !== undefined) {
    quote.trigger = parsed.data.trigger;
  }
  context.bus.emit({ type: "quote", runId, callId, hotelId, quote, at: Date.now() });
  return { ok: true };
}

function reportNote(context: ToolContext, args: unknown, callId: string, runId: string, hotelId: string): Record<string, unknown> {
  const parsed = reportNoteSchema.safeParse(args);
  if (parsed.success === false) {
    return { ok: false, error: "text is required" };
  }
  context.bus.emit({ type: "note", runId, callId, hotelId, text: parsed.data.text, at: Date.now() });
  return { ok: true };
}

function checkMarket(context: ToolContext, callId: string, runId: string): Record<string, unknown> {
  const update = context.getMarketFor(callId);
  context.bus.emit({ type: "market_update", runId, callId, update, at: Date.now() });
  const output: Record<string, unknown> = { action: update.action };
  if (update.bestCompetingQuote !== undefined) {
    output.best_competing_price = update.bestCompetingQuote.price;
    output.best_competing_hotel = update.bestCompetingQuote.hotelName;
  }
  return output;
}

export function createDefaultHandleToolCall(context: ToolContext): HandleToolCall {
  return async (name, args, callId) => {
    const state = context.registry.get(callId);
    if (state === undefined) {
      return { ok: false, error: "unknown call" };
    }
    const runId = state.ctx.runId;
    const hotelId = state.ctx.hotel.id;
    if (name === "report_quote") {
      return reportQuote(context, args, callId, runId, hotelId);
    }
    if (name === "report_note") {
      return reportNote(context, args, callId, runId, hotelId);
    }
    if (name === "check_market") {
      return checkMarket(context, callId, runId);
    }
    return { ok: false, error: `unknown tool ${name}` };
  };
}
