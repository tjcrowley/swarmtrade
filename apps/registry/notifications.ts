import { Pool } from 'pg';
import { createHmac } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationEvent =
  | 'trade.proposed' | 'trade.countered' | 'trade.accepted' | 'trade.rejected'
  | 'escrow.locked' | 'escrow.released' | 'escrow.refunded'
  | 'delivery.confirmed' | 'trade.settled'
  | 'trade.disputed' | 'trade.resolved'
  | 'trade.expired' | 'trade.cancelled';

export interface NotificationPayload {
  event: NotificationEvent;
  trade_id: string;
  timestamp: string;
  data: {
    buyer_id: string;
    seller_id: string;
    asset_id: string;
    status: string;
    trade_value?: number | null;
    currency?: string | null;
    fee_amount?: number | null;
    escrow_id?: string;
    resolution?: string;
    [key: string]: any;
  };
}

export interface Subscription {
  id: string;
  agent_id: string;
  webhook_url: string | null;
  email: string | null;
  events: string[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface NotificationLogEntry {
  id: string;
  subscription_id: string;
  trade_id: string;
  event: string;
  channel: string;
  payload: any;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Human-readable event names for email subjects
// ---------------------------------------------------------------------------

const EVENT_LABELS: Record<NotificationEvent, string> = {
  'trade.proposed': 'Trade Proposed',
  'trade.countered': 'Trade Countered',
  'trade.accepted': 'Trade Accepted',
  'trade.rejected': 'Trade Rejected',
  'escrow.locked': 'Escrow Locked',
  'escrow.released': 'Escrow Released',
  'escrow.refunded': 'Escrow Refunded',
  'delivery.confirmed': 'Delivery Confirmed',
  'trade.settled': 'Trade Settled',
  'trade.disputed': 'Trade Disputed',
  'trade.resolved': 'Trade Resolved',
  'trade.expired': 'Trade Expired',
  'trade.cancelled': 'Trade Cancelled',
};

// Map trade status → notification event
export const STATUS_EVENT_MAP: Record<string, NotificationEvent> = {
  proposed: 'trade.proposed',
  countered: 'trade.countered',
  accepted: 'trade.accepted',
  rejected: 'trade.rejected',
  escrowed: 'escrow.locked',
  delivery_confirmed: 'delivery.confirmed',
  settled: 'trade.settled',
  disputed: 'trade.disputed',
  resolved: 'trade.resolved',
  expired: 'trade.expired',
  cancelled: 'trade.cancelled',
};

// ---------------------------------------------------------------------------
// NotificationService
// ---------------------------------------------------------------------------

export class NotificationService {
  private emailWarned = false;

  constructor(private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // Subscription management
  // -------------------------------------------------------------------------

  async subscribe(agentId: string, opts: {
    webhook_url?: string;
    email?: string;
    events?: string[];
  }): Promise<Subscription> {
    const { webhook_url, email, events = [] } = opts;
    if (!webhook_url && !email) {
      throw new Error('Either webhook_url or email must be provided');
    }

    const client = await this.pool.connect();
    try {
      if (webhook_url) {
        const res = await client.query(
          `INSERT INTO notification_subscriptions (agent_id, webhook_url, email, events, active)
           VALUES ($1, $2, $3, $4, true)
           ON CONFLICT (agent_id, webhook_url) WHERE webhook_url IS NOT NULL
           DO UPDATE SET email = COALESCE($3, notification_subscriptions.email),
                         events = $4,
                         active = true,
                         updated_at = NOW()
           RETURNING id, agent_id, webhook_url, email, events, active, created_at, updated_at`,
          [agentId, webhook_url, email || null, events]
        );
        return res.rows[0];
      } else {
        const res = await client.query(
          `INSERT INTO notification_subscriptions (agent_id, webhook_url, email, events, active)
           VALUES ($1, NULL, $2, $3, true)
           ON CONFLICT (agent_id, email) WHERE email IS NOT NULL
           DO UPDATE SET events = $3,
                         active = true,
                         updated_at = NOW()
           RETURNING id, agent_id, webhook_url, email, events, active, created_at, updated_at`,
          [agentId, email, events]
        );
        return res.rows[0];
      }
    } finally {
      client.release();
    }
  }

  async unsubscribe(agentId: string, subscriptionId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE notification_subscriptions SET active = false, updated_at = NOW()
         WHERE id = $1 AND agent_id = $2`,
        [subscriptionId, agentId]
      );
    } finally {
      client.release();
    }
  }

  async getSubscriptions(agentId: string): Promise<Subscription[]> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT id, agent_id, webhook_url, email, events, active, created_at, updated_at
         FROM notification_subscriptions
         WHERE agent_id = $1 AND active = true
         ORDER BY created_at DESC`,
        [agentId]
      );
      return res.rows;
    } finally {
      client.release();
    }
  }

  async getNotificationLog(agentId: string, opts?: { limit?: number; offset?: number }): Promise<{
    notifications: NotificationLogEntry[];
    total: number;
  }> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT nl.id, nl.subscription_id, nl.trade_id, nl.event, nl.channel,
                nl.payload, nl.status, nl.attempts, nl.last_error, nl.created_at
         FROM notification_log nl
         JOIN notification_subscriptions ns ON nl.subscription_id = ns.id
         WHERE ns.agent_id = $1
         ORDER BY nl.created_at DESC
         LIMIT $2 OFFSET $3`,
        [agentId, limit, offset]
      );
      const countRes = await client.query(
        `SELECT COUNT(*) AS total
         FROM notification_log nl
         JOIN notification_subscriptions ns ON nl.subscription_id = ns.id
         WHERE ns.agent_id = $1`,
        [agentId]
      );
      return {
        notifications: res.rows,
        total: parseInt(countRes.rows[0].total, 10),
      };
    } finally {
      client.release();
    }
  }

  async getAllNotificationLog(opts?: { limit?: number; offset?: number }): Promise<{
    notifications: NotificationLogEntry[];
    total: number;
  }> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT nl.id, nl.subscription_id, nl.trade_id, nl.event, nl.channel,
                nl.payload, nl.status, nl.attempts, nl.last_error, nl.created_at
         FROM notification_log nl
         ORDER BY nl.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      const countRes = await client.query(
        `SELECT COUNT(*) AS total FROM notification_log`
      );
      return {
        notifications: res.rows,
        total: parseInt(countRes.rows[0].total, 10),
      };
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Fire notifications (non-blocking)
  // -------------------------------------------------------------------------

  notify(
    event: NotificationEvent,
    tradeId: string,
    data: NotificationPayload['data']
  ): void {
    // Fire-and-forget — errors are caught and logged, never thrown to caller
    this._notifyAsync(event, tradeId, data).catch((err) => {
      console.error('[notifications] Unexpected error in notify:', err);
    });
  }

  private async _notifyAsync(
    event: NotificationEvent,
    tradeId: string,
    data: NotificationPayload['data']
  ): Promise<void> {
    const payload: NotificationPayload = {
      event,
      trade_id: tradeId,
      timestamp: new Date().toISOString(),
      data,
    };

    // Find subscriptions for both buyer and seller
    const agentIds = [data.buyer_id, data.seller_id].filter(Boolean);
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT id, agent_id, webhook_url, email, events
         FROM notification_subscriptions
         WHERE agent_id = ANY($1) AND active = true`,
        [agentIds]
      );

      for (const sub of res.rows) {
        // Check event filter — empty events array means all events
        if (sub.events && sub.events.length > 0 && !sub.events.includes(event)) {
          continue;
        }

        if (sub.webhook_url) {
          this._deliverWebhook(sub.id, tradeId, event, payload, sub.webhook_url);
        }
        if (sub.email) {
          this._deliverEmail(sub.id, tradeId, event, payload, sub.email);
        }
      }
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Webhook delivery with retries
  // -------------------------------------------------------------------------

  private _deliverWebhook(
    subscriptionId: string,
    tradeId: string,
    event: NotificationEvent,
    payload: NotificationPayload,
    webhookUrl: string,
    attempt = 1
  ): void {
    const maxAttempts = 3;
    const backoffMs = [1000, 5000, 25000]; // 1s, 5s, 25s

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-SwarmTrade-Event': event,
    };

    const signingKey = process.env.NOTIFICATION_SIGNING_KEY;
    if (signingKey) {
      const signature = createHmac('sha256', signingKey).update(body).digest('hex');
      headers['X-SwarmTrade-Signature'] = signature;
    }

    fetch(webhookUrl, { method: 'POST', headers, body })
      .then(async (res) => {
        if (res.ok) {
          await this._logDelivery(subscriptionId, tradeId, event, 'webhook', payload, 'delivered', attempt, null);
        } else {
          const errMsg = `HTTP ${res.status}: ${res.statusText}`;
          await this._logDelivery(subscriptionId, tradeId, event, 'webhook', payload, attempt >= maxAttempts ? 'failed' : 'retrying', attempt, errMsg);
          if (attempt < maxAttempts) {
            setTimeout(() => {
              this._deliverWebhook(subscriptionId, tradeId, event, payload, webhookUrl, attempt + 1);
            }, backoffMs[attempt - 1]);
          }
        }
      })
      .catch(async (err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this._logDelivery(subscriptionId, tradeId, event, 'webhook', payload, attempt >= maxAttempts ? 'failed' : 'retrying', attempt, errMsg).catch(() => {});
        if (attempt < maxAttempts) {
          setTimeout(() => {
            this._deliverWebhook(subscriptionId, tradeId, event, payload, webhookUrl, attempt + 1);
          }, backoffMs[attempt - 1]);
        }
      });
  }

  // -------------------------------------------------------------------------
  // Email delivery
  // -------------------------------------------------------------------------

  private _deliverEmail(
    subscriptionId: string,
    tradeId: string,
    event: NotificationEvent,
    payload: NotificationPayload,
    toEmail: string
  ): void {
    this._sendEmail(subscriptionId, tradeId, event, payload, toEmail).catch((err) => {
      console.error('[notifications] Email delivery error:', err);
    });
  }

  private async _sendEmail(
    subscriptionId: string,
    tradeId: string,
    event: NotificationEvent,
    payload: NotificationPayload,
    toEmail: string
  ): Promise<void> {
    const emailUser = process.env.NOTIFICATION_EMAIL_USER;
    const emailPass = process.env.NOTIFICATION_EMAIL_PASS;

    if (!emailUser || !emailPass) {
      if (!this.emailWarned) {
        console.warn('[notifications] NOTIFICATION_EMAIL_USER or NOTIFICATION_EMAIL_PASS not set — skipping email notifications');
        this.emailWarned = true;
      }
      return;
    }

    try {
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.createTransport({
        host: 'smtp.proton.me',
        port: 587,
        secure: false, // STARTTLS
        auth: { user: emailUser, pass: emailPass },
        tls: { rejectUnauthorized: true },
      });

      const label = EVENT_LABELS[event] || event;
      const d = payload.data;

      const html = `
<div style="background:#1a1a2e;color:#e0e0e0;font-family:monospace;padding:24px;border-radius:8px;">
  <h2 style="color:#e94560;margin-top:0;">${label}</h2>
  <table style="border-collapse:collapse;width:100%;">
    <tr><td style="padding:4px 12px 4px 0;color:#999;">Trade ID</td><td>${payload.trade_id}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#999;">Buyer</td><td>${d.buyer_id}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#999;">Seller</td><td>${d.seller_id}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#999;">Asset</td><td>${d.asset_id}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#999;">Status</td><td>${d.status}</td></tr>
    ${d.trade_value != null ? `<tr><td style="padding:4px 12px 4px 0;color:#999;">Value</td><td>${d.trade_value} ${d.currency || ''}</td></tr>` : ''}
    ${d.escrow_id ? `<tr><td style="padding:4px 12px 4px 0;color:#999;">Escrow</td><td>${d.escrow_id}</td></tr>` : ''}
    ${d.resolution ? `<tr><td style="padding:4px 12px 4px 0;color:#999;">Resolution</td><td>${d.resolution}</td></tr>` : ''}
  </table>
  <p style="color:#666;margin-top:16px;font-size:12px;">Sent by SwarmTrade at ${payload.timestamp}</p>
</div>`;

      await transporter.sendMail({
        from: '"SwarmTrade" <swarm@swarmtrade.store>',
        to: toEmail,
        subject: `[SwarmTrade] ${label}`,
        html,
      });

      await this._logDelivery(subscriptionId, tradeId, event, 'email', payload, 'delivered', 1, null);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this._logDelivery(subscriptionId, tradeId, event, 'email', payload, 'failed', 1, errMsg).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  private async _logDelivery(
    subscriptionId: string,
    tradeId: string,
    event: string,
    channel: string,
    payload: any,
    status: string,
    attempts: number,
    lastError: string | null
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO notification_log (subscription_id, trade_id, event, channel, payload, status, attempts, last_error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [subscriptionId, tradeId, event, channel, JSON.stringify(payload), status, attempts, lastError]
      );
    } catch (err) {
      console.error('[notifications] Failed to log delivery:', err);
    } finally {
      client.release();
    }
  }
}
