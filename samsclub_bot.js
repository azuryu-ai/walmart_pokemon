/**
 * Sam's Club Drop Bot
 * ===================
 * Automates adding a Sam's Club product to cart and completing checkout
 * using your existing Chrome profile. No queue system — products go live
 * directly and the bot monitors for Add to Cart availability.
 * Supports up to 5 items running concurrently in separate tabs.
 *
 * Requirements:
 *   npm install
 *   npx playwright install chromium
 *
 * Usage:
 *   1. Edit config.js with your items, drop time, and Chrome profile path.
 *   2. Run: node samsclub_bot.js
 */

import { chromium } from 'playwright';
import { CONFIG } from './config.js';

// ── Logging ───────────────────────────────────────────────────────────────────

export const logger = {
  fn: (msg, label = 'MAIN') => {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}] [${label}] ${msg}`);
  }
};

const log = (msg, label) => logger.fn(msg, label);


// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
    "button[aria-label='Close']",
    "button[aria-label='close']",
    '#onetrust-accept-btn-handler',
    "button:has-text('Accept')",
    "button:has-text('No thanks')",
    "button:has-text('Maybe later')",
    '[data-modal-close]',
    '.sc-modal-close',
  ];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1200 })) {
        await btn.click();
        await sleep(300);
      }
    } catch {
      // ignore
    }
  }
}


// ── Core steps ────────────────────────────────────────────────────────────────

export async function navigateToProduct(page, url, label) {
  log(`Navigating to: ${url}`, label);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissPopups(page);
  log('Product page loaded.', label);
}


/**
 * Sam's Club has no queue — we simply reload the page until the Add to Cart
 * button appears (products go live and become purchasable at drop time).
 */
export async function waitForAddToCart(page, cfg, label) {
  const atcSelectors = [
    "button[data-automation-id='atc-button']",
    "button[class*='add-to-cart']",
    "button:has-text('Add to cart')",
    "button:has-text('Add to Club')",
    "[data-sc-atc-btn]",
    "button[id*='addToCart']",
  ];

  const maxAttempts = cfg.queueMaxAttempts ?? 120;
  const pollMs = cfg.queuePollIntervalMs ?? 1000;

  log('Waiting for Add to Cart button to appear...', label);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await dismissPopups(page);

      log(`Page URL: ${page.url()}`, label);

      for (const sel of atcSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 800 })) {
            log(`✅ Add to Cart available! (attempt ${attempt})`, label);
            return true;
          }
        } catch {
          // try next selector
        }
      }

      // Dump button texts on first attempt to help diagnose selector misses
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

    if (attempt < maxAttempts) {
      log(`ATC not found yet — retrying... (${attempt}/${maxAttempts})`, label);
      await sleep(pollMs);
    }
  }

  log('❌ Add to Cart never appeared.', label);
  return false;
}


export async function addToCart(page, quantity, label) {
  log(`Adding ${quantity}x to cart...`, label);

  // Try to set quantity before clicking ATC if a quantity input exists
  const qtySelectors = [
    "input[data-automation-id='quantity-input']",
    "input[id*='quantity']",
    "select[data-automation-id='quantity-select']",
    "select[id*='quantity']",
    "input[name='quantity']",
  ];

  for (const sel of qtySelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1200 })) {
        const tag = await el.evaluate(e => e.tagName.toLowerCase());
        if (tag === 'select') {
          await el.selectOption({ value: String(quantity) });
        } else {
          await el.fill(String(quantity));
        }
        log(`Set quantity to ${quantity} via ${sel}`, label);
        break;
      }
    } catch {
      // try next
    }
  }

  // Click Add to Cart
  const atcSelectors = [
    "button[data-automation-id='atc-button']",
    "button[class*='add-to-cart']",
    "button:has-text('Add to cart')",
    "button:has-text('Add to Club')",
    "[data-sc-atc-btn]",
    "button[id*='addToCart']",
  ];

  for (const sel of atcSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        log('Clicked Add to Cart.', label);
        await sleep(2500);

        // Confirm item was added
        const confirmSelectors = [
          "[aria-label*='cart']",
          ".cart-count",
          "button:has-text('View cart')",
          "button:has-text('Go to cart')",
          "[data-automation-id='cart-icon']",
          ".sc-cart-icon",
        ];

        for (const csel of confirmSelectors) {
          try {
            const el = page.locator(csel).first();
            if (await el.isVisible({ timeout: 2000 })) {
              log('✅ Item added to cart.', label);
              return true;
            }
          } catch { /* try next */ }
        }

        // Optimistically proceed if we can't confirm
        log('⚠️  Could not confirm cart add — proceeding anyway.', label);
        return true;
      }
    } catch {
      // try next selector
    }
  }

  log('❌ Could not find Add to Cart button.', label);
  await page.screenshot({ path: `atc_failed_${label}.png` });
  log(`Screenshot saved: atc_failed_${label}.png`, label);
  return false;
}


export async function updateCartQuantity(page, targetQty, label) {
  if (targetQty <= 1) return;

  log(`Adjusting cart quantity to ${targetQty}...`, label);

  const increaseSelectors = [
    "button[aria-label*='Increase quantity']",
    "button[data-automation-id='increase-qty']",
    "button[class*='increment']",
    "button[class*='increase']",
  ];

  // Parse current quantity from aria-label
  let currentQty = 1;
  for (const sel of increaseSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        const ariaLabel = await btn.getAttribute('aria-label') ?? '';
        const match = ariaLabel.match(/Current Quantity\s+(\d+)/i);
        if (match) currentQty = parseInt(match[1]);
        break;
      }
    } catch { /* try next */ }
  }

  const diff = targetQty - currentQty;
  if (diff === 0) { log(`Quantity already ${targetQty}.`, label); return; }

  const clickSelectors = diff > 0
    ? increaseSelectors
    : [
        "button[aria-label*='Decrease quantity']",
        "button[data-automation-id='decrease-qty']",
        "button[class*='decrement']",
        "button[class*='decrease']",
      ];

  for (let i = 0; i < Math.abs(diff); i++) {
    for (const sel of clickSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click();
          await sleep(600);
          break;
        }
      } catch { /* try next */ }
    }
  }

  log(`Quantity set to ${targetQty}.`, label);
}


export async function goToCheckout(page, label, quantity = 1) {
  log('Navigating to cart...', label);

  const cartSelectors = [
    "a[href*='/cart']",
    "button:has-text('View cart')",
    "button:has-text('Go to cart')",
    "[data-automation-id='cart-icon']",
    ".sc-cart-icon",
    "a[href='/cart']",
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
    await page.goto('https://www.samsclub.com/cart', { waitUntil: 'domcontentloaded' });
  }

  await dismissPopups(page);
  log('Waiting for cart to fully load...', label);

  // Wait for network to settle rather than a blind sleep
  try {
    await page.waitForLoadState('networkidle', { timeout: 8_000 });
  } catch {
    // non-fatal — page may still be usable
  }
  await sleep(1000);

  // Update quantity in cart if needed
  if (quantity > 1) {
    await updateCartQuantity(page, quantity, label);
    await sleep(1000);
  }

  const checkoutSelectors = [
    "[data-automation-id='checkout']",
    "[id='Continue to checkout button']",
    "[data-automation-id='checkout-btn']",
    "[data-automation-id='proceed-to-checkout']",
    "button:has-text('Check Out')",
    "button:has-text('Check out')",
    "button:has-text('Checkout')",
    "button:has-text('Proceed to checkout')",
    "button:has-text('Continue to checkout')",
    "a:has-text('Proceed to checkout')",
    "a:has-text('Continue to checkout')",
    "a:has-text('Checkout')",
    "button[class*='checkout']",
    "a[class*='checkout']",
    ".sc-checkout-btn",
  ];

  // Explicitly wait up to 10s for the Check Out button to appear before cycling selectors
  log('Waiting for Check Out button to appear...', label);
  try {
    await page.waitForSelector('[data-automation-id="checkout"]', { state: 'visible', timeout: 3_000 });
    log('Check Out button is visible.', label);
  } catch {
    log('Timed out waiting — proceeding anyway...', label);
  }

  log('Looking for checkout button...', label);
  for (const sel of checkoutSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 3_000 })) {
        await btn.scrollIntoViewIfNeeded();
        await btn.click();
        await page.waitForLoadState('domcontentloaded');
        log('✅ Proceeded to checkout.', label);
        return true;
      }
    } catch {
      // try next
    }
  }

  // JS-based fallback — directly query the DOM bypassing Playwright selector quirks
  log('CSS selectors failed — trying JS evaluate fallback...', label);
  try {
    const clicked = await page.evaluate(() => {
      const byAutomation = document.querySelector('[data-automation-id="checkout"]');
      if (byAutomation) { byAutomation.click(); return 'automation-id'; }

      const byId = document.getElementById('Continue to checkout button');
      if (byId) { byId.click(); return 'id'; }

      const allBtns = Array.from(document.querySelectorAll('button'));
      const match = allBtns.find(b => /check[\s-]?out/i.test(b.innerText));
      if (match) { match.click(); return 'text-match'; }

      return null;
    });

    if (clicked) {
      log(`✅ Checkout clicked via JS fallback (matched by: ${clicked}).`, label);
      await page.waitForLoadState('domcontentloaded');
      return true;
    }
  } catch (e) {
    log(`JS fallback error: ${e.message}`, label);
  }

    // Diagnostic: log all visible buttons on the cart page to help identify the right selector
  log('⚠️  Checkout button not found — dumping visible buttons for diagnosis...', label);
  try {
    const allBtns = await page.locator('button, a[href*="checkout"]').all();
    const texts = [];
    for (const b of allBtns) {
      const t = await b.innerText().catch(() => '');
      const cls = await b.getAttribute('class').catch(() => '');
      const id = await b.getAttribute('id').catch(() => '');
      const automation = await b.getAttribute('data-automation-id').catch(() => '');
      if (t.trim()) texts.push(`"${t.trim().slice(0, 40)}" [class="${(cls ?? '').slice(0, 40)}" id="${id}" automation="${automation}"]`);
    }
    if (texts.length) {
      for (const t of texts) log(`  Button: ${t}`, label);
    } else {
      log('  No buttons found on page.', label);
    }
    log(`  Current URL: ${page.url()}`, label);
  } catch (e) {
    log(`  Diagnostic error: ${e.message}`, label);
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
    "button[data-automation-id='continue-btn']",
    "button[data-automation-id='shipping-continue-btn']",
    ".sc-continue-btn",
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
    log("🔶 DRY RUN — skipping Place Order. Order NOT placed.", label);
    log(`Current URL: ${page.url()}`, label);
    await page.screenshot({ path: `dry_run_${label}.png` });
    log(`Screenshot saved: dry_run_${label}.png`, label);
    return false;
  }

  const placeOrderSelectors = [
    "button:has-text('Place order')",
    "button:has-text('Place your order')",
    "button:has-text('Submit order')",
    "[data-automation-id='place-order-btn']",
    ".sc-place-order-btn",
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
    log("❌ No items configured. Add at least one item to config.js.");
    return;
  }
  if (items.length > 5) {
    log("⚠️  More than 5 items configured — only the first 5 will be used.");
    items = items.slice(0, 5);
  }

  log('='.repeat(55));
  log("  Sam's Club Drop Bot");
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
    const pages = [];
    for (const [i, item] of items.entries()) {
      const label = item.name ?? `Item${i + 1}`;
      const page = context.pages()[i] ?? await context.newPage();
      pages.push(page);
      await navigateToProduct(page, item.url, label);
      log('Tab ready — waiting for drop time.', label);
    }

    await waitUntilDropTime(cfg.dropTimeIso ?? '', cfg.queueLeadSeconds ?? 5);
    log("Drop time! Starting all tabs concurrently...");

    async function reloadAndRun(page, item, index) {
      const label = item.name ?? `Item${index + 1}`;
      try {
        const ready = await waitForAddToCart(page, cfg, label);
        if (!ready) { log('❌ Failed to reach Add to Cart.', label); return; }

        const added = await addToCart(page, item.quantity, label);
        if (!added) { log('❌ Failed to add to cart.', label); return; }

        const checkedOut = await goToCheckout(page, label, item.quantity);
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
      log("Keeping browser open. Close it manually when done.");
      await new Promise(resolve => context.on('close', resolve));
    }
  }
}


// ── Entry point ───────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith('samsclub_bot.js')) {
  runBot(CONFIG).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
