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
const disconnectBtn = document.getElementById("disconnect-btn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const elementsEl = document.getElementById("elements") as HTMLElement;

let ws: WebSocket | null = null;
let session: SessionState = { connected: false, url: "", title: "" };
let elements: InteractableElement[] = [];
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
  disconnectBtn.disabled = !connected;
  connectBtn.textContent = connected ? "Reconnect" : "Connect";
}

function renderElements(): void {
  elementsEl.innerHTML = "";

  if (!session.connected) {
    elementsEl.innerHTML = `<p class="empty">Enter a URL and click Connect to scan interactable elements.</p>`;
    return;
  }

  if (elements.length === 0) {
    elementsEl.innerHTML = `<p class="empty">No interactable elements found on this page.</p>`;
    return;
  }

  const groups = new Map<string, InteractableElement[]>();
  for (const el of elements) {
    const list = groups.get(el.role) ?? [];
    list.push(el);
    groups.set(el.role, list);
  }

  const roleOrder = ["button", "link", "textbox", "checkbox", "radio", "select", "combobox"];
  const sortedRoles = [...groups.keys()].sort(
    (a, b) => roleOrder.indexOf(a) - roleOrder.indexOf(b),
  );

  for (const role of sortedRoles) {
    const section = document.createElement("section");
    section.className = "group";
    section.innerHTML = `<h2>${role}s <span class="count">${groups.get(role)!.length}</span></h2>`;

    const list = document.createElement("div");
    list.className = "group-list";

    for (const el of groups.get(role)!) {
      list.appendChild(renderElementCard(el));
    }

    section.appendChild(list);
    elementsEl.appendChild(section);
  }
}

function renderElementCard(el: InteractableElement): HTMLElement {
  const card = document.createElement("article");
  card.className = "card";
  if (el.disabled) card.classList.add("disabled");

  const header = document.createElement("div");
  header.className = "card-header";
  header.innerHTML = `<span class="ref">${el.ref}</span><span class="label">${escapeHtml(el.label)}</span>`;
  card.appendChild(header);

  if (el.href) {
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = el.href;
    card.appendChild(meta);
  }

  const controls = document.createElement("div");
  controls.className = "card-controls";

  switch (el.role) {
    case "button":
    case "link":
      controls.appendChild(actionButton("Click", () => send({ type: "click", ref: el.ref }), el.disabled));
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

      controls.append(input, fillBtn);
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
      controls.appendChild(toggle);
      break;
    }

    case "select":
    case "combobox": {
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
      controls.append(select, selectBtn);
      break;
    }
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
      renderElements();
      break;

    case "elements":
      elements = message.elements;
      session = { ...session, connected: true, url: message.url, title: message.title };
      updateControls();
      setStatus(
        `${message.title || "Untitled"} — ${message.url} — ${message.elements.length} element(s)${lastAction ? ` — ${lastAction}` : ""}`,
      );
      renderElements();
      break;

    case "action_result":
      lastAction = message.success
        ? `Last action on ${message.ref}: OK`
        : `Last action on ${message.ref} failed: ${message.error}`;
      setStatus(lastAction, message.success ? "success" : "error");
      break;

    case "error":
      setStatus(message.message, "error");
      break;
  }
}

function connectWebSocket(): void {
  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    setStatus("Connected to server");
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
    setStatus("Disconnected from server — reconnecting…", "error");
    setTimeout(connectWebSocket, 1500);
  });
}

navForm.addEventListener("submit", (e) => {
  e.preventDefault();
  send({ type: "navigate", url: urlInput.value });
  setStatus(`Navigating to ${urlInput.value}…`);
});

refreshBtn.addEventListener("click", () => {
  send({ type: "refresh" });
  setStatus("Refreshing element list…");
});

disconnectBtn.addEventListener("click", () => {
  send({ type: "disconnect" });
  elements = [];
  session = { connected: false, url: "", title: "" };
  lastAction = "";
  updateControls();
  renderElements();
  setStatus("Disconnected");
});

connectWebSocket();
updateControls();
renderElements();
