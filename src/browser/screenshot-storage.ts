import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SCREENSHOT_FILENAME = "latest.jpg";

function screenshotDir(): string {
  return process.env.SCREENSHOT_DIR?.trim() || path.join(os.homedir(), ".website-emulator", "screenshots");
}

export async function saveScreenshot(buffer: Buffer): Promise<string> {
  const dir = screenshotDir();
  await mkdir(dir, { recursive: true });
  const filePath = path.resolve(dir, SCREENSHOT_FILENAME);
  await writeFile(filePath, buffer);
  return filePath;
}
