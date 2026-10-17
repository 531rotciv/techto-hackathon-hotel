import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { config, requireConfig } from "./config.js";
import type { EventBus } from "./events.js";
import type { CallResult, DecisionRecord, ReceiptResult, RunReport, TranscriptLine } from "./types.js";

// ---------- composing ----------
export type ReceiptOptions = {
  includeAllTranscripts: boolean;
};

export type ComposedReceipt = {
  subject: string;
  text: string;
  html: string;
};

// ---------- facts the receipt needs, read once from the report ----------

type HotelFacts = { name: string; listedPrice?: number };

function hotelFacts(report: RunReport): Map<string, HotelFacts> {
  const facts = new Map<string, HotelFacts>();
  const decision = report.decision;
  if (decision === undefined) {
    return facts;
  }
  for (const entry of decision.boardSnapshot) {
    facts.set(entry.hotelId, { name: entry.hotelName, listedPrice: entry.listedPrice });
  }
  for (const ranked of decision.ranking) {
    if (facts.has(ranked.hotelId) === false) {
      facts.set(ranked.hotelId, { name: ranked.hotelName });
    }
  }
  return facts;
}

function hotelName(facts: Map<string, HotelFacts>, hotelId: string): string {
  const known = facts.get(hotelId);
  if (known === undefined) {
    return hotelId;
  }
  return known.name;
}

export function money(value: number | undefined): string {
  if (value === undefined) {
    return "-";
  }
  if (Number.isInteger(value)) {
    return `$${value}`;
  }
  return `$${value.toFixed(2)}`;
}

function winnerName(report: RunReport, facts: Map<string, HotelFacts>): string | null {
  const decision = report.decision;
  if (decision === undefined || decision.winnerHotelId === undefined || decision.price === undefined) {
    return null;
  }
  return hotelName(facts, decision.winnerHotelId);
}

function stayLine(report: RunReport): string {
  const task = report.task;
  let roomWord = "rooms";
  if (task.rooms === 1) {
    roomWord = "room";
  }
  return `${task.city}, ${task.checkIn} to ${task.checkOut}, ${task.nights} nights, ${task.guests} guests, ${task.rooms} ${roomWord}, for ${task.guestName}`;
}

function decisionLine(report: RunReport, decision: DecisionRecord): string {
  const secondsIn = Math.round((decision.at - report.startedAt) / 1000);
  const when = new Date(decision.at).toISOString();
  return `Decided at ${when} (${secondsIn}s into the run): ${decision.reason}`;
}

function quoteHistory(call: CallResult): string {
  if (call.quotes.length === 0) {
    return "no price reported";
  }
  const parts = call.quotes.map((quote) => {
    let trigger = "";
    if (quote.trigger !== undefined) {
      trigger = ` (${quote.trigger})`;
    }
    return `${money(quote.price)}${trigger}`;
  });
  return parts.join(" > ");
}

function transcriptFacts(call: CallResult): string {
  const extracted = call.extracted;
  if (extracted === undefined || extracted.lowestTotalPrice === undefined) {
    return "transcript: no price";
  }
  let conditions = "";
  if (extracted.rateConditions !== undefined) {
    conditions = `, ${extracted.rateConditions}`;
  }
  return `transcript: ${money(extracted.lowestTotalPrice)}${conditions}`;
}

function transcriptLineText(line: TranscriptLine): string {
  return `[${line.atSecs.toFixed(1)}s] ${line.speaker}: ${line.text}`;
}

function otherCalls(report: RunReport): CallResult[] {
  let winnerCallId: string | undefined = undefined;
  if (report.decision !== undefined) {
    winnerCallId = report.decision.winnerCallId;
  }
  return report.calls.filter((call) => call.callId !== winnerCallId);
}

// ---------- subject ----------

export function receiptSubject(report: RunReport): string {
  const facts = hotelFacts(report);
  const name = winnerName(report, facts);
  const task = report.task;
  if (name === null || report.decision === undefined) {
    return `No rate found: ${task.city}, ${task.checkIn} to ${task.checkOut}`;
  }
  return `Lowest rate found: ${name} ${money(report.decision.price)} total, ${task.checkIn} to ${task.checkOut}`;
}

// ---------- plain text ----------

function textHeadline(report: RunReport, facts: Map<string, HotelFacts>): string[] {
  const name = winnerName(report, facts);
  const decision = report.decision;
  if (name === null || decision === undefined) {
    return ["NO RATE FOUND", "No hotel gave a price on the phone. What was heard is below.", ""];
  }
  let source = "";
  if (decision.priceSource !== undefined) {
    source = ` (price from ${decision.priceSource})`;
  }
  return ["LOWEST RATE FOUND", `${name}: ${money(decision.price)} total for the whole stay${source}`, ""];
}

function textRanking(decision: DecisionRecord): string[] {
  const lines = ["RANKING"];
  decision.ranking.forEach((ranked, index) => {
    let taxes = "";
    if (ranked.includesTaxes === true) {
      taxes = ", taxes included";
    }
    lines.push(`${index + 1}. ${ranked.hotelName}  ${money(ranked.price)}  (${ranked.priceSource}${taxes})`);
  });
  lines.push("");
  return lines;
}

function textEveryHotel(report: RunReport, facts: Map<string, HotelFacts>): string[] {
  const lines = ["EVERY HOTEL CALLED"];
  for (const call of report.calls) {
    const known = facts.get(call.hotelId);
    let listed = "";
    if (known !== undefined && known.listedPrice !== undefined) {
      listed = `, listed ${money(known.listedPrice)}`;
    }
    lines.push(`${hotelName(facts, call.hotelId)}${listed}: ${quoteHistory(call)}; ${transcriptFacts(call)}; ${call.status}`);
  }
  lines.push("");
  return lines;
}

function textEvidence(winner: CallResult): string[] {
  const lines = ["EVIDENCE"];
  if (winner.extracted !== undefined && winner.extracted.priceQuote !== undefined) {
    lines.push(`The hotel said: "${winner.extracted.priceQuote}"`);
  }
  lines.push(`ElevenLabs conversation ${winner.conversationId}, call length ${winner.durationSecs}s`);
  lines.push("");
  for (const line of winner.transcript) {
    lines.push(transcriptLineText(line));
  }
  lines.push("");
  return lines;
}

function textOtherCalls(report: RunReport, facts: Map<string, HotelFacts>, options: ReceiptOptions): string[] {
  const others = otherCalls(report);
  if (others.length === 0) {
    return [];
  }
  const lines = ["OTHER CALLS"];
  for (const call of others) {
    let summary = "";
    if (call.summary !== undefined) {
      summary = ` ${call.summary}`;
    }
    lines.push(`${hotelName(facts, call.hotelId)}: ${call.status}, ${transcriptFacts(call)}.${summary}`);
    if (options.includeAllTranscripts) {
      for (const line of call.transcript) {
        lines.push(`  ${transcriptLineText(line)}`);
      }
    }
  }
  lines.push("");
  return lines;
}

export function receiptText(report: RunReport, options: ReceiptOptions): string {
  const facts = hotelFacts(report);
  const lines: string[] = [];
  lines.push(...textHeadline(report, facts));
  lines.push("STAY", stayLine(report));
  if (report.decision !== undefined) {
    lines.push(decisionLine(report, report.decision));
  }
  lines.push("");
  if (report.decision !== undefined && report.decision.ranking.length > 0) {
    lines.push(...textRanking(report.decision));
  }
  lines.push(...textEveryHotel(report, facts));
  if (report.winner !== undefined) {
    lines.push(...textEvidence(report.winner));
  }
  lines.push(...textOtherCalls(report, facts, options));
  lines.push("Sent by our AI hotel quote agent. Nothing was booked.");
  return lines.join("\n");
}

// ---------- html ----------

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function htmlRow(cells: string[]): string {
  const tds = cells.map((cell) => `<td style="padding:4px 10px;border-bottom:1px solid #ddd">${cell}</td>`);
  return `<tr>${tds.join("")}</tr>`;
}

function htmlHeadline(report: RunReport, facts: Map<string, HotelFacts>): string {
  const name = winnerName(report, facts);
  const decision = report.decision;
  if (name === null || decision === undefined) {
    return "<h1>No rate found</h1><p>No hotel gave a price on the phone. What was heard is below.</p>";
  }
  let source = "";
  if (decision.priceSource !== undefined) {
    source = ` <small>(price from ${escapeHtml(decision.priceSource)})</small>`;
  }
  return `<h1>Lowest rate found: ${escapeHtml(name)} ${money(decision.price)}</h1><p>Total for the whole stay${source}</p>`;
}

function htmlRanking(decision: DecisionRecord): string {
  const rows = decision.ranking.map((ranked, index) => {
    let taxes = "";
    if (ranked.includesTaxes === true) {
      taxes = "taxes included";
    }
    return htmlRow([String(index + 1), escapeHtml(ranked.hotelName), `<b>${money(ranked.price)}</b>`, escapeHtml(ranked.priceSource), taxes]);
  });
  return `<h2>Ranking</h2><table style="border-collapse:collapse">${rows.join("")}</table>`;
}

function htmlEveryHotel(report: RunReport, facts: Map<string, HotelFacts>): string {
  const header = htmlRow(["<b>Hotel</b>", "<b>Listed</b>", "<b>Quotes on the call</b>", "<b>From transcript</b>", "<b>Status</b>"]);
  const rows = report.calls.map((call) => {
    const known = facts.get(call.hotelId);
    let listed: number | undefined = undefined;
    if (known !== undefined) {
      listed = known.listedPrice;
    }
    return htmlRow([
      escapeHtml(hotelName(facts, call.hotelId)),
      money(listed),
      escapeHtml(quoteHistory(call)),
      escapeHtml(transcriptFacts(call).replace("transcript: ", "")),
      escapeHtml(call.status),
    ]);
  });
  return `<h2>Every hotel called</h2><table style="border-collapse:collapse">${header}${rows.join("")}</table>`;
}

function htmlTranscript(transcript: TranscriptLine[], highlight: string | undefined): string {
  const lines = transcript.map((line) => {
    let style = "margin:2px 0";
    if (highlight !== undefined && line.text === highlight) {
      style = "margin:2px 0;background:#fff3b0;font-weight:bold";
    }
    return `<p style="${style}"><span style="color:#888">[${line.atSecs.toFixed(1)}s]</span> <b>${escapeHtml(line.speaker)}:</b> ${escapeHtml(line.text)}</p>`;
  });
  return lines.join("");
}

function htmlEvidence(winner: CallResult): string {
  let quote = "";
  let highlight: string | undefined = undefined;
  if (winner.extracted !== undefined && winner.extracted.priceQuote !== undefined) {
    highlight = winner.extracted.priceQuote;
    quote = `<blockquote style="background:#fff3b0;padding:8px 12px;margin:8px 0">The hotel said: "${escapeHtml(highlight)}"</blockquote>`;
  }
  let conversation = "";
  if (winner.conversationId !== undefined) {
    conversation = escapeHtml(winner.conversationId);
  }
  return (
    `<h2>Evidence</h2>${quote}` +
    `<p style="color:#555">ElevenLabs conversation ${conversation}, call length ${winner.durationSecs}s</p>` +
    htmlTranscript(winner.transcript, highlight)
  );
}

function htmlOtherCalls(report: RunReport, facts: Map<string, HotelFacts>, options: ReceiptOptions): string {
  const others = otherCalls(report);
  if (others.length === 0) {
    return "";
  }
  const parts = others.map((call) => {
    let summary = "";
    if (call.summary !== undefined) {
      summary = ` ${escapeHtml(call.summary)}`;
    }
    let transcript = "";
    if (options.includeAllTranscripts) {
      transcript = htmlTranscript(call.transcript, undefined);
    }
    return `<p><b>${escapeHtml(hotelName(facts, call.hotelId))}</b>: ${escapeHtml(call.status)}, ${escapeHtml(transcriptFacts(call))}.${summary}</p>${transcript}`;
  });
  return `<h2>Other calls</h2>${parts.join("")}`;
}

export function receiptHtml(report: RunReport, options: ReceiptOptions): string {
  const facts = hotelFacts(report);
  const sections: string[] = [];
  sections.push(htmlHeadline(report, facts));
  sections.push(`<p>${escapeHtml(stayLine(report))}</p>`);
  if (report.decision !== undefined) {
    sections.push(`<p style="color:#555">${escapeHtml(decisionLine(report, report.decision))}</p>`);
    if (report.decision.ranking.length > 0) {
      sections.push(htmlRanking(report.decision));
    }
  }
  sections.push(htmlEveryHotel(report, facts));
  if (report.winner !== undefined) {
    sections.push(htmlEvidence(report.winner));
  }
  sections.push(htmlOtherCalls(report, facts, options));
  sections.push('<p style="color:#888">Sent by our AI hotel quote agent. Nothing was booked.</p>');
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;max-width:760px">${sections.join("")}</body></html>`;
}

// ---------- sending ----------
const SEND_ATTEMPTS = 3; // the first try plus two retries
const RETRY_DELAY_MS = 2000;

function defaultOptions(): ReceiptOptions {
  return { includeAllTranscripts: config.RECEIPT_INCLUDE_ALL_TRANSCRIPTS === 1 };
}

export function composeReceipt(report: RunReport, options?: ReceiptOptions): ComposedReceipt {
  let chosen = defaultOptions();
  if (options !== undefined) {
    chosen = options;
  }
  const receipt: ComposedReceipt = {
    subject: receiptSubject(report),
    text: receiptText(report, chosen),
    html: receiptHtml(report, chosen),
  };
  return receipt;
}

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

// The html is kept even when sending fails, so a human can forward it by hand.
function saveReceiptHtml(runId: string, html: string): string | null {
  try {
    const runsDir = path.join(process.cwd(), "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    const filePath = path.join(runsDir, `${runId}.receipt.html`);
    fs.writeFileSync(filePath, html);
    return filePath;
  } catch (err) {
    console.error(`[calls] runId=${runId} could not save the receipt html: ${errorMessage(err)}`);
    return null;
  }
}

function createReceiptTransport() {
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465, // 465 is TLS from the start; other ports upgrade with STARTTLS
    auth: {
      user: requireConfig("SMTP_USER"),
      pass: requireConfig("SMTP_PASS"),
    },
  });
  return transport;
}

function senderAddress(): string {
  if (config.RECEIPT_FROM !== undefined) {
    return config.RECEIPT_FROM;
  }
  return requireConfig("SMTP_USER");
}

async function deliver(result: ReceiptResult, receipt: ComposedReceipt): Promise<void> {
  let transport: ReturnType<typeof createReceiptTransport>;
  let from: string;
  try {
    transport = createReceiptTransport();
    from = senderAddress();
  } catch (err) {
    result.error = errorMessage(err);
    return;
  }

  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
    try {
      const info = await transport.sendMail({ from, to: result.to, subject: receipt.subject, text: receipt.text, html: receipt.html });
      result.ok = true;
      result.sentAt = Date.now();
      result.messageId = info.messageId;
      delete result.error;
      return;
    } catch (err) {
      result.error = errorMessage(err);
      console.error(`[calls] runId=${result.runId} receipt send attempt ${attempt} failed: ${result.error}`);
      if (attempt < SEND_ATTEMPTS) {
        await wait(RETRY_DELAY_MS);
      }
    }
  }
}

// Never throws: a failed send comes back as ok false, and receipt_sent always fires.
export async function sendReceipt(report: RunReport, to: string, bus: EventBus): Promise<ReceiptResult> {
  const receipt = composeReceipt(report);
  const savedPath = saveReceiptHtml(report.runId, receipt.html);
  if (savedPath !== null) {
    console.log(`[calls] runId=${report.runId} receipt html saved to ${savedPath}`);
  }

  const result: ReceiptResult = { runId: report.runId, to, subject: receipt.subject, ok: false };
  await deliver(result, receipt);
  if (result.ok) {
    console.log(`[calls] runId=${report.runId} receipt sent to ${to}`);
  }
  bus.emit({ type: "receipt_sent", runId: report.runId, result, at: Date.now() });
  return result;
}
