import type { CallResult, EndedBy, ExtractedQuote, TranscriptLine } from "./types.js";
import type { ElevenLabsConversation, ElevenLabsTranscriptTurn } from "./elevenlabs.js";

// Identifiers of the agent's data collection items, as configured in ElevenLabs.
const FIELD_LOWEST_TOTAL_PRICE = "lowest_total_price";
const FIELD_INCLUDES_TAXES = "includes_taxes";
const FIELD_RATE_CONDITIONS = "rate_conditions";
const FIELD_PRICE_QUOTE = "price_quote";

const EMPTY_WORDS = new Set(["", "null", "none", "n/a", "na", "unknown"]);

export function toTranscriptLines(turns: ElevenLabsTranscriptTurn[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const turn of turns) {
    // Tool-call turns have no spoken message.
    if (typeof turn.message !== "string" || turn.message.trim() === "") {
      continue;
    }
    let speaker: TranscriptLine["speaker"] = "hotel";
    if (turn.role === "agent") {
      speaker = "agent";
    }
    lines.push({ speaker, text: turn.message.trim(), atSecs: turn.time_in_call_secs });
  }
  return lines;
}

// Each result entry is documented as { data_collection_id, value, rationale },
// but an entry that is just the value is accepted too.
function rawValueOf(results: Record<string, unknown>, field: string): unknown {
  const entry = results[field];
  if (typeof entry === "object" && entry !== null && "value" in entry) {
    const withValue = entry as { value: unknown };
    return withValue.value;
  }
  return entry;
}

export function parsePrice(value: unknown): number | undefined {
  let price: number | undefined = undefined;
  if (typeof value === "number") {
    price = value;
  } else if (typeof value === "string") {
    const cleaned = value.replace(/[$,\s]/g, "");
    if (cleaned !== "") {
      price = Number(cleaned);
    }
  }
  if (price === undefined || Number.isFinite(price) === false || price <= 0) {
    return undefined;
  }
  return price;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const word = value.trim().toLowerCase();
  if (word === "true" || word === "yes") {
    return true;
  }
  if (word === "false" || word === "no") {
    return false;
  }
  return undefined;
}

function parseText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (EMPTY_WORDS.has(text.toLowerCase())) {
    return undefined;
  }
  return text;
}

export function parseExtracted(results: Record<string, unknown> | null | undefined): ExtractedQuote | undefined {
  if (results === null || results === undefined) {
    return undefined;
  }
  const extracted: ExtractedQuote = {};
  const price = parsePrice(rawValueOf(results, FIELD_LOWEST_TOTAL_PRICE));
  if (price !== undefined) {
    extracted.lowestTotalPrice = price;
  }
  const includesTaxes = parseBoolean(rawValueOf(results, FIELD_INCLUDES_TAXES));
  if (includesTaxes !== undefined) {
    extracted.includesTaxes = includesTaxes;
  }
  const rateConditions = parseText(rawValueOf(results, FIELD_RATE_CONDITIONS));
  if (rateConditions !== undefined) {
    extracted.rateConditions = rateConditions;
  }
  const priceQuote = parseText(rawValueOf(results, FIELD_PRICE_QUOTE));
  if (priceQuote !== undefined) {
    extracted.priceQuote = priceQuote;
  }
  if (Object.keys(extracted).length === 0) {
    return undefined;
  }
  return extracted;
}

// ElevenLabs words termination reasons in prose, so only clear cases are mapped.
export function endedByFromReason(reason: string | undefined): EndedBy | undefined {
  if (reason === undefined) {
    return undefined;
  }
  const lowered = reason.toLowerCase();
  if (lowered.includes("end_call") || lowered.includes("end call")) {
    return "agent";
  }
  if (lowered.includes("disconnect") || lowered.includes("hang") || lowered.includes("hung up")) {
    return "hotel";
  }
  return undefined;
}

export function terminationReasonOf(conversation: ElevenLabsConversation): string | undefined {
  const metadata = conversation.metadata;
  if (metadata === null || metadata === undefined) {
    return undefined;
  }
  if (typeof metadata.termination_reason !== "string") {
    return undefined;
  }
  return metadata.termination_reason;
}

// Copies everything the conversation knows onto the call result.
export function applyConversation(result: CallResult, conversation: ElevenLabsConversation): void {
  result.conversationId = conversation.conversation_id;
  if (Array.isArray(conversation.transcript)) {
    result.transcript = toTranscriptLines(conversation.transcript);
  }

  const metadata = conversation.metadata;
  if (metadata !== null && metadata !== undefined) {
    if (typeof metadata.call_duration_secs === "number") {
      result.durationSecs = metadata.call_duration_secs;
    }
    if (typeof metadata.termination_reason === "string") {
      result.terminationReason = metadata.termination_reason;
    }
  }

  const analysis = conversation.analysis;
  if (analysis !== null && analysis !== undefined) {
    if (typeof analysis.transcript_summary === "string" && analysis.transcript_summary !== "") {
      result.summary = analysis.transcript_summary;
    }
    const extracted = parseExtracted(analysis.data_collection_results);
    if (extracted !== undefined) {
      result.extracted = extracted;
    }
  }
}
