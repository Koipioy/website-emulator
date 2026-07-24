import type { Page } from "playwright";
import sharp from "sharp";
import type { InteractableElement } from "../shared/protocol.js";
import { REF_ATTR, findFrameForRef } from "./scanner.js";

const HIGHLIGHT_COLORS = [
  "#5b9cf5",
  "#4ade80",
  "#f472b6",
  "#fbbf24",
  "#a78bfa",
  "#f87171",
  "#2dd4bf",
  "#fb923c",
];

function colorForOrder(order: number): string {
  return HIGHLIGHT_COLORS[(order - 1) % HIGHLIGHT_COLORS.length]!;
}

async function refreshBounds(
  page: Page,
  elements: InteractableElement[],
): Promise<InteractableElement[]> {
  const refreshed: InteractableElement[] = [];

  for (const el of elements) {
    const frame = await findFrameForRef(page, el.ref);
    const box = await frame.locator(`[${REF_ATTR}="${el.ref}"]`).boundingBox().catch(() => null);

    if (box && box.width > 0 && box.height > 0) {
      refreshed.push({
        ...el,
        bounds: box,
        point: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      });
    } else if (el.bounds && el.bounds.width > 0 && el.bounds.height > 0) {
      refreshed.push(el);
    }
  }

  return refreshed;
}

function buildHighlightSvg(
  width: number,
  height: number,
  elements: InteractableElement[],
): string {
  const shapes = elements
    .filter((el) => el.bounds && el.order)
    .map((el) => {
      const { x, y, width: w, height: h } = el.bounds!;
      const color = colorForOrder(el.order!);
      const label = `#${el.order}`;
      const labelWidth = label.length * 8 + 14;
      const labelY = Math.max(y - 4, 14);

      return `
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"
          fill="none" stroke="${color}" stroke-width="3" rx="2"/>
        <rect x="${x.toFixed(1)}" y="${(labelY - 14).toFixed(1)}" width="${labelWidth}" height="16"
          fill="${color}" rx="2"/>
        <text x="${(x + 5).toFixed(1)}" y="${(labelY - 3).toFixed(1)}"
          fill="#0f1117" font-size="11" font-family="ui-monospace, monospace" font-weight="700">${label}</text>
      `;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes}</svg>`;
}

export async function captureHighlightedScreenshotBuffer(
  page: Page,
  elements: InteractableElement[],
): Promise<Buffer | null> {
  try {
    const highlighted = elements.length > 0 ? await refreshBounds(page, elements) : [];
    const screenshot = await page.screenshot({ type: "png", scale: "css" });
    const metadata = await sharp(screenshot).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width === 0 || height === 0) return null;

    if (highlighted.length === 0) {
      return sharp(screenshot).jpeg({ quality: 70 }).toBuffer();
    }

    const overlay = buildHighlightSvg(width, height, highlighted);
    return sharp(screenshot)
      .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
      .jpeg({ quality: 70 })
      .toBuffer();
  } catch (err) {
    console.error("Screenshot capture failed:", err);
    return null;
  }
}
