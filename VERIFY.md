# VERIFY

Results from a sandbox run on 2026-11-12 are recorded under each item. The code paths are covered by the mock in `npm test`. Run an item again only after a person approves it; each one names the calls, the order, and the fallback.

Set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` (sandbox REST app) and unset `FORCE_MOCK` before items V1 to V6, V7 step 3 and V9. For V9 also set `APP_BASE_URL` to a URL the sandbox buyer's browser can reach (the local `http://localhost:3002` works because the redirect happens in the buyer's own browser). Do not run them while another job is logged in to the same sandbox account.

## Done: VB, Bryntum Backward behavior (real Gantt, no external service)

`npm run check:bryntum` (app running with `FORCE_MOCK=1`) drives the real Bryntum Gantt 7.3.8 trial in headless Chromium.

Stability (2026-11-12): the script has no fixed sleeps; each step waits for the server answer it caused and then for the Gantt to show the server's dates (the Gantt is re-mounted after a refused move). Five runs in a row against one mock server (port 3594): 7/7 each time.

| Check | Result |
|---|---|
| VB1 Loading the server's dates into a Backward project does not make Bryntum recalculate them (event is held by `startnolaterthan`, pinned items by `muststarton`, dependency lags copied from the server) | pass |
| VB2 Dragging the wedding bar: Bryntum's preview after the drop equals the server plan for the same date (payments, tasks) | pass |
| VB3 Pinned (`muststarton`) retainer and its follow-up shoot do not move | pass |
| VB4 Dropping before today: server refuses, Gantt snaps back to the server plan | pass |
| VB5 Moving earlier than a pinned payment allows (sample A): the server answers "pinned", Gantt snaps back | pass |
| VB6 The proposal baseline is drawn at the date the server proposed (exactly one `.vl-bl-proposal` element) | pass |
| VB7 Indicators: each scheduled invoice's issue marker is its due date minus 14 days | pass |

Findings that shaped the build: an event milestone with `muststarton` cannot be dragged (the drop is reverted); `startnolaterthan` makes ALAP place it on the right day and lets the drag rewrite the date. The project end must lie well behind the wedding or a drop later than it is refused. Bryntum draws no conflict dialog for the earlier-than-pinned case, so the server rule is the guard.

## V1 Scheduled invoices keep SCHEDULED after a PUT (needed for the drag scene)

**Result 2026-11-12: PASS.** INV-0023 / INV-0024 (INV2-A5MT-RBVW-MQ22-JNPN, INV2-G35H-WY68-9WMR-CPM9) were SCHEDULED with issue 2026-12-28 / 2027-01-27, due 2027-01-11 / 2027-02-10. After the wedding moved 2027-03-12 -> 2027-03-26 (get, PUT, get) both stayed SCHEDULED with issue 2027-01-11 / 2027-02-10, due 2027-01-25 / 2027-02-24. Bug found and fixed on the way: `send_invoice` answered 422 USER_NOT_FOUND because the sample invoicer email (lena@example.com) is not the sandbox business account, and the Toolkit hid the error, leaving the invoice DRAFT. `invoiceBody.js` now leaves `invoicer.email_address` out on the sandbox path (PayPal uses the REST app's account). Note: invoice numbers are shared by every app on the same sandbox business account, so a number can collide (DUPLICATE_INVOICE_NUMBER); a retry takes the next number.

1. Open the app, press "Try sample: Ortiz & Lee", approve the 3 invoices (calls: `POST /v2/invoicing/invoices` with `detail.invoice_date` = due - 14 days, then Toolkit `send_invoice`).
2. In the sandbox business dashboard, or with Toolkit `get_invoice`, confirm the 2nd installment and the balance are `SCHEDULED` with `invoice_date` 2026-12-28 / 2027-01-27 (for a run on 2026-11-12) and `payment_term.due_date` 2027-01-11 / 2027-02-10.
3. Drag the wedding date, approve the card. Calls per invoice: `get_invoice`, `PUT /v2/invoicing/invoices/{id}`, `get_invoice`.
4. Confirm both dates changed and the status is still `SCHEDULED`.

If it fails: replace the `SCHEDULED` state with a server scheduler that calls `send_invoice` on the issue date (`services/invoiceOps.js`, `createAndSend`: skip the send when the issue date is in the future, and send from `pollContract`). Then change every "SCHEDULED" label in the badges, README and video to "app-scheduled" in one pass.

## V2 Past due date

**Result 2026-11-12: PASS (PayPal accepts it).** Invoice with invoice_date 2026-11-12 and due_date 2026-11-09 was created and sent: status SENT, due_date 2026-11-09 (INV2-H8WV-SVP6-9543-RD68). `dueForPaypal` was left unchanged on purpose (it has a test and the diff logic relies on it); switching it to return the real due date is optional.

1. Create an invoice with `invoice_date` = today and `due_date` = 3 days ago, then `send_invoice`.
2. If PayPal accepts it, `dueForPaypal` in `schedule/engine.js` can return the real due date instead of today, and "3 days late" appears on the invoice. If it rejects it, nothing changes: the app already sends today as the due date and keeps the contract date for its own overdue count.

## V3 Partial payment by the sandbox buyer

**Result 2026-11-12: PARTIAL.** The buyer paying part of an invoice on the hosted page was not driven (needs UI exploration). Fallback path ran: "Record bank transfer" $50 on the $150 fee invoice INV-0026 (INV2-BVJN-K9QK-RZYJ-T8PD): SENT -> PARTIALLY_PAID, paid 5000 cents; the retainer stayed pinned. Hosted-page partial payment: a person must try it.

1. With `configuration.partial_payment.allow_partial_payment = true` (the app sets it when the contract says partial payments are accepted), pay $500 of the retainer from the sandbox buyer account.
2. Run "Poll invoices" and confirm `PARTIALLY_PAID`; the retainer stays pinned and the agent is not triggered.
3. If the hosted page refuses a partial amount: use "Record bank transfer" with a partial amount (`record_payment_for_invoice`), which is already implemented and tested on the mock.

## V4 PUT on a SENT invoice (outside the demo path)

**Result 2026-11-12: PASS (PayPal allows it).** SENT invoice INV2-VCR7-CKYA-KJU3-RNX5: PUT with due_date 2026-11-20 -> 2026-11-27 and send_to_recipient=true answered 200, status stayed SENT, due date changed. An "extend due date" action could reuse `withNewDates`; not added.

1. `PUT` a `SENT` invoice with a new due date and `send_to_recipient: true`.
2. The app does not do this: sent invoices are pinned. If PayPal allows it, an "extend due date" action can reuse `withNewDates`. If not, the fallback is `cancel_sent_invoice` plus a new invoice.

## V5 Webhook delivery

**Recheck 2026-11-13 KST (sandbox OAuth + read-only webhook inventory).** The sandbox REST application accepted OAuth (HTTP 200) and listed four registered listeners, all for other entries. None subscribed to INVOICING.INVOICE.PAID or to all event types. The local VowLedger webhook ID is unset. No test payment was initiated: an invoice event cannot reach this application through the current registrations. Public callback delivery and PayPal signature verification remain unconfirmed. In the sandbox demo, use Payments and polling > Poll invoices. The local HTTP regression covers authentication rejection, a transient invoice-read failure, and concurrent mock redeliveries resulting in a single hold release.

**Result 2026-11-12: SKIPPED.** Needs a public URL or tunnel and a webhook id. A person must expose `/api/webhooks/paypal`, create the sandbox webhook and set `PAYPAL_WEBHOOK_ID`.

1. Expose `/api/webhooks/paypal` (for example with a tunnel), create a sandbox webhook for `INVOICING.INVOICE.PAID`, `.SCHEDULED`, `.UPDATED`, `.CANCELLED`, `.CREATED`, and set `PAYPAL_WEBHOOK_ID`.
2. Pay an invoice from the buyer account. The route verifies the signature with `/v1/notifications/verify-webhook-signature`, de-duplicates by event id, calls `get_invoice`, and the agent runs.
3. If delivery does not work: nothing to change, the 5 second poll (`POLL_INTERVAL_MS`) is already the second entrance.

## V6 Automatic reminders

**Result 2026-11-12: SKIPPED.** Not wired in the app; nothing to run.

Toolkit `setup_invoice_auto_reminders` exists in the installed 1.11.0 but is not wired. Only manual reminders (`send_invoice_reminder`, 2 per invoice per day) are implemented. To add it, enable the action in `integrations/livePaypal.js` and call it from a new approval type.

## V7 SDK smoke (APIMatic Context Plugin)

**Result 2026-11-12: PASS.** Step 1: `node_modules/paypal/package.json` resolved, `dist` has `esm` and `commonjs`. Step 2: grep for invoic|webhook found nothing. Step 3: `getOrder('0AAAAAAAAAAAAAAAA')` answered `404 Specified resource ID does not exist.` against the sandbox. No fallback needed.

The SDK is used for the three Orders calls of the deposit path. Steps 1 and 2 are offline; step 3 is a read-only call against the sandbox and needs a person's approval.

1. `node -e "console.log(require.resolve('paypal/package.json'))"` prints a path under `node_modules/paypal/` and `ls node_modules/paypal/dist` lists `esm` and `commonjs`.
2. `grep -rniE "invoic|webhook" node_modules/paypal/sdk-map.md node_modules/paypal/map/operations` prints nothing. If it prints matches, a newer SDK covers Invoicing or webhooks: redo the lookup in `paypal-plan.md` and move those calls.
3. Read-only smoke, one SDK call against the sandbox credential (it reads an order id that does not exist, so nothing is created or changed):

   ```
   node --input-type=module -e "import 'dotenv/config'; import { createLiveOrders } from './server/integrations/orders/liveOrders.js'; const o = createLiveOrders({ clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET }); o.getOrder('0AAAAAAAAAAAAAAAA').then(console.log, (e) => console.log(e.status, e.message))"
   ```

   Expected: `404` and a message that names the missing resource. That proves the OAuth token fetch, the sandbox host binding, the request shape and the error mapping with the real service. A `502` with "credentials" means the key pair is wrong; a `403` shown as 502 means the app lacks Orders access (see the fallback).
4. Fallback if the sandbox app cannot call Orders (403) or the SDK build is unusable: set `DEPOSIT_CHECKOUT=0`. The first milestone goes back to an invoice with no other change, and the SDK section of the README is then reworded to "planned, not exercised".

## V8 Live Claude path

**Result 2026-11-12: PASS (account-mode Sonnet, 2026-11-12).** Model `claude-sonnet-5-5` through the Claude Agent SDK and the local Claude Code login (`LLM_BACKEND=account`, `ANTHROPIC_API_KEY` empty and stripped from the child environment), PayPal on the mock (`FORCE_MOCK_PAYPAL=1`). One run per scenario. Reader: sample B read in 14.6 s with 3 clauses (Retainer 30% $1,440, Second installment 40% $1,920, Balance 30% $1,440) and the $150 date-change fee, the same as the mock reader, `readBy` = claude-account. Agent after the deposit was captured: tools `get_dependents > get_invoice_status > list_options > get_schedule > list_contract_clauses > propose_option`, chose `paid:p1:pull:t1` (start the Engagement shoot early) with a reason that cited task names and had no dates, `via` = claude-account, server changes line `Engagement shoot Nov 26 -> Nov 13`. Wedding move to 2027-04-30: the agent's note picked the fee option from the date-change clause. The tool order differs from the mock's but passed the same validation, so no prompt change was needed. This does NOT verify the hosted API-key path (`server/agent/claudeAgent.js` with `@anthropic-ai/sdk`), which shares the prompt and tools but was not run. The unit test `test/account.test.js` covers the adapter with a fake SDK.

Recorded runs (account-mode Sonnet, 2026-11-12, `npm run record:runs`, PayPal on the in-memory mock): 6 runs saved in `server/builtin/recorded-runs/` with tool calls in order, timings and the model's closing text. reader-A, reader-B accepted (30/40/30, $150 fee, 14 lead days); reader-C read 30/35/30 and the server refused it ("Clauses add up to $4,560"). agent-B-PAID-p1: `get_schedule > get_invoice_status > get_dependents > list_options > list_contract_clauses > propose_option`, chose `paid:p1:pull:t1`, 11.1 s. agent-B-MOVE: `list_contract_clauses > list_options > get_schedule > propose_option`, chose `move:fee-add`, 19.2 s. agent-A-DUE_UNPAID-p2: `get_schedule > get_invoice_status > get_dependents > list_options > list_contract_clauses > propose_option`, chose `due:p2:hold:t2` with a reminder note, 9.8 s. All picks passed the server validation; mock mode replays them on today's data and labels them "Recorded run: Claude Sonnet, 2026-11-12".

Note: an earlier attempt of this run, before `FORCE_MOCK_PAYPAL` existed, used the sandbox keys from `.env` and created one deposit order and two scheduled invoices in the sandbox by mistake (no capture). It was rerun with PayPal on the mock.

**Cleanup 2026-11-12 (`node scripts/sandbox-invoices.mjs`).** The two leftover Ortiz & Lee invoices that no record cites, INV-0021 `INV2-H9LW-6LGW-QH44-JBJ7` (SCHEDULED) and INV-0022 `INV2-Z67W-QDM2-RU23-B6MS` (DRAFT), were removed: PayPal refuses `cancel` for these states (422 CANNOT_CANCEL_SCHEDULED_INVOICE / CANNOT_CANCEL_DRAFT_INVOICE), so they were deleted (204), and a GET now answers 404. Orders v2 has no cancel or void call for an uncaptured order, so the uncaptured order 7EB337512H6905503 (V9 note, status APPROVED) stays; no money moved and PayPal expires it. The id of the order from the mistaken run was not recorded, so it cannot be named.

**Re-recorded 2026-11-12 after the "moves" fix (account-mode Sonnet, `npm run record:runs -- agent-B-PAID-p1 agent-B-MOVE agent-A-DUE_UNPAID-p2`).** The first agent-B-MOVE recording said the Engagement shoot shifts with the wedding, although it is tied to the captured deposit and stays. Root cause: `get_schedule` and `list_options` gave dates only, not which tasks move. Both tools now say it (`movesWithWedding`, `tiedToPinnedPayment`, `movingTasks`, `unchangedTasks`), the prompt says that tasks tied to a sent or paid payment stay, and `propose_option` refuses a reason that says an unchanged task moves. New runs: agent-B-PAID-p1 `get_dependents > get_invoice_status > list_options > get_schedule > propose_option`, `paid:p1:pull:t1`, 8.5 s; agent-B-MOVE `get_schedule > list_options > list_contract_clauses > propose_option`, `move:fee-add`, 10.8 s, reason "Two tasks ... move with it: Album order and Final shot list ... Engagement shoot does not move. It is tied to the Retainer, which is already paid"; agent-A-DUE_UNPAID-p2 `get_schedule > get_invoice_status > get_dependents > list_contract_clauses > list_options > propose_option`, `due:p2:hold:t2` with a reminder note, 11.9 s. Every call passed the new check on the first try.

**Re-recorded 2026-11-12 after widening the decision (account-mode Sonnet, same command, PayPal on the mock).** `propose_option` now also requires `not_chosen`: every other option from `list_options` with its own reason, checked by the server (each other id exactly once, no unknown id, no date, no amount). A reminder must name the contract clause it rests on (`reminder_clause`, checked against `list_contract_clauses`), and no reason, `not_chosen` line or reminder may carry a dollar amount. New runs: agent-B-PAID-p1 `get_schedule > get_dependents > get_invoice_status > list_options > list_contract_clauses > propose_option`, `paid:p1:pull:t1`, not chosen "Keep the planned dates" because "it leaves the internal Engagement shoot waiting for no reason", 8.9 s; agent-B-MOVE `get_schedule > list_options > list_contract_clauses > propose_option`, `move:fee-add`, not chosen "Move the date without a fee" because "it waives the change fee even though the date_change clause applies", 9.1 s; agent-A-DUE_UNPAID-p2 `get_schedule > get_invoice_status > get_dependents > list_contract_clauses > list_options > propose_option`, `due:p2:hold:t2`, not chosen "Proceed as planned" because the album order would start while the installment is unpaid, reminder citing clause `p2` ("40% of the total fee is due 60 days before the event."), 10.8 s. Every call passed the check on the first try. The screen shows each "Not chosen" line under the agent's reason.

Original steps for the API-key path:

1. Set `ANTHROPIC_API_KEY`, open a sample, and check that the clauses match the mock reader's (`server/contracts/extract.js`, tool `submit_contract_terms`).
2. Pay an invoice and check the agent log line `tools: ... propose_option (claude)`.
3. If the model repeats a rejected call (a date in the reason, an unknown id), the loop gets the error text and retries up to 8 steps; after that the rule-based agent decides and the activity log says so.

## S1 Full app walk in sandbox mode (README steps 1 to 4)

**Result 2026-11-12: PASS.** `npm run demo:sandbox` equivalent (port 3482, PayPal sandbox, model replay), driven by `scripts/sandbox-walk.py` through the sandbox buyer pool. Header chip "PayPal sandbox connected". Step 2: deposit order 28E9422366600420M and INV-0021 / INV-0022 SCHEDULED (send 2026-12-28 / 2027-01-27, due 2027-01-11 / 2027-02-10). Step 3: the real sandbox checkout page (`www.sandbox.paypal.com/checkoutnow`, "Cancel and return to Lena Park Photography", screenshot `final_shots/sb_02_paypal_sandbox_checkout.png`), buyer paid, the app captured: capture 98690159WF131234R COMPLETED $1,440.00, recorded agent pick "Start Engagement shoot now" applied. Step 4: wedding dragged Mar 12 -> Apr 30; card "INV-0021 Second installment $1,920 send Dec 28 -> Feb 15 · due Jan 11 -> Mar 1", "INV-0022 Balance $1,440 send Jan 27 -> Mar 17 · due Feb 10 -> Mar 31", "NEW Date change fee $150 send now", "Unchanged (pinned): Deposit Retainer $1,440 CAPTURED"; approved, "0 not synced". Read back with `get_invoice`: INV2-86XB-BSRM-ZLFH-YTEF INV-0021 SCHEDULED issue 2027-02-15 due 2027-03-01; INV2-D2M6-NSD4-4X6K-GC8S INV-0022 SCHEDULED issue 2027-03-17 due 2027-03-31; INV2-N9E9-SLEG-4XZU-4HTH INV-0027 fee SENT. Screenshots `final_shots/sb_01..05`, log `final_shots/sb_walk_log.txt`.

Bug found and fixed on the way: the first attempt failed both invoices with 422 DUPLICATE_INVOICE_NUMBER, because the app's number counter restarts at INV-0021 on every start while the sandbox business account (shared by every app and every restart) keeps its numbers. `createAndSend` now takes the next number on DUPLICATE_INVOICE_NUMBER (up to 25 tries, the request id carries the number); the fee invoice in the passing run skipped INV-0023 to INV-0026 this way. Mock test added. That failed attempt left order 0BB66971K9656091S captured ($1,440 sandbox money, its contract existed only in that server's memory) and an earlier aborted attempt left order 52887987LN711735K CREATED (uncaptured, its two invoices deleted, 204).

## V9 Deposit checkout and capture (Orders v2 through the SDK)

**Result 2026-11-12: PASS for steps 1 to 5, step 6 SKIPPED.** Step 1: order 36B880966G086342U created with the card approval. Step 2: log shows "PayPal checkout created", badge ORDER_CREATED; `GET` of the order lists links `self, approve, update, capture` (rel `approve`; the create response's rel was not recorded separately, the app built `https://www.sandbox.paypal.com/checkoutnow?token=...`). Step 3: sandbox buyer approved in headless Chromium and the browser returned to the app; badge CAPTURED, capture 85Y88848TP7114705, $1,440.00 COMPLETED, agent proposed "Start Engagement shoot now". The redirect to `/api/deposit/return` worked, so no `experience_context` change. Step 4: pressing capture again sent no second call; PayPal shows exactly one capture on the order. Step 5: moving the wedding listed the deposit under Unchanged (pinned). Step 6 (network cut) needs a person. Note: a first order (7EB337512H6905503) was approved but not captured because the local server was stopped during the redirect; it is left uncaptured.

Needs the sandbox business account and a sandbox buyer account. `APP_BASE_URL` must be set as described at the top.

1. Open the app, press "Try sample: Ortiz & Lee", approve the card "Create the deposit checkout and 2 PayPal invoices?". Calls in order: `POST /v2/checkout/orders` (with `PayPal-Request-Id` = `vl-dep-{contract}-p1-1`), then the invoice calls of V1 for the two later milestones.
2. Confirm in the activity log "PayPal checkout created (order ...)" and the Gantt badge `ORDER CREATED`. In the response of the create call, record which `links[].rel` carries the approve URL: the code accepts `payer-action` and `approve`. If neither is present the panel shows no link: send the order id to the person testing and read the link from the `GET /v2/checkout/orders/{id}` response.
3. Press "Open the client checkout link", log in as the sandbox buyer, pay. The browser comes back to `/api/deposit/return?token=ORDERID`. Calls in order: `GET /v2/checkout/orders/{id}` (must be `APPROVED`), `POST /v2/checkout/orders/{id}/capture` (with `PayPal-Request-Id` = `vl-cap-{orderId}`). Confirm the badge `CAPTURED`, "Paid $1,440", and that the agent proposes a task change.
4. Replay safety: press "Capture now" again. No second capture call may leave (the claim is kept). In the sandbox dashboard the order shows exactly one capture.
5. Move the wedding on the Gantt: the card lists the deposit under "Unchanged (pinned)".
6. Unknown-outcome settle (done by hand, needs a person): cut the network right after the create call leaves, the activity log says "PayPal did not confirm the order yet" and the badge shows `CHECKING`. Restore the network and press Retry on the sync card: the replay with the same `PayPal-Request-Id` must return the same order id. Record whether PayPal honours the replay for `POST /v2/checkout/orders`.

If step 3's redirect does not return to the app (the sandbox ignores `application_context.return_url`): move the same three fields (`brand_name`, `return_url`, `cancel_url`) into `payment_source.paypal.experience_context` in `liveOrders.js`, or press "Capture now" after the payer approved (that path reads the order and captures the same way).
If the replay in step 6 creates a second order, create is not idempotent on `PayPal-Request-Id`: change `createDeposit` to settle by asking the person for the order id in the dashboard (`custom_id` carries the reference) and add it by hand; the claim row already stops the app from creating a second one by itself.

## Hosting

- **Result: PASS 2026-11-12.** https://vowledger.35-216-2-121.sslip.io on a Google Cloud VM (nginx, Let's Encrypt, systemd). Mode: mock PayPal, recorded Claude Sonnet runs. `GET /` and the health endpoint return 200 over https. Walked headless against the https host: Testing instructions steps 1 to 5 (Ortiz & Lee $4,800, approve, deposit checkout returned to the https host and CAPTURED, apply proposal, move the date to 2027-04-30 with 0 not synced, Novak & Daniels blocked at $4,560).
