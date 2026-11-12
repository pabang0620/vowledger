# README screenshots

Both images are 1440x900 captures of the current app, made by `scripts/readme-shots.mjs` on a mock-mode server (mock PayPal, recorded Claude Sonnet runs). Re-run it whenever a screen below changes, so the README never shows an older layout.

| Image | Screen it shows | Client source of that screen |
|---|---|---|
| `05_agent_tool_trail_and_proposal_card.png` | Ortiz & Lee after the client paid the deposit: Gantt with the orange dashed proposal on the Engagement shoot row, the deposit CAPTURED, the Agent panel (option chosen, reason, "Not chosen" line, tool trail "Recorded run: Claude Sonnet", Apply proposal card), right rail Money and Clauses read | `client/src/components/GanttView.jsx`, `AgentPanel.jsx`, `ApprovalCard.jsx`, `DepositPanel.jsx`, `MoneyRail.jsx` |
| `08_after_sync_all_synced.png` | The same contract after Apply proposal, a 49-day wedding move and "Approve 3 PayPal changes": top bar with the "Try a sample" menu and mode chips, guide band with three checks, Gantt scrolled to the new wedding day with "was" baselines, right rail Money "0 not synced" with INV-0021 / INV-0022 SCHEDULED at the new dates and the date change fee SENT | `client/src/components/TopNav.jsx`, `Sidebar.jsx`, `StepBand.jsx`, `GanttView.jsx`, `MoneyRail.jsx` |

Regenerate (from `app/`, on a free port; INV-0021 / INV-0022 appear only on a freshly started server):

```bash
npm run build
FORCE_MOCK=1 FORCE_MOCK_PAYPAL=1 PORT=3594 npm start &
BASE_URL=http://localhost:3594 node scripts/readme-shots.mjs
```

The script writes straight to `docs/img/` (set `OUT=<folder>` to write elsewhere first) and exits with an error if the server is not in mock mode or the page throws.
