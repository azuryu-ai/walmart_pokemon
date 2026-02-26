/**
 * Walmart Drop Bot — Configuration
 * =================================
 * Edit this file before running the bot.
 */

export const CONFIG = {

  // ── Items (max 5) ──────────────────────────────────────────────────────────
  // Add up to 5 items. Each item runs in its own browser tab concurrently.
  // "name" is just a label used in logs and screenshot filenames.
  items: [
    {
      name: "Item1",
      url: "https://www.walmart.com/ip/YOUR-PRODUCT-ID-1",
      quantity: 1,
    },
    // {
    //   name: "Item2",
    //   url: "https://www.walmart.com/ip/YOUR-PRODUCT-ID-2",
    //   quantity: 1,
    // },
    // {
    //   name: "Item3",
    //   url: "https://www.walmart.com/ip/YOUR-PRODUCT-ID-3",
    //   quantity: 1,
    // },
    // {
    //   name: "Item4",
    //   url: "https://www.walmart.com/ip/YOUR-PRODUCT-ID-4",
    //   quantity: 1,
    // },
    // {
    //   name: "Item5",
    //   url: "https://www.walmart.com/ip/YOUR-PRODUCT-ID-5",
    //   quantity: 1,
    // },
  ],


  // ── Timing ─────────────────────────────────────────────────────────────────
  // ISO 8601 drop time. Bot wakes up `queueLeadSeconds` before this.
  // Use your LOCAL time — include offset if needed, e.g. "2025-12-01T10:00:00-05:00"
  // Leave empty "" to start immediately.
  dropTimeIso: "2025-12-01T10:00:00",

  // How many seconds BEFORE drop time to start polling (default 5)
  queueLeadSeconds: 5,


  // ── Queue settings ─────────────────────────────────────────────────────────
  // How many page-reload attempts to make looking for the ATC button
  queueMaxAttempts: 120,

  // Milliseconds between each poll attempt
  queuePollIntervalMs: 1000,

  // Max minutes to wait inside a queue before giving up
  queueMaxWaitMinutes: 60,


  // ── Browser ────────────────────────────────────────────────────────────────
  // Path to your Chrome profile directory.
  // Using a dedicated WalmartBot profile is recommended.
  // Create this folder manually first, then log into Walmart in it.
  chromeProfilePath: "C:/Users/Dave/AppData/Local/Google/Chrome/WalmartBot",

  // Direct path to Chrome executable
  // Common locations:
  //   "C:/Program Files/Google/Chrome/Application/chrome.exe"
  //   "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"
  chromeExecutable: "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",

  // Run headless (no visible window). Keep false to watch it run.
  headless: false,

  // Keep the browser open after completion so you can verify the result
  keepBrowserOpen: true,


  // ── Safety ─────────────────────────────────────────────────────────────────
  // Set true to do a full dry run — everything except the final "Place Order"
  // click. Screenshots will be saved of each item's order review page.
  dryRun: true,   // ⚠️  Change to false when you're ready to actually buy

};
