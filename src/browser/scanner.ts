import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CDPSession, Frame, Page } from "playwright";
import type { ElementRole, InteractableElement, ScanResult } from "../shared/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REF_ATTR = "data-emulator-ref";
export const BTN_REF_ATTR = "data-emulator-btn-ref";

type CdpDomNode = {
  nodeId: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
};

type CdpFrameTree = {
  frame: { id: string };
  childFrames?: CdpFrameTree[];
};

type TabbableCandidate = {
  nodeId?: number;
  role: ElementRole;
  label: string;
  tabIndex: number;
  point?: { x: number; y: number };
  inShadow: boolean;
  stamp?: (ref: string) => Promise<void>;
};

function loadScanInPage(): string {
  return readFileSync(path.join(__dirname, "scan-in-page.js"), "utf8").trim().replace(/;\s*$/, "");
}

function loadScanVisibleButtons(): string {
  return readFileSync(path.join(__dirname, "scan-visible-buttons.js"), "utf8").trim().replace(/;\s*$/, "");
}

function nextRef(elements: InteractableElement[]): string {
  let counter = 0;
  for (const item of elements) {
    const n = Number.parseInt(item.ref.replace(/^e/, ""), 10);
    if (!Number.isNaN(n)) counter = Math.max(counter, n);
  }
  return `e${counter + 1}`;
}

function nextBtnRef(elements: InteractableElement[]): string {
  let counter = 0;
  for (const item of elements) {
    const n = Number.parseInt(item.ref.replace(/^b/, ""), 10);
    if (!Number.isNaN(n)) counter = Math.max(counter, n);
  }
  return `b${counter + 1}`;
}

export function refAttrForRef(ref: string): string {
  return ref.startsWith("b") ? BTN_REF_ATTR : REF_ATTR;
}

function getCdpAttributes(node: CdpDomNode): Record<string, string> {
  const attrs: Record<string, string> = {};
  const list = node.attributes || [];
  for (let i = 0; i < list.length; i += 2) {
    attrs[list[i].toLowerCase()] = list[i + 1] ?? "";
  }
  return attrs;
}

function getCdpNodeText(node: CdpDomNode): string {
  const parts: string[] = [];
  const walk = (current: CdpDomNode) => {
    if (current.nodeName === "#text" && current.nodeValue) {
      parts.push(current.nodeValue);
    }
    for (const child of current.children || []) walk(child);
  };
  walk(node);
  return parts.join("").replace(/\s+/g, " ").trim();
}

function getCdpTabIndex(nodeName: string, attrs: Record<string, string>): number | null {
  if (attrs.disabled === "true" || attrs["aria-disabled"] === "true") return null;

  const tag = nodeName.toUpperCase();
  if (attrs.tabindex !== undefined) {
    const parsed = Number.parseInt(attrs.tabindex, 10);
    if (Number.isNaN(parsed)) return null;
    return parsed;
  }

  if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA") return 0;
  if (tag === "A" && attrs.href) return 0;
  if (tag === "INPUT") {
    const type = (attrs.type || "text").toLowerCase();
    if (type === "hidden") return null;
    return 0;
  }
  if (tag === "SUMMARY") return 0;

  return null;
}

function isCdpTabbable(nodeName: string, attrs: Record<string, string>): boolean {
  const tabIndex = getCdpTabIndex(nodeName, attrs);
  if (tabIndex === null || tabIndex < 0) return false;
  if (attrs["aria-hidden"] === "true") return false;
  if (isNaturallyTabbableTag(nodeName, attrs)) return true;
  return attrs.tabindex !== undefined && tabIndex >= 0;
}

function isCdpButtonLike(nodeName: string, attrs: Record<string, string>): boolean {
  const tag = nodeName.toUpperCase();
  if (tag === "BUTTON") return true;
  if (tag === "INPUT") {
    const type = (attrs.type || "text").toLowerCase();
    return type === "button" || type === "submit" || type === "reset";
  }
  return attrs.role?.toLowerCase() === "button";
}

function isNaturallyTabbableTag(nodeName: string, attrs: Record<string, string>): boolean {
  const tag = nodeName.toUpperCase();
  if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || tag === "SUMMARY") return true;
  if (tag === "A" && attrs.href) return true;
  if (tag === "INPUT") {
    const type = (attrs.type || "text").toLowerCase();
    return type !== "hidden";
  }
  return false;
}

function inferCdpRole(nodeName: string, attrs: Record<string, string>): ElementRole {
  const tag = nodeName.toUpperCase();
  const role = attrs.role?.toLowerCase();

  if (tag === "BUTTON") return "button";
  if (tag === "TEXTAREA") return "textbox";
  if (tag === "SELECT") return "select";
  if (tag === "A" && attrs.href) return "link";

  if (tag === "INPUT") {
    const type = (attrs.type || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    return "textbox";
  }

  if (role === "link") return "link";
  if (role === "checkbox" || role === "switch") return "checkbox";
  if (role === "radio") return "radio";
  if (role === "combobox" || role === "listbox") return "combobox";
  if (role === "textbox" || role === "searchbox" || role === "spinbutton") return "textbox";

  return "button";
}

function inferCdpLabel(node: CdpDomNode, attrs: Record<string, string>): string {
  if (attrs["aria-label"]?.trim()) return attrs["aria-label"].trim().slice(0, 120);
  const text = getCdpNodeText(node);
  if (text) return text.slice(0, 120);
  if (attrs.placeholder?.trim()) return attrs.placeholder.trim();
  if (attrs.title?.trim()) return attrs.title.trim();
  if (attrs.name?.trim()) return attrs.name.trim();
  if (attrs.href) return attrs.href;
  return node.nodeName.toLowerCase();
}

async function getBoxCenter(
  client: CDPSession,
  nodeId: number,
): Promise<{ x: number; y: number } | null> {
  try {
    const { model } = await client.send("DOM.getBoxModel", { nodeId });
    const c = model.content;
    return {
      x: (c[0] + c[2] + c[4] + c[6]) / 4,
      y: (c[1] + c[3] + c[5] + c[7]) / 4,
    };
  } catch {
    return null;
  }
}

async function isCdpNodeVisible(client: CDPSession, nodeId: number): Promise<boolean> {
  try {
    const [{ computedStyle }, { model }] = await Promise.all([
      client.send("CSS.getComputedStyleForNode", { nodeId }),
      client.send("DOM.getBoxModel", { nodeId }),
    ]);

    const style = new Map(computedStyle.map((entry) => [entry.name, entry.value]));
    if (style.get("display") === "none" || style.get("visibility") === "hidden") return false;
    if (Number.parseFloat(style.get("opacity") || "1") <= 0) return false;
    if (style.get("pointer-events") === "none") return false;

    const c = model.content;
    const xs = [c[0], c[2], c[4], c[6]];
    const ys = [c[1], c[3], c[5], c[7]];
    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    return area >= 4;
  } catch {
    return false;
  }
}

const CLEAR_REFS_SCRIPT = `
  ({ refAttr }) => {
    const roots = [document];
    while (roots.length) {
      const root = roots.pop();
      if (!root) continue;
      root.querySelectorAll(\`[\${refAttr}]\`).forEach((el) => el.removeAttribute(refAttr));
      root.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) roots.push(el.shadowRoot);
      });
    }
  }
`;

async function clearEmulatorRefsInFrames(page: Page): Promise<void> {
  for (const refAttr of [REF_ATTR, BTN_REF_ATTR]) {
    const args = JSON.stringify({ refAttr });
    for (const frame of page.frames()) {
      try {
        await frame.evaluate(`(${CLEAR_REFS_SCRIPT})(${args})`);
      } catch {
        // Detached or inaccessible frame.
      }
    }
  }
}

async function clearEmulatorRefsPierced(page: Page, attr: string): Promise<void> {
  const client = await page.context().newCDPSession(page);
  await client.send("DOM.enable");
  await client.send("Page.enable");

  const roots = await getAllPiercedRoots(client);
  const nodes = collectPiercedNodes(roots);

  for (const node of nodes) {
    const attrs = getCdpAttributes(node);
    if (!attrs[attr]) continue;
    try {
      await client.send("DOM.removeAttribute", { nodeId: node.nodeId, name: attr });
    } catch {
      // Node may have been removed between walks.
    }
  }
}

async function clearAllEmulatorRefs(page: Page): Promise<void> {
  await clearEmulatorRefsInFrames(page);
  await Promise.all([
    clearEmulatorRefsPierced(page, REF_ATTR),
    clearEmulatorRefsPierced(page, BTN_REF_ATTR),
  ]);
}

async function clearAllButtonRefs(page: Page): Promise<void> {
  const args = JSON.stringify({ refAttr: BTN_REF_ATTR });
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(`(${CLEAR_REFS_SCRIPT})(${args})`);
    } catch {
      // Detached or inaccessible frame.
    }
  }
  await clearEmulatorRefsPierced(page, BTN_REF_ATTR);
}

async function stampCdpNodeRef(
  client: CDPSession,
  nodeId: number,
  ref: string,
  attr = REF_ATTR,
): Promise<void> {
  const { object } = await client.send("DOM.resolveNode", { nodeId });
  if (!object.objectId) return;

  await client.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function(attr, refId) { this.setAttribute(attr, refId); }`,
    arguments: [{ value: attr }, { value: ref }],
  });
}

async function getAllPiercedRoots(client: CDPSession): Promise<CdpDomNode[]> {
  const { frameTree } = (await client.send("Page.getFrameTree")) as { frameTree: CdpFrameTree };
  const roots: CdpDomNode[] = [];

  const walkFrames = async (frame: CdpFrameTree) => {
    const { root } = (await client.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
      frameId: frame.frame.id,
    } as Record<string, unknown>)) as { root: CdpDomNode };
    roots.push(root);
    for (const child of frame.childFrames || []) {
      await walkFrames(child);
    }
  };

  await walkFrames(frameTree);
  return roots;
}

function collectPiercedNodes(roots: CdpDomNode[]): CdpDomNode[] {
  const nodes: CdpDomNode[] = [];

  const walk = (node: CdpDomNode) => {
    if (node.nodeName !== "#document" && node.nodeName !== "#text") {
      nodes.push(node);
    }
    for (const child of node.children || []) walk(child);
    for (const shadow of node.shadowRoots || []) walk(shadow);
  };

  for (const root of roots) walk(root);
  return nodes;
}

function isDuplicate(
  candidate: TabbableCandidate,
  existing: InteractableElement[],
): boolean {
  return existing.some((item) => {
    if (item.point && candidate.point) {
      const dx = Math.abs(item.point.x - candidate.point.x);
      const dy = Math.abs(item.point.y - candidate.point.y);
      if (dx < 12 && dy < 12) return true;
    }
    return item.label === candidate.label && item.tabIndex === candidate.tabIndex;
  });
}

function isButtonDuplicate(
  candidate: { label: string; point?: { x: number; y: number } },
  existing: InteractableElement[],
): boolean {
  return existing.some((item) => {
    if (item.point && candidate.point) {
      const dx = Math.abs(item.point.x - candidate.point.x);
      const dy = Math.abs(item.point.y - candidate.point.y);
      if (dx < 12 && dy < 12) return true;
    }
    return item.label === candidate.label;
  });
}

async function scanPiercedTabbables(
  page: Page,
  existing: InteractableElement[],
): Promise<InteractableElement[]> {
  const client = await page.context().newCDPSession(page);
  await Promise.all([
    client.send("DOM.enable"),
    client.send("CSS.enable"),
    client.send("Page.enable"),
  ]);

  const roots = await getAllPiercedRoots(client);
  const nodes = collectPiercedNodes(roots);
  const found: InteractableElement[] = [];

  for (const node of nodes) {
    const attrs = getCdpAttributes(node);
    if (attrs[REF_ATTR]) continue;
    if (!isCdpTabbable(node.nodeName, attrs)) continue;
    if (!(await isCdpNodeVisible(client, node.nodeId))) continue;

    const tabIndex = getCdpTabIndex(node.nodeName, attrs);
    if (tabIndex === null) continue;

    const point = await getBoxCenter(client, node.nodeId);
    const candidate: TabbableCandidate = {
      nodeId: node.nodeId,
      role: inferCdpRole(node.nodeName, attrs),
      label: inferCdpLabel(node, attrs),
      tabIndex,
      point: point ?? undefined,
      inShadow: true,
    };

    if (isDuplicate(candidate, [...existing, ...found])) continue;

    const ref = nextRef([...existing, ...found]);
    await stampCdpNodeRef(client, node.nodeId, ref);

    found.push({
      ref,
      role: candidate.role,
      label: candidate.label,
      tabIndex: candidate.tabIndex,
      disabled: attrs.disabled === "true" || attrs["aria-disabled"] === "true",
      point: candidate.point,
    });
  }

  return found;
}

async function scanPiercedButtons(
  page: Page,
  existing: InteractableElement[],
): Promise<InteractableElement[]> {
  const client = await page.context().newCDPSession(page);
  await Promise.all([
    client.send("DOM.enable"),
    client.send("CSS.enable"),
    client.send("Page.enable"),
  ]);

  const roots = await getAllPiercedRoots(client);
  const nodes = collectPiercedNodes(roots);
  const found: InteractableElement[] = [];

  for (const node of nodes) {
    const attrs = getCdpAttributes(node);
    if (attrs[BTN_REF_ATTR]) continue;
    if (!isCdpButtonLike(node.nodeName, attrs)) continue;
    if (!(await isCdpNodeVisible(client, node.nodeId))) continue;

    const point = await getBoxCenter(client, node.nodeId);
    const candidate = {
      label: inferCdpLabel(node, attrs),
      point: point ?? undefined,
    };

    if (isButtonDuplicate(candidate, [...existing, ...found])) continue;

    const ref = nextBtnRef([...existing, ...found]);
    await stampCdpNodeRef(client, node.nodeId, ref, BTN_REF_ATTR);

    found.push({
      ref,
      role: "button",
      label: candidate.label,
      disabled: attrs.disabled === "true" || attrs["aria-disabled"] === "true",
      point: candidate.point,
    });
  }

  return found;
}

const FRAME_BUTTON_SCRIPT = `
  ({ refAttr, startCounter }) => {
    const isInert = (el) => {
      let node = el;
      while (node && node instanceof Element) {
        if (node.hasAttribute("inert")) return true;
        if (node.getAttribute("aria-hidden") === "true") return true;
        node = node.parentElement;
      }
      return false;
    };
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (Number.parseFloat(style.opacity || "1") <= 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isButtonLike = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      if (el instanceof HTMLButtonElement) return true;
      if (el instanceof HTMLInputElement) {
        const type = (el.type || "text").toLowerCase();
        return type === "button" || type === "submit" || type === "reset";
      }
      return el.getAttribute("role")?.toLowerCase() === "button";
    };
    const getLabel = (el) => {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().slice(0, 120);
      const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (text) return text.slice(0, 120);
      return el.tagName.toLowerCase();
    };

    const all = [];
    try {
      const roots = [document];
      while (roots.length) {
        const root = roots.pop();
        if (!root) continue;
        root.querySelectorAll("[" + refAttr + "]").forEach((el) => el.removeAttribute(refAttr));
        const nodes = Array.from(root.querySelectorAll("*") ?? []);
        for (const el of nodes) {
          if (el instanceof HTMLElement && isButtonLike(el) && !isInert(el) && isVisible(el)) {
            all.push(el);
          }
          if (el instanceof HTMLElement && el.shadowRoot) {
            roots.push(el.shadowRoot);
          }
        }
      }
    } catch {
      // Detached or minimal iframe documents may reject traversal.
    }

    return all.map((el, index) => {
      const ref = "b" + (startCounter + index + 1);
      el.setAttribute(refAttr, ref);
      return {
        ref,
        role: "button",
        label: getLabel(el),
        disabled:
          el instanceof HTMLInputElement || el instanceof HTMLButtonElement
            ? el.disabled
            : el.getAttribute("aria-disabled") === "true",
      };
    });
  }
`;

async function scanFrameButtons(
  page: Page,
  existing: InteractableElement[],
): Promise<InteractableElement[]> {
  const found: InteractableElement[] = [];
  let counter = existing.length;

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;

    try {
      const frameArgs = JSON.stringify({ refAttr: BTN_REF_ATTR, startCounter: counter });
      const items = ((await frame.evaluate(
        `(${FRAME_BUTTON_SCRIPT})(${frameArgs})`,
      )) ?? []) as Array<{
        ref: string;
        role: ElementRole;
        label: string;
        disabled: boolean;
      }>;

      for (const item of items) {
        const locator = frame.locator(`[${BTN_REF_ATTR}="${item.ref}"]`);
        const box = await locator.boundingBox().catch(() => null);
        const point = box
          ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
          : undefined;

        if (isButtonDuplicate({ label: item.label, point }, [...existing, ...found])) {
          await locator.evaluate((el, attr) => el.removeAttribute(attr), BTN_REF_ATTR).catch(() => {});
          continue;
        }

        found.push({
          ref: item.ref,
          role: "button",
          label: item.label,
          disabled: item.disabled,
          point,
        });
        counter += 1;
      }
    } catch {
      // Detached or inaccessible frame.
    }
  }

  return found;
}

function sortButtonsByOrder(elements: InteractableElement[]): InteractableElement[] {
  return elements.map((el, index) => ({
    ...el,
    order: index + 1,
  }));
}

export async function scanVisibleButtons(page: Page): Promise<InteractableElement[]> {
  await clearAllButtonRefs(page);

  let result: { elements: InteractableElement[] } = { elements: [] };
  try {
    result = (await page.evaluate(`(${loadScanVisibleButtons()})()`)) as {
      elements: InteractableElement[];
    };
  } catch {
    // Main-frame walk can fail on captcha / bot-check pages.
  }
  if (!Array.isArray(result.elements)) {
    result.elements = [];
  }

  const pierced = await scanPiercedButtons(page, result.elements);
  const framed = await scanFrameButtons(page, [...result.elements, ...pierced]);

  return sortButtonsByOrder([...result.elements, ...pierced, ...framed]);
}

const FRAME_TABBABLE_SCRIPT = `
  ({ refAttr, startCounter }) => {
    const isInert = (el) => {
      let node = el;
      while (node && node instanceof Element) {
        if (node.hasAttribute("inert")) return true;
        if (node.getAttribute("aria-hidden") === "true") return true;
        node = node.parentElement;
      }
      return false;
    };
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0;
    };
    const isNaturallyTabbable = (el) => {
      if (el instanceof HTMLButtonElement) return !el.disabled;
      if (el instanceof HTMLInputElement) return !el.disabled && el.type !== "hidden";
      if (el instanceof HTMLSelectElement) return !el.disabled;
      if (el instanceof HTMLTextAreaElement) return !el.disabled;
      if (el instanceof HTMLAnchorElement) {
        const href = el.getAttribute("href");
        return Boolean(href && href.trim());
      }
      if (el.tagName === "SUMMARY") return true;
      if (el.isContentEditable) return true;
      return false;
    };
    const getTabIndex = (el) => {
      if (el.hasAttribute("tabindex")) {
        const parsed = Number.parseInt(el.getAttribute("tabindex") || "", 10);
        return Number.isNaN(parsed) ? null : parsed;
      }
      return isNaturallyTabbable(el) ? 0 : null;
    };
    const isTabbable = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      if (isInert(el) || !isVisible(el)) return false;
      if (el.getAttribute("aria-disabled") === "true") return false;
      const tabIndex = getTabIndex(el);
      if (tabIndex === null || tabIndex < 0) return false;
      if (isNaturallyTabbable(el)) return true;
      return el.hasAttribute("tabindex") && tabIndex >= 0;
    };
    const inferRole = (el) => {
      if (el instanceof HTMLInputElement) {
        const type = (el.type || "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "button" || type === "submit" || type === "reset") return "button";
        return "textbox";
      }
      if (el instanceof HTMLTextAreaElement) return "textbox";
      if (el instanceof HTMLSelectElement) return "select";
      const role = el.getAttribute("role");
      if (role === "link") return "link";
      if (role === "checkbox") return "checkbox";
      if (role === "radio") return "radio";
      if (role === "textbox" || role === "searchbox") return "textbox";
      if (el instanceof HTMLAnchorElement && el.href) return "link";
      if (el instanceof HTMLButtonElement) return "button";
      return "button";
    };
    const getLabel = (el) => {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().slice(0, 120);
      const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (text) return text.slice(0, 120);
      return el.tagName.toLowerCase();
    };

    const all = [];
    try {
      const roots = [document];
      while (roots.length) {
        const root = roots.pop();
        if (!root) continue;
        root.querySelectorAll("[" + refAttr + "]").forEach((el) => el.removeAttribute(refAttr));
        const nodes = Array.from(root.querySelectorAll("*") ?? []);
        for (const el of nodes) {
          if (el instanceof HTMLElement && isTabbable(el)) {
            all.push(el);
          }
          if (el instanceof HTMLElement && el.shadowRoot) {
            roots.push(el.shadowRoot);
          }
        }
      }
    } catch {
      // Detached or minimal iframe documents may reject traversal.
    }

    const positive = all.filter((el) => getTabIndex(el) > 0).sort((a, b) => getTabIndex(a) - getTabIndex(b));
    const zero = all.filter((el) => getTabIndex(el) <= 0);
    const ordered = [...positive, ...zero];

    return ordered.map((el, index) => {
      const ref = "e" + (startCounter + index + 1);
      el.setAttribute(refAttr, ref);
      return {
        ref,
        role: inferRole(el),
        label: getLabel(el),
        tabIndex: getTabIndex(el) ?? 0,
        disabled:
          el instanceof HTMLInputElement ||
          el instanceof HTMLButtonElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLTextAreaElement
            ? el.disabled
            : el.getAttribute("aria-disabled") === "true",
      };
    });
  }
`;

async function scanFrameTabbables(
  page: Page,
  existing: InteractableElement[],
): Promise<InteractableElement[]> {
  const found: InteractableElement[] = [];
  let counter = existing.length;

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;

    try {
      const frameArgs = JSON.stringify({ refAttr: REF_ATTR, startCounter: counter });
      const items = ((await frame.evaluate(
        `(${FRAME_TABBABLE_SCRIPT})(${frameArgs})`,
      )) ?? []) as Array<{
        ref: string;
        role: ElementRole;
        label: string;
        tabIndex: number;
        disabled: boolean;
      }>;

      for (const item of items) {
        const locator = frame.locator(`[${REF_ATTR}="${item.ref}"]`);
        const box = await locator.boundingBox().catch(() => null);

        const candidate: TabbableCandidate = {
          role: item.role,
          label: item.label,
          tabIndex: item.tabIndex,
          point: box
            ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
            : undefined,
          inShadow: true,
        };

        if (isDuplicate(candidate, [...existing, ...found])) {
          await locator.evaluate((el, attr) => el.removeAttribute(attr), REF_ATTR).catch(() => {});
          continue;
        }

        found.push({
          ref: item.ref,
          role: item.role,
          label: item.label,
          tabIndex: item.tabIndex,
          disabled: item.disabled,
          point: candidate.point,
        });
        counter += 1;
      }
    } catch {
      // Detached or inaccessible frame.
    }
  }

  return found;
}

function sortByTabOrder(elements: InteractableElement[]): InteractableElement[] {
  const positive = elements
    .filter((el) => (el.tabIndex ?? 0) > 0)
    .sort((a, b) => (a.tabIndex ?? 0) - (b.tabIndex ?? 0));
  const zero = elements.filter((el) => (el.tabIndex ?? 0) <= 0);
  return [...positive, ...zero].map((el, index) => ({
    ...el,
    order: index + 1,
  }));
}

export async function scanInteractables(page: Page): Promise<ScanResult> {
  await clearAllEmulatorRefs(page);

  let result: ScanResult = { elements: [], popup: null };
  try {
    result = (await page.evaluate(`(${loadScanInPage()})()`)) as ScanResult;
  } catch {
    // Main-frame walk can fail on captcha / bot-check pages.
  }
  if (!Array.isArray(result.elements)) {
    result.elements = [];
  }

  const pierced = await scanPiercedTabbables(page, result.elements);
  const framed = await scanFrameTabbables(page, [...result.elements, ...pierced]);

  result.elements = sortByTabOrder([...result.elements, ...pierced, ...framed]);
  result.popup = null;
  return result;
}

export async function findFrameForRef(page: Page, ref: string, attr?: string): Promise<Frame> {
  const refAttr = attr ?? refAttrForRef(ref);
  for (const frame of page.frames()) {
    const count = await frame.locator(`[${refAttr}="${ref}"]`).count().catch(() => 0);
    if (count > 0) return frame;
  }
  return page.mainFrame();
}

export function refLocator(page: Page, ref: string, frame?: Frame, attr?: string) {
  const refAttr = attr ?? refAttrForRef(ref);
  const target = frame ?? page;
  return target.locator(`[${refAttr}="${ref}"]`);
}

export function getElementPoint(elements: InteractableElement[], ref: string) {
  return elements.find((item) => item.ref === ref)?.point;
}
