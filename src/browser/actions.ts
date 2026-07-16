import type { Page } from "playwright";
import type { InteractableElement } from "../shared/protocol.js";
import { refLocator, scanInteractables } from "./scanner.js";

export interface ActionResult {
  ref: string;
  success: boolean;
  error?: string;
}

async function waitForStability(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(150);
}

export async function clickElement(page: Page, ref: string): Promise<ActionResult> {
  try {
    const locator = refLocator(page, ref);
    await locator.click({ timeout: 5000 });
    await waitForStability(page);
    return { ref, success: true };
  } catch (err) {
    return { ref, success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fillElement(page: Page, ref: string, value: string): Promise<ActionResult> {
  try {
    const locator = refLocator(page, ref);
    await locator.fill(value, { timeout: 5000 });
    return { ref, success: true };
  } catch (err) {
    return { ref, success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function selectElement(page: Page, ref: string, value: string): Promise<ActionResult> {
  try {
    const locator = refLocator(page, ref);
    await locator.selectOption(value, { timeout: 5000 });
    return { ref, success: true };
  } catch (err) {
    return { ref, success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function checkElement(page: Page, ref: string, checked: boolean): Promise<ActionResult> {
  try {
    const locator = refLocator(page, ref);
    if (checked) {
      await locator.check({ timeout: 5000 });
    } else {
      await locator.uncheck({ timeout: 5000 });
    }
    return { ref, success: true };
  } catch (err) {
    return { ref, success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function pressElement(page: Page, ref: string, key: string): Promise<ActionResult> {
  try {
    const locator = refLocator(page, ref);
    await locator.press(key, { timeout: 5000 });
    await waitForStability(page);
    return { ref, success: true };
  } catch (err) {
    return { ref, success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function scanAndGetPageInfo(page: Page): Promise<{
  elements: InteractableElement[];
  url: string;
  title: string;
}> {
  const [elements, title, url] = await Promise.all([
    scanInteractables(page),
    page.title(),
    page.url(),
  ]);
  return { elements, url, title };
}
