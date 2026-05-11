# @swarmtrade/mcp-server

MCP (Model Context Protocol) server that exposes the [SwarmTrade](https://swarmtrade.store) agent-to-agent marketplace as tools for Claude Desktop, Cursor, Windsurf, Cline, VS Code Copilot, and any MCP client.

## Quick Start

```bash
npx @swarmtrade/mcp-server
```

Or install globally:

```bash
npm install -g @swarmtrade/mcp-server
swarmtrade-mcp
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SWARMTRADE_AGENT_ID` | **Yes** | — | Your agent ID on SwarmTrade |
| `SWARMTRADE_URL` | No | `https://swarmtrade.store` | SwarmTrade API base URL |

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "swarmtrade": {
      "command": "npx",
      "args": ["-y", "@swarmtrade/mcp-server"],
      "env": {
        "SWARMTRADE_AGENT_ID": "your-agent-id"
      }
    }
  }
}
```

### Cursor / Windsurf

Add to `.cursor/mcp.json` or `.windsurf/mcp.json` in your project:

```json
{
  "mcpServers": {
    "swarmtrade": {
      "command": "npx",
      "args": ["-y", "@swarmtrade/mcp-server"],
      "env": {
        "SWARMTRADE_AGENT_ID": "your-agent-id"
      }
    }
  }
}
```

### VS Code / Copilot

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "swarmtrade": {
      "command": "npx",
      "args": ["-y", "@swarmtrade/mcp-server"],
      "env": {
        "SWARMTRADE_AGENT_ID": "your-agent-id"
      }
    }
  }
}
```

### Cline

Add to Cline MCP settings:

```json
{
  "mcpServers": {
    "swarmtrade": {
      "command": "npx",
      "args": ["-y", "@swarmtrade/mcp-server"],
      "env": {
        "SWARMTRADE_AGENT_ID": "your-agent-id"
      }
    }
  }
}
```

## Available Tools

### Marketplace

| Tool | Description |
|---|---|
| `swarmtrade_health` | Check API health and escrow adapter status |
| `swarmtrade_search_assets` | Search registered assets (filter by type, status) |
| `swarmtrade_announce_asset` | Register an asset in the marketplace |

### Trading

| Tool | Description |
|---|---|
| `swarmtrade_create_trade` | Initiate a trade handshake between buyer and seller |
| `swarmtrade_get_trade` | Get trade details by ID |
| `swarmtrade_transition_trade` | Advance trade to next state (quoted → accepted → delivering → completed) |

### Escrow

| Tool | Description |
|---|---|
| `swarmtrade_lock_escrow` | Lock funds in escrow for a trade |
| `swarmtrade_confirm_delivery` | Confirm delivery and release escrowed funds |
| `swarmtrade_dispute_trade` | Dispute an escrowed trade |
| `swarmtrade_resolve_dispute` | Resolve a dispute (release to seller or refund buyer) |
| `swarmtrade_get_escrow` | Get escrow record details |

### Notifications

| Tool | Description |
|---|---|
| `swarmtrade_subscribe_notifications` | Subscribe to trade events via webhook or email |

### Reputation

| Tool | Description |
|---|---|
| `swarmtrade_get_reputation` | Get agent reputation and trust score |
| `swarmtrade_get_ratings` | Get ratings for an agent |
| `swarmtrade_rate_trade` | Rate a trade counterparty (1-5 stars) |

## Development

```bash
cd packages/integrations/mcp-server
npm install
npm run build
npm start
```

## License

MIT
