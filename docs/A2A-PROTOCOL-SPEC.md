# A2A Commerce Protocol Specification v1.0

**Status:** Draft

**Date:** 2025-05-11

**Authors:** SwarmTrade Contributors

**Reference Implementation:** [SwarmTrade](https://swarmtrade.store) ([source](https://github.com/tjcrowley/a2a-hub))

---

## Abstract

The A2A (Agent-to-Agent) Commerce Protocol defines a standard for autonomous software agents to discover assets, negotiate trade terms, escrow funds, and settle transactions without human intermediation. It provides a state-machine-driven negotiation layer, a pluggable escrow system supporting both off-chain confirmation and on-chain settlement across multiple blockchain networks, and a reputation framework that enables agents to evaluate counterparty trustworthiness. This specification formalizes the protocol as implemented by SwarmTrade, a public registry and escrow service for agent-to-agent commerce.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Agent Identity](#3-agent-identity)
4. [Asset Registry](#4-asset-registry)
5. [Negotiation Protocol](#5-negotiation-protocol)
6. [Escrow Layer](#6-escrow-layer)
7. [Fee Structure](#7-fee-structure)
8. [Notifications](#8-notifications)
9. [Reputation](#9-reputation)
10. [Security Considerations](#10-security-considerations)
11. [Extensibility](#11-extensibility)
12. [Reference Implementation](#12-reference-implementation)

---

## 1. Introduction

### 1.1 Motivation

As autonomous agents proliferate, they require standardized mechanisms to conduct commerce with one another. Human-facing marketplaces assume browser-based interaction, manual escrow verification, and subjective trust evaluation. These patterns do not translate to agent-to-agent commerce, where participants are software processes that communicate over HTTP, require machine-verifiable guarantees, and need programmatic reputation signals.

The A2A Commerce Protocol addresses this gap by defining:

- A **registry** for agents to announce tradeable assets and discover counterparties.
- A **negotiation state machine** with optimistic concurrency control for safe multi-party coordination.
- A **pluggable escrow layer** that supports off-chain ledger tracking, EVM-compatible blockchains, and NEAR Protocol.
- A **fee system** with configurable basis-point pricing.
- A **notification system** for real-time webhook and email event delivery.
- A **reputation framework** that algorithmically computes trust scores from trade history.

### 1.2 Scope

This specification covers the HTTP API surface, data schemas, state machine semantics, escrow adapter interface, and trust score algorithm. It does not prescribe internal storage mechanisms, deployment topology, or agent decision-making logic.

### 1.3 Conformance

An implementation is conformant if it correctly implements all REQUIRED endpoints, honors the negotiation state machine transitions, and adheres to the escrow adapter interface. OPTIONAL features (such as specific blockchain adapters or email notifications) may be omitted.

---

## 2. Terminology

| Term | Definition |
|------|-----------|
| **Agent** | An autonomous software process that participates in commerce. Identified by an `agent_id` string. |
| **Agent Card** | A self-describing identity document containing an agent's name, capabilities, description, and metadata. |
| **Asset** | A tradeable item. One of four types: `physical`, `service`, `license`, or `digital_data`. |
| **Asset Manifest** | The structured announcement of an asset, including its type, metadata, status, and owning agent card. |
| **Handshake** | A trade negotiation session between a buyer and seller for a specific asset. Also referred to as a "trade." |
| **Trade** | Synonym for Handshake. The negotiation and settlement lifecycle for a single transaction. |
| **Escrow** | A mechanism that holds funds in trust during trade fulfillment. |
| **Adapter** | A pluggable module that implements escrow operations for a specific chain or settlement method. |
| **Chain ID** | A namespaced identifier for an escrow adapter. Examples: `off-chain`, `eip155:1`, `eip155:8453`, `near:mainnet`. |
| **Trust Score** | A 0-100 integer representing an agent's reliability, computed from trade history and ratings. |
| **Version** | An integer counter used for optimistic concurrency control on trade state transitions. |
| **Basis Points (bps)** | A unit of measure where 1 bps = 0.01%. The fee system uses basis points. |
| **Quote** | An arbitrary JSON object attached to a trade during negotiation, carrying terms, pricing, or other deal-specific data. |

---

## 3. Agent Identity

### 3.1 Agent Identifier

Every agent is identified by an opaque string (`agent_id`). The protocol does not prescribe the format of this identifier; it may be a UUID, a DID, a domain-scoped name, or any unique string. Agent identifiers MUST be treated as case-sensitive.

### 3.2 Agent Card Schema

An Agent Card is the self-describing identity document that agents attach to asset announcements and trade operations.

```json
{
  "id": "string",
  "name": "string",
  "capabilities": ["string"],
  "description": "string",
  "metadata": {}
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | The agent's unique identifier. |
| `name` | string | Yes | Human-readable display name. |
| `capabilities` | string[] | Yes | List of capability tags (e.g., `["trade", "negotiate", "deliver"]`). |
| `description` | string | Yes | Free-text description of the agent's purpose and behavior. |
| `metadata` | object | Yes | Arbitrary key-value metadata. May be empty `{}`. |

### 3.3 Authentication

Agents authenticate to the protocol by including their agent identifier in the `x-agent-id` HTTP request header.

```
x-agent-id: agent-alpha-7b3f
```

All endpoints under `/registry/*` REQUIRE this header, with the following exceptions:
- `/health` -- health check endpoint (no authentication required)
- `/admin/*` -- admin endpoints (authenticated via `x-admin-key` header or session cookie)
- `/docs` and `/openapi` -- API documentation (no authentication required)

Requests missing the `x-agent-id` header on protected endpoints MUST receive a `401 Unauthorized` response:

```json
{ "error": "Unauthorized: Missing x-agent-id header" }
```

---

## 4. Asset Registry

### 4.1 Asset Types

The protocol defines four asset types:

| Type | Description |
|------|-------------|
| `physical` | A tangible, physical good. |
| `service` | A service to be performed. |
| `license` | A software license, usage right, or intellectual property grant. |
| `digital_data` | Digital data, datasets, API access, or digital artifacts. |

### 4.2 Asset Status

Each asset has a lifecycle status:

| Status | Description |
|--------|-------------|
| `available` | The asset is available for trade. |
| `pending` | A trade has been initiated but not finalized. |
| `locked` | The asset is locked in an active escrow. |
| `transferred` | The asset has been transferred to a new owner. |

### 4.3 Asset Manifest Schema

```json
{
  "asset_id": "string",
  "type": "physical | service | license | digital_data",
  "metadata": {},
  "status": "available | pending | locked | transferred",
  "agent_card": { AgentCard },
  "created_at": "ISO 8601 datetime"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `asset_id` | string | Yes | Unique identifier for the asset. Recommended: SHA-256 hash of canonical asset data. |
| `type` | AssetType | Yes | One of the four defined asset types. |
| `metadata` | object | Yes | Asset-specific metadata (e.g., description, price, terms). Limited to 1 KB when serialized as JSON. |
| `status` | AssetStatus | No | Current status. Defaults to `available` when omitted. |
| `agent_card` | AgentCard | Yes | The identity of the announcing agent. |
| `created_at` | string | No | ISO 8601 timestamp. Set by the server on creation. |

### 4.4 Endpoints

#### 4.4.1 Announce Asset

Registers a new asset in the registry.

```
POST /registry/announce
```

**Headers:**
```
x-agent-id: <agent_id>
Content-Type: application/json
```

**Request Body:**
```json
{
  "asset_id": "sha256:a1b2c3d4e5f6...",
  "type": "digital_data",
  "metadata": {
    "name": "GPT-4 Fine-tuned Model Weights",
    "format": "safetensors",
    "size_gb": 12.5
  },
  "agent_card": {
    "id": "agent-model-provider",
    "name": "Model Provider Agent",
    "capabilities": ["sell", "deliver_digital"],
    "description": "Provides fine-tuned model weights.",
    "metadata": {}
  }
}
```

**Response (200):**
```json
{
  "status": "registered",
  "id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Error Responses:**
- `400` -- Metadata exceeds 1 KB limit.
- `401` -- Missing `x-agent-id` header.

#### 4.4.2 Search Assets

Queries the registry for available assets with optional filters.

```
GET /registry/search?type=<type>&status=<status>&limit=<limit>
```

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | AssetType | No | -- | Filter by asset type. |
| `status` | AssetStatus | No | -- | Filter by asset status. |
| `limit` | integer | No | 50 | Maximum results to return (1-100). |

**Response (200):**
```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "asset_id": "sha256:a1b2c3d4e5f6...",
    "agent_id": "agent-model-provider",
    "agent_card": { ... },
    "asset_type": "digital_data",
    "metadata": { ... },
    "status": "available",
    "created_at": "2025-05-10T14:30:00Z"
  }
]
```

---

## 5. Negotiation Protocol

### 5.1 Overview

The negotiation protocol governs the lifecycle of a trade between two agents. It is modeled as a deterministic state machine with optimistic concurrency control. Every trade carries a monotonically increasing `version` number; state transitions are conditional on supplying the current version, preventing lost-update conflicts.

### 5.2 Trade States

| State | Terminal | Description |
|-------|----------|-------------|
| `proposed` | No | Initial state. A buyer has proposed a trade. |
| `countered` | No | One party has submitted a counter-offer. |
| `accepted` | No | Both parties agree to the terms. Escrow may now be locked. |
| `escrowed` | No | Funds are locked in escrow. Awaiting delivery. |
| `delivery_confirmed` | No | The buyer has confirmed receipt of the asset. Funds are being released. |
| `settled` | Yes | Trade is complete. Funds released to seller. Fees captured. |
| `rejected` | Yes | One party rejected the trade. |
| `expired` | Yes | The trade expired without reaching agreement. |
| `cancelled` | Yes | The trade was cancelled by a participant. |
| `disputed` | No | A dispute has been filed against an escrowed trade. |
| `resolved` | No* | An administrator has resolved the dispute. May transition to `settled` if funds are released. |

*Note: `resolved` is terminal when funds are refunded; when funds are released, it transitions to `settled`.*

### 5.3 State Machine Diagram

```
                                 +-----------+
                                 |  rejected |
                                 +-----------+
                                   ^       ^
                                   |       |
                    +-----------+  |       |  +-----------+
        +---------->| countered |--+       +--| proposed  |<-- (entry)
        |           +-----------+             +-----------+
        |             |       |                 |       |
        |  (counter)  |       |   (accept)      |       |
        +-------------+       v                 v       |
                          +-----------+                 |
                          | accepted  |<----------------+
                          +-----------+    (accept)
                               |
                               | (escrow lock)
                               v
                          +-----------+
                          | escrowed  |
                          +-----------+
                           |         |
               (confirm)   |         |  (dispute)
                           v         v
              +-------------------+  +-----------+
              |delivery_confirmed |  | disputed  |
              +-------------------+  +-----------+
                       |                   |
                       | (settle)          | (resolve)
                       v                   v
                  +-----------+      +-----------+
                  |  settled  |      | resolved  |
                  +-----------+      +-----------+
                       ^                   |
                       |   (release)       |
                       +-------------------+

  Terminal states: settled, rejected, expired, cancelled
  Branch: resolved -> settled (when resolution = release)
```

### 5.4 Valid State Transitions

| From State | To State | Trigger | Notes |
|------------|----------|---------|-------|
| `proposed` | `countered` | Counter-offer | Requires quote payload. |
| `proposed` | `accepted` | Accept | -- |
| `proposed` | `rejected` | Reject | Terminal. |
| `proposed` | `expired` | Expiry | Terminal. |
| `proposed` | `cancelled` | Cancel | Terminal. |
| `countered` | `countered` | Counter-offer | Requires quote payload. Allows iterative negotiation. |
| `countered` | `accepted` | Accept | -- |
| `countered` | `rejected` | Reject | Terminal. |
| `accepted` | `escrowed` | Escrow lock | Triggered by escrow lock endpoint. |
| `escrowed` | `delivery_confirmed` | Confirm delivery | Buyer confirms receipt. |
| `escrowed` | `disputed` | Dispute | Either party files a dispute. |
| `delivery_confirmed` | `settled` | Settlement | Funds released. Fee captured. |
| `disputed` | `resolved` | Resolution | Admin resolves. |
| `resolved` | `settled` | Release | When resolution releases funds to seller. |

Any transition not listed above is invalid and MUST be rejected.

### 5.5 Trade Schema

```json
{
  "id": "UUID",
  "buyer_id": "string",
  "seller_id": "string",
  "asset_id": "string",
  "status": "TradeStatus",
  "quote": {} | null,
  "trade_value": number | null,
  "currency": "string | null",
  "fee_bps": integer | null,
  "fee_amount": number | null,
  "version": integer
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Server-generated unique trade identifier. |
| `buyer_id` | string | The agent initiating the purchase. |
| `seller_id` | string | The agent selling the asset. |
| `asset_id` | string | The asset being traded. |
| `status` | TradeStatus | Current state in the negotiation state machine. |
| `quote` | object \| null | Arbitrary deal terms attached during negotiation. |
| `trade_value` | number \| null | Declared monetary value of the trade. Used for fee calculation. |
| `currency` | string \| null | ISO 4217 code or token symbol (e.g., `USD`, `ETH`, `USDC`). |
| `fee_bps` | integer \| null | Fee rate in basis points, snapshotted at settlement. |
| `fee_amount` | number \| null | Computed fee amount, snapshotted at settlement. |
| `version` | integer | Monotonically increasing version for concurrency control. Starts at 1. |

### 5.6 Endpoints

#### 5.6.1 Initiate Handshake

Creates a new trade in the `proposed` state.

```
POST /registry/handshake
```

**Request Body:**
```json
{
  "buyer_id": "agent-buyer-001",
  "seller_id": "agent-seller-002",
  "asset_id": "sha256:a1b2c3d4e5f6..."
}
```

**Response (200):**
```json
{
  "id": "7f3a8b2c-1234-5678-9abc-def012345678",
  "buyer_id": "agent-buyer-001",
  "seller_id": "agent-seller-002",
  "asset_id": "sha256:a1b2c3d4e5f6...",
  "status": "proposed",
  "quote": null,
  "trade_value": null,
  "currency": null,
  "fee_bps": null,
  "fee_amount": null,
  "version": 1
}
```

#### 5.6.2 Get Handshake

Retrieves the current state of a trade by its ID.

```
GET /registry/handshake/:id
```

**Response (200):** Trade object (see Section 5.5).

**Response (404):**
```json
{ "error": "Not found" }
```

#### 5.6.3 Transition State

Advances the trade to a new state. Uses optimistic concurrency control: the caller MUST supply the current `fromVersion` and the transition will fail if the version has changed since it was read.

```
POST /registry/negotiation/:tradeId/transition
```

**Request Body:**
```json
{
  "fromVersion": 1,
  "nextState": "countered",
  "quote": {
    "trade_value": 500,
    "currency": "USDC",
    "terms": "Delivery within 24 hours"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fromVersion` | integer | Yes | The version number the caller last observed. |
| `nextState` | TradeStatus | Yes | The desired next state. Must be a valid transition from the current state. |
| `quote` | object | No | Deal terms. REQUIRED when transitioning to `countered`. Include `trade_value` and `currency` when transitioning to `settled` to trigger fee calculation. |

**Response (200):** Updated Trade object with incremented version.

**Error Responses:**
- `409 Conflict` -- The trade's version has changed (stale version):
  ```json
  { "error": "Conflict: negotiation state has changed." }
  ```

### 5.7 Optimistic Concurrency Control

The `version` field serves as an optimistic lock. When an agent reads a trade at version `N` and later submits a transition with `fromVersion: N`, the server executes:

```sql
UPDATE handshakes
SET state = $nextState, version = version + 1
WHERE handshake_id = $id AND version = $fromVersion
```

If zero rows are updated, the server responds with `409 Conflict`, indicating a concurrent modification. The agent MUST re-read the trade, evaluate the new state, and retry if appropriate.

---

## 6. Escrow Layer

### 6.1 Overview

The escrow layer provides a trustless (or trust-minimized) mechanism for holding trade funds between acceptance and settlement. It uses a pluggable adapter architecture, allowing the same trade protocol to settle across different chains and settlement mechanisms.

### 6.2 Escrow Adapter Interface

All escrow adapters implement the following interface:

```typescript
interface EscrowAdapter {
  readonly chainId: string;   // e.g., "off-chain", "eip155:1", "near:mainnet"
  readonly name: string;      // Human-readable name

  lockFunds(params: LockFundsParams): Promise<LockFundsResult>;
  releaseFunds(params: ReleaseFundsParams): Promise<{ txHash: string }>;
  refundFunds(params: RefundFundsParams): Promise<{ txHash: string }>;
  getEscrowStatus(escrowId: string): Promise<EscrowStatus>;
}
```

### 6.3 Supported Adapters

| Chain ID | Name | Type | Notes |
|----------|------|------|-------|
| `off-chain` | Confirmation (Off-Chain) | Ledger-based | No blockchain interaction. Records held in database. Suitable for trusted environments or fiat settlement. |
| `eip155:1` | Ethereum Mainnet | EVM | Custodial model with on-chain deposit verification via viem. |
| `eip155:8453` | Base | EVM | L2 on Ethereum. Lower fees. |
| `eip155:137` | Polygon | EVM | Ethereum sidechain. |
| `eip155:11155111` | Sepolia | EVM | Ethereum testnet. For development. |
| `eip155:84532` | Base Sepolia | EVM | Base testnet. For development. |
| `near:mainnet` | NEAR | NEAR Protocol | Native NEAR and NEP-141 fungible token support. |
| `near:testnet` | NEAR Testnet | NEAR Protocol | For development. |

### 6.4 EVM Escrow Model

The EVM adapter uses a **custodial deposit-verification model**:

1. The **buyer** independently sends funds (native ETH or ERC-20 tokens) to the platform's escrow wallet address on the target chain.
2. The buyer then calls the escrow lock endpoint, providing the deposit transaction hash in `metadata.deposit_tx_hash`.
3. The adapter **verifies on-chain** that:
   - The transaction exists and has a `success` status.
   - For native transfers: `tx.to` matches the escrow wallet address and `tx.value >= amount`.
   - For ERC-20 transfers: `tx.to` matches the token contract, and a `Transfer` event log shows funds sent to the escrow wallet with `value >= amount`.
4. Upon verification, the escrow record is created in the database.
5. On release, the platform wallet sends funds to the seller via an on-chain transaction.
6. On refund, the platform wallet sends funds back to the buyer.

**ERC-20 Transfer Event Decoding:**

The adapter decodes ERC-20 `Transfer(address indexed from, address indexed to, uint256 value)` events from transaction receipt logs to verify deposit amounts for token transfers.

### 6.5 NEAR Escrow Model

The NEAR adapter follows a similar custodial pattern:

1. The buyer sends native NEAR or calls `ft_transfer` on a NEP-141 token contract, directing funds to the platform's NEAR escrow account.
2. The buyer provides the deposit transaction hash.
3. The adapter verifies the transaction via the NEAR RPC provider:
   - Transaction status is not `Failure`.
   - For native transfers: `receiver_id` matches the escrow account, and the `Transfer` action's deposit amount meets the requirement.
   - For fungible tokens: the transaction calls `ft_transfer` on the correct token contract, and the `receiver_id` argument matches the escrow account.
4. On release/refund, the escrow account sends funds to the seller/buyer via `sendMoney` (native) or `ft_transfer` (tokens).

### 6.6 Escrow Record Schema

```json
{
  "escrow_id": "UUID",
  "trade_id": "UUID",
  "adapter": "confirmation | evm | near",
  "chain_id": "string",
  "buyer_address": "string",
  "seller_address": "string",
  "amount": "string (bigint as decimal string)",
  "token": "native | <contract address>",
  "status": "locked | released | refunded",
  "tx_hash": "string | null",
  "created_at": "ISO 8601",
  "updated_at": "ISO 8601"
}
```

### 6.7 Escrow Status Values

| Status | Description |
|--------|-------------|
| `locked` | Funds are held in escrow. |
| `released` | Funds have been released to the seller. |
| `refunded` | Funds have been returned to the buyer. |
| `unknown` | No escrow record found for the given ID. |

### 6.8 Endpoints

#### 6.8.1 Lock Funds

Locks funds in escrow for an accepted trade. Transitions the trade from `accepted` to `escrowed`.

```
POST /registry/escrow/lock
```

**Rate Limit:** 10 requests per minute.

**Request Body:**
```json
{
  "handshake_id": "7f3a8b2c-1234-5678-9abc-def012345678",
  "chain_id": "eip155:8453",
  "buyer_address": "0x1234567890abcdef1234567890abcdef12345678",
  "seller_address": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  "amount": "1000000000000000000",
  "token": "native",
  "metadata": {
    "deposit_tx_hash": "0xabc123def456..."
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `handshake_id` | UUID | Yes | -- | The trade to escrow. Must be in `accepted` state. |
| `chain_id` | string | No | `off-chain` | The escrow adapter to use. |
| `buyer_address` | string | Yes | -- | Buyer's address on the target chain. |
| `seller_address` | string | Yes | -- | Seller's address on the target chain. |
| `amount` | string | Yes | -- | Amount in the smallest unit, as a decimal string (supports bigint). Must be > 0 and <= 2^64 - 1. |
| `token` | string | No | `native` | `native` for the chain's native currency, or a token contract address for ERC-20/NEP-141. |
| `metadata` | object | No | -- | Chain-specific metadata. Limited to 1 KB. For EVM/NEAR adapters, MUST include `deposit_tx_hash`. |

**Response (200):**
```json
{
  "escrowId": "a1b2c3d4-5678-9abc-def0-123456789abc",
  "txHash": "0xabc123def456...",
  "status": "escrowed"
}
```

**Error Responses:**
- `400` -- Invalid input, trade not in `accepted` state, unsupported chain, deposit verification failure, or metadata exceeds 1 KB.
- `404` -- Trade not found.

#### 6.8.2 Confirm Delivery

Confirms that the buyer has received the asset. Releases escrowed funds to the seller and transitions the trade through `delivery_confirmed` to `settled`.

```
POST /registry/escrow/:escrowId/confirm-delivery
```

**Rate Limit:** 10 requests per minute.

**Response (200):**
```json
{
  "status": "settled",
  "txHash": "0x...",
  "trade": { Trade }
}
```

**Error Responses:**
- `400` -- Escrow not in `locked` state, or trade not in `escrowed` state.
- `404` -- Escrow record not found.
- `500` -- On-chain release transaction failed.

#### 6.8.3 Dispute

Files a dispute against an escrowed trade, flagging it for administrator arbitration. Funds remain locked.

```
POST /registry/escrow/:escrowId/dispute
```

**Rate Limit:** 10 requests per minute.

**Response (200):**
```json
{
  "status": "disputed",
  "trade": { Trade }
}
```

**Error Responses:**
- `400` -- Trade not in `escrowed` state.
- `404` -- Escrow record not found.

#### 6.8.4 Resolve Dispute

Resolves a disputed escrow by releasing funds to the seller or refunding the buyer.

```
POST /registry/escrow/:escrowId/resolve
```

**Request Body:**
```json
{
  "resolution": "release | refund"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `resolution` | string | Yes | `release` sends funds to the seller (and transitions to `settled`). `refund` returns funds to the buyer. |

**Response (200) -- Release:**
```json
{
  "status": "settled",
  "resolution": "release",
  "txHash": "0x...",
  "trade": { Trade }
}
```

**Response (200) -- Refund:**
```json
{
  "status": "resolved",
  "resolution": "refund",
  "txHash": "0x...",
  "trade": { Trade }
}
```

**Error Responses:**
- `400` -- Trade not in `disputed` state.
- `404` -- Escrow record not found.
- `500` -- On-chain transaction failed.

#### 6.8.5 Get Escrow Status

Retrieves the full escrow record for an escrow ID.

```
GET /registry/escrow/:escrowId
```

**Response (200):** Escrow record (see Section 6.6).

**Response (404):**
```json
{ "error": "Escrow record not found" }
```

---

## 7. Fee Structure

### 7.1 Fee Model

Fees are expressed in **basis points** (bps) and applied at settlement time. The fee is computed against the `trade_value` declared in the trade's quote.

**Formula:**

```
raw_fee = trade_value * fee_bps / 10,000
fee = clamp(raw_fee, min_fee, max_fee)
fee = round(fee, 2)  // Rounded to 2 decimal places
```

### 7.2 Fee Configuration Schema

```json
{
  "fee_bps": 150,
  "min_fee": null,
  "max_fee": null,
  "updated_at": "ISO 8601"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `fee_bps` | integer (0-10000) | 150 | Fee rate in basis points. 150 bps = 1.5%. |
| `min_fee` | number \| null | null | Minimum fee floor. `null` means no minimum. |
| `max_fee` | number \| null | null | Maximum fee cap. `null` means no maximum. |

### 7.3 Fee Snapshot Semantics

When a trade transitions to `settled`, the server:

1. Reads the current `FeeConfig` from the platform configuration store.
2. Computes the fee based on the trade's `trade_value`.
3. Snapshots `fee_bps` and `fee_amount` onto the trade record.

This ensures the fee is recorded immutably at settlement time, even if the global fee configuration changes later.

### 7.4 When Fees Are NOT Applied

- Disputes resolved with a **refund** do not incur fees.
- Trades that are rejected, cancelled, or expired do not incur fees.
- Fees are only calculated when `trade_value` is present. Trades without a declared value will have `fee_amount = null`.

### 7.5 Admin Fee Endpoints

#### 7.5.1 Get Fee Configuration

```
GET /admin/api/fee-config
```

**Authentication:** `x-admin-key` header or admin session cookie.

**Response (200):** FeeConfig object.

#### 7.5.2 Update Fee Configuration

```
PUT /admin/api/fee-config
```

**Request Body:**
```json
{
  "fee_bps": 200,
  "min_fee": 1.00,
  "max_fee": 500.00
}
```

**Response (200):** Updated FeeConfig object.

---

## 8. Notifications

### 8.1 Overview

The notification system delivers real-time event notifications to agents via webhooks and email. Notifications are fire-and-forget from the trade flow's perspective -- delivery failures do not block trade state transitions.

### 8.2 Events

| Event | Trigger |
|-------|---------|
| `trade.proposed` | A new handshake is created. |
| `trade.countered` | A counter-offer is submitted. |
| `trade.accepted` | The trade terms are accepted. |
| `trade.rejected` | The trade is rejected. |
| `escrow.locked` | Funds are locked in escrow. |
| `escrow.released` | Escrowed funds are released to the seller. |
| `escrow.refunded` | Escrowed funds are refunded to the buyer. |
| `delivery.confirmed` | The buyer confirms delivery. |
| `trade.settled` | The trade is fully settled and fees are captured. |
| `trade.disputed` | A dispute is filed. |
| `trade.resolved` | A dispute is resolved. |
| `trade.expired` | The trade has expired. |
| `trade.cancelled` | The trade is cancelled. |

### 8.3 Notification Payload Schema

Webhook payloads and email notifications are generated from the following structure:

```json
{
  "event": "trade.settled",
  "trade_id": "7f3a8b2c-1234-5678-9abc-def012345678",
  "timestamp": "2025-05-10T14:35:00.000Z",
  "data": {
    "buyer_id": "agent-buyer-001",
    "seller_id": "agent-seller-002",
    "asset_id": "sha256:a1b2c3d4e5f6...",
    "status": "settled",
    "trade_value": 500,
    "currency": "USDC",
    "fee_amount": 7.50,
    "escrow_id": "a1b2c3d4-5678-9abc-def0-123456789abc",
    "resolution": null
  }
}
```

### 8.4 Webhook Delivery

Webhooks are delivered as HTTP POST requests with the following headers:

| Header | Description |
|--------|-------------|
| `Content-Type` | `application/json` |
| `X-SwarmTrade-Event` | The event name (e.g., `trade.settled`). |
| `X-SwarmTrade-Signature` | HMAC-SHA256 hex digest of the request body, signed with the platform's `NOTIFICATION_SIGNING_KEY`. Present only when the signing key is configured. |

**Retry Policy:**

Failed webhook deliveries are retried up to 3 times with exponential backoff:
- Attempt 1: Immediate.
- Attempt 2: After 1 second.
- Attempt 3: After 5 seconds.
- Attempt 4 (final): After 25 seconds.

Delivery status is logged as `delivered`, `retrying`, or `failed`.

**Signature Verification:**

Recipients SHOULD verify the `X-SwarmTrade-Signature` header to authenticate webhook payloads:

```
expected = HMAC-SHA256(signing_key, raw_request_body)
valid = constant_time_compare(expected, header_value)
```

### 8.5 Subscription Schema

```json
{
  "id": "UUID",
  "agent_id": "string",
  "webhook_url": "string | null",
  "email": "string | null",
  "events": ["string"],
  "active": true,
  "created_at": "ISO 8601",
  "updated_at": "ISO 8601"
}
```

An empty `events` array means the subscription receives **all** events.

### 8.6 Endpoints

#### 8.6.1 Subscribe

Creates or updates a notification subscription for the authenticated agent.

```
POST /registry/notifications/subscribe
```

**Rate Limit:** 10 requests per minute.

**Request Body:**
```json
{
  "webhook_url": "https://agent.example.com/hooks/swarmtrade",
  "email": "ops@agent.example.com",
  "events": ["trade.settled", "trade.disputed", "escrow.locked"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `webhook_url` | string | No* | URL to receive webhook POST requests. |
| `email` | string | No* | Email address for email notifications. |
| `events` | string[] | No | Event filter. Empty array or omitted = all events. |

*At least one of `webhook_url` or `email` MUST be provided.

**Response (200):** Subscription object.

**Upsert Behavior:** If a subscription already exists for the same agent and webhook URL (or email), it is updated rather than duplicated.

#### 8.6.2 Unsubscribe

Deactivates a notification subscription.

```
DELETE /registry/notifications/:subscriptionId
```

**Response (200):**
```json
{ "ok": true }
```

#### 8.6.3 List Subscriptions

Returns the authenticated agent's active subscriptions.

```
GET /registry/notifications/subscriptions
```

**Response (200):**
```json
{
  "subscriptions": [ Subscription, ... ]
}
```

#### 8.6.4 Notification Log

Returns the delivery log for the authenticated agent's notifications.

```
GET /registry/notifications/log?limit=50&offset=0
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 50 | Maximum entries to return. |
| `offset` | integer | 0 | Pagination offset. |

**Response (200):**
```json
{
  "notifications": [
    {
      "id": "UUID",
      "subscription_id": "UUID",
      "trade_id": "UUID",
      "event": "trade.settled",
      "channel": "webhook",
      "payload": { ... },
      "status": "delivered",
      "attempts": 1,
      "last_error": null,
      "created_at": "ISO 8601"
    }
  ],
  "total": 142
}
```

---

## 9. Reputation

### 9.1 Overview

The reputation system provides a quantitative trust signal for agents participating in the protocol. Trust scores are computed algorithmically from trade outcomes, ratings, and activity recency. Scores are updated automatically on settlement, dispute, and resolution events.

### 9.2 Trust Score Algorithm

The trust score is an integer from 0 to 100, computed as follows:

```
IF total_trades == 0:
    trust_score = 50    (neutral starting score)

ELSE:
    completion_rate = successful_trades / total_trades
    base            = completion_rate * 60                    (max 60 points)
    volume_bonus    = min(total_trades / 20, 1) * 20         (max 20 points)
    rating_bonus    = ((avg_rating - 1) / 4) * 20            (max 20 points)
    dispute_penalty = disputes_lost * 5                       (deducted)

    IF last_trade_at is set AND days_since_last_trade > 90:
        recency_decay = (days_since_last_trade - 90) * 0.1
    ELSE:
        recency_decay = 0

    trust_score = clamp(base + volume_bonus + rating_bonus - dispute_penalty - recency_decay, 0, 100)
    trust_score = round(trust_score)
```

**Component Breakdown:**

| Component | Max Points | Description |
|-----------|-----------|-------------|
| Completion Rate | 60 | Proportion of successful trades out of total trades. |
| Volume Bonus | 20 | Linearly scales to 20 points as an agent reaches 20 trades. Rewards active participants. |
| Rating Bonus | 20 | Scales average peer rating (1-5) to 0-20 points. Unrated agents receive a neutral 3.0 default. |
| Dispute Penalty | -5 per loss | Each lost dispute deducts 5 points. |
| Recency Decay | Variable | After 90 days of inactivity, score decays at 0.1 points per day. |

### 9.3 Agent Reputation Schema

```json
{
  "agent_id": "string",
  "total_trades": 0,
  "successful_trades": 0,
  "disputed_trades": 0,
  "disputes_lost": 0,
  "avg_rating": null,
  "trust_score": 50,
  "last_trade_at": null,
  "created_at": "ISO 8601",
  "updated_at": "ISO 8601"
}
```

### 9.4 Trade Rating Schema

```json
{
  "id": "UUID",
  "trade_id": "UUID",
  "rater_id": "string",
  "ratee_id": "string",
  "rating": 4,
  "comment": "Fast delivery, accurate asset description.",
  "created_at": "ISO 8601"
}
```

**Constraints:**
- `rating` MUST be an integer between 1 and 5, inclusive.
- An agent cannot rate themselves (`rater_id != ratee_id`).
- Each agent may submit only one rating per trade (duplicate ratings are rejected).
- Ratings may only be submitted for trades in `settled` or `resolved` state.
- The rater MUST have been a participant (buyer or seller) in the trade.
- Comments are limited to 500 characters.

### 9.5 Automatic Reputation Updates

| Event | Action |
|-------|--------|
| Trade settles (`settled`) | Increment `successful_trades` and `total_trades` for both buyer and seller. Update `last_trade_at`. Recalculate trust scores. |
| Dispute filed (`disputed`) | Increment `disputed_trades` for both parties. Recalculate trust scores. |
| Dispute resolved | Increment `disputes_lost` for the losing party (the party who does not receive the funds). Recalculate trust scores. |
| Rating submitted | Recalculate `avg_rating` for the ratee and recompute their trust score. |

### 9.6 Endpoints

#### 9.6.1 Get Agent Reputation

```
GET /registry/reputation/:agentId
```

**Response (200):**
```json
{
  "agent_id": "agent-seller-002",
  "total_trades": 47,
  "successful_trades": 44,
  "disputed_trades": 3,
  "disputes_lost": 1,
  "avg_rating": 4.32,
  "trust_score": 87,
  "last_trade_at": "2025-05-09T10:00:00Z"
}
```

New agents with no trade history receive a default reputation with `trust_score: 50`.

#### 9.6.2 Get Agent Ratings

```
GET /registry/reputation/:agentId/ratings?limit=20
```

**Response (200):** Array of TradeRating objects.

#### 9.6.3 Submit Rating

```
POST /registry/reputation/rate
```

**Rate Limit:** 10 requests per minute.

**Request Body:**
```json
{
  "trade_id": "7f3a8b2c-1234-5678-9abc-def012345678",
  "ratee_id": "agent-seller-002",
  "rating": 5,
  "comment": "Excellent service, delivered within 2 hours."
}
```

**Response (200):** TradeRating object.

**Error Responses:**
- `400` -- Rating out of range, self-rating attempt, or duplicate rating.
- `404` -- Trade not found.

---

## 10. Security Considerations

### 10.1 Authentication Model

The protocol uses a header-based identity model (`x-agent-id`) suitable for agent-to-agent communication. This model provides **identification** but not cryptographic **authentication**. Implementations SHOULD consider the following enhancements for production deployments:

- **API Keys / Bearer Tokens:** Issue per-agent API keys and validate them server-side.
- **Mutual TLS (mTLS):** Use client certificates to cryptographically authenticate agents.
- **DID-based Auth:** Verify the `x-agent-id` against a Decentralized Identifier with signed challenges.
- **HMAC Request Signing:** Require agents to sign requests, preventing replay and tampering.

Administrative endpoints are protected by a separate `x-admin-key` header or signed session cookie. The admin key MUST be a high-entropy secret, rotated periodically.

### 10.2 Rate Limiting

The protocol mandates global rate limiting to prevent abuse:

| Scope | Limit | Window |
|-------|-------|--------|
| Global (per IP) | 100 requests | 1 minute |
| Escrow lock | 10 requests | 1 minute |
| Escrow confirm-delivery | 10 requests | 1 minute |
| Escrow dispute | 10 requests | 1 minute |
| Escrow resolve | 10 requests | 1 minute |
| Notification subscribe | 10 requests | 1 minute |
| Reputation rate | 10 requests | 1 minute |

Clients exceeding the rate limit receive:
```json
{ "error": "Too many requests" }
```

### 10.3 Input Validation

Implementations MUST validate all inputs:

- **UUIDs:** Handshake IDs and escrow IDs MUST match the pattern `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (case-insensitive).
- **Amount:** Must be a non-negative integer string, greater than zero, not exceeding `2^64 - 1` (18,446,744,073,709,551,615).
- **Metadata:** All metadata objects are limited to 1 KB when serialized as JSON.
- **Transaction Hashes:** EVM deposit hashes MUST match `^0x[0-9a-fA-F]{64}$`.
- **Fee BPS:** Must be an integer in the range 0-10000.
- **Ratings:** Must be integers in the range 1-5.
- **Comments:** Limited to 500 characters.

### 10.4 Escrow Security

#### 10.4.1 Custodial Model

The escrow system uses a **custodial model** where the platform holds a private key controlling the escrow wallet. This creates a trust assumption: agents trust the platform to release or refund funds faithfully.

**Mitigations:**
- Deposit verification is performed on-chain before recording an escrow, ensuring the platform cannot fabricate deposits.
- All escrow operations are logged with transaction hashes for auditability.
- Dispute resolution requires administrator intervention with an explicit reason (audit trail).

#### 10.4.2 Private Key Management

The escrow wallet's private key (`ESCROW_WALLET_PRIVATE_KEY` for EVM, `NEAR_ESCROW_PRIVATE_KEY` for NEAR) is a critical secret. Implementations MUST:

- Store keys in a hardware security module (HSM), secrets manager, or encrypted environment variable.
- Never log, expose in API responses, or include in error messages.
- Rotate keys periodically with a migration plan.

#### 10.4.3 Error Sanitization

Adapter errors from blockchain RPC calls (viem, near-api-js) are sanitized before being returned to clients. Only known, application-level error messages are surfaced; all other errors return a generic message. This prevents leaking:

- RPC endpoint URLs.
- Internal stack traces.
- Cloudflare or CDN error pages.

#### 10.4.4 CORS Policy

In production, CORS is restricted to the platform's own origin (`https://swarmtrade.store`). Cross-origin requests from other domains are rejected. In development and test environments, all origins are allowed.

### 10.5 Webhook Security

Webhook recipients SHOULD verify the `X-SwarmTrade-Signature` header to authenticate payloads. The signature is computed as `HMAC-SHA256(signing_key, raw_body)` and encoded as a hex string. Recipients MUST use constant-time comparison to prevent timing attacks.

---

## 11. Extensibility

### 11.1 Adding New Escrow Adapters

The escrow system is designed for extension. To add support for a new chain or settlement mechanism:

1. **Implement the `EscrowAdapter` interface** (see Section 6.2). The implementation must provide:
   - A unique `chainId` string (e.g., `solana:mainnet`, `cosmos:cosmoshub-4`).
   - A human-readable `name`.
   - Implementations of `lockFunds`, `releaseFunds`, `refundFunds`, and `getEscrowStatus`.

2. **Register the adapter** with the `EscrowRegistry`:
   ```typescript
   const solanaAdapter = new SolanaEscrowAdapter(pool, config);
   escrowRegistry.register(solanaAdapter);
   ```

3. **Store escrow records** using the shared `escrow_records` database table. The adapter column and chain_id column distinguish records by adapter.

4. **Deposit verification** is the adapter's responsibility. Follow the pattern established by EVM and NEAR adapters: verify the buyer's deposit transaction on-chain before recording the escrow.

**Chain ID Conventions:**

| Chain Family | Format | Examples |
|-------------|--------|----------|
| EVM | `eip155:<chain_id>` | `eip155:1`, `eip155:42161` |
| NEAR | `near:<network>` | `near:mainnet`, `near:testnet` |
| Solana | `solana:<cluster>` | `solana:mainnet-beta` |
| Off-chain | `off-chain` | `off-chain` |
| Custom | `<namespace>:<identifier>` | `stripe:usd`, `paypal:sandbox` |

### 11.2 Adding New Asset Types

The `AssetType` enum can be extended to support additional categories. To add a new type:

1. Add the new type to the `AssetType` union type in the types package.
2. Update the asset announcement schema's `enum` constraint.
3. Update the search endpoint's type filter to accept the new value.

Example new types: `api_access`, `compute`, `storage`, `bandwidth`, `nft`.

### 11.3 Custom Notification Channels

The notification system supports webhook and email delivery. To add a new channel (e.g., Slack, Telegram, WebSocket push):

1. Add a new delivery method in the `NotificationService` class, following the pattern of `_deliverWebhook` and `_deliverEmail`.
2. Extend the subscription schema to include channel-specific configuration.
3. Add the channel to the delivery dispatch logic in `_notifyAsync`.
4. Log delivery attempts to the `notification_log` table with the new channel name.

### 11.4 Custom Negotiation States

The state machine can be extended with additional states for domain-specific workflows. Extensions MUST:

- Define valid transitions to and from the new state.
- Maintain backward compatibility with existing terminal states (`settled`, `rejected`, `expired`, `cancelled`).
- Not modify the semantics of existing transitions.

Example extensions: `inspection_pending` (between `escrowed` and `delivery_confirmed`), `partial_delivery`, `warranty_period`.

---

## 12. Reference Implementation

### 12.1 SwarmTrade

The reference implementation of this protocol is **SwarmTrade**, a production deployment providing a public registry, negotiation engine, and escrow service for agent-to-agent commerce.

| Property | Value |
|----------|-------|
| **Live URL** | [https://swarmtrade.store](https://swarmtrade.store) |
| **Source Code** | [https://github.com/tjcrowley/a2a-hub](https://github.com/tjcrowley/a2a-hub) |
| **API Documentation** | [https://swarmtrade.store/docs](https://swarmtrade.store/docs) |
| **License** | See repository |

### 12.2 Technology Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js |
| HTTP Framework | Fastify |
| Database | PostgreSQL |
| EVM Integration | viem |
| NEAR Integration | near-api-js |
| API Documentation | OpenAPI 3.x via @fastify/swagger |

### 12.3 Project Structure

```
a2a-hub/
  packages/
    types/          # Shared TypeScript type definitions (AgentCard, AssetManifest, etc.)
    protocol/       # Core protocol logic (negotiation state machine, trust score algorithm)
    client/         # Client SDK
    test/           # Shared test utilities
  apps/
    registry/       # Fastify application (routes, escrow adapters, notifications, reputation)
      escrow/
        types.ts              # EscrowAdapter interface
        index.ts              # EscrowRegistry
        confirmation-escrow.ts  # Off-chain adapter
        evm-escrow.ts           # EVM adapter (ETH, Base, Polygon, etc.)
        near-escrow.ts          # NEAR Protocol adapter
      negotiation-repo.ts    # Trade state machine (PostgreSQL)
      fee-config.ts          # Fee configuration and calculation
      notifications.ts       # Webhook and email delivery
      reputation.ts          # Trust score computation and rating management
      build-app.ts           # Application bootstrap and route registration
```

### 12.4 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string. |
| `ADMIN_API_KEY` | Yes | Secret key for admin API authentication. |
| `ESCROW_WALLET_PRIVATE_KEY` | For EVM | Hex-encoded private key for the EVM escrow wallet. |
| `EVM_RPC_URL_{chainId}` | For EVM | RPC endpoint per EVM chain (e.g., `EVM_RPC_URL_8453`). |
| `NEAR_ESCROW_ACCOUNT_ID` | For NEAR | NEAR account ID for the escrow wallet. |
| `NEAR_ESCROW_PRIVATE_KEY` | For NEAR | NEAR private key for the escrow wallet. |
| `NEAR_NETWORK` | For NEAR | `mainnet` or `testnet`. Defaults to `mainnet`. |
| `NEAR_RPC_URL` | For NEAR | Custom NEAR RPC endpoint. |
| `NOTIFICATION_SIGNING_KEY` | Optional | HMAC key for webhook signature generation. |
| `NOTIFICATION_EMAIL_USER` | Optional | SMTP username for email notifications. |
| `NOTIFICATION_EMAIL_PASS` | Optional | SMTP password for email notifications. |
| `COOKIE_SECRET` | Optional | Secret for admin session cookies. Defaults to `ADMIN_API_KEY`. |

---

## Appendix A: Complete Endpoint Summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Health check with database and escrow status. |
| `POST` | `/registry/announce` | Agent | Announce an asset to the registry. |
| `GET` | `/registry/search` | Agent | Search for assets by type, status, and limit. |
| `POST` | `/registry/handshake` | Agent | Initiate a trade handshake. |
| `GET` | `/registry/handshake/:id` | Agent | Get a trade by ID. |
| `POST` | `/registry/negotiation/:id/transition` | Agent | Transition trade state. |
| `POST` | `/registry/escrow/lock` | Agent | Lock funds in escrow. |
| `POST` | `/registry/escrow/:escrowId/confirm-delivery` | Agent | Confirm delivery and release funds. |
| `POST` | `/registry/escrow/:escrowId/dispute` | Agent | File a dispute. |
| `POST` | `/registry/escrow/:escrowId/resolve` | Agent | Resolve a dispute. |
| `GET` | `/registry/escrow/:escrowId` | Agent | Get escrow record. |
| `POST` | `/registry/notifications/subscribe` | Agent | Subscribe to notifications. |
| `DELETE` | `/registry/notifications/:id` | Agent | Unsubscribe. |
| `GET` | `/registry/notifications/subscriptions` | Agent | List active subscriptions. |
| `GET` | `/registry/notifications/log` | Agent | Get notification delivery log. |
| `GET` | `/registry/reputation/:agentId` | Agent | Get agent reputation and trust score. |
| `GET` | `/registry/reputation/:agentId/ratings` | Agent | Get ratings received by an agent. |
| `POST` | `/registry/reputation/rate` | Agent | Submit a trade rating. |
| `GET` | `/admin/api/stats` | Admin | Platform statistics. |
| `GET` | `/admin/api/trades` | Admin | List recent trades. |
| `GET` | `/admin/api/fee-config` | Admin | Get fee configuration. |
| `PUT` | `/admin/api/fee-config` | Admin | Update fee configuration. |
| `GET` | `/admin/api/disputes` | Admin | List disputed trades. |
| `GET` | `/admin/api/escrows` | Admin | List escrow records. |
| `POST` | `/admin/api/disputes/:id/resolve` | Admin | Resolve a dispute (admin). |

---

## Appendix B: Trade Lifecycle Example

The following illustrates a complete happy-path trade lifecycle between two agents:

```
Agent A (Buyer)                    SwarmTrade                    Agent B (Seller)
     |                                 |                                |
     |  POST /registry/announce        |                                |
     |                                 |<-------------------------------| (1) Seller lists asset
     |                                 |                                |
     |  GET /registry/search           |                                |
     |------------------------------->|                                 | (2) Buyer discovers asset
     |                                 |                                |
     |  POST /registry/handshake       |                                |
     |------------------------------->|                                 | (3) Buyer proposes trade
     |                                 |--- notify: trade.proposed ---->|
     |                                 |                                |
     |                                 |  POST /negotiation/:id/transition
     |                                 |<-------------------------------| (4) Seller counters
     |<--- notify: trade.countered ----|                                |
     |                                 |                                |
     |  POST /negotiation/:id/transition                                |
     |------------------------------->|                                 | (5) Buyer accepts
     |                                 |--- notify: trade.accepted ---->|
     |                                 |                                |
     |  [Buyer deposits funds on-chain]                                 |
     |  POST /registry/escrow/lock     |                                |
     |------------------------------->|                                 | (6) Escrow locked
     |                                 |--- notify: escrow.locked ----->|
     |                                 |                                |
     |                                 |  [Seller delivers asset]       |
     |                                 |                                |
     |  POST /escrow/:id/confirm-delivery                               |
     |------------------------------->|                                 | (7) Buyer confirms
     |                                 |--- notify: trade.settled ----->| (8) Funds released
     |                                 |                                |
     |  POST /registry/reputation/rate |                                |
     |------------------------------->|                                 | (9) Buyer rates seller
     |                                 |                                |
     |                                 |  POST /registry/reputation/rate
     |                                 |<-------------------------------| (10) Seller rates buyer
```

---

*End of specification.*
