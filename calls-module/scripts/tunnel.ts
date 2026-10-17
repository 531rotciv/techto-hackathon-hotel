// Opens a public tunnel on a static ngrok domain to localhost:PORT, so
// ElevenLabs can reach the tool and post-call routes.
//   npx tsx <path>/calls-module/scripts/tunnel.ts
// It runs in its own process, so restarting your server never drops it.
import ngrok from "@ngrok/ngrok";
import type { Listener } from "@ngrok/ngrok";
import { config, hostFromDomain, requireConfig } from "../config.js";
import { TOOL_DEFINITIONS } from "../hooks.js";

const HEALTH_EVERY_MS = 30000;
const HEALTH_TIMEOUT_MS = 10000;

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// ngrok reports this as ERR_NGROK_334 when another session holds the domain.
function isDomainInUse(err: unknown): boolean {
  const message = errorMessage(err);
  return message.includes("ERR_NGROK_334") || message.includes("already online");
}

function readTunnelSettings(): { authtoken: string; host: string } {
  try {
    const authtoken = requireConfig("NGROK_AUTHTOKEN");
    const host = hostFromDomain(requireConfig("NGROK_DOMAIN"));
    return { authtoken, host };
  } catch (err) {
    console.error(errorMessage(err));
    console.error("[tunnel] set NGROK_AUTHTOKEN (dashboard.ngrok.com) and NGROK_DOMAIN (your static domain) in .env");
    process.exit(1);
  }
}

function printWebhookUrls(publicUrl: string): void {
  console.log(`[tunnel] public URL: ${publicUrl} -> http://localhost:${config.PORT}`);
  console.log("");
  console.log("Paste into ElevenLabs (scripts/setup-agent.ts does this for you):");
  TOOL_DEFINITIONS.forEach((definition, index) => {
    let label = "               ";
    if (index === 0) {
      label = "Server tools:  ";
    }
    console.log(`  ${label}${publicUrl}/elevenlabs/tools/${definition.name}`);
  });
  console.log(`  Post-call webhook: ${publicUrl}/elevenlabs/post-call`);
  console.log("");
}

// Any response means the tunnel reaches a server; the module itself adds no
// health route, so the host's own /health (if any) is not required.
async function checkReachable(publicUrl: string): Promise<void> {
  let reachable = false;
  try {
    // The header skips ngrok's browser warning page on free domains.
    const response = await fetch(`${publicUrl}/elevenlabs/tools/ping`, {
      method: "POST",
      headers: { "ngrok-skip-browser-warning": "1" },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    reachable = response.status === 401;
  } catch {
    reachable = false;
  }
  const time = new Date().toLocaleTimeString();
  if (reachable) {
    console.log(`[tunnel] ${time} tunnel ok, calls routes answering`);
  } else {
    console.log(`[tunnel] ${time} tunnel up but the calls routes aren't answering, is your server running?`);
  }
}

function closeOnExit(listener: Listener, timer: NodeJS.Timeout): void {
  let closing = false;
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    clearInterval(timer);
    console.log("\n[tunnel] closing the tunnel");
    try {
      await listener.close();
    } catch (err) {
      console.error(`[tunnel] close failed: ${errorMessage(err)}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const settings = readTunnelSettings();
  let listener: Listener;
  try {
    listener = await ngrok.forward({ addr: config.PORT, authtoken: settings.authtoken, domain: settings.host });
  } catch (err) {
    if (isDomainInUse(err)) {
      console.error("This domain is already online somewhere. Stop the other ngrok session or the other machine's tunnel, then try again.");
    } else {
      console.error(`[tunnel] could not open the tunnel: ${errorMessage(err)}`);
    }
    process.exit(1);
  }

  let publicUrl = `https://${settings.host}`;
  const listenerUrl = listener.url();
  if (listenerUrl !== null) {
    publicUrl = listenerUrl;
  }
  printWebhookUrls(publicUrl);
  await checkReachable(publicUrl);
  const timer = setInterval(() => {
    checkReachable(publicUrl).catch((err: unknown) => {
      console.error(`[tunnel] reachability check error: ${errorMessage(err)}`);
    });
  }, HEALTH_EVERY_MS);
  closeOnExit(listener, timer);
}

main().catch((err: unknown) => {
  console.error(`[tunnel] ${errorMessage(err)}`);
  process.exit(1);
});
