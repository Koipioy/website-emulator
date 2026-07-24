export function buildInstructionsPrompt(baseUrl: string): string {
  return `You control a live browser through the Website Emulator HTTP API at ${baseUrl}.

## Workflow

1. POST /api/act with { "action": "navigate", "url": "..." } to open a page (does not scan).
2. GET /api/state to scan: highlighted screenshot + interactable elements + choices.
3. POST /api/act with one of the choice commands.
4. GET /api/state again whenever you need an updated screenshot and element list.

The page is never auto-scanned. Only GET /api/state rescans.

## 1. State

GET ${baseUrl}/api/state

Rescans the live page. Returns JSON with:
- url, title
- screenshot — data:image/jpeg;base64,... with numbered outlines (#1, #2, …)
- elements / buttons — interactables with id, description, and available actions
- choices — commands you can POST to /api/act unchanged (except edit values like url, value, or checked)
- cached — always false for this endpoint

Example response:
{
  "url": "https://example.com",
  "title": "Example Domain",
  "screenshot": "data:image/jpeg;base64,...",
  "elements": [
    {
      "id": 1,
      "description": "Link: More information... · https://www.iana.org/domains/example",
      "actions": [
        { "type": "click", "description": "Click the element" },
        { "type": "scroll", "description": "Scroll the element into view" }
      ]
    }
  ],
  "buttons": [],
  "popup": null,
  "choices": [
    { "action": "scroll-up" },
    { "action": "scroll-down" },
    { "action": "navigate", "url": "https://example.com" },
    { "id": 1, "action": "click" },
    { "id": 1, "action": "scroll-into-view" }
  ],
  "cached": false
}

Without an active session this returns HTTP 503.

Example:
curl ${baseUrl}/api/state

## 2. Choices (cached)

GET ${baseUrl}/api/choices

Returns the last scanned choices without rescanning. Call GET /api/state first.

With no active session, choices only includes navigate:
{ "action": "navigate", "url": "https://example.com" }

Example:
curl ${baseUrl}/api/choices

## 3. Screenshot (cached)

GET ${baseUrl}/api/screenshot

Returns the last scanned JPEG. Call GET /api/state first to capture a new one.

Example:
curl -o screenshot.jpg ${baseUrl}/api/screenshot

## 4. Act

POST ${baseUrl}/api/act
Content-Type: application/json

Execute one command from /api/state. Does not rescan — call GET /api/state afterward for an updated screenshot and choices.

Page commands:
{ "action": "scroll-up" }
{ "action": "scroll-down" }
{ "action": "navigate", "url": "https://google.com" }

Element commands (id matches screenshot number):
{ "id": 1, "action": "click" }
{ "id": 2, "action": "fill", "value": "hello" }
{ "id": 3, "action": "select", "value": "option-value" }
{ "id": 4, "action": "check", "checked": true }
{ "id": 5, "action": "press", "key": "Enter" }
{ "id": 6, "action": "scroll-into-view" }

Response:
{
  "success": true,
  "url": "https://example.com",
  "title": "Example Domain",
  "choices": [ ... ]
}

Examples:
curl -X POST ${baseUrl}/api/act -H "Content-Type: application/json" -d '{"action":"navigate","url":"https://example.com"}'
curl -X POST ${baseUrl}/api/act -H "Content-Type: application/json" -d '{"id":1,"action":"click"}'
curl -X POST ${baseUrl}/api/act -H "Content-Type: application/json" -d '{"action":"scroll-down"}'

## Tips

- Start with navigate, then always GET /api/state before acting on elements.
- Only POST commands that appear in the latest /api/state response.
- /api/act and /api/choices do not refresh the page scan.
- The server binds to localhost only; do not expose it to the network.`;
}
