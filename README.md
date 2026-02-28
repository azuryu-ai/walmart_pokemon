# Drop Bot (Node.js)

Automates product drops on **Walmart** and **Sam's Club** — waiting through queues, adding to cart, and completing checkout using your existing Chrome profile so you don't need to re-login or re-enter payment info.

---

## Supported Stores

| Store | Queue System | Notes |
|-------|-------------|-------|
| Walmart | ✅ Queue polling | Joins virtual queue at drop time |
| Sam's Club | ❌ None | Polls for Add to Cart button to go live |

---

## Setup

### 1. Install Node.js

Download and install Node.js (v18 or newer) from https://nodejs.org

### 2. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 3. Find your Chrome profile path

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

### 4. Make sure you're logged in

Open Chrome with your normal profile, log into your store, and ensure:
- You're logged in
- You have a saved shipping address
- You have a saved payment method set as default

Then **close Chrome completely**.

---

## Running

```bash
node server.js
```

Then open **http://localhost:5000** in your browser.

---

## Web UI

The UI is the only way to run the bot. All configuration is done through the browser — no config files to edit.

### Bot Selection
Use the **Bot Selection** dropdown at the top to choose between **Walmart Bot** and **Sam's Club Bot**. The UI will update the header and SKU placeholder text to match the selected store.

### Drop Time
Set the scheduled drop time in your local timezone. Leave it blank to start the bot immediately.

### Product SKUs
Enter the SKU/item number for each product (up to 5). The bot will open a separate browser tab for each item and run them all concurrently.

- Walmart URL: `https://www.walmart.com/ip/SKU`
- Sam's Club URL: `https://www.samsclub.com/ip/SKU`

### Browser Settings
Configure your Chrome paths and browser behavior:

| Field | Description |
|-------|-------------|
| **Chrome Profile Path** | Path to your Chrome profile directory (see Setup above). The bot uses this to access your saved login, address, and payment info. |
| **Chrome Executable Path** | Full path to your `chrome.exe` or Chrome binary. Leave blank to use the system default. |
| **Headless** | When enabled, Chrome runs invisibly in the background with no visible window. Disable to watch the bot run and intervene manually if needed. |

> 💾 **Settings are automatically saved.** Chrome paths, bot selection, and all toggles are persisted in your browser's local storage and restored every time you open the UI — no need to re-enter them.

### Options

| Toggle | Description |
|--------|-------------|
| **Dry Run** | Runs the full bot flow but skips the final Place Order click. Use this to verify everything works before a real drop. A screenshot of the order review page will be saved. |
| **Keep Browser Open** | Leaves the browser window open after the bot finishes so you can verify the result. |

### Launching
Click **▶ LAUNCH BOT** to start. The right panel streams live log output from the bot in real time. Click **■ STOP** to abort.

---

## Output files

| File | When created |
|------|-------------|
| `order_confirmation_<n>.png` | Screenshot after successful order |
| `dry_run_<n>.png` | Screenshot of order review page during dry run |
| `cart_debug_<n>.png` | Screenshot if checkout button not found |
| `atc_failed_<n>.png` | Screenshot if Add to Cart button not found |
| `error_<n>.png` | Screenshot if an unhandled error occurs |

---

## Tips

- **Always do a dry run first.** Enable Dry Run, launch the bot, and confirm it reaches the order review page and takes a screenshot. Then disable it for the real drop.
- **`headless: false`** (Headless toggle off) lets you watch the bot run and intervene manually if needed.
- The bot retries every step indefinitely — if an error popup appears it will be dismissed automatically and the step retried until it succeeds.
- For Sam's Club, the bot has no queue to join — it reloads the product page until the **Add to Cart** button goes live at drop time.
