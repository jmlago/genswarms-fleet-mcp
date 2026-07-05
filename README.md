# genswarms-fleet-mcp

**MCP server over a fleet of GenSwarms swarms**: connect any MCP harness
(Claude Code, claude.ai, Cursor, ...) and observe, configure, debug and —
opt-in — operate your swarms. One connector, the whole fleet.

```
Claude Code / claude.ai / Cursor
        │ MCP (stdio)
        ▼
 genswarms-fleet-mcp  (thin adapter — holds NO authority)
        ├──▶ dashboard read API   (responses pre-redacted per config_schema)
        └──▶ engine REST API      (op gate + scoped tokens server-side)
```

This is the outbound twin of
[genswarms-mcp-gateway](https://github.com/jmlago/genswarms-mcp-gateway)
(which lets caged agents consume external MCP servers). Direction here:
the world consuming the swarms.

## Quickstart (Claude Code)

```bash
# 1. fleet config (token fields are env var NAMES, never secrets)
mkdir -p ~/.config/genswarms
curl -o ~/.config/genswarms/fleet.json \
  https://raw.githubusercontent.com/jmlago/genswarms-fleet-mcp/main/fleet.json.example
$EDITOR ~/.config/genswarms/fleet.json

# 2. register the server (npx builds it straight from GitHub via `prepare`)
claude mcp add genswarms-fleet --scope user \
  -e FLEET_MCP_CONFIG=$HOME/.config/genswarms/fleet.json \
  -e BITPRIME_DASH_TOKEN=... \
  -- npx -y github:jmlago/genswarms-fleet-mcp
```

Restart/`/mcp` once and ask: *"why is bitprime slow?"* →
`get_events(bitprime, level=error)` → *"which agent is stuck?"* →
`get_agent_history(...)` → *"bump the proxy budget"* →
`patch_object_config(...)` → audited in the overlay.

From a checkout instead: `npm install && npm test`, then point the harness
at `node /path/to/genswarms-fleet-mcp/dist/index.js` with the same env.

## Tools, in four tiers

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

**Tier 2.5 — agent debugging** (`engine_url`, full engine token):
`list_agents`, `get_agent_history`, `get_agent_logs`. The missing surface
when diagnosing WHY an agent misbehaves — dashboards show sessions, not
agent turns. Read-only, so not gated by `enable_operate`, but these engine
routes need the full token (the config-scoped one covers only config
routes).

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
file; values come from the MCP server process env:

```json
{
  "enable_operate": false,
  "swarms": {
    "wingston": {
      "dashboard_url": "http://wingston-dashboard:4001",
      "dashboard_token_env": "WINGSTON_DASH_TOKEN",
      "engine_url": "http://wingston-engine:4000",
      "config_token_env": "WINGSTON_CONFIG_TOKEN",
      "operate_token_env": "WINGSTON_OPERATE_TOKEN"
    },
    "bitprime": {
      "dashboard_url": "http://192.168.1.100:4001",
      "dashboard_token_env": "BITPRIME_DASH_TOKEN"
    }
  }
}
```

**Hot-reload**: per-call lookups re-read the file when its mtime changes —
adding a swarm to the fleet needs **no server restart**. (A broken edit
keeps the last good fleet; a live session never goes blind. Tool
REGISTRATION — tier gating, `enable_operate` — deliberately stays
startup-time, so tier-3 tools cannot appear because a file changed under a
live session.)

## Connecting a NEW swarm

On the swarm side you need up to two surfaces:

1. **Dashboard (tier 1)** — the swarm declares a
   [genswarms-dashboard](https://github.com/genlayerlabs/genswarms-dashboard)
   object (`gsp add swarmidx:genlayerlabs/genswarms-dashboard@… --as
   object:dashboard`). Loopback = no token; exposed = set a token and pass
   its env NAME as `dashboard_token_env`.
2. **Engine REST (tiers 2/2.5/3)** — the engine BEAM serves it
   (`Genswarms.Application.start_web_server(port: …)` or `genswarms.up`)
   with `GENSWARMS_API_TOKEN` (full) and `GENSWARMS_CONFIG_API_TOKEN`
   (config-scoped) set on the ENGINE side.

Then add the entry to `fleet.json` — live, thanks to hot-reload. If the
entry reuses already-exported token env vars (or the endpoints are
tokenless loopback), the new swarm is queryable immediately; if it needs
NEW env vars, add them to the server's `env` block and reconnect once.
Verify with `get_dashboard("<name>")`.

The bundled Claude Code skill walks an agent through exactly this — see
below.

## Claude Code skill

[`.claude/skills/genswarms-fleet-use/SKILL.md`](.claude/skills/genswarms-fleet-use/SKILL.md)
teaches a Claude Code session when and how to use the tools (diagnosis
playbook, tier map, and the connect-a-new-swarm procedure). Install it for
yourself with:

```bash
mkdir -p ~/.claude/skills/genswarms-fleet-use
cp .claude/skills/genswarms-fleet-use/SKILL.md ~/.claude/skills/genswarms-fleet-use/
```

## Build & test

```bash
npm install
npm test    # builds + 7 e2e tests speaking REAL MCP stdio against a fake
            # fleet: tier gating, multi-swarm routing, per-tier token
            # pass-through, engine 422 relay, operate-flag registration,
            # fleet.json hot-reload, agent-debug tier
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
