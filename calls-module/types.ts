// ---------- what a call is about ----------
export type Task = {
  taskId: string;
  city: string;
  checkIn: string;          // YYYY-MM-DD
  checkOut: string;
  nights: number;
  guests: number;
  rooms: number;
  guestName: string;
  receiptEmail: string;
  notes?: string;
};

export type Hotel = {
  id: string;
  name: string;
  phone: string;            // E.164
  listedPrice?: number;     // total for the stay
  address?: string;
};

export type CallContext = {
  callId: string;
  runId: string;
  task: Task;
  hotel: Hotel;
};

// ---------- what comes back ----------
export type TranscriptLine = {
  speaker: "agent" | "hotel";
  text: string;
  atSecs: number;           // seconds into the call
};

export type CallStatus = "completed" | "no_answer" | "busy" | "failed" | "timeout";

export type EndedBy = "agent" | "hotel" | "system" | "timeout";

export type QuoteRecord = {
  price: number;            // total for the stay
  at: number;               // ms epoch
  includesTaxes?: boolean;
  roomType?: string;
  trigger?: string;         // initial | asked best rate | non-refundable | competing quote | other
};

// What ElevenLabs' post-call analysis read out of the transcript.
export type ExtractedQuote = {
  lowestTotalPrice?: number;  // whole stay, taxes and fees in
  includesTaxes?: boolean;
  rateConditions?: string;    // e.g. "non-refundable", "breakfast included"
  priceQuote?: string;        // the hotel's exact words when it gave that price
};

export type CallResult = {
  callId: string;
  runId: string;
  hotelId: string;
  conversationId?: string;
  twilioCallSid?: string;
  status: CallStatus;
  endedBy?: EndedBy;
  terminationReason?: string;
  quotes: QuoteRecord[];    // prices reported live through report_quote
  quotedPrice?: number;     // lowest of those
  extracted?: ExtractedQuote;
  notes: string[];
  transcript: TranscriptLine[];
  summary?: string;         // ElevenLabs transcript summary
  durationSecs?: number;
  startedAt: number;
  endedAt: number;
  error?: string;
};

// ---------- the answer to check_market ----------
export type MarketAction = "keep_going" | "wrap_up";

export type MarketUpdate = {
  action: MarketAction;
  bestCompetingQuote?: { hotelName: string; price: number }; // a real quote from another hotel only
};

// ---------- receipt ----------
export type BoardStatus = "idle" | "dialing" | "talking" | "quoted" | "done" | "failed";

export type BoardEntry = {
  hotelId: string;
  hotelName: string;
  callId?: string;
  status: BoardStatus;
  listedPrice?: number;
  bestPrice?: number;
  priceHistory: QuoteRecord[];
  notes: string[];
  attempts: number;
};

export type PriceSource = "transcript" | "reported";

export type RankedQuote = {
  hotelId: string;
  hotelName: string;
  callId: string;
  price: number;
  priceSource: PriceSource;
  includesTaxes?: boolean;
};

export type DecisionRecord = {
  runId: string;
  at: number;
  winnerHotelId?: string;
  winnerCallId?: string;
  price?: number;
  priceSource?: PriceSource;
  reason: string;
  ranking: RankedQuote[];   // every priced call, cheapest first
  boardSnapshot: BoardEntry[];
};

export type RunReport = {
  runId: string;
  task: Task;
  startedAt: number;
  endedAt: number;
  calls: CallResult[];
  decision?: DecisionRecord;
  winner?: CallResult;
};

export type ReceiptResult = {
  runId: string;
  to: string;
  subject: string;
  ok: boolean;
  sentAt?: number;
  messageId?: string;
  error?: string;
};

// A call that never got anywhere is a failure until proven otherwise.
export function emptyResult(ctx: CallContext): CallResult {
  const now = Date.now();
  const result: CallResult = {
    callId: ctx.callId,
    runId: ctx.runId,
    hotelId: ctx.hotel.id,
    status: "failed",
    quotes: [],
    notes: [],
    transcript: [],
    startedAt: now,
    endedAt: now,
  };
  return result;
}
