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
  type InteractableElement,
  type ServerMessage,
  type SessionState,
  parseClientMessage,
} from "./shared/protocol.js";
import { formatUserError } from "./shared/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const HOST = "127.0.0.1";
const IS_DEV = process.env.DEV === "1";
const SYNC_INTERVAL_MS = 3000;

const session = new BrowserSession();
const clients = new Set<WebSocket>();

let rescanTimer: ReturnType<typeof setTimeout> | null = null;
let syncInterval: ReturnType<typeof setInterval> | null = null;
let syncInProgress = false;
let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
let vite: ViteDevServer | null = null;
let shuttingDown = false;
let lastElements: InteractableElement[] = [];
let scanInProgress = false;

function cancelPendingRescan(): void {
  if (rescanTimer) {
    clearTimeout(rescanTimer);
    rescanTimer = null;
  }
}

async function pushElements(): Promise<void> {
  if (shuttingDown || scanInProgress) return;

  const page = session.getPage();
  if (!page) return;

  scanInProgress = true;
  try {
    const info = await scanAndGetPageInfo(page);
    lastElements = info.elements;
    broadcast({
      type: "elements",
      elements: info.elements,
      url: info.url,
      title: info.title,
      popup: info.popup,
      screenshot: info.screenshot,
    });
  } catch (err) {
    if (shuttingDown) return;
    broadcast({
      type: "error",
      message: formatUserError(err),
    });
  } finally {
    scanInProgress = false;
  }
}

function scheduleRescan(): void {
  if (shuttingDown || scanInProgress) return;
  cancelPendingRescan();
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    void pushElements();
  }, 300);
}

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

function stopPeriodicSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

function startPeriodicSync(): void {
  stopPeriodicSync();
  syncInterval = setInterval(() => {
    void syncOnce();
  }, SYNC_INTERVAL_MS);
}

async function syncOnce(): Promise<void> {
  if (shuttingDown || syncInProgress || !session.active) return;
  syncInProgress = true;
  try {
    await pushElements();
  } finally {
    syncInProgress = false;
  }
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
    cancelPendingRescan();
    stopPeriodicSync();
    await session.navigate(target, scheduleRescan);
    const page = session.getPage();
    if (!page) throw new Error("Failed to open page");

    scanInProgress = true;
    let info;
    try {
      info = await scanAndGetPageInfo(page);
    } finally {
      scanInProgress = false;
    }

    lastElements = info.elements;
    broadcast({
      type: "session",
      session: { connected: true, url: info.url, title: info.title },
    });
    broadcast({
      type: "elements",
      elements: info.elements,
      url: info.url,
      title: info.title,
      popup: info.popup,
      screenshot: info.screenshot,
    });
    startPeriodicSync();
  } catch (err) {
    if (shuttingDown) return;
    scanInProgress = false;
    send(ws, {
      type: "error",
      message: formatUserError(err),
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
      stopPeriodicSync();
      await session.close();
      broadcast({
        type: "session",
        session: { connected: false, url: "", title: "" },
      });
      broadcast({ type: "elements", elements: [], url: "", title: "", popup: null });
      break;

    case "refresh":
      await pushElements();
      break;

    case "click": {
      const point = lastElements.find((item) => item.ref === message.ref)?.point;
      await handleAction(
        ws,
        () => clickElement(session.getPage()!, message.ref, point),
        message.ref,
      );
      break;
    }

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

    const finish = () => resolve();
    const timer = setTimeout(finish, 500);
    httpServer.closeAllConnections?.();
    httpServer.close(() => {
      clearTimeout(timer);
      finish();
    });
  });
}

function closeWsServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!wss) {
      resolve();
      return;
    }

    const finish = () => resolve();
    const timer = setTimeout(finish, 500);
    wss.close(() => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function shutdown(signal?: string): Promise<void> {
  if (shuttingDown) {
    process.exit(0);
    return;
  }
  shuttingDown = true;

  const isDevRestart = IS_DEV && signal === "SIGTERM";
  const maxWait = isDevRestart ? 250 : 1500;
  const forceExit = setTimeout(() => process.exit(0), maxWait);

  try {
    if (rescanTimer) {
      clearTimeout(rescanTimer);
      rescanTimer = null;
    }
    stopPeriodicSync();

    closeWebSockets();

    await Promise.race([
      (async () => {
        if (isDevRestart) {
          await session.closeFast();
        } else {
          await session.close();
        }
        await Promise.all([closeWsServer(), closeHttpServer(), vite?.close()]);
      })(),
      new Promise((resolve) => setTimeout(resolve, Math.max(maxWait - 50, 50))),
    ]);
  } finally {
    clearTimeout(forceExit);
    process.exit(0);
  }
}

function registerShutdownHandlers(): void {
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

registerShutdownHandlers();

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

  await new Promise<void>((resolve, reject) => {
    const server = httpServer!;

    const tryListen = (attempt = 0): void => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && IS_DEV && attempt < 10) {
          console.warn(`Port ${PORT} busy, retrying in 300ms...`);
          setTimeout(() => tryListen(attempt + 1), 300);
          return;
        }
        reject(err);
      });

      server.listen({ port: PORT, host: HOST, exclusive: false }, () => {
        server.removeAllListeners("error");
        console.log(`Website Emulator running at http://${HOST}:${PORT}`);
        resolve();
      });
    };

    tryListen();
  });
}

void main();
