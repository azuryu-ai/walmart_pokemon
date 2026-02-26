# Walmart Drop Bot (Node.js)

Automates joining a Walmart product drop, waiting through the queue, adding to cart, and completing checkout — using your existing Chrome profile so you don't need to re-login or re-enter payment info.

---

## Setup

### 1. Install Node.js

Download and install Node.js (v18 or newer) from https://nodejs.org

### 2. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 3. Configure

Edit `config.js`:

| Key | Description |
|-----|-------------|
| `items` | Array of up to 5 `{ name, url, quantity }` objects |
| `dropTimeIso` | Drop time in ISO 8601 format, e.g. `"2025-12-01T10:00:00-05:00"` |
| `queueLeadSeconds` | Seconds before drop time to start polling (default `5`) |
| `queueMaxAttempts` | How many reload attempts before giving up on the ATC button |
| `queuePollIntervalMs` | Milliseconds between poll attempts (default `1000`) |
| `queueMaxWaitMinutes` | Max time to wait inside a queue (default `30`) |
| `chromeProfilePath` | Path to your Chrome profile directory (see below) |
| `chromeExecutable` | Full path to your Chrome `.exe` |
| `headless` | `false` = visible browser window, `true` = headless |
| `keepBrowserOpen` | Leave browser open after completion to verify result |
| `dryRun` | `true` = skip final Place Order click (safe testing mode) |

### 4. Find your Chrome profile path

**macOS**
```
/Users/YOUR_NAME/Library/Application Support/Google/Chrome
```

**Windows**
```
C:\Users\YOUR_NAME\AppData\Local\Google\Chrome\User Data
```

**Linux**
```
/home/YOUR_NAME/.config/google-chrome
```

> ⚠️ **Chrome must be fully closed before running the bot.** Chrome locks its profile directory while running — the bot will fail or open a blank session if Chrome is open.

### 5. Make sure you're logged into Walmart

Open Chrome with your normal profile, log into walmart.com, and ensure:
- You're logged in
- You have a saved shipping address
- You have a saved payment method set as default

Then **close Chrome completely**.

---

## Running

### Option A — Web UI (recommended)

```bash
node server.js
```

Then open **http://localhost:5000** in your browser. Configure your items and drop time in the UI and click **Launch Bot**.

### Option B — Command line

```bash
node walmart_bot.js
```

Reads directly from `config.js`.

---

## Output files

| File | When created |
|------|-------------|
| `order_confirmation_<name>.png` | Screenshot after successful order |
| `dry_run_<name>.png` | Screenshot of review page during dry run |
| `cart_debug_<name>.png` | Screenshot if checkout button not found |
| `error_<name>.png` | Screenshot if an unhandled error occurs |

---

## Tips

- **Do a dry run first.** Set `dryRun: true` in `config.js`, run the bot, and confirm it reaches the order review page and takes a screenshot. Then set it to `false` for the real drop.
- **`queuePollIntervalMs: 500`** is more aggressive polling if you want to shave time.
- **`headless: false`** lets you watch the bot run and intervene manually if needed.
- The bot is resilient — if selectors fail it tries multiple fallback selectors before giving up.
