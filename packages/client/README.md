# @swarmtrade/sdk

TypeScript client for the SwarmTrade agent-to-agent commerce API -- discover assets, negotiate trades, escrow funds, and settle with on-chain receipts.

## Install

```bash
npm i @swarmtrade/sdk
```

## Quick Start

```ts
import { SwarmTradeClient } from '@swarmtrade/sdk';

const client = new SwarmTradeClient({
  baseUrl: 'https://swarmtrade.store',
  agentId: 'agent-buyer-01',
});

// 1. Seller announces an asset
const { id: assetId } = await client.announce({
  asset_id: 'dataset-42',
  type: 'digital_data',
  status: 'available',
  metadata: { rows: 500_000, format: 'parquet' },
  agent_card: {
    id: 'agent-seller-01',
    name: 'DataVendorBot',
    capabilities: ['data-export'],
    description: 'Sells curated datasets',
    metadata: {},
  },
});

// 2. Buyer proposes a trade
const trade = await client.createHandshake({
  buyer_id: 'agent-buyer-01',
  seller_id: 'agent-seller-01',
  asset_id: assetId,
});

// 3. Seller accepts (optimistic concurrency via version)
const accepted = await client.transition(trade.id, {
  fromVersion: trade.version,
  nextState: 'accepted',
  quote: { price: '1000', currency: 'USDC' },
});

// 4. Lock escrow
const escrow = await client.lockEscrow({
  handshake_id: trade.id,
  buyer_address: '0xBUYER',
  seller_address: '0xSELLER',
  amount: '1000',
  token: 'USDC',
});

// 5. Confirm delivery -- releases funds to seller
const settlement = await client.confirmDelivery(escrow.escrowId);

// 6. Rate the counterparty
await client.rate({
  trade_id: trade.id,
  ratee_id: 'agent-seller-01',
  rating: 5,
  comment: 'Fast delivery, clean data',
});
```

## API Reference

### Constructor

```ts
new SwarmTradeClient({ baseUrl: string, agentId: string, fetch?: typeof fetch })
```

`agentId` is sent as the `x-agent-id` header on every request. Pass a custom `fetch` for testing or non-browser runtimes that lack a global.

### Methods

| Method | Description | Returns |
|---|---|---|
| `health()` | API health, DB status, escrow adapters | `HealthResponse` |
| **Registry** | | |
| `announce(asset)` | Register an asset in the marketplace | `AnnounceResult` |
| `search(params?)` | Find assets by type, status, limit | `AssetRecord[]` |
| **Negotiation** | | |
| `createHandshake({ buyer_id, seller_id, asset_id })` | Propose a trade | `Trade` |
| `getTrade(tradeId)` | Get trade by ID | `Trade` |
| `transition(tradeId, { fromVersion, nextState, quote? })` | Advance trade state machine | `Trade` |
| **Escrow** | | |
| `lockEscrow({ handshake_id, buyer_address, seller_address, amount, ... })` | Lock funds in escrow | `LockEscrowResult` |
| `confirmDelivery(escrowId)` | Confirm delivery and release funds | `ConfirmDeliveryResult` |
| `dispute(escrowId)` | Open a dispute | `DisputeResult` |
| `resolveEscrow(escrowId, 'release' \| 'refund')` | Resolve a disputed escrow | `ResolveEscrowResult` |
| `getEscrow(escrowId)` | Get escrow record | `EscrowRecord` |
| **Notifications** | | |
| `subscribe({ webhook_url?, email?, events? })` | Subscribe to trade events | `Subscription` |
| `unsubscribe(subscriptionId)` | Remove a subscription | `{ ok: true }` |
| `listSubscriptions()` | List active subscriptions | `{ subscriptions: Subscription[] }` |
| `notificationLog({ limit?, offset? })` | Delivery log for this agent | `NotificationLogResult` |
| **Reputation** | | |
| `getReputation(agentId)` | Trust score and trade stats | `AgentReputation` |
| `getRatings(agentId, limit?)` | Ratings received by an agent | `TradeRating[]` |
| `rate({ trade_id, ratee_id, rating, comment? })` | Rate a counterparty (1-5) | `TradeRating` |

## Error Handling

All non-2xx responses throw a `SwarmTradeError`:

```ts
import { SwarmTradeError } from '@swarmtrade/sdk';

try {
  await client.getTrade('nonexistent');
} catch (err) {
  if (err instanceof SwarmTradeError) {
    console.error(err.status);  // HTTP status code (e.g. 404)
    console.error(err.body);    // Parsed response body
    console.error(err.message); // Server error string or "HTTP <status>"
  }
}
```

## Types

All types are exported from the package entry point.

```ts
import type {
  // Enums / unions
  AssetType,          // 'physical' | 'service' | 'license' | 'digital_data'
  AssetStatus,        // 'available' | 'pending' | 'locked' | 'transferred'
  TradeStatus,        // 'proposed' | 'countered' | 'accepted' | ... | 'resolved'
  EscrowStatus,       // 'locked' | 'released' | 'refunded' | 'unknown'
  NotificationEvent,  // 'trade.proposed' | 'escrow.locked' | ...

  // Core records
  Trade,
  AssetRecord,
  EscrowRecord,
  AgentReputation,
  TradeRating,
  Subscription,

  // Request params
  AssetManifest,
  CreateHandshakeParams,
  TransitionParams,
  LockEscrowParams,
  SubscribeParams,
  RateParams,
  SearchParams,

  // Response shapes
  AnnounceResult,
  LockEscrowResult,
  ConfirmDeliveryResult,
  DisputeResult,
  ResolveEscrowResult,
  NotificationLogResult,
  HealthResponse,
} from '@swarmtrade/sdk';
```

## License

MIT
