# genswarms-fleet-mcp

**MCP server over a fleet of GenSwarms swarms**: connect any MCP harness
(Claude Code, claude.ai, Cursor, ...) and observe, configure and — opt-in —
operate your swarms. One connector, the whole fleet.

```
Claude Code / claude.ai / Cursor
        │ MCP (stdio)
        ▼
 genswarms-fleet-mcp  (thin adapter — holds NO authority)
        ├──▶ dashboard read API   (responses pre-redacted per config_schema)
        └──▶ engine config API    (op gate + scoped tokens server-side)
```

This is the outbound twin of
[genswarms-mcp-gateway](https://github.com/jmlago/genswarms-mcp-gateway)
(which lets caged agents consume external MCP servers). Direction here:
the world consuming the swarms.

## Tools, in three tiers

Tiers exist per swarm, derived from what its fleet entry provides; tools are
only REGISTERED when at least one swarm qualifies.

**Tier 1 — observe** (`dashboard_url`): `get_dashboard`, `get_events`,
`get_session_history`, `get_session_logs`, `get_config`. Read-only; config
responses arrive already redacted against each package's `config_schema` —
secrets structurally cannot appear here.

**Tier 2 — configure** (`engine_url`): `patch_object_config`, `get_overlay`.
Works with the **narrow `GENSWARMS_CONFIG_API_TOKEN`** — the engine's
config_schema op gate is the authority (only `x-mutable` keys, host-escape
keys always rejected, 422 relayed verbatim). Every change lands in the
overlay audit trail; a leaked config token's blast radius is the tuning
surface each package declared.

**Tier 3 — operate** (`enable_operate: true` in the fleet file, full engine
token): `send_task` (the test/probe surface), `restart_agent`,
`list_objects`, `snapshot` (effective config as `.exs` — commit it to make
runtime mutations permanent). **Off by default; not even registered
without the flag.** The catalog deliberately EXCLUDES create/delete swarm,
add/remove agent/object, scale, `route_message` and `clear_overlay` —
that's operator-CLI territory, never a harness tool.

## Fleet config

`FLEET_MCP_CONFIG` points at a JSON file. Token fields are **env var
NAMES** (the ecosystem's x-secret contract) — secrets never live in the
file:

```json
{
  "enable_operate": false,
  "swarms": {
    "wingston": {
      "dashboard_url": "http://wingston-dashboard:4001",
      "dashboard_token_env": "WINGSTON_DASH_TOKEN",
      "engine_url": "http://wingston-engine:4000",
      "config_token_env": "WINGSTON_CONFIG_TOKEN"
    },
    "bitprime": {
      "dashboard_url": "http://192.168.1.100:4001",
      "dashboard_token_env": "BITPRIME_DASH_TOKEN"
    }
  }
}
```

## Claude Code wiring

```json
{
  "mcpServers": {
    "genswarms-fleet": {
      "command": "node",
      "args": ["/path/to/genswarms-fleet-mcp/dist/index.js"],
      "env": {
        "FLEET_MCP_CONFIG": "/path/to/fleet.json",
        "WINGSTON_DASH_TOKEN": "…",
        "WINGSTON_CONFIG_TOKEN": "…"
      }
    }
  }
}
```

Then: *"why is wingston slow?"* → `get_events(wingston, level=error)` →
*"bump the proxy budget"* → `patch_object_config(...)` → audited in the
overlay.

## Build & test

```bash
npm install
npm test    # builds + 4 e2e tests speaking REAL MCP stdio against a fake
            # fleet: tier gating, multi-swarm routing, per-tier token
            # pass-through, engine 422 relay, operate-flag registration
```

## Not a swarmidx package — on purpose

Per the gsp design admission criteria, swarmidx indexes what a swarm
references by content to constitute itself (bodies, policies, handlers,
swarms). This server is an **external client** — exactly the category the
criteria exclude — so it ships via GitHub releases, not the notary.

## Roadmap

- Streamable HTTP transport (claude.ai remote connectors) with its own
  bearer at the front door
- MCP resources for dashboards (subscribe to a swarm's live feed)
- Per-swarm tool visibility (today a tool registers fleet-wide and errors
  per-swarm when the tier is missing)
