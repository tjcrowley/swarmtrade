# SwarmTrade Operations Runbook

## Deploy to Production

Deployments are triggered automatically by pushes to `main`.

```bash
git push origin main
```

DO App Platform picks up the push, builds the Docker image, and deploys with zero-downtime rolling restart (typically 2–4 min).

**Verify deployment:**
```bash
curl -s https://swarmtrade.store/health | jq .
# Expect: { "status": "healthy", "db_connected": true, "escrow_ready": true }
```

---

## Rollback Procedure

### Option 1 — Revert commit and push (recommended)

```bash
# Find the last good commit
git log --oneline -10

# Revert HEAD to last good commit
git revert HEAD --no-edit       # revert last commit
# or to revert multiple:
git revert HEAD~2..HEAD --no-edit

git push origin main
```

### Option 2 — DO App Platform forced deploy of previous image

```bash
# List recent deploys
doctl apps list-deployments <APP_ID>

# Re-deploy a specific deployment ID
doctl apps create-deployment <APP_ID> --force-rebuild
```

Get APP_ID:
```bash
doctl apps list | grep swarmtrade
```

---

## Environment Variables

Set in DO App Platform → Settings → Environment Variables.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Managed PG connection string |
| `ADMIN_API_KEY` | yes | Admin dashboard access key |
| `COOKIE_SECRET` | yes | Signs admin session cookies (min 32 chars) |
| `SLACK_WEBHOOK_URL` | optional | 5xx alerting. Omit to disable. |
| `NODE_ENV` | yes | Set to `production` |

---

## Database

### Connection
```bash
doctl databases connection 153971f2-5154-48a6-8114-1270d226ff3f --format URI
```

### Backups
DO managed PostgreSQL takes automatic daily backups. Verify:
```bash
doctl databases backups 153971f2-5154-48a6-8114-1270d226ff3f
```

### Point-in-time restore
1. DO Console → Databases → swarmtrade-db → Backups
2. Click **Restore** next to a backup timestamp
3. Creates a new DB cluster — update `DATABASE_URL` in app env to point to it
4. Test with `/health` endpoint before full cutover

### Run migrations manually (if needed)
```bash
# Connect to DB
doctl databases connection 153971f2-5154-48a6-8114-1270d226ff3f --format URI
# Copy URI, then:
DATABASE_URL=<URI> node dist/migrate.js
```

---

## Monitoring & Alerts

- **Uptime monitoring:** DO Uptime Check on `/health` (email alerts if down >2 min)
- **Slack 5xx alerts:** Triggered when error rate >1% over 60s window (min 5 requests)
  - Configured via `SLACK_WEBHOOK_URL` env var
  - Throttled to 1 alert per 5 minutes

**Check current health:**
```bash
curl -s https://swarmtrade.store/health | jq .
```

---

## Admin Dashboard

URL: `https://swarmtrade.store/admin/login.html`

Auth: Use the `ADMIN_API_KEY` value set in DO environment variables.

Key pages:
- `/admin/login.html` — login
- `/admin/dashboard.html` — stats, trades, disputes, fee config

---

## Common Issues

### App not starting after deploy
Check DO App Platform logs in the console. Common causes:
- `DATABASE_URL` missing or wrong (migration will fail on startup)
- `ADMIN_API_KEY` or `COOKIE_SECRET` not set

### Health returns `db_connected: false`
- DB cluster may be restarting — check DO Databases console
- Connection pool exhausted — check for query leaks in logs

### `escrow_ready: false` (degraded)
- Expected on cold start before first request that registers adapters
- If persistent, check `ConfirmationEscrowAdapter` initialization in logs
