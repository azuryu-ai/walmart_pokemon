/**
 * Drop Bot — Web UI Server
 * ========================
 * Supports both Walmart and Sam's Club bots.
 *
 *   node server.js
 *
 * Then open http://localhost:5000 in your browser.
 */

import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

import {
  navigateToProduct as walmartNavigateToProduct,
  waitUntilDropTime as walmartWaitUntilDropTime,
  joinQueue,
  addToCart as walmartAddToCart,
  goToCheckout as walmartGoToCheckout,
  completeCheckout as walmartCompleteCheckout,
  logger as walmartLogger,
} from './walmart_bot.js';

import {
  navigateToProduct as samsNavigateToProduct,
  waitUntilDropTime as samsWaitUntilDropTime,
  waitForAddToCart,
  addToCart as samsAddToCart,
  goToCheckout as samsGoToCheckout,
  completeCheckout as samsCompleteCheckout,
  logger as samsLogger,
} from './samsclub_bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── App setup ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── State ─────────────────────────────────────────────────────────────────────

let botRunning = false;
let sseClients = [];

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

  let { items, drop_time, dry_run, keep_open, bot, chrome_profile, chrome_executable, headless } = req.body;

  if (!items || !items.length) {
    return res.json({ status: 'error', message: 'No items provided.' });
  }
  if (items.length > 5) items = items.slice(0, 5);

  const cfg = {
    items,
    bot: bot ?? 'walmart',
    dropTimeIso: drop_time ?? '',
    dryRun: dry_run ?? false,
    keepBrowserOpen: keep_open ?? true,
    chromeProfilePath: chrome_profile ?? '',
    chromeExecutable: chrome_executable ?? '',
    headless: headless ?? false,
    queueLeadSeconds: req.body.queue_lead_seconds ?? 5,
    queueMaxAttempts: req.body.queue_max_attempts ?? 120,
    queuePollIntervalMs: req.body.queue_poll_interval_ms ?? 1000,
    queueMaxWaitMinutes: req.body.queue_max_wait_minutes ?? 30,
  };

  botRunning = true;
  uiLog(`Bot started from UI. [${cfg.bot.toUpperCase()}]`, 'SERVER');

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

  const keepalive = setInterval(() => {
    try { res.write('data: \n\n'); } catch { /* ignore */ }
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepalive);
    sseClients = sseClients.filter(c => c !== res);
  });
});


// ── Bot runner ────────────────────────────────────────────────────────────────

async function runBotWithConfig(cfg) {
  const items = cfg.items ?? [];
  const isSams = cfg.bot === 'samsclub';

  const botLabel = isSams ? "Sam's Club Drop Bot" : "Walmart Drop Bot";
  const navigateToProduct = isSams ? samsNavigateToProduct : walmartNavigateToProduct;
  const waitUntilDropTime = isSams ? samsWaitUntilDropTime : walmartWaitUntilDropTime;
  const addToCart         = isSams ? samsAddToCart         : walmartAddToCart;
  const goToCheckout      = isSams ? samsGoToCheckout      : walmartGoToCheckout;
  const completeCheckout  = isSams ? samsCompleteCheckout  : walmartCompleteCheckout;

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
        if (isSams) {
          // Sam's Club: poll for ATC button, then add to cart and checkout
          const ready = await waitForAddToCart(page, cfg, label);
          if (!ready) { uiLog('❌ Failed to reach Add to Cart.', label); return; }

          const added = await addToCart(page, item.quantity, label);
          if (!added) { uiLog('❌ Failed to add to cart.', label); return; }

          const checkedOut = await goToCheckout(page, label, item.quantity);
          if (!checkedOut) { uiLog('❌ Failed to reach checkout.', label); return; }
        } else {
          // Walmart: join queue, then add to cart and checkout
          const inQueue = await joinQueue(page, cfg, item, label);
          if (!inQueue) { uiLog('❌ Failed to reach Add to Cart.', label); return; }

          const added = await addToCart(page, item.quantity, label);
          if (!added) { uiLog('❌ Failed to add to cart.', label); return; }

          const checkedOut = await goToCheckout(page, label, item.quantity);
          if (!checkedOut) { uiLog('❌ Failed to reach checkout.', label); return; }
        }

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
