# paypal-plan.md: VowLedger and the APIMatic PayPal TypeScript SDK

Scope: the first payment milestone of a contract (the deposit / booking fee) is collected through a PayPal **Orders v2 checkout** instead of an invoice. Those Orders calls go through the plugin SDK `paypal` (client `PaypalClient`, version 2.29.0). Every later milestone stays on Invoicing v2, which the SDK does not cover.

Sources read (plugin 0.4.1): `typescript-integrate-paypal`, `typescript-getting-started`, `typescript-error-handling`, `typescript-client-initialization`, `typescript-calling-endpoints` (field channels), `typescript-models`, `typescript-configuration-resilience` (writes under retries, host binding), `typescript-testing`. Facts below come from `node_modules/paypal/sdk-map.md`, `map/operations/orders.md`, `map/operations/payments.md` and the model files named in the Type sources tables. Nothing was run against PayPal.

## Toolchain and repo survey

| Item | Value |
| --- | --- |
| Language / module format | plain JavaScript, ESM (`"type": "module"`), Node >= 20 (SDK floor 20.3). `instanceof PaypalError` is reliable because the app only loads the ESM dialect |
| Package manager | npm. `paypal` is a dependency (`github:context-plugins/paypal-typescript-sdk#main`), `dist/` is built |
| Type check | none configured (no tsconfig, plain JS) |
| Tests / build | `node --test test/*.test.js` / `vite build` (client only) |
| Adapter exemplar | `server/integrations/mockPaypal.js` and `livePaypal.js` share one interface; the new Orders adapters follow the same pair pattern |
| Error boundary | `PayPalError(status, name, issue, message)` in `mockPaypal.js`, answered by the central error handler in `routes.js` |

## Host decision

The SDK declares one server (`https://api-m.sandbox.paypal.com`) and no environment selector. The app binds the host in code: `server/integrations/paypalHost.js` exports `SANDBOX_BASE`, the SDK client is built with `serverOptions.baseUrl = SANDBOX_BASE`, and the factory throws if it is asked for any other base URL. `livePaypal.js` (REST/Toolkit) imports the same constant, so the two paths cannot point at different hosts. The client is built once and held (`getSdkClient()`), because the OAuth token cache lives on it. Logging is switched off explicitly (`logging: { level: 'off' }`) so `PAYPAL_CLIENT_LOG` cannot turn it on and no request body is ever logged. Retries stay at the SDK default for reads; every write passes `retry: { maxRetries: 0 }`.

## Operations in scope

| Adapter method | SDK call | Wire | In scope because |
| --- | --- | --- | --- |
| `createOrder` | `client.orders.createOrder(request: Orders.CreateOrderRequest)` | `POST /v2/checkout/orders` | deposit checkout link |
| `getOrder` | `client.orders.getOrder(request: Orders.GetOrderRequest)` | `GET /v2/checkout/orders/{id}` | status badge, pre-capture check, read-back after an unknown outcome |
| `captureOrder` | `client.orders.captureOrder(request: Orders.CaptureOrderRequest)` | `POST /v2/checkout/orders/{id}/capture` | collect the deposit after the payer approved |

Refund (`client.payments.refundCapturedPayment`, `POST /v2/payments/captures/{capture_id}/refund`) is **not wired**. The change flow never moves or cancels a captured deposit: a captured deposit is pinned (fixed and paid) and listed under "Unchanged (pinned)". The contract clause "the retainer is not refundable" matches. If a later feature cancels a deposit, `refundCapturedPayment` is the call, with a DUPLICATE CLAIMS row on `PayPal-Request-Id`.

### Not in SDK, kept on REST or the Agent Toolkit

| Adapter method | PayPal call today |
| --- | --- |
| `createInvoice` | REST `POST /v2/invoicing/invoices` |
| `updateInvoice` | REST `PUT /v2/invoicing/invoices/{id}` |
| `sendInvoice`, `getInvoice`, `deleteInvoice`, `recordPayment`, `sendReminder` | Toolkit tools over Invoicing v2 |
| `verifyWebhook` | REST `POST /v1/notifications/verify-webhook-signature` |

`grep -rniE "invoic|webhook" node_modules/paypal/sdk-map.md node_modules/paypal/map/operations` returns nothing.

## Signatures and request fields

`createOrder(request: Orders.CreateOrderRequest, options?: RequestOptions): ApiPromise<Order, Orders.CreateOrderError>`. Auth `oauth2`. Body `application/json`, the `body` field, **required**. SDK-sent: `Idempotency-Key` (minted per call, not ours to set).

| Field | Channel | Wire | Type | Req | Default |
| --- | --- | --- | --- | --- | --- |
| `payPalMockResponse` | header | `PayPal-Mock-Response` | string | no | none |
| `payPalRequestId` | header | `PayPal-Request-Id` | string | no | none |
| `payPalPartnerAttributionId` | header | `PayPal-Partner-Attribution-Id` | string | no | none |
| `payPalClientMetadataId` | header | `PayPal-Client-Metadata-Id` | string | no | none |
| `prefer` | header | `Prefer` | string | no | `"return=minimal"` (SDK fills it) |
| `payPalAuthAssertion` | header | `PayPal-Auth-Assertion` | string | no | none |
| `body` | body | none | `OrderRequest` | yes | none |

`OrderRequest` (`src/models/order-request.ts`): `intent: CheckoutPaymentIntent` (required; members `CAPTURE`, `AUTHORIZE`), `purchaseUnits: PurchaseUnitRequest[]` (required, wire `purchase_units`), optional `processingInstruction`, `payer`, `paymentSource`, `applicationContext` (wire `application_context`).
`PurchaseUnitRequest`: `amount: AmountWithBreakdown` (required), optional `referenceId`, `payee`, `paymentInstruction`, `description`, `customId`, `invoiceId`, `softDescriptor`, `items`, `shipping`, `supplementaryData`.
`AmountWithBreakdown`: `currencyCode: string`, `value: string` (both required, wire `currency_code`), optional `breakdown`.
`OrderApplicationContext` members and defaults: `brandName?`, `locale?`, `landingPage` (default `NO_PREFERENCE`, SDK fills), `shippingPreference` (default `GET_FROM_FILE`, SDK fills; members `GET_FROM_FILE`, `NO_SHIPPING`, `SET_PROVIDED_ADDRESS`), `userAction` (default `CONTINUE`, SDK fills; members `CONTINUE`, `PAY_NOW`), `paymentMethod?`, `returnUrl?`, `cancelUrl?`, `storedPaymentSource?`.

`getOrder(request: Orders.GetOrderRequest, options?): ApiPromise<Order, Orders.GetOrderError>`. `GET`, body none. Fields: `id` (path, required), `fields` (query, optional), `payPalMockResponse` (header, optional), `payPalAuthAssertion` (header, optional).

`captureOrder(request: Orders.CaptureOrderRequest, options?): ApiPromise<Order, Orders.CaptureOrderError>`. Body `OrderCaptureRequest`, **optional** (omitted = no body, no `Content-Type`). SDK-sent `Idempotency-Key`. Fields: `id` (path, required), `payPalMockResponse`, `payPalRequestId` (`PayPal-Request-Id`), `prefer` (default `"return=minimal"`), `payPalClientMetadataId`, `payPalAuthAssertion`, `body`: all header/body, optional.

`Order` (response, `src/models/order.ts`, all members optional): `id`, `status: OrderStatus` (`CREATED`, `SAVED`, `APPROVED`, `VOIDED`, `COMPLETED`, `PAYER_ACTION_REQUIRED`; open enum), `intent`, `purchaseUnits: PurchaseUnit[]` (each: `amount`, `referenceId`, `customId`, `payments.captures: OrdersCapture[]` with `id`, `status: CaptureStatus` (`COMPLETED`, `DECLINED`, `PARTIALLY_REFUNDED`, `PENDING`, `REFUNDED`, `FAILED`), `amount: Money`), `links: LinkDescription[]` (`href`, `rel`, `method?`), `createTime`, `updateTime`, `payer`, `paymentSource`.
Because every `Order` member is optional, a truncated success decodes cleanly. The adapter guards: `createOrder` requires `id`, `captureOrder` requires `status`, `getOrder` requires `id` and `status`; otherwise it throws a "PayPal answered with an unreadable order" error (502, never mapped to "not found").

Error arms per operation (each also has a `default` arm and `"undeclared"`): create 400, 401, 422; get 401, 404; capture 400, 401, 403, 404, 422, 500. Tags are per operation, so the adapter never switches on `payload.kind`; it reads `err.status` and takes the reason from `payload.body` (`Error`: `name`, `message`, `debugId`, `details[].issue`, `details[].description`) when the arm decoded.

## DUPLICATE CLAIMS

| Write | Where the claim is stored | What rejects the second one | Where that rejection is caught | Where in the code |
| --- | --- | --- | --- | --- |
| create the deposit order | `store.claims` Map, key `deposit-create:{contractId}:{stepId}`, value holds the `PayPal-Request-Id` reference (`vl-dep-{contractId}-{stepId}-{attempt}`), committed before the SDK call | `store.claim(key, value)` returns false when the key exists (synchronous set-if-absent on a value every caller computes the same: contract, step, attempt). The per-contract lock also serializes | `createDeposit` in `server/services/deposits.js` turns false into `HttpError(409)`; the loser reads `step.deposit` the winner wrote | `createDeposit`, claim then `ctx.orders.createOrder` |
| capture the deposit order | `store.claims`, key `deposit-capture:{orderId}`, committed before the SDK call | same `store.claim` on the order id, which every caller (return redirect, "Capture now" button) computes the same | `captureDeposit` in `deposits.js`: false becomes `HttpError(409)` unless the claim is this write's own `unknown` claim being settled | `captureDeposit`, claim then `ctx.orders.captureOrder` |

The claim is released when PayPal refuses the call (an `ApiError`, `AuthError`, `EncodeError`), so a later legitimate attempt is not blocked. It is kept when the outcome is unknown. A completed capture keeps its claim for good: a second capture of the same order never reaches PayPal.
The declared key goes beside the claim: `payPalRequestId` is set to the reference stored on the claim (`vl-dep-{contractId}-{stepId}-{attempt}` for create, `vl-cap-{orderId}` for capture). The SDK's own `Idempotency-Key` is left as the SDK mints it.

## UNKNOWN OUTCOMES

| Write | The operation you re-read with | The reference you search by | Where in the code | The test that fails the connection |
| --- | --- | --- | --- | --- |
| create order | none exists for a missing id: Orders has no list or search. Settle by **replaying `createOrder` with the same `PayPal-Request-Id`** (PayPal documents that a replay returns the original order). Not found / replay fails: still unknown | `PayPal-Request-Id` stored on the claim; the order also carries `customId` = the same reference | `createDeposit` catch of `OutcomeUnknownError`, then `settleCreate` | `orders.test.js` "lost createOrder response: the replay with the same request id settles on one order" and "lost createOrder twice: ..."; never-sent: "a refused credential on createOrder sends nothing, does not replay, and frees the claim" |
| capture order | `getOrder(orderId)`: `COMPLETED` means captured and is recorded; `APPROVED` means still unknown, then replay `captureOrder` with the same `PayPal-Request-Id` | order id (the claim key) | `captureDeposit` catch of `OutcomeUnknownError`, then `readBackCapture` | `orders.test.js` "lost captureOrder response: getOrder shows COMPLETED and there is no second capture", "lost captureOrder response, order still APPROVED: replay with the same request id"; never-sent: "a refused credential on captureOrder sends nothing and is not an unknown outcome" |

Blocker-like assumption for create: because Orders has no read by reference, the create settle relies on PayPal honouring `PayPal-Request-Id` for `POST /v2/checkout/orders`. VERIFY item V9 checks it. Until it passes, a lost create answer stays "CHECKING" and the card offers the same-id replay, never a new order with a new id. `ConnectionError` and `TimeoutError` are the unknown kinds; `AuthError` (no credential obtained) and `EncodeError` (nothing sent) are never-sent and get no re-read.

## CROSS-OPERATION INVARIANTS

| Invariant | Where the legal set comes from | Enforced where | The test that proves it |
| --- | --- | --- | --- |
| Only an order this app created can be captured | `store.findByOrderId`, i.e. the deposits in the store, not "any order the account holds" | return route and `captureDeposit` look the id up before any claim or SDK call | "return with an order id the app never created is refused and nothing is called" |
| Only the first milestone gets a deposit checkout | the contract's `steps[0]` | `createDeposit` checks `contract.steps[0].id === step.id` and `contract.depositCheckout` | "createDeposit refuses a later milestone and never calls PayPal" |
| The captured amount is the server's amount | `step.amountCents` computed from the contract total | `captureDeposit` reads the order first and refuses when `amount` differs from `money2(step.amountCents)` or the status is not `APPROVED` | "capture is refused when the order amount differs from the schedule" |

## OPTIONAL FIELDS

`createOrder`

| Field | What requires it | Set it? |
| --- | --- | --- |
| `payPalRequestId` | DUPLICATE CLAIMS row (create) and UNKNOWN OUTCOMES row (replay reference) | set, from the claim |
| `payPalMockResponse`, `payPalPartnerAttributionId`, `payPalClientMetadataId`, `payPalAuthAssertion`, `prefer` | nothing | leave out (`prefer` is filled by the SDK default) |
| body `processingInstruction`, `payer`, `paymentSource` | nothing | leave out |
| body `applicationContext.brandName` | the task's "booking fee" screen shows the photographer, `contract.vendor.businessName` | set |
| body `applicationContext.returnUrl`, `cancelUrl` | "on return the server captures the order" | set |
| body `applicationContext.shippingPreference` | a service deposit has no shipping address; the SDK would otherwise send `GET_FROM_FILE` | set `NO_SHIPPING` |
| body `applicationContext.userAction` | the server captures on return with no review page; the SDK would otherwise send `CONTINUE` | set `PAY_NOW` |
| body `applicationContext.landingPage` | nothing | leave out (SDK default `NO_PREFERENCE` is sent) |
| `locale`, `paymentMethod`, `storedPaymentSource` | nothing | leave out |
| purchase unit `referenceId` | identifies the milestone in `purchaseUnits[0]` of every read-back | set to the step id |
| purchase unit `description` | the task's "booking fee" wording | set |
| purchase unit `customId` | UNKNOWN OUTCOMES row: the reference, so the payment can be found in the dashboard | set to the claim reference |
| purchase unit `invoiceId`, `items`, `shipping`, `payee`, `softDescriptor`, `supplementaryData`, `paymentInstruction`, amount `breakdown` | nothing | leave out |

`getOrder`: only `id`. `captureOrder`: `id` and `payPalRequestId` (DUPLICATE CLAIMS capture row). The test `orders.test.js` "createOrder sends the planned request and no key that a sheet row does not require" asserts the header names and body keys of the captured request.

## WHEN THE API SAYS NO

One mapping, applied identically by all three operations (`server/integrations/orders/errorMap.js`), then answered by the central error handler.

| status | your app answers | the caller reads | test |
| --- | --- | --- | --- |
| a `4xx` other than 401 / 403 / 429 | the same `4xx` | PayPal's reason from `payload.body` (`details[0].issue` or `message`) | "a refused 422 frees the claim and the reason reaches the caller", "HTTP: a PayPal 404 reason reaches the response of the capture route" |
| 401 / 403 | 502 | "PayPal refused our credentials." | "status mapping: 401 and 403 are 502 with a fixed message, 429 is 503, 5xx is 502" |
| 429 | 503 | "PayPal is rate limiting this app. Try again soon." | same status mapping test |
| 5xx | 502 | "PayPal had an error." | same status mapping test |
| a `DecodeError` on an error status | the original status | "PayPal rejected the request; the details were unreadable." | same status mapping test |
| a `DecodeError` on a success status | 502 | "PayPal answered with something unreadable." | "a truncated success body is not reported as success" |
| no response, on a write | per UNKNOWN OUTCOMES (HTTP 502 with the message "PayPal did not confirm ... outcome unknown", never "failed") | outcome unknown | the two lost-response tests |
| no response, on a read | 502 | "PayPal could not be reached." | "a connection failure on a read is a plain 502, not an unknown outcome" |

SDK `err.message` (it names the URL) is never put on the wire. The response carries a message written here, or PayPal's reason for a caller-caused `4xx`.

## Observability

Logging is off (`level: 'off'`, request bodies never logged). The `debugId` from a PayPal error body is kept on the app error (`err.debugId`) and written to the activity log line for the failed step, so support can quote it. There are no hooks or middleware on this SDK; none are built.

## Assumptions and blockers

- Assumption: the approve link is the `links` entry with `rel` `payer-action` or `approve` (PayPal docs, not stated in the SDK map). If neither is present the adapter reports no link and `refresh` re-reads the order. VERIFY V9 records the real `rel`.
- Assumption: `application_context.return_url` is honoured for a PayPal-wallet checkout without `payment_source`. If PayPal ignores it, VERIFY V9 names the fallback (`paymentSource.paypal.experienceContext`, same fields).
- Assumption: `PayPal-Request-Id` dedupes `POST /v2/checkout/orders` and `POST .../capture` replays. This is the one thing the create settle depends on.
- No blocker. Nothing was run against PayPal.

## REQUIRED READING

Loaded before code: `typescript-error-handling`, `typescript-client-initialization`, `typescript-testing`, `typescript-calling-endpoints`, `typescript-models`, `typescript-configuration-resilience`.
