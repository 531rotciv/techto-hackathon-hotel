// Checks the ElevenLabs and Twilio setup without placing a call.
//   npx tsx <path>/calls-module/scripts/check.ts
import { config } from "../config.js";
import type { OptionalConfigKey } from "../config.js";
import { getAgent, listPhoneNumbers } from "../elevenlabs.js";
import type { ElevenLabsAgent } from "../elevenlabs.js";
import { DATA_COLLECTION_FIELDS, DEFAULT_SYSTEM_PROMPT, TOOL_DEFINITIONS } from "../hooks.js";
import { createTwilioClient } from "../twilio.js";

type Line = { ok: boolean; text: string };

function mark(ok: boolean): string {
  if (ok) {
    return "PASS";
  }
  return "FAIL";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// ---------- .env ----------

const KEYS: OptionalConfigKey[] = [
  "PUBLIC_URL",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_AGENT_ID",
  "ELEVENLABS_AGENT_PHONE_NUMBER_ID",
  "ELEVENLABS_WEBHOOK_SECRET",
  "ELEVENLABS_TOOL_SECRET",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
];

function checkEnv(): Line[] {
  return KEYS.map((key) => {
    const ok = config[key] !== undefined;
    let text = `${key} set`;
    if (ok === false) {
      text = `${key} missing`;
    }
    return { ok, text };
  });
}

// ---------- ElevenLabs agent ----------

function agentPrompt(agent: ElevenLabsAgent): { prompt: string; toolIds: string[]; builtIns: string[] } {
  let prompt = "";
  let toolIds: string[] = [];
  let builtIns: string[] = [];
  const conversation = agent.conversation_config;
  if (conversation === null || conversation === undefined) {
    return { prompt, toolIds, builtIns };
  }
  const agentConfig = conversation.agent;
  if (agentConfig === null || agentConfig === undefined || agentConfig.prompt === null || agentConfig.prompt === undefined) {
    return { prompt, toolIds, builtIns };
  }
  if (typeof agentConfig.prompt.prompt === "string") {
    prompt = agentConfig.prompt.prompt;
  }
  if (Array.isArray(agentConfig.prompt.tool_ids)) {
    toolIds = agentConfig.prompt.tool_ids;
  }
  const builtInTools = agentConfig.prompt.built_in_tools;
  if (builtInTools !== null && builtInTools !== undefined) {
    builtIns = Object.keys(builtInTools).filter((name) => builtInTools[name] !== null);
  }
  return { prompt, toolIds, builtIns };
}

// Newer agents list data collection items without their names, so only the
// legacy map can confirm names; the count of newer items is reported too.
function dataCollectionIds(agent: ElevenLabsAgent): string[] {
  const settings = agent.platform_settings;
  if (settings === null || settings === undefined || settings.data_collection === null || settings.data_collection === undefined) {
    return [];
  }
  return Object.keys(settings.data_collection);
}

async function checkAgent(): Promise<Line[]> {
  if (config.ELEVENLABS_API_KEY === undefined || config.ELEVENLABS_AGENT_ID === undefined) {
    return [{ ok: false, text: "ElevenLabs agent not checked: API key or agent id missing" }];
  }
  let agent: ElevenLabsAgent;
  try {
    agent = await getAgent(config.ELEVENLABS_AGENT_ID);
  } catch (err) {
    return [{ ok: false, text: `ElevenLabs agent: ${errorMessage(err)}` }];
  }
  const details = agentPrompt(agent);
  const ids = new Set(dataCollectionIds(agent));
  let promptNote = "";
  if (details.prompt.trim() !== DEFAULT_SYSTEM_PROMPT.trim()) {
    promptNote = ", differs from the default, fine if it's yours";
  }
  const lines: Line[] = [
    { ok: true, text: `ElevenLabs key works, agent "${agent.name}" found` },
    {
      ok: details.prompt.trim() !== "",
      text: `system prompt set (${details.prompt.length} chars${promptNote})`,
    },
    { ok: details.toolIds.length >= TOOL_DEFINITIONS.length, text: `${details.toolIds.length} server tools attached (expect ${TOOL_DEFINITIONS.length})` },
    { ok: details.builtIns.includes("end_call"), text: "End call tool attached" },
  ];
  for (const field of DATA_COLLECTION_FIELDS) {
    lines.push({ ok: ids.has(field.identifier), text: `price field ${field.identifier}` });
  }
  return lines;
}

// ---------- phone number ----------

async function checkPhoneNumber(): Promise<Line[]> {
  if (config.ELEVENLABS_API_KEY === undefined) {
    return [];
  }
  let numbers: Awaited<ReturnType<typeof listPhoneNumbers>>;
  try {
    numbers = await listPhoneNumbers();
  } catch (err) {
    return [{ ok: false, text: `ElevenLabs phone numbers: ${errorMessage(err)}` }];
  }
  const wanted = config.ELEVENLABS_AGENT_PHONE_NUMBER_ID;
  const match = numbers.find((number) => number.phone_number_id === wanted);
  if (match === undefined) {
    return [{ ok: false, text: `ELEVENLABS_AGENT_PHONE_NUMBER_ID matches none of the ${numbers.length} imported number(s). Import a Twilio number and copy its phnum_ id.` }];
  }
  let assigned = false;
  if (match.assigned_agent !== null && match.assigned_agent !== undefined) {
    assigned = match.assigned_agent.agent_id === config.ELEVENLABS_AGENT_ID;
  }
  return [
    { ok: true, text: `phone number ${match.phone_number} imported (${match.provider})` },
    { ok: assigned, text: "phone number assigned to this agent" },
  ];
}

// ---------- Twilio ----------

async function checkTwilio(): Promise<Line[]> {
  if (config.TWILIO_ACCOUNT_SID === undefined || config.TWILIO_API_KEY_SID === undefined || config.TWILIO_API_KEY_SECRET === undefined) {
    return [{ ok: false, text: "Twilio not checked: keys missing (only needed to end calls that overrun)" }];
  }
  try {
    const client = createTwilioClient();
    const numbers = await client.incomingPhoneNumbers.list({ limit: 20 });
    return [
      { ok: true, text: "Twilio credentials work" },
      { ok: numbers.length > 0, text: `${numbers.length} phone number(s) on the Twilio account` },
    ];
  } catch (err) {
    return [{ ok: false, text: `Twilio: ${errorMessage(err)}` }];
  }
}

async function main(): Promise<void> {
  const sections: [string, Line[]][] = [
    [".env", checkEnv()],
    ["ElevenLabs agent", await checkAgent()],
    ["ElevenLabs phone number", await checkPhoneNumber()],
    ["Twilio", await checkTwilio()],
  ];
  let allOk = true;
  for (const [title, lines] of sections) {
    console.log(`\n${title}`);
    for (const line of lines) {
      console.log(`  ${mark(line.ok)}  ${line.text}`);
      if (line.ok === false) {
        allOk = false;
      }
    }
  }
  if (allOk === false) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`[calls] check failed: ${errorMessage(err)}`);
  process.exitCode = 1;
});
