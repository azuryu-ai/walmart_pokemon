/**
 * Walmart Drop Bot
 * ================
 * Automates joining a Walmart product drop queue, adding to cart,
 * and completing checkout using your existing Chrome profile.
 * Supports up to 5 items running concurrently in separate tabs.
 *
 * Requirements:
 *   npm install
 *   npx playwright install chromium
 *
 * Usage:
 *   1. Edit config.js with your items, drop time, and Chrome profile path.
 *   2. Run: node walmart_bot.js
 */

import { chromium } from 'playwright';
import { CONFIG } from './config.js';
import { writeFileSync } from 'fs';

// ── Logging ───────────────────────────────────────────────────────────────────
// Using a mutable object so server.js can swap the implementation at runtime
// without hitting ES module read-only binding restrictions.

export const logger = {
  fn: (msg, label = 'MAIN') => {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    console.log(`[${ts}] [${label}] ${msg}`);
  }
};

// Shorthand used throughout this file
const log = (msg, label) => logger.fn(msg, label);


// ── Helpers ───────────────────────────────────────────────────────────────────

export async function waitUntilDropTime(dropTimeIso, leadSeconds = 5) {
  if (!dropTimeIso) {
    log('No drop time set — starting immediately.');
    return;
  }

  const dropDt = new Date(dropTimeIso);
  const waitMs = dropDt.getTime() - Date.now() - (leadSeconds * 1000);

  if (waitMs > 0) {
    log(`Drop at ${dropDt.toLocaleString()} — waiting ${(waitMs / 1000).toFixed(1)}s (waking ${leadSeconds}s early)...`);
    await sleep(waitMs);
    log('Waking up — drop is imminent!');
  } else {
    log('Drop time already passed or imminent — starting now.');
  }
}

export async function dismissPopups(page) {
  const selectors = [
    "button[data-automation-id='close-modal']",
    "button[aria-label='Close dialog']",
    '#onetrust-accept-btn-handler',
    'button.modal-close-btn',
  ];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click();
      }
    } catch {
      // ignore
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ── Core steps ────────────────────────────────────────────────────────────────

export async function navigateToProduct(page, url, label) {
  log(`Navigating to: ${url}`, label);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissPopups(page);
  log('Product page loaded.', label);
}


export async function joinQueue(page, cfg, item, label) {
  /**
   * Refresh the product page and detect when we've entered the queue.
   * Queue detection uses multiple signals since the exact button text varies.
   * Once in the queue, hands off to waitInQueue which polls WITHOUT reloading —
   * Walmart auto-redirects back to the product page when your turn comes.
   */
  const atcSelectors = [
    "button[data-automation-id='atc-button']",
    "button[class*='add-to-cart']",
    "button[data-tl-id='ProductPrimaryCTA-cta_add_to_cart_button']",
    "button:has-text('Add to cart')",
  ];

  // Multiple signals that indicate we're in the queue.
  // Walmart's exact button text and page structure can vary by drop.
  const queueSelectors = [
    "button:has-text('Hold my spot')",           // partial match — covers variants
    "button:has-text('hold my spot')",
    "[data-automation-id='queue-hold-spot-btn']",
    "[data-automation-id='holding-page-cta']",
    "button:has-text('Leave queue')",
    "button:has-text('You are in line')",
    "[class*='queue']",                           // any element with 'queue' in class
  ];

  const maxJoinAttempts = 30;

  log('Refreshing page to join queue...', label);

  for (let attempt = 1; attempt <= maxJoinAttempts; attempt++) {
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await dismissPopups(page);

      // Log current URL each attempt to help debug selector misses
      log(`Page URL: ${page.url()}`, label);

      // Check if we landed directly on ATC (no queue this drop)
      for (const sel of atcSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 800 })) {
            log('✅ Add to Cart available immediately — no queue!', label);
            return true;
          }
        } catch {
          // try next selector
        }
      }

      // Check all queue indicator signals
      for (const sel of queueSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 800 })) {
            const text = await el.innerText().catch(() => sel);
            log(`✅ Queue detected via: "${text.trim().slice(0, 60)}" (attempt ${attempt})`, label);
            log('Waiting for Walmart to redirect back to product page...', label);
            return await waitInQueue(page, atcSelectors, cfg, label);
          }
        } catch {
          // try next signal
        }
      }

      // Walmart queue pages land on /qp?qpdata=... with queued:true in the payload
      const url = page.url();
      const urlObj = new URL(url);
      if (urlObj.pathname === '/qp') {
        try {
          const qpdata = JSON.parse(decodeURIComponent(urlObj.searchParams.get('qpdata') || '{}'));
          if (qpdata.queued === true) {
            const itemName = qpdata.customMetadata?.item?.name ?? 'unknown item';
            log(`✅ Queue confirmed via /qp URL — queued: true — "${itemName}"`, label);
            log('Waiting for Walmart to redirect back to product page...', label);
            return await waitInQueue(page, atcSelectors, cfg, label);
          }
        } catch {
          // qpdata malformed — still treat /qp path as a queue signal
          log(`✅ Queue detected via /qp URL (could not parse qpdata)`, label);
          return await waitInQueue(page, atcSelectors, cfg, label);
        }
      }

      // Dump all visible button texts on first attempt to help diagnose missed selectors
      if (attempt === 1) {
        try {
          const allBtns = await page.locator('button').all();
          const texts = [];
          for (const b of allBtns) {
            const t = await b.innerText().catch(() => '');
            if (t.trim()) texts.push(`"${t.trim().slice(0, 40)}"`);
          }
          if (texts.length) log(`Visible buttons: ${texts.join(', ')}`, label);
        } catch { /* non-fatal */ }
      }

    } catch (e) {
      log(`Attempt ${attempt} error: ${e.message}`, label);
    }

    if (attempt < maxJoinAttempts) {
      log(`Queue not detected yet — retrying... (${attempt}/${maxJoinAttempts})`, label);
      await sleep(1000);
    }
  }

  log('❌ Could not detect queue entry after 30 seconds.', label);
  return false;
}


async function waitInQueue(page, atcSelectors, cfg, label) {
  // Do NOT reload here — Walmart auto-redirects the page when your turn comes.
  // We just poll the current DOM until the ATC button appears.
  const maxWait = (cfg.queueMaxWaitMinutes ?? 30) * 60 * 1000;
  const pollInterval = cfg.queuePollIntervalMs ?? 2000;
  let elapsed = 0;

  log(`Polling for ATC button every ${pollInterval}ms (up to ${maxWait / 60000} min)...`, label);

  while (elapsed < maxWait) {
    for (const sel of atcSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          log('✅ Through the queue — Add to Cart is live!', label);
          return true;
        }
      } catch {
        // not visible yet, keep waiting
      }
    }

    await sleep(pollInterval);
    elapsed += pollInterval;

    if (Math.floor(elapsed / 1000) % 30 === 0) {
      log(`Still in queue... (${Math.floor(elapsed / 1000)}s elapsed)`, label);
    }
  }

  log('❌ Queue wait timed out.', label);
  return false;
}


export async function addToCart(page, quantity, label) {
  log(`Adding ${quantity}x to cart...`, label);

  const qtySelectors = [
    "input[data-automation-id='quantity-input']",
    "input[id*='quantity']",
    "select[data-automation-id='quantity-select']",
    "select[id*='quantity']",
  ];

  for (const sel of qtySelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        const tag = await el.evaluate(el => el.tagName.toLowerCase());
        if (tag === 'select') {
          await el.selectOption(String(quantity));
        } else {
          await el.click({ clickCount: 3 });
          await el.type(String(quantity));
        }
        log(`Quantity set to ${quantity}`, label);
        break;
      }
    } catch {
      // try next
    }
  }

  const atcSelectors = [
    "button[data-automation-id='atc-button']",
    "button[data-tl-id='ProductPrimaryCTA-cta_add_to_cart_button']",
    "button:has-text('Add to cart')",
  ];

  for (const sel of atcSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        log('✅ Clicked Add to Cart!', label);
        await sleep(2000);
        return true;
      }
    } catch {
      // try next
    }
  }

  log('❌ Could not click Add to Cart.', label);
  return false;
}


export async function goToCheckout(page, label) {
  log('Navigating to cart...', label);

  const cartSelectors = [
    "a[href*='/cart']",
    "button:has-text('View cart')",
    "button:has-text('Go to cart')",
    "[data-automation-id='cart-icon-btn']",
  ];

  let navigated = false;
  for (const sel of cartSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        await page.waitForLoadState('domcontentloaded');
        log('In cart.', label);
        navigated = true;
        break;
      }
    } catch {
      // try next
    }
  }

  if (!navigated) {
    log('Cart button not found — navigating directly to /cart', label);
    await page.goto('https://www.walmart.com/cart', { waitUntil: 'domcontentloaded' });
  }

  await dismissPopups(page);
  log('Waiting for cart to fully load...', label);
  await sleep(3000);

  const checkoutSelectors = [
    "button[data-automation-id='checkout']",
    "button[id='Continue to checkout button']",
    "button:has-text('Continue to checkout')",
    "button:has-text('Checkout')",
    "a:has-text('Continue to checkout')",
  ];

  for (const sel of checkoutSelectors) {
    try {
      const btn = page.locator(sel).first();
      await btn.waitFor({ state: 'visible', timeout: 10_000 });
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      await page.waitForLoadState('domcontentloaded');
      log('✅ Proceeded to checkout.', label);
      return true;
    } catch {
      // try next
    }
  }

  log('❌ Could not find checkout button.', label);
  await page.screenshot({ path: `cart_debug_${label}.png` });
  log(`Screenshot saved: cart_debug_${label}.png`, label);
  return false;
}


export async function completeCheckout(page, cfg, label) {
  log('Starting checkout completion...', label);
  await sleep(2000);
  await dismissPopups(page);

  try {
    await page.waitForLoadState('networkidle', { timeout: 10_000 });
  } catch {
    // non-fatal
  }

  const continueSelectors = [
    "button:has-text('Continue')",
    "button:has-text('Next')",
    "button[data-automation-id='continue-to-payment']",
    "button[data-automation-id='shipping-continue-btn']",
  ];

  log('Checking shipping details...', label);
  for (const sel of continueSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 3000 })) {
        await btn.click();
        await sleep(2000);
        log('Continued past shipping step.', label);
        break;
      }
    } catch {
      // try next
    }
  }

  log('Checking payment details...', label);
  await sleep(2000);
  await dismissPopups(page);

  for (const sel of continueSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 3000 })) {
        await btn.click();
        await sleep(2000);
        log('Continued past payment step.', label);
        break;
      }
    } catch {
      // try next
    }
  }

  await sleep(2000);
  await dismissPopups(page);

  if (cfg.dryRun) {
    log('🔶 DRY RUN — skipping Place Order. Order NOT placed.', label);
    log(`Current URL: ${page.url()}`, label);
    await page.screenshot({ path: `dry_run_${label}.png` });
    log(`Screenshot saved: dry_run_${label}.png`, label);
    return false;
  }

  const placeOrderSelectors = [
    "button[data-automation-id='place-order-btn']",
    "button:has-text('Place order')",
    "button:has-text('Place your order')",
    "button[data-tl-id='CheckoutPlaceOrder']",
  ];

  for (const sel of placeOrderSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 5000 })) {
        log('🛒 Placing order...', label);
        await btn.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
        log('✅ Order placed!', label);
        await sleep(3000);
        log(`Final URL: ${page.url()}`, label);
        await page.screenshot({ path: `order_confirmation_${label}.png` });
        log(`Screenshot saved: order_confirmation_${label}.png`, label);
        return true;
      }
    } catch (e) {
      log(`Place order selector failed: ${e.message}`, label);
    }
  }

  log('❌ Could not find Place Order button.', label);
  await page.screenshot({ path: `checkout_stuck_${label}.png` });
  log(`Screenshot saved: checkout_stuck_${label}.png`, label);
  return false;
}


// ── Main ──────────────────────────────────────────────────────────────────────

export async function runBot(cfg) {
  let items = cfg.items ?? [];

  if (!items.length) {
    log('❌ No items configured. Add at least one item to config.js.');
    return;
  }
  if (items.length > 5) {
    log('⚠️  More than 5 items configured — only the first 5 will be used.');
    items = items.slice(0, 5);
  }

  log('='.repeat(55));
  log('  Walmart Drop Bot');
  log(`  Items   : ${items.length}`);
  for (const [i, item] of items.entries()) {
    log(`    [${i + 1}] ${item.name ?? 'Unnamed'} — qty ${item.quantity} — ${item.url}`);
  }
  log(`  Drop at : ${cfg.dropTimeIso || 'Now'}`);
  log(`  Dry run : ${cfg.dryRun ?? false}`);
  log('='.repeat(55));

  const context = await chromium.launchPersistentContext(cfg.chromeProfilePath, {
    executablePath: cfg.chromeExecutable || undefined,
    headless: cfg.headless ?? false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  try {
    // Open a tab for each item and navigate to product pages
    const pages = [];
    for (const [i, item] of items.entries()) {
      const label = item.name ?? `Item${i + 1}`;
      const page = context.pages()[i] ?? await context.newPage();
      pages.push(page);
      await navigateToProduct(page, item.url, label);
      log('Tab ready — waiting for drop time.', label);
    }

    await waitUntilDropTime(cfg.dropTimeIso ?? '', cfg.queueLeadSeconds ?? 5);
    log('Drop time! Starting all tabs concurrently...');

    async function reloadAndRun(page, item, index) {
      const label = item.name ?? `Item${index + 1}`;
      try {
        const inQueue = await joinQueue(page, cfg, item, label);
        if (!inQueue) { log('❌ Failed to reach Add to Cart.', label); return; }

        const added = await addToCart(page, item.quantity, label);
        if (!added) { log('❌ Failed to add to cart.', label); return; }

        const checkedOut = await goToCheckout(page, label);
        if (!checkedOut) { log('❌ Failed to reach checkout.', label); return; }

        await completeCheckout(page, cfg, label);
      } catch (e) {
        log(`💥 Unhandled error: ${e.message}`, label);
        await page.screenshot({ path: `error_${label}.png` });
        log(`Screenshot saved: error_${label}.png`, label);
      }
    }

    await Promise.all(items.map((item, i) => reloadAndRun(pages[i], item, i)));
    log('✅ All items processed.');

  } catch (e) {
    log(`💥 Unhandled error in main: ${e.message}`);
    throw e;
  } finally {
    if (!(cfg.keepBrowserOpen ?? true)) {
      await context.close();
    } else {
      log('Keeping browser open. Close it manually when done.');
      // Keep process alive until browser closes naturally
      await new Promise(resolve => context.on('close', resolve));
    }
  }
}


// ── Entry point ───────────────────────────────────────────────────────────────

// Only run directly if this is the main module
if (process.argv[1] && process.argv[1].endsWith('walmart_bot.js')) {
  runBot(CONFIG).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
