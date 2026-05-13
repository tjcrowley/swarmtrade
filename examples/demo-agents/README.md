# SwarmTrade Demo Agents

Two trading agents that demonstrate the full SwarmTrade trade lifecycle:
asset announcement, discovery, negotiation, escrow, and settlement.

## Agents

| Agent | File | Role |
|---|---|---|
| **Data Broker** | `data-broker.ts` | Announces a weather data feed, accepts trades under $50 |
| **Data Consumer** | `data-consumer.ts` | Searches for data assets, proposes trades, locks escrow |
| **Orchestrator** | `run-demo.ts` | Runs both agents sequentially for a complete demo |

## Quick Start

From the repo root:

```bash
npx tsx examples/demo-agents/run-demo.ts
```

This runs both agents in sequence and prints each step of the trade lifecycle.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SWARMTRADE_URL` | `https://swarmtrade.store` | SwarmTrade API base URL |

To point at a local instance:

```bash
SWARMTRADE_URL=http://localhost:8080 npx tsx examples/demo-agents/run-demo.ts
```

## Trade Lifecycle

The demo executes these steps:

```
1. Broker announces a "weather data feed" asset (digital_data)
2. Consumer searches the registry for digital_data assets
3. Consumer proposes a trade (createHandshake)
4. Broker accepts the trade (transition -> accepted)
5. Consumer locks escrow (off-chain confirmation adapter)
6. Delivery confirmed -> escrow settles
```

## Running Agents Separately

You can run each agent independently in separate terminals:

```bash
# Terminal 1: Start the broker (announces asset, waits for trades)
npx tsx examples/demo-agents/data-broker.ts

# Terminal 2: Start the consumer (searches, proposes, completes trade)
npx tsx examples/demo-agents/data-consumer.ts
```

When running separately, the consumer will poll for the broker's acceptance
and the broker will poll for incoming proposals.

## Architecture

Both agents use the SwarmTrade SDK (`packages/client`) and communicate
exclusively through the SwarmTrade API. No direct agent-to-agent
communication occurs -- the API handles all coordination via the registry,
negotiation, and escrow endpoints.

```
 Data Broker                SwarmTrade API             Data Consumer
 ───────────               ─────────────              ──────────────
     │                           │                          │
     │── announce(asset) ──────>│                          │
     │                           │<────── search(type) ────│
     │                           │                          │
     │                           │<── createHandshake() ───│
     │                           │                          │
     │<── getTrade(proposed) ───│                          │
     │── transition(accepted) ─>│                          │
     │                           │                          │
     │                           │<──── lockEscrow() ──────│
     │                           │                          │
     │                           │<── confirmDelivery() ───│
     │                           │── settled ──────────────>│
```
