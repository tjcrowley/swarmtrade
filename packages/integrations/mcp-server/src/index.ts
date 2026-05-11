#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Config from environment
const BASE_URL = process.env.SWARMTRADE_URL ?? 'https://swarmtrade.store';
const AGENT_ID = process.env.SWARMTRADE_AGENT_ID;

if (!AGENT_ID) {
  console.error('SWARMTRADE_AGENT_ID environment variable is required');
  process.exit(1);
}

// HTTP helper
async function apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'x-agent-id': AGENT_ID!,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data}`);
  return JSON.parse(data);
}

// Format response for LLM readability
function formatResponse(data: unknown): string {
  if (typeof data === 'string') return data;
  return JSON.stringify(data, null, 2);
}

// Create server
const server = new McpServer({
  name: 'swarmtrade',
  version: '1.0.0',
});

// ── Tool 1: Health Check ──────────────────────────────────────────────

server.tool(
  'swarmtrade_health',
  'Check SwarmTrade API health and escrow adapter status',
  {},
  async () => {
    try {
      const data = await apiRequest('GET', '/health');
      return { content: [{ type: 'text' as const, text: `SwarmTrade Health:\n${formatResponse(data)}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Health check failed: ${(err as Error).message}` }], isError: true };
    }
  },
);

// ── Tool 2: Search Assets ─────────────────────────────────────────────

server.tool(
  'swarmtrade_search_assets',
  'Search registered assets in the SwarmTrade marketplace. Filter by type, status, or limit results.',
  {
    q: z.string().optional().describe('Free-text search query'),
    type: z.string().optional().describe('Asset type filter (e.g. "model", "dataset", "api", "compute", "service")'),
    status: z.string().optional().describe('Asset status filter (e.g. "available", "reserved")'),
    limit: z.number().optional().describe('Max number of results to return'),
  },
  async ({ q, type, status, limit }) => {
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (type) params.set('type', type);
      if (status) params.set('status', status);
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      const data = await apiRequest('GET', `/registry/search${qs ? `?${qs}` : ''}`);
      return { content: [{ type: 'text' as const, text: `Search results:\n${formatResponse(data)}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Search failed: ${(err as Error).message}` }], isError: true };
    }
  },
);

// ── Tool 3: Announce Asset ────────────────────────────────────────────

server.tool(
  'swarmtrade_announce_asset',
  'Register a new asset in the SwarmTrade marketplace so other agents can discover and trade for it.',
  {
    asset_id: z.string().describe('Unique identifier for the asset'),
    type: z.string().describe('Asset type (e.g. "model", "dataset", "api", "compute", "service")'),
    metadata: z.record(z.unknown()).describe('Asset metadata object (name, description, pricing, etc.)'),
    agent_name: z.string().optional().describe('Display name of the agent offering this asset'),
    capabilities: z.array(z.string()).optional().describe('List of capabilities this asset provides'),
    description: z.string().optional().describe('Human-readable description of the asset'),
  },
  async ({ asset_id, type, metadata, agent_name, capabilities, description }) => {
    try {
      const data = await apiRequest('POST', '/registry/announce', {
        asset_id,
        type,
        metadata,
        status: 'available',
        agent_card: {
          id: AGENT_ID,
          name: agent_name ?? AGENT_ID,
          capabilities: capabilities ?? [],
          description: description ?? '',
          metadata: {},
        },
      });
      return { content: [{ type: 'text' as const, text: `Asset registered successfully!\n${formatResponse(data)}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to register asset: ${(err as Error).message}` }], isError: true };
    }
  },
);

// ── Tool 4: Create Trade ──────────────────────────────────────────────

server.tool(
  'swarmtrade_create_trade',
  'Initiate a trade handshake between a buyer and seller for a specific asset.',
  {
    buyer_id: z.string().describe('Agent ID of the buyer'),
    seller_id: z.string().describe('Agent ID of the seller'),
    asset_id: z.string().describe('ID of the asset being traded'),
  },
  async ({ buyer_id, seller_id, asset_id }) => {
    try {
      const data = await apiRequest('POST', '/registry/handshake', { buyer_id, seller_id, asset_id });
      const trade = data as Record<string, unknown>;
      return {
        content: [{
          type: 'text' as const,
          text: `Trade created!\nTrade ID: ${trade.id ?? trade.handshake_id ?? 'unknown'}\nBuyer: ${buyer_id}\nSeller: ${seller_id}\nAsset: ${asset_id}\nState: ${trade.state ?? 'initiated'}\n\nFull details:\n${formatResponse(data)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to create trade: ${(err as Error).message}` }], isError: true };
    }
  },
);

// ── Tool 5: Get Trade ─────────────────────────────────────────────────

server.tool(
  'swarmtrade_get_trade',
  'Get details of a specific trade by its ID, including current state and participants.',
  {
    trade_id: z.string().describe('The trade/handshake ID to look up'),
  },
  async ({ trade_id }) => {
    try {
      const data = await apiRequest('GET', `/registry/handshake/${trade_id}`);
      return { content: [{ type: 'text' as const, text: `Trade details:\n${formatResponse(data)}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to get trade: ${(err as Error).message}` }], isError: true };
    }
  },
);

// ── Tool 6: Transition Trade ──────────────────────────────────────────

server.tool(
  'swarmtrade_transition_trade',
  'Advance a trade to its next state in the negotiation protocol. Requires the current version for optimistic concurrency.',
  {
    trade_id: z.string().describe('The trade/handshake ID'),
    next_state: z.string().describe('Target state (e.g. "accepted", "countered", "rejected", "escrowed", "delivery_confirmed", "settled")'),
    from_version: z.number().describe('Current version number of the trade (for optimistic concurrency control)'),
    quote: z.record(z.unknown()).optional().describe('Quote details if transitioning with a price change (trade_value, currency, terms)'),
  },
  async ({ trade_id, next_state, from_version, quote }) => {
    try {
      const body: Record<string, unknown> = {
        fromVersion: from_version,
        nextState: next_state,
      };
      if (quote) body.quote = quote;
      const data = await apiRequest('POST', `/registry/negotiation/${trade_id}/transition`, body);
      return { content: [{ type: 'text' as const, text: `Trade ${trade_id} transitioned to "${next_state}".\n${formatResponse(data)}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to transition trade: ${(err as Error).message}` }], isError: true };
    }
  },
);

// ── Tool 7: Lock Escrow ───────────────────────────────────────────────

server.tool(
  'swarmtrade_lock_escrow',
  'Lock funds in escrow for a trade. This secures the payment until delivery is confirmed or a dispute is resolved.',
  {
    handshake_id: z.string().describe('The trade/handshake ID this escrow is for'),
    buyer_address: z.string().describe('Buyer wallet or payment address'),
    seller_address: z.string().describe('Seller wallet or payment address'),
    amount: z.string().describe('Amount to lock in escrow (as string for precision)'),
    chain_id: z.number().optional().describe('Numeric chain ID for on-chain escrow (1=Ethereum, 8453=Base, 137=Polygon, 11155111=Sepolia). Omit for off-chain escrow.'),
    token: z.string().optional().describe('Token contract address for ERC-20 escrow (omit for native token)'),
  },
  async ({ handshake_id, buyer_address, seller_address, amount, chain_id, token }) => {
    try {
      const body: Record<string, unknown> = { handshake_id, buyer_address, seller_address, amount };
      // API expects CAIP-2 format "eip155:<chainId>" or the string "off-chain"
      if (chain_id !== undefined) body.chain_id = `eip155:${chain_id}`;
      if (token) body.token = token;
      const data = await apiRequest('POST', '/registry/escrow/lock', body);
      const escrow = data as Record<string, unknown>;
      return {
        content: [{
          type: 'text' as const,
          text: `Escrow locked!\nEscrow ID: ${escrow.escrow_id ?? escrow.id ?? 'unknown'}\nAmount: ${amount}${token ? ` ${token}` : ''}\nStatus: ${escrow.status ?? 'locked'}\n\nFull details:\n${formatResponse(data)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to lock escrow: ${(err as Error).message}` }], isError: true };
    }
  },
);

// ── Tool 8: Confirm Delivery ──────────────────────────────────────────

server.tool(
  'swarmtrade_confirm_delivery',
  'Confirm that an asset has been delivered, releasing escrowed funds to the seller. This is irreversible.',
  {
    escrow_id: z.string().describe('The escrow ID to confirm delivery for'),
  },
  async ({ escrow_id }) => {
    try {
      const data = await apiRequest('POST', `/registry/escrow/${escrow_id}/confirm-delivery`, {});
      return { content: [{ type: 'text' as const, text: `Delivery confirmed! Escrow ${escrow_id} settled.\n${formatResponse(data)}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to confirm delivery: ${(err as Error).message}` }], isError: true };
    }
  },
);

// ── Tool 9: Dispute Trade ─────────────────────────────────────────────

server.tool(
  'swarmtrade_dispute_trade',
  'Dispute an escrowed trade. This freezes the escrow and escalates to platform arbitration.',
  {
    escrow_id: z.string().describe('The escrow ID to dispute'),
    reason: z.string().optional().describe('Reason for the dispute'),
  },
  async ({ escrow_id, reason }) => {
    try {
      const body: Record<string, unknown> = {};
      if (reason) body.reason = reason;
      const data = await apiRequest('POST', `/registry/escrow/${escrow_id}/dispute`, body);
      return { content: [{ type: 'text' as const, text: `Dispute filed for escrow ${escrow_id}.\n${formatResponse(data)}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to dispute trade: ${(err as Error).message}` }], isError: true };
    }
  },
);

// ── Tool 10: Resolve Dispute ──────────────────────────────────────────

server.tool(
  'swarmtrade_resolve_dispute',
  'Resolve a disputed escrow by releasing funds to the seller or refunding the buyer. This is irreversible.',
  {
    escrow_id: z.string().describe('The escrow ID with an active dispute'),
    resolution: z.enum(['release', 'refund']).describe('"release" sends funds to seller, "refund" returns funds to buyer'),
  },
  async ({ escrow_id, resolution }) => {
    try {
      const data = await apiRequest('POST', `/registry/escrow/${escrow_id}/resolve`, { resolution });
      return { content: [{ type: 'text' as const, text: `Dispute resolved (${resolution}) for escrow ${escrow_id}.\n${formatResponse(data)}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to resolve dispute: ${(err as Error).message}` }], isError: true };
    }
  },
);

// ── Tool 11: Get Escrow ───────────────────────────────────────────────

server.tool(
  'swarmtrade_get_escrow',
  'Get the current status and details of an escrow record.',
  {
    escrow_id: z.string().describe('The escrow ID to look up'),
  },
  async ({ escrow_id }) => {
    try {
      const data = await apiRequest('GET', `/registry/escrow/${escrow_id}`);
      return { content: [{ type: 'text' as const, text: `Escrow details:\n${formatResponse(data)}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to get escrow: ${(err as Error).message}` }], isError: true };
    }
  },
);

// ── Tool 12: Subscribe Notifications ──────────────────────────────────

server.tool(
  'swarmtrade_subscribe_notifications',
  'Subscribe to trade event notifications via webhook or email. Get notified when trades change state.',
  {
    webhook_url: z.string().optional().describe('Webhook URL to receive event POST notifications (HMAC-signed)'),
    email: z.string().optional().describe('Email address for event notifications'),
    events: z.array(z.string()).optional().describe('Event types to subscribe to (e.g. ["trade.accepted", "escrow.locked", "trade.settled", "trade.disputed"])'),
  },
  async ({ webhook_url, email, events }) => {
    try {
      const body: Record<string, unknown> = {};
      if (webhook_url) body.webhook_url = webhook_url;
      if (email) body.email = email;
      if (events) body.events = events;
      const data = await apiRequest('POST', '/registry/notifications/subscribe', body);
      return { content: [{ type: 'text' as const, text: `Subscribed to notifications!\n${formatResponse(data)}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to subscribe: ${(err as Error).message}` }], isError: true };
    }
  },
);

// ── Tool 13: Get Reputation ───────────────────────────────────────────

server.tool(
  'swarmtrade_get_reputation',
  "Get an agent's reputation score and trust metrics on SwarmTrade.",
  {
    agent_id: z.string().describe('The agent ID to look up reputation for'),
  },
  async ({ agent_id }) => {
    try {
      const data = await apiRequest('GET', `/registry/reputation/${agent_id}`);
      const rep = data as Record<string, unknown>;
      return {
        content: [{
          type: 'text' as const,
          text: `Reputation for ${agent_id}:\nTrust Score: ${rep.trust_score ?? 'N/A'}\nTotal Trades: ${rep.total_trades ?? 'N/A'}\nSuccessful: ${rep.successful_trades ?? 'N/A'}\nAvg Rating: ${rep.avg_rating ?? 'N/A'}\n\nFull details:\n${formatResponse(data)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to get reputation: ${(err as Error).message}` }], isError: true };
    }
  },
);

// ── Tool 14: Get Ratings ──────────────────────────────────────────────

server.tool(
  'swarmtrade_get_ratings',
  'Get ratings and reviews left for an agent by trade counterparties.',
  {
    agent_id: z.string().describe('The agent ID to get ratings for'),
    limit: z.number().optional().describe('Max number of ratings to return'),
  },
  async ({ agent_id, limit }) => {
    try {
      const params = new URLSearchParams();
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      const data = await apiRequest('GET', `/registry/reputation/${agent_id}/ratings${qs ? `?${qs}` : ''}`);
      const ratings = data as Array<Record<string, unknown>>;
      if (Array.isArray(ratings) && ratings.length > 0) {
        const lines = ratings.map((r, i) =>
          `${i + 1}. ★${r.rating}/5 by ${r.rater_id ?? 'anonymous'} — "${r.comment ?? 'No comment'}"`
        );
        return { content: [{ type: 'text' as const, text: `Ratings for ${agent_id}:\n${lines.join('\n')}\n\nRaw:\n${formatResponse(data)}` }] };
      }
      return { content: [{ type: 'text' as const, text: `No ratings found for ${agent_id}.\n${formatResponse(data)}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to get ratings: ${(err as Error).message}` }], isError: true };
    }
  },
);

// ── Tool 15: Rate Trade ───────────────────────────────────────────────

server.tool(
  'swarmtrade_rate_trade',
  'Rate a trade counterparty after a completed trade. Helps build reputation in the marketplace.',
  {
    trade_id: z.string().describe('The trade/handshake ID to rate'),
    ratee_id: z.string().describe('Agent ID of the counterparty being rated'),
    rating: z.number().min(1).max(5).describe('Rating from 1 (poor) to 5 (excellent)'),
    comment: z.string().optional().describe('Optional review comment'),
  },
  async ({ trade_id, ratee_id, rating, comment }) => {
    try {
      const body: Record<string, unknown> = { trade_id, ratee_id, rating };
      if (comment) body.comment = comment;
      const data = await apiRequest('POST', '/registry/reputation/rate', body);
      return { content: [{ type: 'text' as const, text: `Rated ${ratee_id} ★${rating}/5 for trade ${trade_id}.\n${formatResponse(data)}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to rate trade: ${(err as Error).message}` }], isError: true };
    }
  },
);

// ── Start Server ──────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('SwarmTrade MCP server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
