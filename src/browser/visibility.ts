import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CDPSession, Page } from "playwright";
import type { InteractableElement } from "../shared/protocol.js";
import { REF_ATTR, findFrameForRef } from "./scanner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type ElementBounds = { x: number; y: number; width: number; height: number };

type OnScreenResult = {
  visible: boolean;
  bounds?: ElementBounds;
};

type CdpDomNode = {
  nodeId: number;
  attributes?: string[];
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
};

function loadOnScreenCheck(): string {
  return readFileSync(path.join(__dirname, "on-screen-check.js"), "utf8").trim().replace(/;\s*$/, "");
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

async function getCdpSession(page: Page): Promise<CDPSession> {
  const client = await page.context().newCDPSession(page);
  await Promise.all([
    client.send("DOM.enable"),
    client.send("CSS.enable"),
    client.send("Page.enable"),
  ]);
  return client;
}

function walkCdpRefs(node: CdpDomNode, map: Map<string, number>): void {
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === REF_ATTR && attrs[i + 1]) {
      map.set(attrs[i + 1]!, node.nodeId);
    }
  }
  for (const child of node.children || []) walkCdpRefs(child, map);
  for (const shadow of node.shadowRoots || []) walkCdpRefs(shadow, map);
}

async function buildCdpRefMap(client: CDPSession): Promise<Map<string, number>> {
  const { root } = (await client.send("DOM.getDocument", { depth: -1, pierce: true })) as {
    root: CdpDomNode;
  };
  const map = new Map<string, number>();
  walkCdpRefs(root, map);
  return map;
}

async function getCdpBounds(client: CDPSession, nodeId: number): Promise<ElementBounds | null> {
  try {
    const { object } = await client.send("DOM.resolveNode", { nodeId });
    if (!object.objectId) return null;

    const { result } = await client.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function() {
        const r = this.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }`,
      returnByValue: true,
    });

    const value = result.value as ElementBounds | undefined;
    if (!value || value.width <= 0 || value.height <= 0) return null;
    return value;
  } catch {
    return null;
  }
}

async function isCdpNodeOnScreen(client: CDPSession, nodeId: number): Promise<boolean> {
  try {
    const [{ computedStyle }, bounds] = await Promise.all([
      client.send("CSS.getComputedStyleForNode", { nodeId }),
      getCdpBounds(client, nodeId),
    ]);

    if (!bounds) return false;

    const style = new Map(computedStyle.map((entry) => [entry.name, entry.value]));
    if (style.get("display") === "none" || style.get("visibility") === "hidden") return false;
    if (Number.parseFloat(style.get("opacity") || "1") <= 0) return false;

    const { visualViewport } = await client.send("Page.getLayoutMetrics");
    const vw = visualViewport.clientWidth;
    const vh = visualViewport.clientHeight;
    const offsetX = visualViewport.offsetX;
    const offsetY = visualViewport.offsetY;

    if (
      bounds.y + bounds.height <= offsetY ||
      bounds.y >= offsetY + vh ||
      bounds.x + bounds.width <= offsetX ||
      bounds.x >= offsetX + vw
    ) {
      return false;
    }

    const cx = Math.min(Math.max(bounds.x + bounds.width / 2, offsetX), offsetX + vw - 1);
    const cy = Math.min(Math.max(bounds.y + bounds.height / 2, offsetY), offsetY + vh - 1);

    const { nodeId: hitId } = await client.send("DOM.getNodeForLocation", {
      x: Math.round(cx),
      y: Math.round(cy),
    });

    if (!hitId || hitId === nodeId) return hitId === nodeId;

    const { node: hitNode } = await client.send("DOM.describeNode", { nodeId: hitId });
    let current: { nodeId: number; parentId?: number } | undefined = hitNode;
    while (current) {
      if (current.nodeId === nodeId) return true;
      if (!current.parentId) break;
      const described: { node: { nodeId: number; parentId?: number } } = await client.send(
        "DOM.describeNode",
        { nodeId: current.parentId },
      );
      current = described.node;
    }

    return false;
  } catch {
    return false;
  }
}

async function checkElementOnScreen(
  page: Page,
  ref: string,
  cdpClient: CDPSession,
  cdpRefMap: Map<string, number>,
): Promise<OnScreenResult> {
  const frame = await findFrameForRef(page, ref);
  const locator = frame.locator(`[${REF_ATTR}="${ref}"]`);
  const count = await locator.count().catch(() => 0);

  if (count > 0) {
    const onScreenCheck = loadOnScreenCheck();
    const argsJson = JSON.stringify({ attr: REF_ATTR, refId: ref });
    const frameResult = (await frame
      .evaluate(`(${onScreenCheck})(${argsJson})`)
      .catch(() => ({ visible: false }))) as OnScreenResult;

    if (!frameResult?.visible) return { visible: false };

    const pageBox = await locator.boundingBox().catch(() => null);
    if (!pageBox || pageBox.width <= 0 || pageBox.height <= 0) {
      return { visible: false };
    }

    return { visible: true, bounds: pageBox };
  }

  const nodeId = cdpRefMap.get(ref);
  if (nodeId === undefined) return { visible: false };

  const [visible, bounds] = await Promise.all([
    isCdpNodeOnScreen(cdpClient, nodeId),
    getCdpBounds(cdpClient, nodeId),
  ]);

  if (!visible || !bounds) return { visible: false };
  return { visible: true, bounds };
}

export async function filterOnScreen(
  page: Page,
  elements: InteractableElement[],
): Promise<InteractableElement[]> {
  if (elements.length === 0) return [];

  const visible: InteractableElement[] = [];
  const cdpClient = await getCdpSession(page);
  const cdpRefMap = await buildCdpRefMap(cdpClient);

  for (const el of elements) {
    const result = await checkElementOnScreen(page, el.ref, cdpClient, cdpRefMap);
    if (!result.visible || !result.bounds) continue;

    visible.push({
      ...el,
      bounds: result.bounds,
      point: {
        x: result.bounds.x + result.bounds.width / 2,
        y: result.bounds.y + result.bounds.height / 2,
      },
    });
  }

  return sortByTabOrder(visible);
}
