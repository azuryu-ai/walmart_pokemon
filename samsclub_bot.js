/**
 * Sam's Club Drop Bot
 * ===================
 * Automates adding a Sam's Club product to cart and completing checkout
 * using your existing Chrome profile. No queue system — products go live
 * directly and the bot monitors for Add to Cart availability.
 * Supports up to 5 items running concurrently in separate tabs.
 *
 * Run via the web UI: node server.js
 */

import { chromium } from 'playwright';

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

// Dismisses general popups (cookie banners, modals, etc.)
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

// Dismisses error/alert dialogs that Sam's Club shows during drops
// Returns true if an error popup was found and dismissed.
async function dismissErrorPopups(page, label) {
  const errorSelectors = [
    "button:has-text('Try again')",
    "button:has-text('OK')",
    "button:has-text('Ok')",
    "button:has-text('Got it')",
    "button:has-text('Dismiss')",
    "button:has-text('Close')",
    "button[aria-label='Close']",
    "button[aria-label='close']",
    "[data-automation-id='error-modal-close']",
    "[data-automation-id='alert-close']",
    "[data-testid='modal-close']",
    "[data-testid='error-close']",
    "[data-testid='toast-close']",
    "button[class*='modal-close']",
    "button[class*='dialog-close']",
    "button[class*='alert-close']",
  ];

  let dismissed = false;
  for (const sel of errorSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 600 })) {
        const text = await btn.innerText().catch(() => sel);
        log(`⚠️  Error popup detected — dismissing: "${text.trim()}"`, label);
        await btn.click();
        await sleep(500);
        dismissed = true;
      }
    } catch {
      // not visible, try next
    }
  }
  return dismissed;
}

// Retries an async action indefinitely until it succeeds,
// dismissing error popups between each attempt.
async function withRetry(action, { label, taskName, delayMs = 1500, page }) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const result = await action();
      if (result !== false) return result;
      log(`⚠️  ${taskName} attempt ${attempt} failed — retrying...`, label);
    } catch (e) {
      log(`⚠️  ${taskName} attempt ${attempt} error: ${e.message} — retrying...`, label);
    }

    const hadPopup = await dismissErrorPopups(page, label);
    if (!hadPopup) await dismissPopups(page);
    log(`🔄 Retrying ${taskName} (attempt ${attempt + 1})...`, label);
    await sleep(delayMs);
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
      await dismissErrorPopups(page, label);
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

  // Click Add to Cart — with retry on error popups
  const atcSelectors = [
    "button[data-automation-id='atc-button']",
    "button[class*='add-to-cart']",
    "button:has-text('Add to cart')",
    "button:has-text('Add to Club')",
    "[data-sc-atc-btn]",
    "button[id*='addToCart']",
  ];

  const result = await withRetry(async () => {
    for (const sel of atcSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          log('Clicked Add to Cart.', label);
          await sleep(2500);

          // Check for error popup after clicking
          const hadError = await dismissErrorPopups(page, label);
          if (hadError) return false; // trigger retry

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
    return false;
  }, { label, taskName: 'Add to Cart', delayMs: 2000, page });

  if (!result) {
    await page.screenshot({ path: `atc_failed_${label}.png` });
    log(`Screenshot saved: atc_failed_${label}.png`, label);
  }
  return result;
}


async function readCartQuantity(page, label) {
  try {
    const result = await page.evaluate(() => {
      // Primary: data-testid="quantity-label" — the span between the +/- buttons
      const label = document.querySelector('[data-testid="quantity-label"]');
      if (label) {
        return { source: 'quantity-label', text: label.textContent.trim() };
      }

      // Fallback: "Subtotal(X items)" text
      const subtotalEls = Array.from(document.querySelectorAll('*'));
      for (const el of subtotalEls) {
        if (el.children.length === 0) {
          const m = el.textContent.match(/Subtotal\s*\((\d+)\s*items?\)/i);
          if (m) return { source: 'subtotal', text: m[1] };
        }
      }

      return null;
    });

    if (result) {
      const match = result.text.match(/\d+/);
      if (match) {
        const qty = parseInt(match[0]);
        if (label) log(`Read cart quantity: ${qty} (source: ${result.source}, raw: "${result.text}")`, label);
        return qty;
      }
      if (label) log(`⚠️  Could not parse number from: "${result.text}" (source: ${result.source})`, label);
    } else {
      if (label) log('⚠️  Could not find quantity-label or subtotal element', label);
    }
  } catch (e) {
    if (label) log(`⚠️  readCartQuantity error: ${e.message}`, label);
  }
  return null;
}

export async function updateCartQuantity(page, targetQty, label) {
  if (targetQty <= 1) return;

  log(`Adjusting cart quantity to ${targetQty}...`, label);

  let attempts = 0;
  while (true) {
    attempts++;

    // Read current quantity with full diagnostics
    const currentQty = await readCartQuantity(page, label) ?? 1;
    log(`Cart quantity: ${currentQty} / target: ${targetQty} (attempt ${attempts})`, label);

    if (currentQty === targetQty) {
      log(`✅ Cart quantity confirmed at ${targetQty}.`, label);
      return;
    }

    const diff = targetQty - currentQty;
    const incBtn = page.locator('[data-testid="quantity-stepper-inc-icon"]').locator('..').first();
    const decBtn = page.locator('[data-testid="quantity-stepper-dec-icon"]').locator('..').first();
    const btn = diff > 0 ? incBtn : decBtn;
    const clicks = Math.abs(diff);

    log(`Clicking ${diff > 0 ? '+' : '-'} button ${clicks} time(s)...`, label);
    for (let i = 0; i < clicks; i++) {
      try {
        await btn.waitFor({ state: 'visible', timeout: 3000 });
        await btn.click();
        // Wait for the DOM to reflect the new quantity before reading again
        await sleep(1000);
        await dismissErrorPopups(page, label);

        // Verify each individual click updated the count
        const afterClick = await readCartQuantity(page, null) ?? 1;
        log(`After click ${i + 1}/${clicks}: quantity is now ${afterClick}`, label);
      } catch (e) {
        log(`⚠️  Button click ${i + 1}/${clicks} failed: ${e.message}`, label);
      }
    }

    // Final settle and verify
    await sleep(1000);
    const verifiedQty = await readCartQuantity(page, label) ?? 1;
    if (verifiedQty === targetQty) {
      log(`✅ Cart quantity confirmed at ${targetQty}.`, label);
      return;
    }

    log(`⚠️  Quantity is ${verifiedQty}, expected ${targetQty} — retrying...`, label);
    await dismissErrorPopups(page, label);
    await sleep(1000);
  }
}


export async function goToCheckout(page, label, quantity = 1) {
  log('Navigating to cart...', label);

  // Navigate to cart — with retry
  const cartNavigated = await withRetry(async () => {
    const cartSelectors = [
      "a[href*='/cart']",
      "button:has-text('View cart')",
      "button:has-text('Go to cart')",
      "[data-automation-id='cart-icon']",
      ".sc-cart-icon",
      "a[href='/cart']",
    ];

    for (const sel of cartSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          await el.click();
          await page.waitForLoadState('domcontentloaded');
          log('In cart.', label);
          return true;
        }
      } catch {
        // try next
      }
    }

    log('Cart button not found — navigating directly to /cart', label);
    await page.goto('https://www.samsclub.com/cart', { waitUntil: 'domcontentloaded' });

    const hadError = await dismissErrorPopups(page, label);
    if (hadError) return false;

    return true;
  }, { label, taskName: 'Navigate to cart', delayMs: 2000, page });

  if (!cartNavigated) {
    await page.screenshot({ path: `cart_debug_${label}.png` });
    log(`Screenshot saved: cart_debug_${label}.png`, label);
    return false;
  }

  await dismissPopups(page);
  log('Waiting for cart to fully load...', label);
  try {
    await page.waitForLoadState('networkidle', { timeout: 8_000 });
  } catch { /* non-fatal */ }
  await sleep(1000);

  // Update quantity in cart if needed
  if (quantity > 1) {
    await updateCartQuantity(page, quantity, label);
    await sleep(1000);
  }

  // Click checkout button — with retry
  const checkedOut = await withRetry(async () => {
    try {
      await page.waitForSelector('[data-automation-id="checkout"]', { state: 'visible', timeout: 3_000 });
    } catch { /* proceed anyway */ }

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

    for (const sel of checkoutSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 3_000 })) {
          await btn.scrollIntoViewIfNeeded();
          await btn.click();
          await sleep(1500);

          const hadError = await dismissErrorPopups(page, label);
          if (hadError) return false;

          await page.waitForLoadState('domcontentloaded');
          log('✅ Proceeded to checkout.', label);
          return true;
        }
      } catch {
        // try next
      }
    }

    // JS evaluate fallback
    log('CSS selectors failed — trying JS evaluate fallback...', label);
    const clicked = await page.evaluate(() => {
      const byAutomation = document.querySelector('[data-automation-id="checkout"]');
      if (byAutomation) { byAutomation.click(); return 'automation-id'; }
      const byId = document.getElementById('Continue to checkout button');
      if (byId) { byId.click(); return 'id'; }
      const allBtns = Array.from(document.querySelectorAll('button'));
      const match = allBtns.find(b => /check[\s-]?out/i.test(b.innerText));
      if (match) { match.click(); return 'text-match'; }
      return null;
    }).catch(() => null);

    if (clicked) {
      await sleep(1500);
      const hadError = await dismissErrorPopups(page, label);
      if (hadError) return false;
      await page.waitForLoadState('domcontentloaded');
      log(`✅ Checkout clicked via JS fallback (matched by: ${clicked}).`, label);
      return true;
    }

    return false;
  }, { label, taskName: 'Click checkout button', delayMs: 2000, page });

  if (!checkedOut) {
    log('⚠️  Checkout button not found — dumping visible buttons for diagnosis...', label);
    try {
      const allBtns = await page.locator('button, a[href*="checkout"]').all();
      for (const b of allBtns) {
        const t = await b.innerText().catch(() => '');
        const cls = await b.getAttribute('class').catch(() => '');
        const id = await b.getAttribute('id').catch(() => '');
        const automation = await b.getAttribute('data-automation-id').catch(() => '');
        if (t.trim()) log(`  Button: "${t.trim().slice(0, 40)}" [class="${(cls ?? '').slice(0, 40)}" id="${id}" automation="${automation}"]`, label);
      }
      log(`  Current URL: ${page.url()}`, label);
    } catch (e) {
      log(`  Diagnostic error: ${e.message}`, label);
    }
    await page.screenshot({ path: `cart_debug_${label}.png` });
    log(`Screenshot saved: cart_debug_${label}.png`, label);
  }

  return checkedOut;
}


export async function completeCheckout(page, cfg, label) {
  log('Starting checkout completion...', label);
  await sleep(2000);
  await dismissErrorPopups(page, label);
  await dismissPopups(page);

  try {
    await page.waitForLoadState('networkidle', { timeout: 10_000 });
  } catch { /* non-fatal */ }

  const continueSelectors = [
    "button:has-text('Continue')",
    "button:has-text('Next')",
    "button[data-automation-id='continue-btn']",
    "button[data-automation-id='shipping-continue-btn']",
    ".sc-continue-btn",
  ];

  // Shipping step — with retry
  log('Checking shipping details...', label);
  await withRetry(async () => {
    for (const sel of continueSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 3000 })) {
          await btn.click();
          await sleep(2000);
          const hadError = await dismissErrorPopups(page, label);
          if (hadError) return false;
          log('Continued past shipping step.', label);
          return true;
        }
      } catch { /* try next */ }
    }
    return true; // no shipping step visible — that's OK
  }, { label, taskName: 'Shipping step', delayMs: 2000, page });

  // Payment step — with retry
  log('Checking payment details...', label);
  await sleep(2000);
  await dismissErrorPopups(page, label);
  await dismissPopups(page);

  await withRetry(async () => {
    for (const sel of continueSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 3000 })) {
          await btn.click();
          await sleep(2000);
          const hadError = await dismissErrorPopups(page, label);
          if (hadError) return false;
          log('Continued past payment step.', label);
          return true;
        }
      } catch { /* try next */ }
    }
    return true; // no payment step visible — that's OK
  }, { label, taskName: 'Payment step', delayMs: 2000, page });

  await sleep(2000);
  await dismissErrorPopups(page, label);
  await dismissPopups(page);

  if (cfg.dryRun) {
    log("🔶 DRY RUN — skipping Place Order. Order NOT placed.", label);
    log(`Current URL: ${page.url()}`, label);
    await page.screenshot({ path: `dry_run_${label}.png` });
    log(`Screenshot saved: dry_run_${label}.png`, label);
    return false;
  }

  // Place Order — with retry
  const placeOrderSelectors = [
    "button[data-automation-id='place-order-button']",
    "button[data-testid='place-order-button']",
    "button[aria-label*='Place order']",
    "button:has-text('Place order')",
    "button:has-text('Place your order')",
    "button:has-text('Submit order')",
    "[data-automation-id='place-order-btn']",
    ".sc-place-order-btn",
  ];

  const ordered = await withRetry(async () => {
    for (const sel of placeOrderSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 5000 })) {
          log('🛒 Placing order...', label);
          await btn.click();
          await sleep(2000);

          const hadError = await dismissErrorPopups(page, label);
          if (hadError) return false;

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
    return false;
  }, { label, taskName: 'Place Order', delayMs: 2000, page });

  if (!ordered) {
    log('❌ Could not place order.', label);
    await page.screenshot({ path: `checkout_stuck_${label}.png` });
    log(`Screenshot saved: checkout_stuck_${label}.png`, label);
  }

  return ordered;
}


// ── Main ──────────────────────────────────────────────────────────────────────

export async function runBot(cfg) {
  let items = cfg.items ?? [];

  if (!items.length) {
    log("❌ No items configured.");
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
