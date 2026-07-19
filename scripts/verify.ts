/**
 * Integration smoke test for website-emulator server.
 * Run: node --import tsx scripts/verify.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
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
    if (!instructionsJson.systemPrompt?.includes("/api/screenshot")) {
      throw new Error("GET /instructions missing API documentation");
    }
    console.log("✓ GET /instructions returned system prompt");

    send(ws, { type: "navigate", url: "https://example.com" });
    const elementsMsg = await nextMessage(ws, "elements", 45000);
    if (elementsMsg.type !== "elements") throw new Error("Expected elements message");

    const links = elementsMsg.elements.filter((e) => e.role === "link");
    if (links.length === 0) throw new Error("Expected at least one visible link on example.com");
    if (!elementsMsg.screenshot?.startsWith("data:image/jpeg")) {
      throw new Error("Expected highlighted screenshot in elements message");
    }
    console.log(
      `✓ Scanned example.com — ${elementsMsg.elements.length} visible element(s), ${links.length} link(s), screenshot included`,
    );

    const elementsRes = await fetch(`${BASE}/api/elements`);
    if (!elementsRes.ok) throw new Error(`GET /api/elements failed: ${elementsRes.status}`);
    const elementsJson = (await elementsRes.json()) as {
      url: string;
      elements: Array<{ number?: number; ref: string; actions: Array<{ type: string }> }>;
    };
    if (!elementsJson.url.includes("example.com")) throw new Error("API elements missing page url");
    if (elementsJson.elements.length === 0) throw new Error("API elements list is empty");
    if (!elementsJson.elements[0]!.actions.some((action) => action.type === "click")) {
      throw new Error("API elements missing click action");
    }
    console.log(`✓ GET /api/elements returned ${elementsJson.elements.length} element(s)`);

    const screenshotRes = await fetch(`${BASE}/api/screenshot`);
    if (!screenshotRes.ok) throw new Error(`GET /api/screenshot failed: ${screenshotRes.status}`);
    const contentType = screenshotRes.headers.get("content-type");
    if (!contentType?.includes("image/jpeg")) {
      throw new Error(`Expected image/jpeg from /api/screenshot, got ${contentType}`);
    }
    const screenshotBytes = await screenshotRes.arrayBuffer();
    if (screenshotBytes.byteLength < 1000) {
      throw new Error("Screenshot response too small");
    }
    console.log(`✓ GET /api/screenshot returned ${screenshotBytes.byteLength} byte JPEG`);

    const linkRef = links[0]!.ref;
    const apiClickRes = await fetch(`${BASE}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: linkRef, action: "click" }),
    });
    if (!apiClickRes.ok) throw new Error(`POST /api/action failed: ${apiClickRes.status}`);
    const apiClickJson = (await apiClickRes.json()) as { ref: string; success: boolean; error?: string };
    if (!apiClickJson.success) {
      throw new Error(`POST /api/action click failed: ${apiClickJson.error ?? "unknown"}`);
    }
    console.log("✓ POST /api/action click succeeded");

    send(ws, { type: "click", ref: linkRef });
    const clickResult = await nextMessage(ws, "action_result", 15000);
    if (clickResult.type !== "action_result" || !clickResult.success) {
      throw new Error(`Click failed: ${clickResult.type === "action_result" ? clickResult.error : "unknown"}`);
    }
    console.log("✓ Click relayed successfully");

    const afterClick = await nextMessage(ws, "elements", 15000);
    if (afterClick.type !== "elements") throw new Error("Expected elements after click");
    console.log(`✓ Element list refreshed after click — ${afterClick.elements.length} element(s)`);

    send(ws, { type: "navigate", url: "https://httpbin.org/forms/post" });
    const formMsg = await nextMessage(ws, "elements", 45000);
    if (formMsg.type !== "elements") throw new Error("Expected form elements");
    const textboxes = formMsg.elements.filter((e) => e.role === "textbox");
    if (textboxes.length === 0) throw new Error("Expected textboxes on httpbin form");
    console.log(`✓ Scanned httpbin form — ${textboxes.length} textbox(es)`);

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

    const disconnectedElementsRes = await fetch(`${BASE}/api/elements`);
    if (disconnectedElementsRes.status !== 503) {
      throw new Error(`Expected 503 from /api/elements after disconnect, got ${disconnectedElementsRes.status}`);
    }
    console.log("✓ GET /api/elements returns 503 when disconnected");

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
