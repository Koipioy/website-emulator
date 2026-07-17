import { chromium, type Browser, type Page } from "playwright";
import { formatUserError } from "../shared/errors.js";

const CLOSE_TIMEOUT_MS = 800;

export class BrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private navigationHandler: (() => void) | null = null;

  get active(): boolean {
    return this.page !== null;
  }

  getPage(): Page | null {
    return this.page;
  }

  async navigate(url: string, onNavigate?: () => void): Promise<Page> {
    await this.close();

    this.browser = await chromium.launch({
      headless: process.env.HEADLESS === "1",
      handleSIGINT: false,
      handleSIGTERM: false,
    }).catch((err) => {
      throw new Error(formatUserError(err));
    });
    const context = await this.browser.newContext();
    this.page = await context.newPage();

    if (onNavigate) {
      this.navigationHandler = onNavigate;
      this.page.on("framenavigated", (frame) => {
        if (frame === this.page?.mainFrame()) {
          onNavigate();
        }
      });
    }

    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return this.page;
  }

  async closeFast(): Promise<void> {
    const page = this.page;
    const browser = this.browser;
    const browserProcess =
      browser && "process" in browser && typeof browser.process === "function"
        ? browser.process()
        : null;

    this.page = null;
    this.browser = null;
    this.navigationHandler = null;

    if (page) {
      page.removeAllListeners("framenavigated");
    }

    if (browserProcess && browserProcess.exitCode === null) {
      try {
        browserProcess.kill("SIGKILL");
      } catch {
        // Process may already be gone.
      }
    }

    await browser?.close().catch(() => {});
  }

  async close(): Promise<void> {
    const page = this.page;
    const browser = this.browser;
    const browserProcess =
      browser && "process" in browser && typeof browser.process === "function"
        ? browser.process()
        : null;

    this.page = null;
    this.browser = null;
    this.navigationHandler = null;

    if (page) {
      page.removeAllListeners("framenavigated");
    }

    await Promise.race([
      (async () => {
        try {
          if (page) {
            const context = page.context();
            await page.close({ runBeforeUnload: false });
            await context.close();
          }
          if (browser) {
            await browser.close();
          }
        } catch {
          // Best-effort graceful shutdown.
        }
      })(),
      new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
    ]);

    if (browserProcess && browserProcess.exitCode === null) {
      try {
        browserProcess.kill("SIGKILL");
      } catch {
        // Process may already be gone.
      }
    }
  }
}
