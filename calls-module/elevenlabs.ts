import { z } from "zod";
import { config, requireConfig } from "./config.js";
import type { CallContext } from "./types.js";

const API_BASE = "https://api.elevenlabs.io";

// ---------- response shapes, validated because ElevenLabs fields change ----------

const agentSchema = z.object({
  agent_id: z.string().nullish(),
  name: z.string().nullish(),
  conversation_config: z
    .object({
      agent: z
        .object({
          first_message: z.string().nullish(),
          prompt: z
            .object({
              prompt: z.string().nullish(),
              llm: z.string().nullish(),
              tool_ids: z.array(z.string()).nullish(),
              built_in_tools: z.record(z.string(), z.unknown()).nullish(),
            })
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
  platform_settings: z
    .object({
      data_collection: z.record(z.string(), z.unknown()).nullish(),
      analysis_items: z
        .object({
          data_collection: z.array(z.unknown()).nullish(),
        })
        .nullish(),
    })
    .nullish(),
});
export type ElevenLabsAgent = z.infer<typeof agentSchema>;

const phoneNumberSchema = z.object({
  phone_number: z.string(),
  phone_number_id: z.string(),
  label: z.string().nullish(),
  provider: z.string().nullish(),
  assigned_agent: z
    .object({
      agent_id: z.string(),
      agent_name: z.string().nullish(),
    })
    .nullish(),
});
export type ElevenLabsPhoneNumber = z.infer<typeof phoneNumberSchema>;

const outboundCallResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  conversation_id: z.string().nullish(),
  callSid: z.string().nullish(),
});
export type OutboundCallResponse = z.infer<typeof outboundCallResponseSchema>;

const transcriptTurnSchema = z.object({
  role: z.string(),
  message: z.string().nullish(),
  time_in_call_secs: z.number(),
});
export type ElevenLabsTranscriptTurn = z.infer<typeof transcriptTurnSchema>;

// The same shape arrives as the post-call webhook's `data` and from GET conversation.
// Data collection entries are kept as unknown and read field by field, so one
// odd entry can't make the whole payload fail validation.
export const conversationSchema = z.object({
  conversation_id: z.string(),
  status: z.string().nullish(),
  transcript: z.array(transcriptTurnSchema).nullish(),
  metadata: z
    .object({
      call_duration_secs: z.number().nullish(),
      termination_reason: z.string().nullish(),
    })
    .nullish(),
  analysis: z
    .object({
      call_successful: z.string().nullish(),
      transcript_summary: z.string().nullish(),
      data_collection_results: z.record(z.string(), z.unknown()).nullish(),
    })
    .nullish(),
});
export type ElevenLabsConversation = z.infer<typeof conversationSchema>;

// ---------- requests ----------

const SECRET_KEYS = ["ELEVENLABS_API_KEY", "ELEVENLABS_TOOL_SECRET", "ELEVENLABS_WEBHOOK_SECRET"] as const;

// ElevenLabs validation errors echo the request back, secrets included, so
// every known secret and anything shaped like a long token is masked first.
export function redactSecrets(text: string, extraSecrets: string[]): string {
  let redacted = text;
  const secrets: string[] = [...extraSecrets];
  for (const key of SECRET_KEYS) {
    const value = config[key];
    if (value !== undefined) {
      secrets.push(value);
    }
  }
  for (const secret of secrets) {
    if (secret.length >= 8) {
      redacted = redacted.split(secret).join("<redacted>");
    }
  }
  redacted = redacted.replace(/\b[0-9a-f]{32,}\b/gi, "<redacted>");
  redacted = redacted.replace(/\b(sk|whsec)_[A-Za-z0-9]{16,}\b/g, "<redacted>");
  return redacted;
}

let extraSecretsToRedact: string[] = [];

// For secrets created during this process, before config knows them.
export function alsoRedact(secret: string): void {
  extraSecretsToRedact = [...extraSecretsToRedact, secret];
}

// Throws with the status and the start of the body, secrets masked, so the
// caller can turn it into a failed CallResult or print it.
async function elevenLabsRequest(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> {
  const apiKey = requireConfig("ELEVENLABS_API_KEY");
  const headers: Record<string, string> = { "xi-api-key": apiKey };
  let payload: string | undefined = undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${path}`, { method, headers, body: payload });
  const text = await response.text();
  if (response.ok === false) {
    const preview = redactSecrets(text, extraSecretsToRedact).slice(0, 400);
    throw new Error(`ElevenLabs ${method} ${path} failed with HTTP ${response.status}: ${preview}`);
  }
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

export async function getAgent(agentId: string): Promise<ElevenLabsAgent> {
  const raw = await elevenLabsRequest("GET", `/v1/convai/agents/${encodeURIComponent(agentId)}`);
  return agentSchema.parse(raw);
}

export async function listPhoneNumbers(): Promise<ElevenLabsPhoneNumber[]> {
  const raw = await elevenLabsRequest("GET", "/v1/convai/phone-numbers");
  return z.array(phoneNumberSchema).parse(raw);
}

export async function placeOutboundCall(ctx: CallContext, dynamicVariables: Record<string, string | number>): Promise<OutboundCallResponse> {
  const body = {
    agent_id: requireConfig("ELEVENLABS_AGENT_ID"),
    agent_phone_number_id: requireConfig("ELEVENLABS_AGENT_PHONE_NUMBER_ID"),
    to_number: ctx.hotel.phone,
    conversation_initiation_client_data: {
      dynamic_variables: dynamicVariables,
    },
    telephony_call_config: {
      ringing_timeout_secs: config.RING_TIMEOUT_S,
    },
  };
  const raw = await elevenLabsRequest("POST", "/v1/convai/twilio/outbound-call", body);
  return outboundCallResponseSchema.parse(raw);
}

export async function getConversation(conversationId: string): Promise<ElevenLabsConversation> {
  const raw = await elevenLabsRequest("GET", `/v1/convai/conversations/${encodeURIComponent(conversationId)}`);
  return conversationSchema.parse(raw);
}

// ---------- workspace setup (scripts/setup-agent.ts) ----------

const createdWebhookSchema = z.object({
  webhook_id: z.string(),
  webhook_secret: z.string().nullish(),
});
export type CreatedWebhook = z.infer<typeof createdWebhookSchema>;

// Creates an HMAC-signed workspace webhook. The secret is only returned here, once.
export async function createWorkspaceWebhook(name: string, webhookUrl: string): Promise<CreatedWebhook> {
  const body = { settings: { auth_type: "hmac", name, webhook_url: webhookUrl } };
  const raw = await elevenLabsRequest("POST", "/v1/workspace/webhooks", body);
  return createdWebhookSchema.parse(raw);
}

// Points the workspace's Agents post-call events at one webhook.
export async function usePostCallWebhook(webhookId: string): Promise<void> {
  const body = {
    webhooks: {
      post_call_webhook_id: webhookId,
      events: ["transcript", "call_initiation_failure"],
    },
  };
  await elevenLabsRequest("PATCH", "/v1/convai/settings", body);
}

// ---------- tools and agent config (scripts/setup-agent.ts) ----------

const toolListSchema = z.object({
  tools: z.array(
    z.object({
      id: z.string(),
      tool_config: z.object({ name: z.string().nullish(), type: z.string().nullish() }).nullish(),
    }),
  ),
});
export type ExistingTool = { id: string; name: string };

const createdToolSchema = z.object({ id: z.string() });

export async function listTools(): Promise<ExistingTool[]> {
  const raw = await elevenLabsRequest("GET", "/v1/convai/tools");
  const parsed = toolListSchema.parse(raw);
  const tools: ExistingTool[] = [];
  for (const tool of parsed.tools) {
    if (tool.tool_config !== null && tool.tool_config !== undefined && typeof tool.tool_config.name === "string") {
      tools.push({ id: tool.id, name: tool.tool_config.name });
    }
  }
  return tools;
}

export async function createTool(toolConfig: Record<string, unknown>): Promise<string> {
  const raw = await elevenLabsRequest("POST", "/v1/convai/tools", { tool_config: toolConfig });
  return createdToolSchema.parse(raw).id;
}

export async function updateTool(toolId: string, toolConfig: Record<string, unknown>): Promise<void> {
  await elevenLabsRequest("PATCH", `/v1/convai/tools/${encodeURIComponent(toolId)}`, { tool_config: toolConfig });
}

// Raw on purpose: the agent config is sent back with only our fields changed,
// so settings this project doesn't know about survive.
export async function getAgentRaw(agentId: string): Promise<Record<string, unknown>> {
  const raw = await elevenLabsRequest("GET", `/v1/convai/agents/${encodeURIComponent(agentId)}`);
  return z.record(z.string(), z.unknown()).parse(raw);
}

export async function patchAgent(agentId: string, body: Record<string, unknown>): Promise<void> {
  await elevenLabsRequest("PATCH", `/v1/convai/agents/${encodeURIComponent(agentId)}`, body);
}

// ---------- payload builders (pure, so they can be tested and shown with --dry-run) ----------

const TOOL_TIMEOUT_SECS = 5; // ElevenLabs' minimum; the tool route answers within a second

export type ToolDefinitionInput = { name: string; description: string; parameters: Record<string, unknown> };
export type DataCollectionInput = { identifier: string; type: string; description: string };

function hasProperties(parameters: Record<string, unknown>): boolean {
  const properties = parameters.properties;
  if (typeof properties !== "object" || properties === null) {
    return false;
  }
  return Object.keys(properties).length > 0;
}

// The call id rides in a header filled from the {{call_id}} dynamic variable,
// so the model never has to repeat it.
export function webhookToolConfig(definition: ToolDefinitionInput, publicUrl: string, toolSecret: string): Record<string, unknown> {
  const apiSchema: Record<string, unknown> = {
    url: `${publicUrl}/elevenlabs/tools/${definition.name}`,
    method: "POST",
    request_headers: {
      "X-Tool-Secret": toolSecret,
      "X-Call-Id": { variable_name: "call_id" },
    },
  };
  if (hasProperties(definition.parameters)) {
    apiSchema.request_body_schema = definition.parameters;
  }
  return {
    type: "webhook",
    name: definition.name,
    description: definition.description,
    response_timeout_secs: TOOL_TIMEOUT_SECS,
    api_schema: apiSchema,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && Array.isArray(value) === false) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return (value as unknown[]).filter((item): item is string => typeof item === "string");
}

export type AgentPatchInput = {
  systemPrompt: string;
  firstMessage: string;
  fields: DataCollectionInput[];
  ourToolIds: string[];
  replacedToolIds: string[];
};

// Starts from the agent's current config and changes only these fields: prompt,
// first message, our tool ids (others kept), end_call, and data collection.
export function buildAgentPatch(currentAgent: Record<string, unknown>, input: AgentPatchInput): Record<string, unknown> {
  const conversationConfig = asRecord(currentAgent.conversation_config);
  const agent = asRecord(conversationConfig.agent);
  const prompt = asRecord(agent.prompt);

  const keptToolIds = stringList(prompt.tool_ids).filter((id) => input.replacedToolIds.includes(id) === false && input.ourToolIds.includes(id) === false);
  prompt.tool_ids = [...keptToolIds, ...input.ourToolIds];
  // Inline tools are deprecated in favour of tool_ids; sending both is ambiguous.
  delete prompt.tools;
  prompt.prompt = input.systemPrompt;

  const builtInTools = asRecord(prompt.built_in_tools);
  builtInTools.end_call = { type: "system", name: "end_call", params: { system_tool_type: "end_call" } };
  prompt.built_in_tools = builtInTools;

  agent.prompt = prompt;
  agent.first_message = input.firstMessage;
  conversationConfig.agent = agent;

  const dataCollection = asRecord(asRecord(currentAgent.platform_settings).data_collection);
  for (const field of input.fields) {
    dataCollection[field.identifier] = { type: field.type, description: field.description };
  }
  const platformSettings = asRecord(currentAgent.platform_settings);
  platformSettings.data_collection = dataCollection;

  return { conversation_config: conversationConfig, platform_settings: platformSettings };
}

// Newer agents keep analysis items separately, and those win over data_collection.
export function usesAnalysisItems(currentAgent: Record<string, unknown>): boolean {
  const analysisItems = asRecord(currentAgent.platform_settings).analysis_items;
  return analysisItems !== null && analysisItems !== undefined;
}
