import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

// An empty line like `ELEVENLABS_API_KEY=` should count as "not set",
// so the default or the optional path applies instead of an empty string.
function emptyAsUndefined(value: unknown): unknown {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return value;
}

function optionalText() {
  return z.preprocess(emptyAsUndefined, z.string().optional());
}

function textWithDefault(fallback: string) {
  return z.preprocess(emptyAsUndefined, z.string().default(fallback));
}

function integerWithDefault(fallback: number) {
  return z.preprocess(emptyAsUndefined, z.coerce.number().int().default(fallback));
}

function flagWithDefault(fallback: 0 | 1) {
  return z.preprocess(emptyAsUndefined, z.coerce.number().int().min(0).max(1).default(fallback));
}

const configSchema = z.object({
  // server
  PORT: integerWithDefault(3000),
  PUBLIC_URL: optionalText(),

  // ngrok tunnel (scripts/tunnel.ts)
  NGROK_AUTHTOKEN: optionalText(),
  NGROK_DOMAIN: optionalText(),

  // elevenlabs
  ELEVENLABS_API_KEY: optionalText(),
  ELEVENLABS_AGENT_ID: optionalText(),
  ELEVENLABS_AGENT_PHONE_NUMBER_ID: optionalText(),
  ELEVENLABS_WEBHOOK_SECRET: optionalText(),
  ELEVENLABS_TOOL_SECRET: optionalText(),

  // twilio, only to end calls that overrun
  TWILIO_ACCOUNT_SID: optionalText(),
  TWILIO_API_KEY_SID: optionalText(),
  TWILIO_API_KEY_SECRET: optionalText(),

  // receipt email, optional
  SMTP_HOST: textWithDefault("smtp.gmail.com"),
  SMTP_PORT: integerWithDefault(465),
  SMTP_USER: optionalText(),
  SMTP_PASS: optionalText(),
  RECEIPT_FROM: optionalText(),
  RECEIPT_INCLUDE_ALL_TRANSCRIPTS: flagWithDefault(0),
  RECEIPT_TEST_TO: optionalText(),

  // call timing
  CALL_TIMEOUT_MS: integerWithDefault(120000),
  RING_TIMEOUT_S: integerWithDefault(20),
});

export type CallsConfig = z.infer<typeof configSchema>;

// People paste the domain in different forms, so keep only the host.
export function hostFromDomain(domain: string): string {
  let host = domain.trim();
  host = host.replace(/^https?:\/\//, "");
  host = host.replace(/\/+$/, "");
  return host;
}

// With a static ngrok domain the public URL is known up front.
function applyNgrokPublicUrl(loaded: CallsConfig): void {
  const domain = loaded.NGROK_DOMAIN;
  if (loaded.PUBLIC_URL === undefined && domain !== undefined) {
    loaded.PUBLIC_URL = `https://${hostFromDomain(domain)}`;
  }
}

function loadConfig(): CallsConfig {
  const parsed = configSchema.safeParse(process.env);
  if (parsed.success === false) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`[calls] invalid environment variables: ${problems.join("; ")}`);
  }
  const loaded = parsed.data;
  applyNgrokPublicUrl(loaded);
  return loaded;
}

export const config: CallsConfig = loadConfig();

export type OptionalConfigKey =
  | "PUBLIC_URL"
  | "NGROK_AUTHTOKEN"
  | "NGROK_DOMAIN"
  | "ELEVENLABS_API_KEY"
  | "ELEVENLABS_AGENT_ID"
  | "ELEVENLABS_AGENT_PHONE_NUMBER_ID"
  | "ELEVENLABS_WEBHOOK_SECRET"
  | "ELEVENLABS_TOOL_SECRET"
  | "TWILIO_ACCOUNT_SID"
  | "TWILIO_API_KEY_SID"
  | "TWILIO_API_KEY_SECRET"
  | "SMTP_USER"
  | "SMTP_PASS"
  | "RECEIPT_FROM"
  | "RECEIPT_TEST_TO";

// Keys are optional at boot so the host app runs with no accounts. A feature
// that actually needs one calls this and gets a clear error instead.
export function requireConfig(key: OptionalConfigKey): string {
  const value = config[key];
  if (value === undefined) {
    throw new Error(`[calls] missing required environment variable ${key}. Set it in .env and restart.`);
  }
  return value;
}
