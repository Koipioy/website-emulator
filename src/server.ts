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
import {
  choicesResponse,
  isActCommand,
  type ActCommand,
  type ChoicesResponse,
} from "./api/commands.js";
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

function screenshotDataUrlToBuffer(dataUrl: string): Buffer | null {
  const match = /^data:image\/\w+;base64,(.+)$/.exec(dataUrl);
  if (!match?.[1]) return null;
  return Buffer.from(match[1], "base64");
}

type ElementActionType = "click" | "fill" | "select" | "check" | "press" | "scroll";

function resolveElementRef(element: number): string | null {
  const match = [...lastElements, ...lastButtons].find((el) => el.order === element);
  return match?.ref ?? null;
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

async function executeActCommand(
  cmd: ActCommand,
): Promise<{ success: boolean; error?: string; ref?: string }> {
  if (shuttingDown) {
    return { success: false, error: "Server is shutting down" };
  }

  if (cmd.action === "navigate") {
    try {
      await navigateToUrl(cmd.url);
      return { success: true };
    } catch (err) {
      return { success: false, error: formatUserError(err) };
    }
  }

  const page = session.getPage();
  if (!page) {
    return { success: false, error: "No active browser session" };
  }

  if (cmd.action === "scroll-up" || cmd.action === "scroll-down") {
    const result = await scrollPage(page, cmd.action === "scroll-up" ? "up" : "down");
    return { success: result.success, error: result.error, ref: result.ref };
  }

  if (!("element" in cmd)) {
    return { success: false, error: "Unknown command" };
  }

  const ref = resolveElementRef(cmd.element);
  if (!ref) {
    return { success: false, error: `Unknown element: ${cmd.element}` };
  }

  switch (cmd.action) {
    case "click":
      return performElementAction(ref, "click", {});
    case "scroll-into-view":
      return performElementAction(ref, "scroll", {});
    case "fill":
      return performElementAction(ref, "fill", { value: cmd.value });
    case "select":
      return performElementAction(ref, "select", { value: cmd.value });
    case "check":
      return performElementAction(ref, "check", { checked: cmd.checked });
    case "press":
      return performElementAction(ref, "press", { key: cmd.key });
    default:
      return { success: false, error: `Unknown action: ${(cmd as ActCommand & { action: string }).action}` };
  }
}

interface ActResponse extends ChoicesResponse {
  success: boolean;
  error?: string;
  ref?: string;
}

async function runAct(body: unknown): Promise<ActResponse> {
  if (!isActCommand(body)) {
    return {
      success: false,
      error: "Invalid command JSON",
      ...choicesResponse(lastSnapshot, lastSnapshot !== null),
    };
  }

  const result = await executeActCommand(body);
  if (!result.success) {
    return {
      success: false,
      error: result.error,
      ref: result.ref,
      ...choicesResponse(lastSnapshot, lastSnapshot !== null),
    };
  }

  if (body.action !== "navigate") {
    await pushElements();
  }

  return {
    success: true,
    ref: result.ref,
    ...choicesResponse(lastSnapshot, false),
  };
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

  app.get("/api/choices", async (req, res) => {
    try {
      if (!session.getPage()) {
        res.json(choicesResponse(null));
        return;
      }

      const result = await getPageSnapshot(wantsRefresh(req));
      if (!result) {
        res.json(choicesResponse(null));
        return;
      }

      const { snapshot, cached } = result;
      res.json(choicesResponse(snapshot, cached));
    } catch (err) {
      res.status(500).json({ error: formatUserError(err) });
    }
  });

  app.post("/api/act", async (req, res) => {
    try {
      const result = await runAct(req.body);

      if (!result.success && result.error === "No active browser session") {
        res.status(503).json(result);
        return;
      }

      if (
        !result.success &&
        (result.error === "Invalid command JSON" || result.error?.startsWith("Unknown"))
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

async function navigateToUrl(url: string): Promise<PageSnapshot> {
  if (shuttingDown) {
    throw new Error("Server is shutting down");
  }

  let target = url.trim();
  if (!target) {
    throw new Error("URL is required");
  }
  if (!/^https?:\/\//i.test(target)) {
    target = `https://${target}`;
  }

  cancelPendingRescan();
  stopPeriodicSync();
  await session.navigate(target, scheduleRescan);
  const page = session.getPage();
  if (!page) throw new Error("Failed to open page");

  const info = await fetchCurrentPageInfo();
  if (!info || !lastSnapshot) throw new Error("Failed to scan page");

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

  return lastSnapshot;
}

async function handleNavigate(ws: WebSocket, url: string): Promise<void> {
  if (shuttingDown) return;

  try {
    await navigateToUrl(url);
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
