import http from "node:http";
import path from "node:path";
import { exec } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
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
  scrollElement,
  scrollPage,
  selectElement,
  type ActionResult,
} from "./browser/actions.js";
import { BrowserSession } from "./browser/session.js";
import { actionsForElement } from "./shared/element-actions.js";
import {
  type ClientMessage,
  type InteractableElement,
  type PopupScope,
  type ServerMessage,
  type SessionState,
  parseClientMessage,
} from "./shared/protocol.js";
import { formatUserError } from "./shared/errors.js";
import { buildInstructionsPrompt } from "./api/instructions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3000;
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
let lastButtons: InteractableElement[] = [];
let lastSnapshot: PageSnapshot | null = null;
let activeScan: ReturnType<typeof scanAndGetPageInfo> | null = null;

interface PageSnapshot {
  url: string;
  title: string;
  elements: InteractableElement[];
  buttons: InteractableElement[];
  screenshot?: string;
  popup: PopupScope | null;
}

function updateSnapshot(info: PageSnapshot): void {
  lastElements = info.elements;
  lastButtons = info.buttons;
  lastSnapshot = info;
}

function clearSnapshot(): void {
  lastElements = [];
  lastButtons = [];
  lastSnapshot = null;
}

function wantsRefresh(req: express.Request): boolean {
  const value = req.query.refresh;
  return value === "1" || value === "true";
}

function cancelPendingRescan(): void {
  if (rescanTimer) {
    clearTimeout(rescanTimer);
    rescanTimer = null;
  }
}

async function fetchCurrentPageInfo() {
  if (shuttingDown) {
    throw new Error("Server is shutting down");
  }

  const page = session.getPage();
  if (!page) {
    return null;
  }

  if (activeScan) {
    return activeScan;
  }

  activeScan = scanAndGetPageInfo(page)
    .then((info) => {
      updateSnapshot({
        url: info.url,
        title: info.title,
        elements: info.elements,
        buttons: info.buttons,
        screenshot: info.screenshot,
        popup: info.popup,
      });
      return info;
    })
    .finally(() => {
      activeScan = null;
    });

  return activeScan;
}

async function getPageSnapshot(
  forceRefresh = false,
): Promise<{ snapshot: PageSnapshot; cached: boolean } | null> {
  if (!session.getPage()) return null;
  if (!forceRefresh && lastSnapshot) {
    return { snapshot: lastSnapshot, cached: true };
  }

  const info = await fetchCurrentPageInfo();
  if (!info || !lastSnapshot) return null;
  return { snapshot: lastSnapshot, cached: false };
}

function serializeElement(el: InteractableElement) {
  return {
    number: el.order,
    ref: el.ref,
    role: el.role,
    label: el.label,
    value: el.value,
    checked: el.checked,
    href: el.href,
    disabled: el.disabled,
    inputType: el.inputType,
    options: el.options,
    bounds: el.bounds,
    actions: actionsForElement(el),
  };
}

function screenshotDataUrlToBuffer(dataUrl: string): Buffer | null {
  const match = /^data:image\/\w+;base64,(.+)$/.exec(dataUrl);
  if (!match?.[1]) return null;
  return Buffer.from(match[1], "base64");
}

type ElementActionType = "click" | "fill" | "select" | "check" | "press" | "scroll";

interface ApiActionRequest {
  ref?: string;
  id?: string;
  number?: number;
  action?: string;
  value?: string;
  checked?: boolean;
  key?: string;
}

function resolveElementRef(body: ApiActionRequest): string | null {
  if (typeof body.ref === "string" && body.ref.trim()) return body.ref.trim();
  if (typeof body.id === "string" && body.id.trim()) return body.id.trim();
  if (typeof body.number === "number") {
    const match = [...lastElements, ...lastButtons].find((el) => el.order === body.number);
    return match?.ref ?? null;
  }
  return null;
}

async function performElementAction(
  ref: string,
  action: ElementActionType,
  params: { value?: string; checked?: boolean; key?: string },
): Promise<ActionResult> {
  const page = session.getPage();
  if (!page) {
    return { ref, success: false, error: "No active browser session" };
  }

  switch (action) {
    case "click": {
      const point =
        lastElements.find((item) => item.ref === ref)?.point ??
        lastButtons.find((item) => item.ref === ref)?.point;
      return clickElement(page, ref, point);
    }
    case "fill":
      if (typeof params.value !== "string") {
        return { ref, success: false, error: "Missing required parameter: value" };
      }
      return fillElement(page, ref, params.value);
    case "select":
      if (typeof params.value !== "string") {
        return { ref, success: false, error: "Missing required parameter: value" };
      }
      return selectElement(page, ref, params.value);
    case "check":
      if (typeof params.checked !== "boolean") {
        return { ref, success: false, error: "Missing required parameter: checked" };
      }
      return checkElement(page, ref, params.checked);
    case "press":
      if (typeof params.key !== "string" || !params.key.trim()) {
        return { ref, success: false, error: "Missing required parameter: key" };
      }
      return pressElement(page, ref, params.key);
    case "scroll":
      return scrollElement(page, ref);
    default:
      return { ref, success: false, error: `Unknown action: ${action}` };
  }
}

async function runElementAction(body: ApiActionRequest): Promise<ActionResult> {
  if (shuttingDown) {
    return { ref: "", success: false, error: "Server is shutting down" };
  }

  const ref = resolveElementRef(body);
  if (!ref) {
    return { ref: "", success: false, error: "Element id is required (ref, id, or number)" };
  }

  if (!body.action || typeof body.action !== "string") {
    return { ref, success: false, error: "Action is required" };
  }

  const action = body.action as ElementActionType;
  const result = await performElementAction(ref, action, {
    value: body.value,
    checked: body.checked,
    key: body.key,
  });

  if (result.success && !shuttingDown) {
    await pushElements();
  }

  return result;
}

function registerApiRoutes(app: express.Express): void {
  app.use(express.json({ limit: "1mb" }));

  app.get("/instructions", (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    res.json({ systemPrompt: buildInstructionsPrompt(baseUrl) });
  });

  app.get("/api/screenshot", async (req, res) => {
    try {
      const result = await getPageSnapshot(wantsRefresh(req));
      if (!result) {
        res.status(503).json({ error: "No active browser session" });
        return;
      }

      const image = result.snapshot.screenshot
        ? screenshotDataUrlToBuffer(result.snapshot.screenshot)
        : null;
      if (!image) {
        res.status(500).json({ error: "Failed to capture screenshot" });
        return;
      }

      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      res.send(image);
    } catch (err) {
      res.status(500).json({ error: formatUserError(err) });
    }
  });

  app.get("/api/elements", async (req, res) => {
    try {
      const result = await getPageSnapshot(wantsRefresh(req));
      if (!result) {
        res.status(503).json({ error: "No active browser session" });
        return;
      }

      const { snapshot, cached } = result;
      res.json({
        url: snapshot.url,
        title: snapshot.title,
        elements: snapshot.elements.map(serializeElement),
        buttons: snapshot.buttons.map(serializeElement),
        cached,
      });
    } catch (err) {
      res.status(500).json({ error: formatUserError(err) });
    }
  });

  app.post("/api/action", async (req, res) => {
    try {
      const result = await runElementAction(req.body as ApiActionRequest);

      if (result.error === "No active browser session") {
        res.status(503).json(result);
        return;
      }

      if (
        !result.success &&
        (result.error?.includes("required") ||
          result.error?.includes("Unknown action") ||
          result.error === "Action is required" ||
          result.error === "Element id is required (ref, id, or number)")
      ) {
        res.status(400).json(result);
        return;
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: formatUserError(err) });
    }
  });
}

async function pushElements(): Promise<void> {
  if (shuttingDown) return;

  try {
    const info = await fetchCurrentPageInfo();
    if (!info) return;

    broadcast({
      type: "elements",
      elements: info.elements,
      buttons: info.buttons,
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
  }
}

function scheduleRescan(): void {
  if (shuttingDown) return;
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

    const info = await fetchCurrentPageInfo();
    if (!info) throw new Error("Failed to scan page");

    broadcast({
      type: "session",
      session: { connected: true, url: info.url, title: info.title },
    });
    broadcast({
      type: "elements",
      elements: info.elements,
      buttons: info.buttons,
      url: info.url,
      title: info.title,
      popup: info.popup,
      screenshot: info.screenshot,
    });
    startPeriodicSync();
  } catch (err) {
    if (shuttingDown) return;
    send(ws, {
      type: "error",
      message: formatUserError(err),
    });
  }
}

async function handleAction(
  ws: WebSocket,
  action: () => Promise<ActionResult>,
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
      clearSnapshot();
      broadcast({
        type: "session",
        session: { connected: false, url: "", title: "" },
      });
      broadcast({ type: "elements", elements: [], buttons: [], url: "", title: "", popup: null });
      break;

    case "refresh":
      await pushElements();
      break;

    case "click":
      await handleAction(
        ws,
        () => performElementAction(message.ref, "click", {}),
        message.ref,
      );
      break;

    case "fill":
      await handleAction(
        ws,
        () => performElementAction(message.ref, "fill", { value: message.value }),
        message.ref,
      );
      break;

    case "select":
      await handleAction(
        ws,
        () => performElementAction(message.ref, "select", { value: message.value }),
        message.ref,
      );
      break;

    case "check":
      await handleAction(
        ws,
        () => performElementAction(message.ref, "check", { checked: message.checked }),
        message.ref,
      );
      break;

    case "press":
      await handleAction(
        ws,
        () => performElementAction(message.ref, "press", { key: message.key }),
        message.ref,
      );
      break;

    case "scroll":
      await handleAction(
        ws,
        () => performElementAction(message.ref, "scroll", {}),
        message.ref,
      );
      break;

    case "scroll_page":
      await handleAction(
        ws,
        () => scrollPage(session.getPage()!, message.direction),
        "page",
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

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

async function resolvePort(): Promise<number> {
  if (process.env.PORT) {
    const port = Number(process.env.PORT);
    if (!isValidPort(port)) {
      throw new Error(`Invalid PORT environment variable: ${process.env.PORT}`);
    }
    return port;
  }

  if (!input.isTTY) return DEFAULT_PORT;

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = await rl.question(`Port to host on [${DEFAULT_PORT}]: `);
      const port = answer.trim() ? Number(answer) : DEFAULT_PORT;
      if (isValidPort(port)) return port;
      console.log("Enter a valid port number (1-65535).");
    }
  } finally {
    rl.close();
  }
}

function openBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;

  exec(command, (error) => {
    if (error) {
      console.error(`Could not open browser automatically: ${error.message}`);
      console.error(`Open this URL manually: ${url}`);
    }
  });
}

async function waitForEnterToOpen(url: string): Promise<void> {
  if (!input.isTTY) return;

  const rl = createInterface({ input, output });
  try {
    await rl.question(`Press Enter to open ${url} in your browser… `);
    openBrowser(url);
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const port = await resolvePort();
  const siteUrl = `http://${HOST}:${port}`;

  const app = express();
  registerApiRoutes(app);
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
          console.warn(`Port ${port} busy, retrying in 300ms...`);
          setTimeout(() => tryListen(attempt + 1), 300);
          return;
        }
        reject(err);
      });

      server.listen({ port, host: HOST, exclusive: false }, () => {
        server.removeAllListeners("error");
        console.log(`Website Emulator running at ${siteUrl}`);
        resolve();
      });
    };

    tryListen();
  });

  await waitForEnterToOpen(siteUrl);
}

void main();
