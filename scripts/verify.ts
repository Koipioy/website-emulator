/**
 * Integration smoke test for website-emulator server.
 * Run: node --import tsx scripts/verify.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import type { ServerMessage } from "../src/shared/protocol.js";

const HOST = "127.0.0.1";
const PORT = 3000;
const BASE = `http://${HOST}:${PORT}`;
const WS_URL = `ws://${HOST}:${PORT}/ws`;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      // retry
    }
    await wait(250);
  }
  throw new Error("Server did not start in time");
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket, type?: string, timeoutMs = 30000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type ?? "message"}`)), timeoutMs);

    const handler = (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as ServerMessage;
        if (!type || msg.type === type) {
          clearTimeout(timer);
          ws.off("message", handler);
          resolve(msg);
        }
      } catch (err) {
        clearTimeout(timer);
        ws.off("message", handler);
        reject(err);
      }
    };

    ws.on("message", handler);
  });
}

function send(ws: WebSocket, msg: object): void {
  ws.send(JSON.stringify(msg));
}

async function runTests(): Promise<void> {
  let serverProc: ChildProcess | null = null;
  const serverLogs: string[] = [];

  try {
    try {
      const { execSync } = await import("node:child_process");
      execSync("fuser -k 3000/tcp 2>/dev/null", { stdio: "ignore" });
      await wait(300);
    } catch {
      // port may already be free
    }

    serverProc = spawn("node", ["dist/server.js"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HEADLESS: "1" },
    });

    serverProc.stdout?.on("data", (chunk) => serverLogs.push(chunk.toString()));
    serverProc.stderr?.on("data", (chunk) => serverLogs.push(chunk.toString()));

    await waitForServer();
    console.log("✓ Server started");

    const ws = await connectWs();
    const sessionMsg = await nextMessage(ws, "session");
    if (sessionMsg.type !== "session" || sessionMsg.session.connected) {
      throw new Error("Expected disconnected session on connect");
    }
    console.log("✓ WebSocket connected");

    const instructionsRes = await fetch(`${BASE}/instructions`);
    if (!instructionsRes.ok) throw new Error(`GET /instructions failed: ${instructionsRes.status}`);
    const instructionsJson = (await instructionsRes.json()) as { systemPrompt?: string };
    if (!instructionsJson.systemPrompt?.includes("/api/state")) {
      throw new Error("GET /instructions missing API documentation");
    }
    console.log("✓ GET /instructions returned system prompt");

    const noSessionChoicesRes = await fetch(`${BASE}/api/choices`);
    if (!noSessionChoicesRes.ok) throw new Error(`GET /api/choices failed: ${noSessionChoicesRes.status}`);
    const noSessionChoices = (await noSessionChoicesRes.json()) as { choices: Array<{ action: string }> };
    if (!noSessionChoices.choices.some((choice) => choice.action === "navigate")) {
      throw new Error("GET /api/choices without session should include navigate");
    }
    console.log("✓ GET /api/choices without session lists navigate");

    const noSessionStateRes = await fetch(`${BASE}/api/state`);
    if (!noSessionStateRes.ok) throw new Error(`GET /api/state failed: ${noSessionStateRes.status}`);
    const noSessionState = (await noSessionStateRes.json()) as {
      elements: unknown[];
      choices: Array<{ action: string }>;
    };
    if (noSessionState.elements.length !== 0) {
      throw new Error("GET /api/state without session should return no elements");
    }
    if (!noSessionState.choices.some((choice) => choice.action === "navigate")) {
      throw new Error("GET /api/state without session should include navigate");
    }
    console.log("✓ GET /api/state without session returns navigate choice");

    const emptyNavPromise = nextMessage(ws, "elements", 15000);
    const navigateRes = await fetch(`${BASE}/api/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "navigate", url: "https://example.com" }),
    });
    if (!navigateRes.ok) throw new Error(`POST /api/act navigate failed: ${navigateRes.status}`);
    const navigateJson = (await navigateRes.json()) as {
      success: boolean;
      url: string;
      choices: Array<{ action: string; id?: number }>;
    };
    if (!navigateJson.success || !navigateJson.url.includes("example.com")) {
      throw new Error("POST /api/act navigate did not open example.com");
    }
    console.log(`✓ POST /api/act navigate opened example.com — ${navigateJson.choices.length} choice(s)`);

    // Navigate no longer scans; drain the empty elements broadcast.
    const emptyAfterNav = await emptyNavPromise;
    if (emptyAfterNav.type !== "elements") throw new Error("Expected elements message after navigate");
    if (emptyAfterNav.elements.length !== 0) {
      throw new Error("Navigate should not auto-scan elements");
    }
    console.log("✓ Navigate did not auto-scan elements");

    const stateElementsPromise = nextMessage(ws, "elements", 15000);
    const stateRes = await fetch(`${BASE}/api/state`);
    if (!stateRes.ok) throw new Error(`GET /api/state failed: ${stateRes.status}`);
    const stateJson = (await stateRes.json()) as {
      url: string;
      title: string;
      screenshot?: string;
      elements: Array<{ id?: number; description: string; actions: unknown[] }>;
      buttons: unknown[];
      choices: Array<{ action: string; id?: number }>;
      cached: boolean;
    };
    if (!stateJson.url.includes("example.com")) throw new Error("API state missing page url");
    if (!stateJson.screenshot || !path.isAbsolute(stateJson.screenshot)) {
      throw new Error("API state missing absolute screenshot path");
    }
    await access(stateJson.screenshot);
    if (stateJson.elements.length === 0) throw new Error("API state returned no elements");
    if (!stateJson.elements.some((el) => el.id != null && el.description && el.actions.length > 0)) {
      throw new Error("API state elements missing id/description/actions");
    }
    if (stateJson.cached !== false) throw new Error("API state should always rescan (cached=false)");
    if (stateJson.choices.length === 0) throw new Error("API state returned no choices");
    console.log(
      `✓ GET /api/state returned ${stateJson.elements.length} element(s), ${stateJson.choices.length} choice(s)`,
    );

    const elementsMsg = await stateElementsPromise;
    if (elementsMsg.type !== "elements") throw new Error("Expected elements broadcast from /api/state");
    const links = elementsMsg.elements.filter((e) => e.role === "link");
    if (links.length === 0) throw new Error("Expected at least one visible link on example.com");
    if (!elementsMsg.screenshot || !path.isAbsolute(elementsMsg.screenshot)) {
      throw new Error("Expected absolute screenshot path in elements message");
    }
    await access(elementsMsg.screenshot);
    console.log(
      `✓ WebSocket received scan from /api/state — ${elementsMsg.elements.length} visible element(s), ${links.length} link(s)`,
    );

    const choicesRes = await fetch(`${BASE}/api/choices`);
    if (!choicesRes.ok) throw new Error(`GET /api/choices failed: ${choicesRes.status}`);
    const choicesJson = (await choicesRes.json()) as {
      url: string;
      choices: Array<{ action: string; id?: number }>;
    };
    if (!choicesJson.url.includes("example.com")) throw new Error("API choices missing page url");
    if (!choicesJson.choices.some((choice) => choice.action === "scroll-down")) {
      throw new Error("API choices missing scroll-down");
    }
    console.log(`✓ GET /api/choices returned ${choicesJson.choices.length} command(s)`);

    const screenshotRes = await fetch(`${BASE}/api/screenshot`);
    if (!screenshotRes.ok) throw new Error(`GET /api/screenshot failed: ${screenshotRes.status}`);
    const contentType = screenshotRes.headers.get("content-type");
    if (!contentType?.includes("application/json")) {
      throw new Error(`Expected application/json from /api/screenshot, got ${contentType}`);
    }
    const screenshotJson = (await screenshotRes.json()) as { screenshot?: string };
    if (!screenshotJson.screenshot || !path.isAbsolute(screenshotJson.screenshot)) {
      throw new Error("GET /api/screenshot missing absolute screenshot path");
    }
    await access(screenshotJson.screenshot);
    console.log(`✓ GET /api/screenshot returned path ${screenshotJson.screenshot}`);

    const clickCommand = choicesJson.choices.find(
      (choice) => choice.action === "click" && choice.id != null,
    );
    if (!clickCommand?.id) throw new Error("API choices missing click command");

    const apiClickRes = await fetch(`${BASE}/api/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: clickCommand.id, action: "click" }),
    });
    if (!apiClickRes.ok) throw new Error(`POST /api/act failed: ${apiClickRes.status}`);
    const apiClickJson = (await apiClickRes.json()) as {
      success: boolean;
      choices: unknown[];
      error?: string;
    };
    if (!apiClickJson.success) {
      throw new Error(`POST /api/act click failed: ${apiClickJson.error ?? "unknown"}`);
    }
    console.log("✓ POST /api/act click succeeded without auto-rescan");

    send(ws, { type: "click", ref: links[0]!.ref });
    const clickResult = await nextMessage(ws, "action_result", 15000);
    if (clickResult.type !== "action_result" || !clickResult.success) {
      throw new Error(`Click failed: ${clickResult.type === "action_result" ? clickResult.error : "unknown"}`);
    }
    console.log("✓ Click relayed successfully");

    const afterRefreshPromise = nextMessage(ws, "elements", 15000);
    send(ws, { type: "refresh" });
    const afterRefresh = await afterRefreshPromise;
    if (afterRefresh.type !== "elements") throw new Error("Expected elements after refresh");
    console.log(`✓ WS refresh rescanned — ${afterRefresh.elements.length} element(s)`);

    const emptyFormPromise = nextMessage(ws, "elements", 45000);
    send(ws, { type: "navigate", url: "https://httpbin.org/forms/post" });
    const emptyForm = await emptyFormPromise;
    if (emptyForm.type !== "elements") throw new Error("Expected elements after form navigate");
    const formMsgPromise = nextMessage(ws, "elements", 45000);
    send(ws, { type: "refresh" });
    const formMsg = await formMsgPromise;
    if (formMsg.type !== "elements") throw new Error("Expected form elements after refresh");
    const textboxes = formMsg.elements.filter((e) => e.role === "textbox");
    if (textboxes.length === 0) throw new Error("Expected textboxes on httpbin form");
    console.log(`✓ Scanned httpbin form via refresh — ${textboxes.length} textbox(es)`);

    const custname = textboxes.find((e) => e.label.toLowerCase().includes("custname")) ?? textboxes[0]!;
    send(ws, { type: "fill", ref: custname.ref, value: "Test User" });
    const fillResult = await nextMessage(ws, "action_result", 15000);
    if (fillResult.type !== "action_result" || !fillResult.success) {
      throw new Error(`Fill failed: ${fillResult.type === "action_result" ? fillResult.error : "unknown"}`);
    }
    console.log("✓ Fill relayed successfully");

    send(ws, { type: "disconnect" });
    const disconnectSession = await nextMessage(ws, "session", 10000);
    if (disconnectSession.type !== "session" || disconnectSession.session.connected) {
      throw new Error("Expected disconnected session after disconnect");
    }
    console.log("✓ Disconnect closed browser session");

    const disconnectedChoicesRes = await fetch(`${BASE}/api/choices`);
    if (!disconnectedChoicesRes.ok) throw new Error(`GET /api/choices failed after disconnect`);
    const disconnectedChoices = (await disconnectedChoicesRes.json()) as { choices: unknown[] };
    if (disconnectedChoices.choices.length === 0) {
      throw new Error("Expected navigate-only choices after disconnect");
    }
    console.log("✓ GET /api/choices returns navigate command when disconnected");

    ws.close();
    console.log("\nAll verification checks passed.");
  } finally {
    if (serverProc) {
      serverProc.kill("SIGTERM");
      await wait(500);
      if (!serverProc.killed) serverProc.kill("SIGKILL");
    }
  }
}

runTests().catch((err) => {
  console.error("\nVerification failed:", err);
  process.exit(1);
});
