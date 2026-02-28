# Drop Bot (Node.js)

Automates product drops on **Walmart** and **Sam's Club** — waiting through queues, adding to cart, and completing checkout using your existing Chrome profile so you don't need to re-login or re-enter payment info.

---

## Supported Stores

| Store | Bot File | Queue System | Notes |
|-------|----------|-------------|-------|
| Walmart | `walmart_bot.js` | ✅ Queue polling | Joins virtual queue at drop time |
| Sam's Club | `samsclub_bot.js` | ❌ None | Polls for Add to Cart button to go live |

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
| `queueMaxWaitMinutes` | Max time to wait inside a queue (default `30`) — Walmart only |
| `chromeProfilePath` | Path to your Chrome profile directory (see below) |
| `chromeExecutable` | Full path to your Chrome `.exe` |
| `headless` | `false` = visible browser window, `true` = headless |
| `keepBrowserOpen` | Leave browser open after completion to verify result |
| `dryRun` | `true` = skip final Place Order click (safe testing mode) |

**Item URLs by store:**
- Walmart: `https://www.walmart.com/ip/SKU`
- Sam's Club: `https://www.samsclub.com/ip/SKU`

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

### 5. Make sure you're logged in

Open Chrome with your normal profile, log into your store, and ensure:
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

Then open **http://localhost:5000** in your browser. Use the **Bot Selection** dropdown to choose between Walmart and Sam's Club, configure your items and drop time, and click **Launch Bot**.

### Option B — Command line (Walmart)

```bash
node walmart_bot.js
```

### Option C — Command line (Sam's Club)

```bash
node samsclub_bot.js
```

Both read directly from `config.js`.

---

## Output files

| File | When created |
|------|-------------|
| `order_confirmation_<n>.png` | Screenshot after successful order |
| `dry_run_<n>.png` | Screenshot of review page during dry run |
| `cart_debug_<n>.png` | Screenshot if checkout button not found |
| `atc_failed_<n>.png` | Screenshot if Add to Cart button not found |
| `error_<n>.png` | Screenshot if an unhandled error occurs |

---

## Tips

- **Do a dry run first.** Set `dryRun: true` in `config.js`, run the bot, and confirm it reaches the order review page and takes a screenshot. Then set it to `false` for the real drop.
- **`queuePollIntervalMs: 500`** is more aggressive polling if you want to shave time off queue detection.
- **`headless: false`** lets you watch the bot run and intervene manually if needed.
- The bot is resilient — if selectors fail it tries multiple fallback selectors and a JS `evaluate()` fallback before giving up.
- For Sam's Club, the bot has no queue to join — it simply reloads the product page until the **Add to Cart** button goes live at drop time.
