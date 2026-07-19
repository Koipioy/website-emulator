import type { Page } from "playwright";
import type { InteractableElement, PopupScope } from "../shared/protocol.js";
import { captureHighlightedScreenshot } from "./screenshot.js";
import { filterOnScreen } from "./visibility.js";
import { BTN_REF_ATTR, REF_ATTR, findFrameForRef, refAttrForRef, refLocator, scanInteractables, scanVisibleButtons } from "./scanner.js";

export interface ActionResult {
  ref: string;
  success: boolean;
  error?: string;
}

const ACTION_TIMEOUT = 5000;

async function waitForStability(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(150);
}

function isObscuredError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("intercepts pointer events") ||
    message.includes("not visible") ||
    message.includes("outside of the viewport") ||
    message.includes("detached from the DOM")
  );
}

async function clickWithFallback(page: Page, ref: string): Promise<void> {
  const attr = refAttrForRef(ref);
  const frame = await findFrameForRef(page, ref, attr);
  const locator = refLocator(page, ref, frame, attr);

  try {
    await locator.click({ timeout: ACTION_TIMEOUT });
    return;
  } catch (firstErr) {
    if (!isObscuredError(firstErr)) throw firstErr;
  }

  try {
    await locator.click({ force: true, timeout: ACTION_TIMEOUT });
    return;
  } catch {
    // Continue to DOM click.
  }

  try {
    await locator.dispatchEvent("click", { timeout: ACTION_TIMEOUT });
    return;
  } catch {
    // Continue to DOM click.
  }

  await frame.evaluate(
    ({ attr, refId }) => {
      const el = document.querySelector(`[${attr}="${refId}"]`);
      if (!(el instanceof HTMLElement)) {
        throw new Error(`Element ${refId} not found`);
      }
      el.click();
    },
    { attr: refAttrForRef(ref), refId: ref },
  );
}

async function locatorForRef(page: Page, ref: string) {
  const attr = refAttrForRef(ref);
  const frame = await findFrameForRef(page, ref, attr);
  return refLocator(page, ref, frame, attr);
}

async function runAction(
  page: Page,
  ref: string,
  action: () => Promise<void>,
  fallback?: () => Promise<void>,
): Promise<ActionResult> {
  try {
    await action();
    return { ref, success: true };
  } catch (firstErr) {
    if (fallback && isObscuredError(firstErr)) {
      try {
        await fallback();
        return { ref, success: true };
      } catch (fallbackErr) {
        return {
          ref,
          success: false,
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        };
      }
    }

    return { ref, success: false, error: firstErr instanceof Error ? firstErr.message : String(firstErr) };
  }
}

export async function clickElement(
  page: Page,
  ref: string,
  point?: { x: number; y: number },
): Promise<ActionResult> {
  try {
    if (point) {
      await page.mouse.click(point.x, point.y);
      await waitForStability(page);
      return { ref, success: true };
    }

    await clickWithFallback(page, ref);
    await waitForStability(page);
    return { ref, success: true };
  } catch (err) {
    return { ref, success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fillElement(page: Page, ref: string, value: string): Promise<ActionResult> {
  const locator = await locatorForRef(page, ref);
  return runAction(
    page,
    ref,
    async () => {
      await locator.fill(value, { timeout: ACTION_TIMEOUT });
    },
    async () => {
      await locator.fill(value, { force: true, timeout: ACTION_TIMEOUT });
    },
  );
}

export async function selectElement(page: Page, ref: string, value: string): Promise<ActionResult> {
  const locator = await locatorForRef(page, ref);
  return runAction(
    page,
    ref,
    async () => {
      await locator.selectOption(value, { timeout: ACTION_TIMEOUT });
    },
    async () => {
      await locator.selectOption(value, { force: true, timeout: ACTION_TIMEOUT });
    },
  );
}

export async function checkElement(page: Page, ref: string, checked: boolean): Promise<ActionResult> {
  const locator = await locatorForRef(page, ref);
  return runAction(
    page,
    ref,
    async () => {
      if (checked) await locator.check({ timeout: ACTION_TIMEOUT });
      else await locator.uncheck({ timeout: ACTION_TIMEOUT });
    },
    async () => {
      if (checked) await locator.check({ force: true, timeout: ACTION_TIMEOUT });
      else await locator.uncheck({ force: true, timeout: ACTION_TIMEOUT });
    },
  );
}

export async function pressElement(page: Page, ref: string, key: string): Promise<ActionResult> {
  const locator = await locatorForRef(page, ref);
  const result = await runAction(page, ref, async () => {
    await locator.press(key, { timeout: ACTION_TIMEOUT });
  });
  if (result.success) await waitForStability(page);
  return result;
}

export async function scrollElement(page: Page, ref: string): Promise<ActionResult> {
  const locator = await locatorForRef(page, ref);
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT });
    await waitForStability(page);
    return { ref, success: true };
  } catch (err) {
    return { ref, success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function scrollPage(page: Page, direction: "up" | "down"): Promise<ActionResult> {
  try {
    const delta = direction === "up" ? -500 : 500;
    await page.mouse.wheel(0, delta);
    await waitForStability(page);
    return { ref: "page", success: true };
  } catch (err) {
    return { ref: "page", success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function scanAndGetPageInfo(page: Page): Promise<{
  elements: InteractableElement[];
  buttons: InteractableElement[];
  popup: PopupScope | null;
  url: string;
  title: string;
  screenshot?: string;
}> {
  const [scan, title, url] = await Promise.all([
    scanInteractables(page),
    page.title(),
    page.url(),
  ]);
  const scannedButtons = await scanVisibleButtons(page);
  const [elements, buttons] = await Promise.all([
    filterOnScreen(page, scan.elements, REF_ATTR),
    filterOnScreen(page, scannedButtons, BTN_REF_ATTR),
  ]);
  const screenshot = await captureHighlightedScreenshot(page, elements);
  return { elements, buttons, popup: null, url, title, screenshot };
}
