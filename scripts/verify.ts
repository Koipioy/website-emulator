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

    send(ws, { type: "navigate", url: "https://example.com" });
    const elementsMsg = await nextMessage(ws, "elements", 45000);
    if (elementsMsg.type !== "elements") throw new Error("Expected elements message");

    const links = elementsMsg.elements.filter((e) => e.role === "link");
    if (links.length === 0) throw new Error("Expected at least one link on example.com");
    console.log(`✓ Scanned example.com — ${elementsMsg.elements.length} element(s), ${links.length} link(s)`);

    const linkRef = links[0]!.ref;
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
