export function formatUserError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  if (message.includes("Executable doesn't exist") || message.includes("playwright install")) {
    return "Chromium is not installed. Run: npx playwright install chromium";
  }

  if (message.includes("ECONNREFUSED") || message.includes("ENOTFOUND")) {
    return "Could not reach the website. Check the URL and your network connection.";
  }

  const firstLine = message.split("\n")[0]?.trim() ?? message;
  return firstLine.length > 240 ? `${firstLine.slice(0, 237)}...` : firstLine;
}
