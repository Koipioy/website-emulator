import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import type { InteractableElement } from "../shared/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REF_ATTR = "data-emulator-ref";

const SCAN_IN_PAGE = readFileSync(path.join(__dirname, "scan-in-page.js"), "utf8");

export async function scanInteractables(page: Page): Promise<InteractableElement[]> {
  return page.evaluate(`(${SCAN_IN_PAGE})()`);
}

export function refLocator(page: Page, ref: string) {
  return page.locator(`[${REF_ATTR}="${ref}"]`);
}

export { REF_ATTR };
