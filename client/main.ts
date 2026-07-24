import type {
  InteractableElement,
  ServerMessage,
  SessionState,
} from "../src/shared/protocol";

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

const urlInput = document.getElementById("url-input") as HTMLInputElement;
const navForm = document.getElementById("nav-form") as HTMLFormElement;
const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement;
const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement;
const getStateBtn = document.getElementById("get-state-btn") as HTMLButtonElement;
const scrollUpBtn = document.getElementById("scroll-up-btn") as HTMLButtonElement;
const scrollDownBtn = document.getElementById("scroll-down-btn") as HTMLButtonElement;
const disconnectBtn = document.getElementById("disconnect-btn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const buttonsSection = document.getElementById("buttons-section") as HTMLElement;
const elementsEl = document.getElementById("elements") as HTMLElement;
const screenshotSection = document.getElementById("screenshot-section") as HTMLElement;
const screenshotPath = document.getElementById("screenshot-path") as HTMLElement;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let hasConnectedOnce = false;
let session: SessionState = { connected: false, url: "", title: "" };
let elements: InteractableElement[] = [];
let buttons: InteractableElement[] = [];
let elementsSnapshot = "";
let buttonsSnapshot = "";
let lastAction = "";

function send(message: object): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function setStatus(text: string, kind: "info" | "error" | "success" = "info"): void {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

function updateControls(): void {
  const connected = session.connected;
  refreshBtn.disabled = !connected;
  getStateBtn.disabled = !connected;
  scrollUpBtn.disabled = !connected;
  scrollDownBtn.disabled = !connected;
  disconnectBtn.disabled = !connected;
  connectBtn.textContent = connected ? "Reconnect" : "Connect";
}

function updateScreenshot(screenshot?: string): void {
  if (session.connected && screenshot) {
    screenshotSection.classList.remove("hidden");
    screenshotPath.textContent = screenshot;
    return;
  }

  screenshotSection.classList.add("hidden");
  screenshotPath.textContent = "";
}

function renderButtons(): void {
  buttonsSection.innerHTML = "";

  if (!session.connected) {
    buttonsSection.classList.add("hidden");
    return;
  }

  buttonsSection.classList.remove("hidden");

  const banner = document.createElement("div");
  banner.className = "list-banner buttons-banner";
  banner.textContent = `Visible buttons on screen (${buttons.length})`;
  buttonsSection.appendChild(banner);

  if (buttons.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No visible buttons on screen.";
    buttonsSection.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "tab-list";

  for (const btn of buttons) {
    list.appendChild(renderButtonCard(btn));
  }

  buttonsSection.appendChild(list);
}

function renderButtonCard(el: InteractableElement): HTMLElement {
  const card = document.createElement("article");
  card.className = "card button-card";
  if (el.disabled) card.classList.add("disabled");

  const header = document.createElement("div");
  header.className = "card-header";

  const orderBadge = document.createElement("span");
  orderBadge.className = "tab-order";
  orderBadge.textContent = `#${el.order ?? "?"}`;

  const title = document.createElement("div");
  title.className = "card-title";
  title.innerHTML = `<span class="ref">${el.ref}</span><span class="label">${escapeHtml(el.label)}</span>`;

  header.append(orderBadge, title);
  card.appendChild(header);

  const controls = document.createElement("div");
  controls.className = "card-controls";
  controls.append(
    actionButton("Click", () => send({ type: "click", ref: el.ref }), el.disabled),
    actionButton("Scroll", () => send({ type: "scroll", ref: el.ref }), el.disabled),
  );
  card.appendChild(controls);

  return card;
}

function renderElements(): void {
  const focusRef =
    document.activeElement?.closest(".card")?.querySelector(".ref")?.textContent ?? null;
  const draftValue =
    focusRef && document.activeElement instanceof HTMLInputElement
      ? document.activeElement.value
      : null;

  elementsEl.innerHTML = "";

  if (!session.connected) {
    elementsEl.innerHTML = `<p class="empty">Enter a URL and click Connect to list visible tabbable elements.</p>`;
    return;
  }

  const banner = document.createElement("div");
  banner.className = "list-banner";
  banner.textContent = "Visible tabbable elements (on screen) — tab order";
  elementsEl.appendChild(banner);

  if (elements.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No visible tabbable elements on screen.";
    elementsEl.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "tab-list";

  const sorted = [...elements].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const el of sorted) {
    list.appendChild(renderElementCard(el));
  }

  elementsEl.appendChild(list);

  if (focusRef && draftValue !== null) {
    const card = [...elementsEl.querySelectorAll(".card")].find(
      (node) => node.querySelector(".ref")?.textContent === focusRef,
    );
    const input = card?.querySelector(".text-input");
    if (input instanceof HTMLInputElement) {
      input.value = draftValue;
      input.focus();
    }
  }
}

function renderElementCard(el: InteractableElement): HTMLElement {
  const card = document.createElement("article");
  card.className = "card";
  if (el.disabled) card.classList.add("disabled");

  const header = document.createElement("div");
  header.className = "card-header";

  const orderBadge = document.createElement("span");
  orderBadge.className = "tab-order";
  orderBadge.textContent = `#${el.order ?? "?"}`;

  const metaBadges = document.createElement("div");
  metaBadges.className = "card-badges";

  const roleBadge = document.createElement("span");
  roleBadge.className = "role-badge";
  roleBadge.textContent = el.role;

  const tabIndexBadge = document.createElement("span");
  tabIndexBadge.className = "tabindex-badge";
  tabIndexBadge.textContent = `tabindex=${el.tabIndex ?? 0}`;

  metaBadges.append(roleBadge, tabIndexBadge);

  const title = document.createElement("div");
  title.className = "card-title";
  title.innerHTML = `<span class="ref">${el.ref}</span><span class="label">${escapeHtml(el.label)}</span>`;

  header.append(orderBadge, title, metaBadges);
  card.appendChild(header);

  if (el.href) {
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = el.href;
    card.appendChild(meta);
  }

  const controls = document.createElement("div");
  controls.className = "card-controls";

  const scrollBtn = actionButton("Scroll", () => send({ type: "scroll", ref: el.ref }), el.disabled);

  switch (el.role) {
    case "button":
    case "link":
      controls.append(
        actionButton("Click", () => send({ type: "click", ref: el.ref }), el.disabled),
        scrollBtn,
      );
      break;

    case "textbox": {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "text-input";
      input.value = el.value ?? "";
      input.placeholder = el.inputType ? `type: ${el.inputType}` : "Enter value";
      input.disabled = !!el.disabled;

      const fillBtn = actionButton("Fill", () => {
        send({ type: "fill", ref: el.ref, value: input.value });
      }, el.disabled);

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          send({ type: "press", ref: el.ref, key: "Enter" });
        }
      });

      controls.append(input, fillBtn, scrollBtn);
      break;
    }

    case "checkbox":
    case "radio": {
      const toggle = document.createElement("label");
      toggle.className = "toggle";
      const input = document.createElement("input");
      input.type = el.role === "radio" ? "radio" : "checkbox";
      input.checked = el.checked ?? false;
      input.disabled = !!el.disabled;
      input.addEventListener("change", () => {
        send({ type: "check", ref: el.ref, checked: input.checked });
      });
      toggle.append(input, document.createTextNode(el.checked ? "Checked" : "Unchecked"));
      controls.append(toggle, scrollBtn);
      break;
    }

    case "select": {
      const select = document.createElement("select");
      select.disabled = !!el.disabled;
      for (const opt of el.options ?? []) {
        const option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        if (opt.value === el.value) option.selected = true;
        select.appendChild(option);
      }
      const selectBtn = actionButton("Select", () => {
        send({ type: "select", ref: el.ref, value: select.value });
      }, el.disabled);
      controls.append(select, selectBtn, scrollBtn);
      break;
    }

    case "combobox": {
      if (el.options && el.options.length > 0) {
        const select = document.createElement("select");
        select.disabled = !!el.disabled;
        for (const opt of el.options) {
          const option = document.createElement("option");
          option.value = opt.value;
          option.textContent = opt.label;
          if (opt.value === el.value) option.selected = true;
          select.appendChild(option);
        }
        const selectBtn = actionButton("Select", () => {
          send({ type: "select", ref: el.ref, value: select.value });
        }, el.disabled);
        controls.append(select, selectBtn, scrollBtn);
      } else {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "text-input";
        input.value = el.value ?? "";
        input.placeholder = "Enter value";
        input.disabled = !!el.disabled;

        const fillBtn = actionButton("Fill", () => {
          send({ type: "fill", ref: el.ref, value: input.value });
        }, el.disabled);

        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            send({ type: "press", ref: el.ref, key: "Enter" });
          }
        });

        controls.append(input, fillBtn, scrollBtn);
      }
      break;
    }

    default:
      controls.append(
        actionButton("Click", () => send({ type: "click", ref: el.ref }), el.disabled),
        scrollBtn,
      );
  }

  card.appendChild(controls);
  return card;
}

function actionButton(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "action-btn";
  btn.textContent = label;
  btn.disabled = disabled;
  btn.addEventListener("click", onClick);
  return btn;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case "session":
      session = message.session;
      updateControls();
      if (session.connected && session.url) {
        urlInput.value = session.url;
      }
      if (!session.connected) {
        updateScreenshot();
      }
      renderButtons();
      renderElements();
      break;

    case "elements": {
      const snapshot = JSON.stringify(message.elements);
      const buttonsSnap = JSON.stringify(message.buttons ?? []);
      const pageChanged = message.url !== session.url || message.title !== session.title;
      elements = message.elements;
      buttons = message.buttons ?? [];
      session = { ...session, connected: true, url: message.url, title: message.title };
      updateControls();
      updateScreenshot(message.screenshot);
      setStatus(
        `${message.title || "Untitled"} — ${message.url} — ${message.elements.length} tabbable, ${buttons.length} button(s) — auto-sync every 3s${lastAction ? ` — ${lastAction}` : ""}`,
      );
      if (snapshot !== elementsSnapshot || buttonsSnap !== buttonsSnapshot || pageChanged) {
        elementsSnapshot = snapshot;
        buttonsSnapshot = buttonsSnap;
        renderButtons();
        renderElements();
      }
      break;
    }

    case "action_result":
      lastAction = message.success
        ? `Last action on ${message.ref}: OK`
        : `Last action on ${message.ref} failed: ${message.error}`;
      setStatus(lastAction, message.success ? "success" : "error");
      break;

    case "error":
      setStatus(message.message, "error");
      updateControls();
      break;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  const delay = Math.min(500 * 2 ** reconnectAttempt, 8000);
  reconnectAttempt += 1;
  const serverHint = hasConnectedOnce
    ? "Server connection lost"
    : "Cannot reach server — run npm run dev in the project folder";
  setStatus(
    reconnectAttempt === 1
      ? `${serverHint} — reconnecting…`
      : `${serverHint} — retrying in ${Math.round(delay / 1000)}s…`,
    "error",
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function connectWebSocket(): void {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
    hasConnectedOnce = true;
    setStatus("Connected to server — enter a URL and click Connect");
  });

  ws.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data as string) as ServerMessage;
      handleServerMessage(message);
    } catch {
      setStatus("Received invalid message from server", "error");
    }
  });

  ws.addEventListener("close", () => {
    ws = null;
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // close event will trigger reconnect
  });
}

navForm.addEventListener("submit", (e) => {
  e.preventDefault();
  send({ type: "navigate", url: urlInput.value });
  setStatus(`Navigating to ${urlInput.value}…`);
});

refreshBtn.addEventListener("click", () => {
  send({ type: "refresh" });
  setStatus("Refreshing visible elements and buttons…");
});

getStateBtn.addEventListener("click", () => {
  void fetchState();
});

async function fetchState(): Promise<void> {
  if (!session.connected || getStateBtn.disabled) return;

  getStateBtn.disabled = true;
  setStatus("Fetching /api/state…");

  try {
    const res = await fetch("/api/state");
    const data = (await res.json()) as {
      error?: string;
      url?: string;
      elements?: unknown[];
      choices?: unknown[];
    };

    if (!res.ok) {
      setStatus(data.error ?? `GET /api/state failed (${res.status})`, "error");
      return;
    }

    const elementCount = data.elements?.length ?? 0;
    const choiceCount = data.choices?.length ?? 0;
    setStatus(
      `State loaded — ${elementCount} element(s), ${choiceCount} choice(s)${data.url ? ` · ${data.url}` : ""}`,
      "success",
    );
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  } finally {
    getStateBtn.disabled = !session.connected;
  }
}

scrollUpBtn.addEventListener("click", () => {
  send({ type: "scroll_page", direction: "up" });
  setStatus("Scrolling page up…");
});

scrollDownBtn.addEventListener("click", () => {
  send({ type: "scroll_page", direction: "down" });
  setStatus("Scrolling page down…");
});

disconnectBtn.addEventListener("click", () => {
  send({ type: "disconnect" });
  elements = [];
  buttons = [];
  elementsSnapshot = "";
  buttonsSnapshot = "";
  session = { connected: false, url: "", title: "" };
  lastAction = "";
  updateControls();
  updateScreenshot();
  renderButtons();
  renderElements();
  setStatus("Disconnected");
});

connectWebSocket();
updateControls();
renderButtons();
renderElements();
