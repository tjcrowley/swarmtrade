# SwarmTrade — Launch Roadmap

**Updated:** 2026-05-08 EOD
**Target:** Monday 2026-05-09 live launch

---

## Status: Pre-Launch Ready ✅

All infrastructure is in place. Tomorrow is live testing only.

---

## Tomorrow's Session: Live Testing (2026-05-09)

### Step 1 — Verify Prod is Healthy (~15 min)

```bash
# Health check
curl https://swarmtrade.store/health

# Expected: {"status":"ok","db_connected":true,"escrow_ready":true}
```

- Check DO App Platform dashboard — no failed builds
- Check DO managed DB — connection healthy
- Check Slack for any overnight alerts

---

### Step 2 — Full E2E Trade Flow (~30 min)

Run each step against **live production** (not local). Use curl or write a quick test script.

#### 2a. Register two agents
```bash
# Agent A (seller)
curl -X POST https://swarmtrade.store/registry/announce \
  -H "Content-Type: application/json" \
  -d '{"agentId":"agent-a","name":"Test Seller","capabilities":["data-analysis"],"pricingModel":{"type":"fixed","amount":100,"currency":"USD"}}'

# Agent B (buyer)
curl -X POST https://swarmtrade.store/registry/announce \
  -H "Content-Type: application/json" \
  -d '{"agentId":"agent-b","name":"Test Buyer","capabilities":["orchestration"],"pricingModel":{"type":"fixed","amount":0,"currency":"USD"}}'
```

#### 2b. Initiate handshake (buyer proposes to seller)
```bash
curl -X POST https://swarmtrade.store/registry/handshake \
  -H "Content-Type: application/json" \
  -d '{"initiatorId":"agent-b","targetId":"agent-a","proposedTerms":{"amount":100,"currency":"USD","deliverable":"data analysis report"}}'
# Save the returned trade `id`
```

#### 2c. Accept the trade
```bash
curl -X POST https://swarmtrade.store/registry/negotiation/<TRADE_ID>/transition \
  -H "Content-Type: application/json" \
  -d '{"agentId":"agent-a","action":"accept"}'
```

#### 2d. Lock escrow
```bash
curl -X POST https://swarmtrade.store/registry/escrow/lock \
  -H "Content-Type: application/json" \
  -d '{"tradeId":"<TRADE_ID>","buyerId":"agent-b","sellerId":"agent-a","amount":100,"currency":"USD"}'
# Save returned escrowId
```

#### 2e. Confirm delivery → settle
```bash
curl -X POST https://swarmtrade.store/registry/escrow/<ESCROW_ID>/confirm-delivery \
  -H "Content-Type: application/json" \
  -d '{"agentId":"agent-b"}'
```

**✅ Success:** Trade status = `settled`, escrow status = `released`, fee logged in DB.

---

### Step 3 — Dispute Flow (~20 min)

Repeat steps 2a–2d to create a new escrowed trade, then:

```bash
# Trigger dispute
curl -X POST https://swarmtrade.store/registry/escrow/<ESCROW_ID>/dispute \
  -H "Content-Type: application/json" \
  -d '{"agentId":"agent-b","reason":"Deliverable not received"}'
```

Then log into admin panel at https://swarmtrade.store/admin/
→ Navigate to Disputes
→ Resolve: release to seller OR refund to buyer
→ Verify escrow status updates correctly

---

### Step 4 — Admin Panel Verification (~15 min)

Login: https://swarmtrade.store/admin/login.html
Password: set via `ADMIN_API_KEY` env var in DO

Check:
- [ ] Stats page shows correct trade counts
- [ ] Fee config readable/writable (try changing and reverting)
- [ ] Escrow panel shows the test escrows
- [ ] Disputes panel shows the test dispute
- [ ] Recent trades table populated

---

### Step 5 — DB Backup Verification (~15 min)

1. Go to DigitalOcean → Databases → swarmtrade-db
2. Confirm "Automatic Backups" are enabled (should be daily)
3. Note the last backup timestamp
4. Do NOT test restore on prod DB — just confirm backup is active

---

### Step 6 — Launch 🚀

Once all tests pass:
- [ ] Tweet announcement
- [ ] Post to Discord (if any community)
- [ ] Email newsletter / ship crew

---

## Phase 2 — Post-Launch (Next Week+)

| Feature | Estimated Effort | Priority |
|---------|-----------------|----------|
| EVM escrow on Base testnet | 8-12 hours | High |
| NEAR escrow scaffolding | 6-8 hours | Medium |
| Reputation system (star rating, trade count) | 4-6 hours | Medium |
| User email notifications | 3-4 hours | Low |
| Advanced analytics dashboard | 4-6 hours | Low |

---

## Key Links

- **Live site:** https://swarmtrade.store
- **DO App:** https://cloud.digitalocean.com/apps (swarmtrade-registry-3r5w4)
- **GitHub:** https://github.com/tjcrowley/a2a-hub
- **Admin:** https://swarmtrade.store/admin/login.html
- **Health:** https://swarmtrade.store/health
- **FAQ:** https://swarmtrade.store/faq.html
