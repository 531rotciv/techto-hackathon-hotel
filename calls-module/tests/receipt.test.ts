import { test } from "node:test";
import assert from "node:assert/strict";
import { composeReceipt } from "../receipt.js";
import type { BoardEntry, CallResult, DecisionRecord, RunReport, Task } from "../types.js";

// A finished three-hotel run.
export function sampleRunReport(receiptEmail: string): RunReport {
  const runId = "sample-run";
  const startedAt = Date.parse("2026-11-01T17:30:00Z");
  const task: Task = {
    taskId: "sample-1",
    city: "City X",
    checkIn: "2026-11-05",
    checkOut: "2026-11-07",
    nights: 2,
    guests: 2,
    rooms: 1,
    guestName: "Test Guest",
    receiptEmail,
  };

  const maple: CallResult = {
    callId: "call-maple",
    runId,
    hotelId: "maple-suites",
    conversationId: "conv_sample_maple",
    status: "completed",
    endedBy: "agent",
    quotes: [
      { price: 154, at: startedAt + 12000, includesTaxes: true, trigger: "initial" },
      { price: 149, at: startedAt + 17000, includesTaxes: true, trigger: "non-refundable" },
      { price: 139, at: startedAt + 23000, includesTaxes: true, trigger: "competing quote" },
    ],
    quotedPrice: 139,
    extracted: {
      lowestTotalPrice: 139,
      includesTaxes: true,
      rateConditions: "non-refundable",
      priceQuote: "Yes, $139 total, non-refundable.",
    },
    notes: ["non-refundable rate"],
    transcript: [
      { speaker: "hotel", text: "Good afternoon, Maple Suites.", atSecs: 1 },
      { speaker: "agent", text: "Hi, what's the total for two guests, November fifth to seventh, including taxes and fees?", atSecs: 3 },
      { speaker: "hotel", text: "That would be $154 for both nights, taxes included.", atSecs: 9 },
      { speaker: "agent", text: "Is there a cheaper non-refundable rate?", atSecs: 11 },
      { speaker: "hotel", text: "Non-refundable is $149.", atSecs: 15 },
      { speaker: "agent", text: "I've been quoted $145 elsewhere. Can you do any better?", atSecs: 17 },
      { speaker: "hotel", text: "I can do $139 on the non-refundable rate.", atSecs: 21 },
      { speaker: "agent", text: "So that's $139 total for the whole stay, including taxes and fees?", atSecs: 23 },
      { speaker: "hotel", text: "Yes, $139 total, non-refundable.", atSecs: 25 },
      { speaker: "agent", text: "Thank you so much, that's really helpful. We'll call back if we decide to book. Have a great day.", atSecs: 27 },
    ],
    summary: "Maple Suites went from $154 to $149 non-refundable, then $139 after hearing a $145 competing quote.",
    durationSecs: 30,
    startedAt: startedAt + 1000,
    endedAt: startedAt + 38000,
  };

  const harbor: CallResult = {
    callId: "call-harbor",
    runId,
    hotelId: "harbor-inn",
    conversationId: "conv_sample_harbor",
    status: "completed",
    endedBy: "agent",
    quotes: [{ price: 145, at: startedAt + 11000, includesTaxes: true, trigger: "initial" }],
    quotedPrice: 145,
    extracted: { lowestTotalPrice: 145, includesTaxes: true, rateConditions: "resort fee included", priceQuote: "Yes, $145 all in." },
    notes: ["resort fee included"],
    transcript: [
      { speaker: "hotel", text: "Harbor Inn, front desk.", atSecs: 1 },
      { speaker: "hotel", text: "That comes to $145 with the resort fee.", atSecs: 9 },
      { speaker: "hotel", text: "Yes, $145 all in.", atSecs: 16 },
    ],
    summary: "Harbor Inn quoted $145 for the stay, resort fee included, with no cheaper rate.",
    durationSecs: 20,
    startedAt: startedAt + 1200,
    endedAt: startedAt + 30000,
  };

  const grand: CallResult = {
    callId: "call-grand",
    runId,
    hotelId: "grand-central",
    conversationId: "conv_sample_grand",
    status: "completed",
    endedBy: "agent",
    quotes: [
      { price: 189, at: startedAt + 16000, includesTaxes: true, trigger: "initial" },
      { price: 179, at: startedAt + 30000, includesTaxes: true, trigger: "non-refundable" },
    ],
    quotedPrice: 179,
    extracted: { lowestTotalPrice: 179, includesTaxes: true, rateConditions: "non-refundable", priceQuote: "Sorry, $179 is the best I can do." },
    notes: [],
    transcript: [{ speaker: "hotel", text: "That would be $189 total.", atSecs: 13 }],
    summary: "Grand Central quoted $189, then $179 non-refundable, and would not match $139.",
    durationSecs: 38,
    startedAt: startedAt + 1400,
    endedAt: startedAt + 48000,
  };

  const boardSnapshot: BoardEntry[] = [
    { hotelId: "maple-suites", hotelName: "Maple Suites", callId: "call-maple", status: "done", listedPrice: 154, bestPrice: 139, priceHistory: maple.quotes, notes: maple.notes, attempts: 1 },
    { hotelId: "harbor-inn", hotelName: "Harbor Inn", callId: "call-harbor", status: "done", listedPrice: 149, bestPrice: 145, priceHistory: harbor.quotes, notes: harbor.notes, attempts: 1 },
    { hotelId: "grand-central", hotelName: "Grand Central", callId: "call-grand", status: "done", listedPrice: 189, bestPrice: 179, priceHistory: grand.quotes, notes: [], attempts: 1 },
  ];

  const decision: DecisionRecord = {
    runId,
    at: startedAt + 48600,
    winnerHotelId: "maple-suites",
    winnerCallId: "call-maple",
    price: 139,
    priceSource: "transcript",
    reason: "all 3 calls ended, 3 priced, Maple Suites lowest from its transcript",
    ranking: [
      { hotelId: "maple-suites", hotelName: "Maple Suites", callId: "call-maple", price: 139, priceSource: "transcript", includesTaxes: true },
      { hotelId: "harbor-inn", hotelName: "Harbor Inn", callId: "call-harbor", price: 145, priceSource: "transcript", includesTaxes: true },
      { hotelId: "grand-central", hotelName: "Grand Central", callId: "call-grand", price: 179, priceSource: "transcript", includesTaxes: true },
    ],
    boardSnapshot,
  };

  const report: RunReport = {
    runId,
    task,
    startedAt,
    endedAt: startedAt + 50000,
    calls: [maple, harbor, grand],
    decision,
    winner: maple,
  };
  return report;
}

test("composeReceipt puts the winner's name and price in the subject and body", () => {
  const receipt = composeReceipt(sampleRunReport("guest@example.com"), { includeAllTranscripts: false });
  assert.equal(receipt.subject, "Lowest rate found: Maple Suites $139 total, 2026-11-05 to 2026-11-07");
  for (const body of [receipt.text, receipt.html]) {
    assert.ok(body.includes("Maple Suites") && body.includes("$139"));
    assert.ok(body.includes("Harbor Inn") && body.includes("Grand Central"), "every hotel called is listed");
    assert.ok(body.includes("Yes, $139 total, non-refundable."), "the hotel's exact words");
  }
  assert.ok(receipt.text.includes("[25.0s] hotel: Yes, $139 total, non-refundable."), "seconds-into-call timestamps");
  assert.ok(receipt.text.includes("1. Maple Suites  $139  (transcript, taxes included)"), "ranking cheapest first");
});

test("other calls get full transcripts only when asked", () => {
  const report = sampleRunReport("guest@example.com");
  assert.equal(composeReceipt(report, { includeAllTranscripts: false }).text.includes("That comes to $145 with the resort fee."), false);
  assert.equal(composeReceipt(report, { includeAllTranscripts: true }).text.includes("That comes to $145 with the resort fee."), true);
});

test("a run with no price says so", () => {
  const report = sampleRunReport("guest@example.com");
  report.decision = undefined;
  report.winner = undefined;
  const receipt = composeReceipt(report, { includeAllTranscripts: false });
  assert.equal(receipt.subject, "No rate found: City X, 2026-11-05 to 2026-11-07");
});

test("hotel text is escaped in the html", () => {
  const report = sampleRunReport("guest@example.com");
  const winner = report.winner;
  assert.ok(winner !== undefined);
  winner.transcript.push({ speaker: "hotel", text: "<script>alert(1)</script>", atSecs: 29 });
  const receipt = composeReceipt(report, { includeAllTranscripts: false });
  assert.equal(receipt.html.includes("<script>"), false);
});
