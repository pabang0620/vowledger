#!/usr/bin/env python3
"""Walks README steps 1 to 4 against the PayPal SANDBOX (app started with `npm run demo:sandbox`).

Usage: buyer-run.sh python3 scripts/sandbox-walk.py <baseUrl> <shotDir>
Credentials: SANDBOX_BUYER_EMAIL / SANDBOX_BUYER_PASSWORD from the environment only (never printed, never on the
command line). The login page is not screenshotted. Prints the order, capture and invoice ids it sees on screen.
"""
import os
import re
import sys
import time

from playwright.sync_api import sync_playwright

BASE, OUT = sys.argv[1].rstrip('/'), sys.argv[2].rstrip('/') + '/'
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')
EMAIL, PASSWORD = os.environ.get('SANDBOX_BUYER_EMAIL', ''), os.environ.get('SANDBOX_BUYER_PASSWORD', '')
if not EMAIL or not PASSWORD:
    sys.exit('Run through buyer-run.sh so the sandbox buyer is in the environment.')


def log(*parts):
    print(' '.join(str(p) for p in parts), flush=True)


def shot(page, name):
    page.screenshot(path=f'{OUT}sb_{name}.png', full_page=True)
    log('shot', name)


def drag_event(page, dx):
    box = page.evaluate("""() => { const g = window.__vowledgerGantt; const el = g.getElementFromTaskRecord(g.taskStore.getById('event'));
      const b = el.getBoundingClientRect(); return {x: b.x, y: b.y, w: b.width, h: b.height} }""")
    x, y = box['x'] + box['w'] / 2, box['y'] + box['h'] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    for i in range(1, 21):
        page.mouse.move(x + dx * i / 20, y)
        time.sleep(0.03)
    page.mouse.up()


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=EXE)
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
    page = ctx.new_page()
    page.goto(BASE)
    page.wait_for_timeout(2500)
    log('chip:', page.locator('.vl-modes').inner_text().replace('\n', ' | '))

    page.get_by_role('button', name=re.compile('Try sample: Ortiz')).first.click()
    page.get_by_role('button', name=re.compile('Approve checkout')).wait_for(timeout=30000)
    page.get_by_role('button', name=re.compile('Approve checkout')).click()
    page.get_by_text('Open the client checkout link').wait_for(timeout=60000)
    for _ in range(30):
        if page.locator('text=not invoiced').count() == 0:
            break
        page.wait_for_timeout(1000)
    page.wait_for_timeout(1500)
    shot(page, '01_approved')
    body = page.inner_text('body') + page.locator('.b-gantt').inner_text()
    log('invoice numbers:', sorted(set(re.findall(r'INV-\d{4,}', body))))

    with ctx.expect_page() as new_page:
        page.get_by_text('Open the client checkout link').click()
    co = new_page.value
    co.wait_for_url(re.compile(r'paypal\.com'), timeout=30000)
    co.wait_for_load_state('domcontentloaded')
    log('checkout host:', re.sub(r'token=[^&]+', 'token=<order>', co.url)[:90])
    token = re.search(r'token=([A-Z0-9]+)', co.url)
    log('order id from checkout url:', token.group(1) if token else None)
    email = co.locator('#email')
    try:
        email.wait_for(timeout=20000)
    except Exception:
        pass
    if email.is_visible():
        email.fill(EMAIL)
        if co.locator('#btnNext').is_visible():
            co.locator('#btnNext').click()
        co.locator('#password').fill(PASSWORD)
        co.locator('#btnLogin').click()
    pay = co.locator("button#payment-submit-btn, button[data-id='payment-submit-btn'], button:has-text('Complete Purchase'), button:has-text('Pay Now'), button:has-text('Continue')").first
    pay.wait_for(timeout=45000)
    co.wait_for_timeout(2500)
    co.screenshot(path=f'{OUT}sb_02_paypal_sandbox_checkout.png')
    log('shot 02_paypal_sandbox_checkout')
    pay.click()
    co.wait_for_url(re.compile(r'deposit/return|' + re.escape(BASE)), timeout=60000)
    co.wait_for_timeout(3000)
    co.close()

    applied = False
    for _ in range(40):
        page.wait_for_timeout(1000)
        if page.get_by_role('button', name=re.compile('Apply proposal')).count():
            applied = True
            break
    shot(page, '03_captured')
    body = page.inner_text('body')
    log('CAPTURED on screen:', 'CAPTURED' in body.upper(), '| proposal:', applied)
    if applied:
        page.get_by_role('button', name=re.compile('Apply proposal')).click()
        page.wait_for_timeout(2500)

    page.get_by_role('button', name='Jump to the wedding day').click()
    page.wait_for_timeout(1200)
    drag_event(page, 49 * 6)
    page.wait_for_timeout(4000)
    shot(page, '04_move_card')
    card = page.locator('.vl-card').filter(has_text='Unchanged').first
    log('move card:', card.inner_text()[:1500].replace('\n', ' | ') if card.count() else 'NO CARD')
    btn = page.get_by_role('button', name=re.compile(r'Approve \d+ PayPal change'))
    if btn.count():
        btn.first.click()
        page.wait_for_timeout(15000)
    shot(page, '05_moved_synced')
    body = page.inner_text('body')
    log('0 not synced:', '0 not synced' in body)
    activity = page.locator('text=Activity').locator('xpath=..').inner_text()
    log('activity:', activity[:2500].replace('\n', ' | '))
    browser.close()
