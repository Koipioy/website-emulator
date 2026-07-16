import { chromium, type Browser, type Page } from "playwright";

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

  async close(): Promise<void> {
    const page = this.page;
    const browser = this.browser;
    this.page = null;
    this.browser = null;
    this.navigationHandler = null;

    if (page) {
      page.removeAllListeners("framenavigated");
      const context = page.context();
      await Promise.race([
        (async () => {
          await page.close().catch(() => {});
          await context.close().catch(() => {});
        })(),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }

    if (browser) {
      await Promise.race([
        browser.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
  }
}
