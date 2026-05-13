// ---------------------------------------------------------------------------
// @swarmtrade/langchain — LangChain tool definitions
// ---------------------------------------------------------------------------

import { DynamicStructuredTool } from '@langchain/core/tools';
import { SwarmTradeClient } from '@swarmtrade/sdk';
import type { TradeStatus } from '@swarmtrade/sdk';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Toolkit options
// ---------------------------------------------------------------------------

export interface SwarmTradeToolkitOptions {
  /** Base URL of the SwarmTrade API (e.g. "https://swarmtrade.store"). */
  baseUrl: string;
  /** Your agent's unique identifier. Sent as the x-agent-id header. */
  agentId: string;
}

// ---------------------------------------------------------------------------
// Helper: safe JSON stringification for LLM consumption
// ---------------------------------------------------------------------------

function toJSON(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create all SwarmTrade LangChain tools, pre-configured with a shared SDK
 * client. Returns an array that can be passed directly to
 * `AgentExecutor.fromAgentAndTools(...)` or any LangChain agent constructor.
 *
 * ```ts
 * const tools = new SwarmTradeToolkit({
 *   baseUrl: "https://swarmtrade.store",
 *   agentId: "agent-123",
 * }).getTools();
 * ```
 */
export class SwarmTradeToolkit {
  private readonly client: SwarmTradeClient;
  private readonly agentId: string;

  constructor(opts: SwarmTradeToolkitOptions) {
    this.agentId = opts.agentId;
    this.client = new SwarmTradeClient({
      baseUrl: opts.baseUrl,
      agentId: opts.agentId,
    });
  }

  /** Return every SwarmTrade tool as an array ready for LangChain agents. */
  getTools(): DynamicStructuredTool[] {
    const client = this.client;
    const agentId = this.agentId;

    // ── 1. Search ─────────────────────────────────────────────────────
    const searchTool = new DynamicStructuredTool({
      name: 'swarmtrade_search',
      description:
        'Search for assets listed on the SwarmTrade marketplace. ' +
        'Filter by asset type (physical, service, license, digital_data), ' +
        'status (available, pending, locked, transferred), or limit the ' +
        'number of results returned.',
      schema: z.object({
        type: z
          .enum(['physical', 'service', 'license', 'digital_data'])
          .optional()
          .describe('Filter by asset type'),
        status: z
          .enum(['available', 'pending', 'locked', 'transferred'])
          .optional()
          .describe('Filter by asset status'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of results to return'),
      }),
      func: async ({ type, status, limit }) => {
        try {
          const results = await client.search({ type, status, limit });
          return toJSON(results);
        } catch (err) {
          return `Error searching assets: ${(err as Error).message}`;
        }
      },
    });

    // ── 2. Announce ───────────────────────────────────────────────────
    const announceTool = new DynamicStructuredTool({
      name: 'swarmtrade_announce',
      description:
        'Announce (register) a new asset for sale on the SwarmTrade ' +
        'marketplace so other agents can discover and trade for it.',
      schema: z.object({
        asset_id: z.string().describe('Unique identifier for the asset'),
        type: z
          .enum(['physical', 'service', 'license', 'digital_data'])
          .describe('Asset type'),
        metadata: z
          .record(z.unknown())
          .describe('Asset metadata (name, description, pricing, etc.)'),
        status: z
          .enum(['available', 'pending', 'locked', 'transferred'])
          .default('available')
          .describe('Initial status of the asset'),
        agent_name: z
          .string()
          .optional()
          .describe('Display name of the agent offering this asset'),
        capabilities: z
          .array(z.string())
          .optional()
          .describe('List of capabilities this asset provides'),
        description: z
          .string()
          .optional()
          .describe('Human-readable description of the asset'),
      }),
      func: async ({ asset_id, type, metadata, status, agent_name, capabilities, description }) => {
        try {
          const result = await client.announce({
            asset_id,
            type,
            metadata,
            status,
            agent_card: {
              id: agentId,
              name: agent_name ?? 'agent',
              capabilities: capabilities ?? [],
              description: description ?? '',
              metadata: {},
            },
          });
          return toJSON(result);
        } catch (err) {
          return `Error announcing asset: ${(err as Error).message}`;
        }
      },
    });

    // ── 3. Create Trade ───────────────────────────────────────────────
    const createTradeTool = new DynamicStructuredTool({
      name: 'swarmtrade_create_trade',
      description:
        'Propose a new trade (handshake) between a buyer and seller for ' +
        'a specific asset. Returns the created trade with its ID and ' +
        'initial state.',
      schema: z.object({
        buyer_id: z.string().describe('Agent ID of the buyer'),
        seller_id: z.string().describe('Agent ID of the seller'),
        asset_id: z.string().describe('ID of the asset being traded'),
      }),
      func: async ({ buyer_id, seller_id, asset_id }) => {
        try {
          const trade = await client.createHandshake({ buyer_id, seller_id, asset_id });
          return toJSON(trade);
        } catch (err) {
          return `Error creating trade: ${(err as Error).message}`;
        }
      },
    });

    // ── 4. Get Trade ──────────────────────────────────────────────────
    const getTradeTool = new DynamicStructuredTool({
      name: 'swarmtrade_get_trade',
      description:
        'Get the current details and status of a trade by its ID, ' +
        'including buyer, seller, asset, quote, and version number.',
      schema: z.object({
        trade_id: z.string().describe('The trade/handshake ID to look up'),
      }),
      func: async ({ trade_id }) => {
        try {
          const trade = await client.getTrade(trade_id);
          return toJSON(trade);
        } catch (err) {
          return `Error getting trade: ${(err as Error).message}`;
        }
      },
    });

    // ── 5. Transition ─────────────────────────────────────────────────
    const transitionTool = new DynamicStructuredTool({
      name: 'swarmtrade_transition',
      description:
        'Advance a trade to the next state in the negotiation protocol. ' +
        'Valid transitions include: accept, counter, reject. Requires ' +
        'the current version number for optimistic concurrency control.',
      schema: z.object({
        trade_id: z.string().describe('The trade/handshake ID'),
        next_state: z
          .enum([
            'proposed',
            'countered',
            'accepted',
            'escrowed',
            'delivery_confirmed',
            'settled',
            'rejected',
            'expired',
            'cancelled',
            'disputed',
            'resolved',
          ])
          .describe('Target state to transition to'),
        from_version: z
          .number()
          .int()
          .describe('Current version of the trade (for optimistic concurrency)'),
        quote: z
          .record(z.unknown())
          .optional()
          .describe('Quote details when countering (trade_value, currency, terms)'),
      }),
      func: async ({ trade_id, next_state, from_version, quote }) => {
        try {
          const trade = await client.transition(trade_id, {
            fromVersion: from_version,
            nextState: next_state as TradeStatus,
            quote,
          });
          return toJSON(trade);
        } catch (err) {
          return `Error transitioning trade: ${(err as Error).message}`;
        }
      },
    });

    // ── 6. Lock Escrow ────────────────────────────────────────────────
    const lockEscrowTool = new DynamicStructuredTool({
      name: 'swarmtrade_lock_escrow',
      description:
        'Lock funds in escrow for an accepted trade. Secures payment ' +
        'until delivery is confirmed or a dispute is resolved.',
      schema: z.object({
        handshake_id: z
          .string()
          .describe('The trade/handshake ID this escrow is for'),
        buyer_address: z
          .string()
          .describe('Buyer wallet or payment address'),
        seller_address: z
          .string()
          .describe('Seller wallet or payment address'),
        amount: z
          .string()
          .describe('Amount to lock (as string for bigint precision)'),
        chain_id: z
          .string()
          .optional()
          .describe('Chain ID in CAIP-2 format (e.g. "eip155:8453" for Base)'),
        token: z
          .string()
          .optional()
          .describe('Token contract address for ERC-20 (omit for native)'),
        metadata: z
          .record(z.unknown())
          .optional()
          .describe('Additional escrow metadata'),
      }),
      func: async ({ handshake_id, buyer_address, seller_address, amount, chain_id, token, metadata }) => {
        try {
          const result = await client.lockEscrow({
            handshake_id,
            buyer_address,
            seller_address,
            amount,
            chain_id,
            token,
            metadata,
          });
          return toJSON(result);
        } catch (err) {
          return `Error locking escrow: ${(err as Error).message}`;
        }
      },
    });

    // ── 7. Confirm Delivery ───────────────────────────────────────────
    const confirmDeliveryTool = new DynamicStructuredTool({
      name: 'swarmtrade_confirm_delivery',
      description:
        'Confirm that an asset has been delivered, releasing escrowed ' +
        'funds to the seller and settling the trade. This is irreversible.',
      schema: z.object({
        escrow_id: z
          .string()
          .describe('The escrow ID to confirm delivery for'),
      }),
      func: async ({ escrow_id }) => {
        try {
          const result = await client.confirmDelivery(escrow_id);
          return toJSON(result);
        } catch (err) {
          return `Error confirming delivery: ${(err as Error).message}`;
        }
      },
    });

    // ── 8. Get Reputation ─────────────────────────────────────────────
    const getReputationTool = new DynamicStructuredTool({
      name: 'swarmtrade_get_reputation',
      description:
        "Get an agent's reputation and trust score on SwarmTrade, " +
        'including total trades, success rate, disputes, and average rating.',
      schema: z.object({
        agent_id: z
          .string()
          .describe('The agent ID to look up reputation for'),
      }),
      func: async ({ agent_id }) => {
        try {
          const rep = await client.getReputation(agent_id);
          return toJSON(rep);
        } catch (err) {
          return `Error getting reputation: ${(err as Error).message}`;
        }
      },
    });

    // ── 9. Rate ───────────────────────────────────────────────────────
    const rateTool = new DynamicStructuredTool({
      name: 'swarmtrade_rate',
      description:
        'Rate a trade counterparty after a completed (settled/resolved) ' +
        'trade. Rating is 1-5 stars with an optional comment.',
      schema: z.object({
        trade_id: z
          .string()
          .describe('The trade/handshake ID for the completed trade'),
        ratee_id: z
          .string()
          .describe('Agent ID of the counterparty being rated'),
        rating: z
          .number()
          .int()
          .min(1)
          .max(5)
          .describe('Rating from 1 (poor) to 5 (excellent)'),
        comment: z
          .string()
          .optional()
          .describe('Optional review comment'),
      }),
      func: async ({ trade_id, ratee_id, rating, comment }) => {
        try {
          const result = await client.rate({ trade_id, ratee_id, rating, comment });
          return toJSON(result);
        } catch (err) {
          return `Error rating trade: ${(err as Error).message}`;
        }
      },
    });

    return [
      searchTool,
      announceTool,
      createTradeTool,
      getTradeTool,
      transitionTool,
      lockEscrowTool,
      confirmDeliveryTool,
      getReputationTool,
      rateTool,
    ];
  }
}
