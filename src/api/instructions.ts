export function buildInstructionsPrompt(baseUrl: string): string {
  return `You control a live browser through the Website Emulator HTTP API at ${baseUrl}.

## Prerequisite

An active browser session is required before any API call will work. Open the Website Emulator web UI, enter a URL, and click Connect. All API endpoints return 503 until a page is loaded.

## Workflow

1. Get a screenshot to see the page with numbered visible elements.
2. Get the element list to read labels, refs, and allowed actions.
3. Execute an action on an element by ref or number.
4. Repeat from step 1 after actions that change the page.

## 1. Screenshot

GET ${baseUrl}/api/screenshot

Returns a JPEG image of the current page. Visible tabbable elements are outlined and labeled with their number (#1, #2, …). Use these numbers to match elements in the element list or when calling the action API.

By default this returns the latest cached scan (same data the web UI shows). Add ?refresh=1 to force a new scan.

- Success: 200, Content-Type image/jpeg
- No session: 503, JSON { "error": "No active browser session" }

Example:
curl -o screenshot.jpg ${baseUrl}/api/screenshot
curl -o screenshot.jpg "${baseUrl}/api/screenshot?refresh=1"

## 2. Elements

GET ${baseUrl}/api/elements

Returns JSON describing the current page and every visible interactable element. By default returns the cached scan; add ?refresh=1 to force a new scan. The response includes "cached": true when served from cache.

Response shape:
{
  "url": "https://example.com",
  "title": "Example Domain",
  "elements": [
    {
      "number": 1,
      "ref": "e1",
      "role": "link",
      "label": "More information...",
      "href": "https://www.iana.org/domains/example",
      "disabled": false,
      "bounds": { "x": 100, "y": 200, "width": 120, "height": 20 },
      "actions": [
        { "type": "click", "description": "Click the element" },
        { "type": "scroll", "description": "Scroll the element into view" }
      ]
    }
  ],
  "buttons": []
}

- elements: visible tabbable controls in tab order (numbered in the screenshot)
- buttons: visible on-screen buttons (separate list, also numbered)
- Each item includes an actions array listing what you may do; only use actions listed there
- Identify elements by ref, id (alias for ref), or number (matches screenshot labels)

- Success: 200, Content-Type application/json
- No session: 503, JSON { "error": "No active browser session" }

Example:
curl ${baseUrl}/api/elements

## 3. Action

POST ${baseUrl}/api/action
Content-Type: application/json

Execute an action on an element. On success the page is rescanned automatically.

Request body:
{
  "ref": "e1",
  "action": "click"
}

You may identify the element with any one of:
- ref: element reference from /api/elements
- id: alias for ref
- number: screenshot label (#1, #2, …)

Supported actions:
- click — no extra fields
- fill — requires value (string)
- select — requires value (string, option value)
- check — requires checked (boolean)
- press — requires key (string, e.g. "Enter")
- scroll — scroll element into view

Examples:
curl -X POST ${baseUrl}/api/action -H "Content-Type: application/json" -d '{"number": 1, "action": "click"}'
curl -X POST ${baseUrl}/api/action -H "Content-Type: application/json" -d '{"ref": "e3", "action": "fill", "value": "hello"}'
curl -X POST ${baseUrl}/api/action -H "Content-Type: application/json" -d '{"ref": "e4", "action": "check", "checked": true}'

Response:
{ "ref": "e1", "success": true }
{ "ref": "e1", "success": false, "error": "..." }

Status codes:
- 200 — action completed (check success field)
- 400 — invalid request (missing ref/number, unknown action, missing parameters)
- 503 — no active browser session

## Tips

- Prefer number when matching screenshot labels; prefer ref when you already fetched /api/elements.
- /api/screenshot and /api/elements are instant when served from cache. POST /api/action refreshes the cache after a successful action. Use ?refresh=1 when you need a guaranteed fresh scan.
- Disabled elements only support scroll.
- The server binds to localhost only; do not expose it to the network.`;
}
