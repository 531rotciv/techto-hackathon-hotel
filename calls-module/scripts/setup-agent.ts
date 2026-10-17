// Sets up ElevenLabs for this server's public URL in one command:
//   1. the post-call webhook, with its secret saved to .env (never printed)
//   2. the three server tools (created, or updated if they exist)
//   3. the agent: prompt, first message, tools, End call, price fields
// Run from your repo root, where .env lives:
//   npx tsx <path>/calls-module/scripts/setup-agent.ts                do it (secrets go to .env, never the screen)
//   npx tsx <path>/calls-module/scripts/setup-agent.ts --dry-run      show what would be sent
//   npx tsx <path>/calls-module/scripts/setup-agent.ts --new-webhook  replace the webhook
// Rerun it when the public URL or the prompt changes. It updates, never duplicates.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config, requireConfig } from "../config.js";
import {
  alsoRedact,
  buildAgentPatch,
  createTool,
  createWorkspaceWebhook,
  getAgentRaw,
  listTools,
  patchAgent,
  updateTool,
  usePostCallWebhook,
  usesAnalysisItems,
  webhookToolConfig,
} from "../elevenlabs.js";
import { DATA_COLLECTION_FIELDS, DEFAULT_FIRST_MESSAGE, DEFAULT_SYSTEM_PROMPT, TOOL_DEFINITIONS } from "../hooks.js";

const WEBHOOK_NAME = "calls-module post-call";

type Options = { dryRun: boolean; newWebhook: boolean };

function readOptions(): Options {
  const parsed = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      "new-webhook": { type: "boolean" },
    },
  });
  return { dryRun: parsed.values["dry-run"] === true, newWebhook: parsed.values["new-webhook"] === true };
}

// Replaces the key's line in .env, or appends it, keeping every other line as is.
function writeEnvValue(key: string, value: string): void {
  const envPath = path.join(process.cwd(), ".env");
  let text = "";
  if (fs.existsSync(envPath)) {
    text = fs.readFileSync(envPath, "utf8");
  }
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(text)) {
    text = text.replace(pattern, line);
  } else {
    let separator = "";
    if (text !== "" && text.endsWith("\n") === false) {
      separator = "\n";
    }
    text = `${text}${separator}${line}\n`;
  }
  fs.writeFileSync(envPath, text);
}

// The tool secret is ours to choose, so it's generated once if missing.
function ensureToolSecret(options: Options): string {
  if (config.ELEVENLABS_TOOL_SECRET !== undefined) {
    return config.ELEVENLABS_TOOL_SECRET;
  }
  const secret = crypto.randomBytes(32).toString("hex");
  alsoRedact(secret);
  if (options.dryRun === false) {
    writeEnvValue("ELEVENLABS_TOOL_SECRET", secret);
    console.log("[calls] generated ELEVENLABS_TOOL_SECRET and saved it to .env");
  }
  return secret;
}

async function setUpWebhook(publicUrl: string, options: Options): Promise<void> {
  const webhookUrl = `${publicUrl}/elevenlabs/post-call`;
  const haveSecret = config.ELEVENLABS_WEBHOOK_SECRET !== undefined;
  if (haveSecret && options.newWebhook === false) {
    console.log("[calls] 1/3 webhook: ELEVENLABS_WEBHOOK_SECRET already set, keeping it (pass --new-webhook to replace)");
    return;
  }
  if (options.dryRun) {
    console.log(`[calls] 1/3 webhook: would create "${WEBHOOK_NAME}" -> ${webhookUrl} and route post-call events to it`);
    return;
  }
  const created = await createWorkspaceWebhook(WEBHOOK_NAME, webhookUrl);
  if (typeof created.webhook_secret !== "string" || created.webhook_secret === "") {
    throw new Error(`webhook ${created.webhook_id} created but no secret returned. Copy it from the dashboard into ELEVENLABS_WEBHOOK_SECRET.`);
  }
  alsoRedact(created.webhook_secret);
  writeEnvValue("ELEVENLABS_WEBHOOK_SECRET", created.webhook_secret);
  await usePostCallWebhook(created.webhook_id);
  console.log(`[calls] 1/3 webhook: ${webhookUrl} created (${created.webhook_id}), secret saved to .env, post-call events routed to it`);
}

type ToolIds = { ours: string[]; replaced: string[] };

async function setUpTools(publicUrl: string, toolSecret: string, options: Options): Promise<ToolIds> {
  if (options.dryRun) {
    for (const definition of TOOL_DEFINITIONS) {
      console.log(`[calls] 2/3 tool ${definition.name}: would create or update`);
      console.log(JSON.stringify(webhookToolConfig(definition, publicUrl, "<ELEVENLABS_TOOL_SECRET>"), null, 2));
    }
    return { ours: [], replaced: [] };
  }

  const existing = await listTools();
  const ours: string[] = [];
  const replaced: string[] = [];
  for (const definition of TOOL_DEFINITIONS) {
    const toolConfig = webhookToolConfig(definition, publicUrl, toolSecret);
    const match = existing.find((tool) => tool.name === definition.name);
    if (match !== undefined) {
      await updateTool(match.id, toolConfig);
      ours.push(match.id);
      console.log(`[calls] 2/3 tool ${definition.name}: updated (${match.id})`);
    } else {
      const id = await createTool(toolConfig);
      ours.push(id);
      console.log(`[calls] 2/3 tool ${definition.name}: created (${id})`);
    }
    // Any other tool with the same name would be a stale duplicate on the agent.
    for (const tool of existing) {
      if (tool.name === definition.name && (match === undefined || tool.id !== match.id)) {
        replaced.push(tool.id);
      }
    }
  }
  return { ours, replaced };
}

async function setUpAgent(agentId: string, toolIds: ToolIds, options: Options): Promise<void> {
  if (options.dryRun) {
    console.log(`[calls] 3/3 agent ${agentId}: would set the prompt, first message, the 3 tools, End call, and price fields`);
    return;
  }
  const current = await getAgentRaw(agentId);
  const patch = buildAgentPatch(current, {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    firstMessage: DEFAULT_FIRST_MESSAGE,
    fields: DATA_COLLECTION_FIELDS,
    ourToolIds: toolIds.ours,
    replacedToolIds: toolIds.replaced,
  });
  await patchAgent(agentId, patch);
  console.log(`[calls] 3/3 agent ${agentId}: prompt, first message, tools, End call, and price fields updated`);
  if (usesAnalysisItems(current)) {
    console.log("[calls] note: this agent uses the newer analysis items. Run scripts/check.ts to confirm the four price fields.");
  }
}

async function main(): Promise<void> {
  const options = readOptions();
  if (options.dryRun) {
    console.log("[calls] dry run: nothing will be changed in ElevenLabs or .env");
  }
  const publicUrl = requireConfig("PUBLIC_URL");
  let agentId = "<ELEVENLABS_AGENT_ID>";
  if (options.dryRun === false) {
    requireConfig("ELEVENLABS_API_KEY");
    agentId = requireConfig("ELEVENLABS_AGENT_ID");
  } else if (config.ELEVENLABS_AGENT_ID !== undefined) {
    agentId = config.ELEVENLABS_AGENT_ID;
  }
  const toolSecret = ensureToolSecret(options);

  await setUpWebhook(publicUrl, options);
  const toolIds = await setUpTools(publicUrl, toolSecret, options);
  await setUpAgent(agentId, toolIds, options);

  if (options.dryRun === false) {
    console.log("\n[calls] done. Restart your server so it loads the new secrets, then run scripts/check.ts");
    console.log("[calls] still manual: import a Twilio number under Phone Numbers, assign it to the agent, and set ELEVENLABS_AGENT_PHONE_NUMBER_ID");
  }
}

main().catch((err: unknown) => {
  let message = String(err);
  if (err instanceof Error) {
    message = err.message;
  }
  console.error(`[calls] setup failed: ${message}`);
  console.error("[calls] steps before the failure are already applied; fix the error and rerun");
  process.exitCode = 1;
});
