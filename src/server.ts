import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import {
  checkElement,
  clickElement,
  fillElement,
  pressElement,
  scanAndGetPageInfo,
  selectElement,
} from "./browser/actions.js";
import { BrowserSession } from "./browser/session.js";
import {
  type ClientMessage,
  type ServerMessage,
  type SessionState,
  parseClientMessage,
} from "./shared/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const HOST = "127.0.0.1";
const IS_DEV = process.env.DEV === "1";

const session = new BrowserSession();
const clients = new Set<WebSocket>();

let rescanTimer: ReturnType<typeof setTimeout> | null = null;
let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
let vite: ViteDevServer | null = null;
let shuttingDown = false;

function broadcast(message: ServerMessage): void {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

function getSessionState(): SessionState {
  const page = session.getPage();
  return {
    connected: session.active,
    url: page?.url() ?? "",
    title: "",
  };
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

async function pushElements(): Promise<void> {
  if (shuttingDown) return;

  const page = session.getPage();
  if (!page) return;

  try {
    const info = await scanAndGetPageInfo(page);
    broadcast({
      type: "elements",
      elements: info.elements,
      url: info.url,
      title: info.title,
    });
  } catch (err) {
    if (shuttingDown) return;
    broadcast({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function scheduleRescan(): void {
  if (shuttingDown) return;
  if (rescanTimer) clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    void pushElements();
  }, 300);
}

async function handleNavigate(ws: WebSocket, url: string): Promise<void> {
  if (shuttingDown) return;

  let target = url.trim();
  if (!target) {
    send(ws, { type: "error", message: "URL is required" });
    return;
  }
  if (!/^https?:\/\//i.test(target)) {
    target = `https://${target}`;
  }

  try {
    await session.navigate(target, scheduleRescan);
    const page = session.getPage();
    if (!page) throw new Error("Failed to open page");

    const info = await scanAndGetPageInfo(page);
    broadcast({
      type: "session",
      session: { connected: true, url: info.url, title: info.title },
    });
    broadcast({
      type: "elements",
      elements: info.elements,
      url: info.url,
      title: info.title,
    });
  } catch (err) {
    if (shuttingDown) return;
    send(ws, {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleAction(
  ws: WebSocket,
  action: () => Promise<{ ref: string; success: boolean; error?: string }>,
  ref: string,
): Promise<void> {
  if (shuttingDown) return;

  const page = session.getPage();
  if (!page) {
    send(ws, { type: "error", message: "No active browser session" });
    return;
  }

  const result = await action();
  if (shuttingDown) return;

  send(ws, { type: "action_result", ...result });

  if (result.success) {
    await pushElements();
  }
}

async function handleClientMessage(ws: WebSocket, raw: string): Promise<void> {
  if (shuttingDown) return;

  let message: ClientMessage;
  try {
    message = parseClientMessage(raw);
  } catch {
    send(ws, { type: "error", message: "Invalid message format" });
    return;
  }

  switch (message.type) {
    case "navigate":
      await handleNavigate(ws, message.url);
      break;

    case "disconnect":
      await session.close();
      broadcast({
        type: "session",
        session: { connected: false, url: "", title: "" },
      });
      broadcast({ type: "elements", elements: [], url: "", title: "" });
      break;

    case "refresh":
      await pushElements();
      break;

    case "click":
      await handleAction(ws, () => clickElement(session.getPage()!, message.ref), message.ref);
      break;

    case "fill":
      await handleAction(
        ws,
        () => fillElement(session.getPage()!, message.ref, message.value),
        message.ref,
      );
      break;

    case "select":
      await handleAction(
        ws,
        () => selectElement(session.getPage()!, message.ref, message.value),
        message.ref,
      );
      break;

    case "check":
      await handleAction(
        ws,
        () => checkElement(session.getPage()!, message.ref, message.checked),
        message.ref,
      );
      break;

    case "press":
      await handleAction(
        ws,
        () => pressElement(session.getPage()!, message.ref, message.key),
        message.ref,
      );
      break;

    default:
      send(ws, { type: "error", message: `Unknown message type` });
  }
}

function closeWebSockets(): void {
  for (const ws of clients) {
    ws.terminate();
  }
  clients.clear();
}

function closeHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!httpServer) {
      resolve();
      return;
    }

    httpServer.closeAllConnections?.();
    httpServer.close(() => resolve());
  });
}

function closeWsServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!wss) {
      resolve();
      return;
    }

    wss.close(() => resolve());
  });
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  if (rescanTimer) {
    clearTimeout(rescanTimer);
    rescanTimer = null;
  }

  closeWebSockets();
  await session.close();
  await closeWsServer();
  await closeHttpServer();
  await vite?.close();

  process.exit(0);
}

async function main(): Promise<void> {
  const app = express();
  httpServer = http.createServer(app);
  wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws) => {
    clients.add(ws);
    send(ws, { type: "session", session: getSessionState() });

    ws.on("message", (data) => {
      void handleClientMessage(ws, data.toString());
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  if (IS_DEV) {
    vite = await createViteServer({
      configFile: path.resolve(__dirname, "../vite.config.ts"),
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const clientDir = path.resolve(__dirname, "../dist/client");
    app.use(express.static(clientDir));
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }

  await new Promise<void>((resolve) => {
    httpServer!.listen(PORT, HOST, () => {
      console.log(`Website Emulator running at http://${HOST}:${PORT}`);
      resolve();
    });
  });

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
