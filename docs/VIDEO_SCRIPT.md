# Video script (2:48, captions on screen, the voice reads the same sentences)

## Start in the recording state

```bash
npm install
npm run demo:video     # builds, then starts on http://localhost:3002 with mock PayPal and a fresh in-memory state
```

Open `http://localhost:3002` in a fresh browser window at 1440x900. Restarting the command clears every contract.

`demo:video` forces the built-in mock PayPal and the model replay, whatever is in `.env`. The header then reads "Mock PayPal (Invoicing v2 shapes) | Recorded runs: Claude Sonnet, 2026-11-12 (samples), rule-based for new text". Every agent line on screen names its source: "Recorded run: Claude Sonnet, 2026-11-12" is a real model run replayed on today's data (see `server/builtin/recorded-runs/`), never a scripted text.

A sandbox take (PayPal sandbox keys in `.env`, `npm start` without `FORCE_MOCK`) is optional and needs a person; it uses the same steps, and the checkout in scene 5 becomes the real PayPal sandbox page. V1 and V9 in `VERIFY.md` passed on 2026-11-12, so both may be shown.

Step numbers are the README "Testing instructions" steps; DEVPOST uses the same numbers and names. The three-step guide band in the app ("Approve checkout + invoices", "Client pays deposit", "Drag the wedding date") is steps 2, 3 and 4. Captions name no calendar dates, because the samples are built from the day they are opened.

| Time | Scene | On screen | Caption (English) | Criterion |
|---|---|---|---|---|
| 0:00-0:10 | 1 Cold open | 8 second clip from scene 6: the red WEDDING DAY diamond dragged right, the scheduled payments follow, the approval card appears | Lena photographs weddings and bills couples through PayPal. The couple just moved their wedding. | E2, D3 |
| 0:10-0:24 | 2 The problem | First screen with the read-only preview Gantt. Overlay: "Photography: often paid 30 days before the wedding" (The Knot), "Couples hire 13 vendors on average" (The Knot 2026 Real Weddings Study), "Choose a new due date, then re-share the updated invoice" (HoneyBook help centre) | Every payment counts back from the wedding day. Move the day, and each invoice has to be fixed by hand. | C1, C2, E2 |
| 0:24-0:42 | 3 Step 1, Try sample: Ortiz & Lee | Press **Try sample: Ortiz & Lee**. Zoom on the left column: three quoted clauses, "30% = $1,440", "Read by Recorded run: Claude Sonnet, 2026-11-12". The card "Create the deposit checkout and 2 PayPal invoices?" | Claude reads the contract and quotes it. Code computes every dollar and checks 30 + 40 + 30 equals the $4,800 total. | A2, A3, B3 |
| 0:42-0:58 | 4 Step 2, Approve checkout + invoices | Press **Approve checkout and 2 invoices**. Badges ORDER CREATED and SCHEDULED, paper-plane markers 14 days before each due date, the guide band ticks | One approval: a PayPal checkout for the deposit, and two PayPal invoices scheduled to send 14 days before they are due. | A1, B3 |
| 0:58-1:28 | 5 Step 3, Client pays deposit | Press **Open the client checkout link**, then **Pay Now**. Back in the app: CAPTURED, the Agent panel with the tool line `get_schedule > get_invoice_status > get_dependents > list_options > list_contract_clauses > propose_option (Recorded run: Claude Sonnet, 2026-11-12 ...)`, the orange dashed proposal bar on the Engagement shoot row. Press **Apply proposal** | The deposit is in. The agent looks at the plan and picks one option the server computed. It cannot write a date or an amount. | A2, D2, E1 |
| 1:28-2:00 | 6 Step 4, Drag the wedding date | Press **Jump to the wedding day**, drag the red diamond about 49 days right. Grey bars keep the old plan. Zoom on the card: each invoice as `send A -> B · due C -> D`, the date change fee line, "Unchanged (pinned): Deposit Retainer $1,440 CAPTURED", the agent note with its recorded-run label. Press **Approve 3 PayPal changes**; "0 not synced" | Drag one bar. The unsent invoices follow, the paid deposit stays pinned, and one approval rewrites PayPal's send and due dates. | D1, D3, B3, A1 |
| 2:00-2:14 | 7 Step 5, Kim & Rivera | Press **Kim & Rivera**, approve. Agent panel: "Hold Album order", the reminder card that quotes the contract | An installment is due and unpaid. The agent holds the album order, the one task that costs outside money, and drafts a reminder. | C3, A2 |
| 2:14-2:30 | 8 Step 5, partial failure | Press **Ortiz & Lee** again, approve, open Demo controls, **Make the next PayPal edit fail**, type the new date, approve. "2 of 3 changes applied", NOT SYNCED, press **Retry**, "0 not synced" | If PayPal refuses one edit, the others stay, the screen says which one failed, and Retry sends only that one. (Simulated failure on the mock.) | A3, A4 |
| 2:30-2:38 | 9 Step 5, Novak & Daniels | Press **Novak & Daniels**: "Clauses add up to $4,560, contract total is $4,800." | If the contract does not add up, nothing is invoiced. | A3, B2 |
| 2:38-2:45 | 10 Proof | Open **Sandbox evidence** at the bottom of the page (V1 and V9 rows), then a terminal with the `npm test` pass line and `npm run check:bryntum` 7 PASS lines | Checked against the PayPal sandbox on November 12, and covered by tests. | E1, A4 |
| 2:45-2:48 | 11 End | "VowLedger. Move the wedding, not the paperwork." "Bryntum Gantt, PayPal Invoicing v2 + Orders v2 + Agent Toolkit, Claude" | Same text. | E3 |

Do not film: a "PayPal sandbox connected" header over a mock take, the API-key Claude path (not run), webhooks (V5 not run), or automatic reminders (V6 not wired).
