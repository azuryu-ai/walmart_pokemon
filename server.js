/**
 * Walmart Drop Bot — Web UI Server
 * =================================
 * Run this instead of walmart_bot.js to use the browser UI.
 *
 *   node server.js
 *
 * Then open http://localhost:5000 in your browser.
 */

import express from 'express';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { CONFIG } from './config.js';
import {
  navigateToProduct as walmartNavigateToProduct,
  waitUntilDropTime as walmartWaitUntilDropTime,
  joinQueue,
  addToCart as walmartAddToCart,
  goToCheckout as walmartGoToCheckout,
  completeCheckout as walmartCompleteCheckout,
  dismissPopups as walmartDismissPopups,
  logger as walmartLogger,
} from './walmart_bot.js';

import {
  navigateToProduct as samsNavigateToProduct,
  waitUntilDropTime as samsWaitUntilDropTime,
  addToCart as samsAddToCart,
  goToCheckout as samsGoToCheckout,
  completeCheckout as samsCompleteCheckout,
  dismissPopups as samsDismissPopups,
  logger as samsLogger,
} from './samsclub_bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── App setup ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── State ─────────────────────────────────────────────────────────────────────

let botRunning = false;
let sseClients = [];   // active SSE connections

// ── Logging (broadcasts to all SSE clients) ───────────────────────────────────

function uiLog(msg, label = 'BOT') {
  const ts = new Date().toISOString().slice(11, 23);
  const entry = `[${ts}] [${label}] ${msg}`;
  console.log(entry);
  broadcast(entry);
}

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { /* client disconnected */ }
  }
}

// Route all bot log calls through uiLog so they appear in the UI's SSE stream
walmartLogger.fn = uiLog;
samsLogger.fn = uiLog;


// ── Routes ────────────────────────────────────────────────────────────────────

// Serve the UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ui.html'));
});

// Start the bot
app.post('/start', async (req, res) => {
  if (botRunning) {
    return res.json({ status: 'error', message: 'Bot is already running.' });
  }

  let { items, drop_time, dry_run, keep_open, bot } = req.body;

  if (!items || !items.length) {
    return res.json({ status: 'error', message: 'No items provided.' });
  }
  if (items.length > 5) items = items.slice(0, 5);

  // Merge UI values over the file config
  const cfg = {
    ...CONFIG,
    items,
    dropTimeIso: drop_time ?? CONFIG.dropTimeIso,
    dryRun: dry_run ?? CONFIG.dryRun,
    keepBrowserOpen: keep_open ?? CONFIG.keepBrowserOpen,
    bot: bot ?? 'walmart',
  };

  botRunning = true;
  uiLog(`Bot started from UI. [${(cfg.bot).toUpperCase()}]`, 'SERVER');

  // Run bot in background (don't await)
  runBotWithConfig(cfg).finally(() => {
    botRunning = false;
    uiLog('Bot finished.', 'SERVER');
  });

  res.json({ status: 'ok', message: 'Bot started.' });
});

// Stop signal
app.post('/stop', (req, res) => {
  botRunning = false;
  uiLog('Stop requested by user.', 'SERVER');
  res.json({ status: 'ok', message: 'Stop signal sent.' });
});

// Status check
app.get('/status', (req, res) => {
  res.json({ running: botRunning });
});

// SSE log stream
app.get('/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);

  // Keepalive ping every 25 seconds
  const keepalive = setInterval(() => {
    try { res.write('data: \n\n'); } catch { /* ignore */ }
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepalive);
    sseClients = sseClients.filter(c => c !== res);
  });
});


// ── Bot runner (used by the web server) ───────────────────────────────────────

async function runBotWithConfig(cfg) {
  const items = cfg.items ?? [];
  const isSams = cfg.bot === 'samsclub';

  const botLabel = isSams ? "Sam's Club Drop Bot" : "Walmart Drop Bot";
  const navigateToProduct = isSams ? samsNavigateToProduct : walmartNavigateToProduct;
  const waitUntilDropTime = isSams ? samsWaitUntilDropTime : walmartWaitUntilDropTime;
  const addToCart = isSams ? samsAddToCart : walmartAddToCart;
  const goToCheckout = isSams ? samsGoToCheckout : walmartGoToCheckout;
  const completeCheckout = isSams ? samsCompleteCheckout : walmartCompleteCheckout;

  uiLog('='.repeat(50));
  uiLog(`  ${botLabel}`);
  uiLog(`  Items   : ${items.length}`);
  for (const [i, item] of items.entries()) {
    uiLog(`    [${i + 1}] ${item.name ?? `Item${i + 1}`} — qty ${item.quantity} — ${item.url}`);
  }
  uiLog(`  Drop at : ${cfg.dropTimeIso || 'Now'}`);
  uiLog(`  Dry run : ${cfg.dryRun ?? false}`);
  uiLog('='.repeat(50));

  const context = await chromium.launchPersistentContext(cfg.chromeProfilePath, {
    executablePath: cfg.chromeExecutable || undefined,
    headless: cfg.headless ?? false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  try {
    const pages = [];
    for (const [i, item] of items.entries()) {
      const label = item.name ?? `Item${i + 1}`;
      const page = context.pages()[i] ?? await context.newPage();
      pages.push(page);
      await navigateToProduct(page, item.url, label);
      uiLog('Tab ready — waiting for drop time.', label);
    }

    await waitUntilDropTime(cfg.dropTimeIso ?? '', cfg.queueLeadSeconds ?? 5);
    uiLog('Drop time! Starting all tabs concurrently...', 'BOT');

    async function runItem(page, item, index) {
      const label = item.name ?? `Item${index + 1}`;
      try {
        if (!isSams) {
          const inQueue = await joinQueue(page, cfg, item, label);
          if (!inQueue) { uiLog('❌ Failed to reach Add to Cart.', label); return; }
        }

        const added = await addToCart(page, item.quantity, label);
        if (!added) { uiLog('❌ Failed to add to cart.', label); return; }

        const checkedOut = await goToCheckout(page, label, item.quantity);
        if (!checkedOut) { uiLog('❌ Failed to reach checkout.', label); return; }

        await completeCheckout(page, cfg, label);
      } catch (e) {
        uiLog(`💥 Error: ${e.message}`, label);
      }
    }

    await Promise.all(items.map((item, i) => runItem(pages[i], item, i)));
    uiLog('✅ All items processed.', 'BOT');

  } catch (e) {
    uiLog(`💥 Main error: ${e.message}`, 'BOT');
  } finally {
    if (!(cfg.keepBrowserOpen ?? true)) {
      await context.close();
    } else {
      uiLog('Keeping browser open. Close manually when done.', 'BOT');
    }
  }
}


// ── Start server ──────────────────────────────────────────────────────────────

const PORT = 5000;
app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('  Drop Bot UI (Walmart + Sam\'s Club)');
  console.log(`  Open http://localhost:${PORT} in your browser`);
  console.log('='.repeat(50));
});
