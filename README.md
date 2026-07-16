# Website Emulator

Mirror interactable DOM elements from a Playwright-controlled browser onto a local control panel. Interacting on the control panel performs the same action on the real page.

## Quick start

```bash
npm install
npm run dev
```

`npm install` runs `playwright install chromium` automatically. If you see a missing-browser error, run:

```bash
npx playwright install chromium
```

Open http://localhost:3000, enter a URL, and click **Connect**. A headed Chromium window opens with the real site; the control panel lists every interactable element.

## How it works

1. **Playwright** launches a headed Chromium window and navigates to your URL.
2. **Scanner** finds buttons, links, inputs, selects, and ARIA-interactive elements, stamping each with a temporary `data-emulator-ref`.
3. **Control panel** renders those elements as usable controls.
4. **Actions** you take on the panel (click, type, select) are relayed back to the real page via Playwright.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start server + Vite dev client |
| `npm run build` | Build client and compile server |
| `npm start` | Run production build |
| `npm run verify` | Run integration smoke test (uses headless browser) |

Set `HEADLESS=1` to run without a visible browser window (useful in CI). By default the real browser window is shown.

## Security

The server binds to `127.0.0.1` only. Do not expose it to the network.
