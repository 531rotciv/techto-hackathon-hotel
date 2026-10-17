import twilio from "twilio";
import { requireConfig } from "./config.js";

export function createTwilioClient() {
  const apiKeySid = requireConfig("TWILIO_API_KEY_SID");
  const apiKeySecret = requireConfig("TWILIO_API_KEY_SECRET");
  const accountSid = requireConfig("TWILIO_ACCOUNT_SID");
  const client = twilio(apiKeySid, apiKeySecret, { accountSid });
  return client;
}

const FINAL_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

export function isFinalCallStatus(status: string): boolean {
  return FINAL_STATUSES.has(status);
}

// Twilio only accepts "canceled" for a call that hasn't been answered yet,
// and "completed" for one that has, so the current status picks the update.
export async function endTwilioCall(callSid: string): Promise<string> {
  const client = createTwilioClient();
  const call = await client.calls(callSid).fetch();
  if (isFinalCallStatus(call.status)) {
    return call.status;
  }

  const notAnswered = call.status === "queued" || call.status === "ringing";
  let newStatus: "canceled" | "completed" = "completed";
  if (notAnswered) {
    newStatus = "canceled";
  }
  const updated = await client.calls(callSid).update({ status: newStatus });
  return updated.status;
}
