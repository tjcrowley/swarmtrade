/**
 * Slack alerting for production error rate monitoring.
 *
 * Tracks 5xx responses in a rolling 60-second window.
 * If the 5xx rate exceeds 1% (min 5 total requests), posts to Slack.
 * Throttles alerts to at most one per 5 minutes.
 *
 * Activated by setting SLACK_WEBHOOK_URL env var.
 */

interface WindowEntry {
  ts: number;
  is5xx: boolean;
}

const WINDOW_MS = 60_000;
const RATE_THRESHOLD = 0.01; // 1%
const MIN_REQUESTS = 5;
const THROTTLE_MS = 5 * 60_000; // 5 minutes between alerts

const window: WindowEntry[] = [];
let lastAlertAt = 0;

export function recordResponse(statusCode: number): void {
  const now = Date.now();
  window.push({ ts: now, is5xx: statusCode >= 500 });

  // Evict entries outside the rolling window
  const cutoff = now - WINDOW_MS;
  while (window.length > 0 && window[0].ts < cutoff) window.shift();

  if (window.length < MIN_REQUESTS) return;
  if (now - lastAlertAt < THROTTLE_MS) return;

  const total = window.length;
  const errors = window.filter((e) => e.is5xx).length;
  const rate = errors / total;

  if (rate > RATE_THRESHOLD) {
    lastAlertAt = now;
    sendSlackAlert(errors, total, rate).catch(() => { /* best effort */ });
  }
}

async function sendSlackAlert(errors: number, total: number, rate: number): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const pct = (rate * 100).toFixed(1);
  const body = JSON.stringify({
    text: `:rotating_light: *SwarmTrade 5xx alert* — ${errors}/${total} requests failed (${pct}%) in the last 60s\n<https://swarmtrade.store/health|Health check> | <https://cloud.digitalocean.com|DO Dashboard>`,
  });

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}
