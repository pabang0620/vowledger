import { Router } from 'express'

// The mock stand-in for PayPal's hosted checkout page. Mounted only when no sandbox keys are set.
const TOKEN = /^[A-Za-z0-9]{8,40}$/
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function mockCheckoutRouter(mockOrders) {
  const router = Router()

  router.get('/checkout', (req, res, next) => {
    try {
      const token = String(req.query.token || '')
      if (!TOKEN.test(token)) return res.status(400).type('text').send('Bad checkout token.')
      const view = mockOrders.checkoutView(token)
      res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mock PayPal checkout</title>
<style>body{font:16px system-ui;max-width:420px;margin:48px auto;padding:0 16px}a.b{display:block;text-align:center;padding:12px;border-radius:24px;text-decoration:none;margin-top:12px}.pay{background:#ffc439;color:#111}.cancel{color:#245}small{color:#666}</style></head>
<body><h1>Mock PayPal checkout</h1><p><small>Stand-in for the PayPal-hosted page. No real payment.</small></p>
<p>${esc(view.brandName)}<br><strong>${esc(view.amount.value)} ${esc(view.amount.currencyCode)}</strong><br>${esc(view.description)}</p>
${view.status === 'CREATED' ? `<a class="b pay" href="/mock-paypal/approve?token=${esc(token)}">Pay Now</a><a class="b cancel" href="/mock-paypal/cancel?token=${esc(token)}">Cancel and return</a>` : `<p>Order is ${esc(view.status)}.</p>`}
</body></html>`)
    } catch (err) {
      next(err)
    }
  })

  router.get('/approve', (req, res, next) => {
    try {
      const token = String(req.query.token || '')
      if (!TOKEN.test(token)) return res.status(400).type('text').send('Bad checkout token.')
      const { returnUrl } = mockOrders.simulateApprove(token)
      res.redirect(302, `${returnUrl}?token=${token}&PayerID=MOCKPAYER`)
    } catch (err) {
      next(err)
    }
  })

  router.get('/cancel', (req, res, next) => {
    try {
      const token = String(req.query.token || '')
      if (!TOKEN.test(token)) return res.status(400).type('text').send('Bad checkout token.')
      const { cancelUrl } = mockOrders.checkoutView(token)
      res.redirect(302, `${cancelUrl}?token=${token}`)
    } catch (err) {
      next(err)
    }
  })

  return router
}
