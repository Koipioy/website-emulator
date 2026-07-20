export function buildInstructionsPrompt(baseUrl: string): string {
  return `You control a live browser through the Website Emulator HTTP API at ${baseUrl}.

## Workflow

1. GET /api/choices to see every command you can run, copied verbatim into POST /api/act.
2. GET /api/screenshot to see numbered elements on the page.
3. POST /api/act with one of the choice commands.
4. Repeat from step 1. /api/act returns refreshed choices after each successful command.

## 1. Choices

GET ${baseUrl}/api/choices

Lists every valid command for the current page as JSON objects you can POST to /api/act unchanged (except edit values like url, value, or checked).

Example response:
{
  "url": "https://example.com",
  "title": "Example Domain",
  "cached": true,
  "choices": [
    { "action": "scroll-up" },
    { "action": "scroll-down" },
    { "action": "navigate", "url": "https://example.com" },
    { "element": 1, "action": "click" },
    { "element": 1, "action": "scroll-into-view" }
  ]
}

With no active session, choices only includes navigate:
{ "action": "navigate", "url": "https://example.com" }

Add ?refresh=1 to force a new scan before listing choices.

Example:
curl ${baseUrl}/api/choices

## 2. Screenshot

GET ${baseUrl}/api/screenshot

Returns a JPEG with visible tabbable elements outlined and numbered (#1, #2, …). Match element numbers to commands in /api/choices.

By default returns the cached screenshot. Add ?refresh=1 to force a new capture.

Example:
curl -o screenshot.jpg ${baseUrl}/api/screenshot

## 3. Act

POST ${baseUrl}/api/act
Content-Type: application/json

Execute one command from /api/choices. On success, the page is rescanned and the response includes updated choices.

Page commands:
{ "action": "scroll-up" }
{ "action": "scroll-down" }
{ "action": "navigate", "url": "https://google.com" }

Element commands (element matches screenshot number):
{ "element": 1, "action": "click" }
{ "element": 2, "action": "fill", "value": "hello" }
{ "element": 3, "action": "select", "value": "option-value" }
{ "element": 4, "action": "check", "checked": true }
{ "element": 5, "action": "press", "key": "Enter" }
{ "element": 6, "action": "scroll-into-view" }

Response:
{
  "success": true,
  "url": "https://example.com",
  "title": "Example Domain",
  "choices": [ ... ]
}

Examples:
curl -X POST ${baseUrl}/api/act -H "Content-Type: application/json" -d '{"action":"navigate","url":"https://example.com"}'
curl -X POST ${baseUrl}/api/act -H "Content-Type: application/json" -d '{"element":1,"action":"click"}'
curl -X POST ${baseUrl}/api/act -H "Content-Type: application/json" -d '{"action":"scroll-down"}'

## Tips

- Start with { "action": "navigate", "url": "..." } — no web UI required.
- Only POST commands that appear in /api/choices.
- /api/act refreshes choices after success; use GET /api/screenshot to see the updated page image.
- The server binds to localhost only; do not expose it to the network.`;
}
