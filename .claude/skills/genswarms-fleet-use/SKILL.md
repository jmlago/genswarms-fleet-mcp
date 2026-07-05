---
name: genswarms-fleet-use
description: Observe, configure, debug and operate GenSwarms swarms through the genswarms-fleet MCP. Use when the user asks about a swarm's health ("why is X slow/silent/failing?"), wants to inspect agents or sessions, tune an object's config at runtime, or CONNECT A NEW SWARM to the fleet. Encodes the diagnosis playbook (dashboard → events → agent history → config), which token each tier needs, and the fleet.json hot-reload procedure.
---

# genswarms-fleet — using the fleet MCP

One MCP connector for the whole GenSwarms fleet. Every tool takes `swarm`
(the key in `fleet.json`). Tools appear in tiers depending on what each
swarm's fleet entry provides — if a call errors with "no engine_url"/"no
dashboard_url", the swarm's entry lacks that surface, it is not a bug.

## Tool map

| tier | tools | needs (fleet entry) | token |
|---|---|---|---|
| observe | `get_dashboard` `get_events` `get_session_history` `get_session_logs` `get_config` | `dashboard_url` | `dashboard_token_env` (optional on loopback) |
| configure | `patch_object_config` `get_overlay` | `engine_url` | `config_token_env` (narrow, config routes only) |
| agent debug | `list_agents` `get_agent_history` `get_agent_logs` | `engine_url` | `operate_token_env` (full engine token; still read-only) |
| operate | `send_task` `restart_agent` `list_objects` `snapshot` | `engine_url` + `enable_operate: true` | `operate_token_env` |

`get_config` responses are pre-redacted per each package's config_schema
(secrets structurally absent; `mutable: true` marks what you may patch).

## Diagnosis playbook

1. `get_dashboard(swarm)` — alive? agents idle/active? pool saturated?
   warnings?
2. `get_events(swarm, level: "error", minutes: 30)` — error bursts, budget
   blocks (`llm_proxy_global_block`), lifecycle anomalies.
3. Agent silent or wrong? `list_agents(swarm)` → `get_agent_history(swarm,
   agent)` (did the task arrive? did it answer?) → `get_agent_logs(swarm,
   agent)` (user/assistant/tool lines of its runtime session).
4. Tuning fix? `get_config(swarm)` to see what is `mutable: true`, then
   `patch_object_config(swarm, object, {key: value})` — the engine gates it
   server-side (only x-mutable keys; 422 lists `immutable_keys`), the object
   restarts with the merged config, and the change lands in `get_overlay`'s
   audit trail.
5. Make runtime mutations permanent: `snapshot(swarm)` renders the effective
   config as `.exs` — commit that to the swarm's repo.

Cross-check trick: `snapshot` (manager's view), `get_config` (schema view)
and `list_objects` (supervisor's view) must agree — a divergence between
them is an engine bug, not an illusion.

## Connecting a NEW swarm to the fleet

The fleet file (`FLEET_MCP_CONFIG`, usually
`~/.config/genswarms/fleet.json`) **hot-reloads on mtime** — editing it
needs NO server restart.

1. **What does the swarm expose?**
   - Dashboard read API (tier observe): the swarm must declare a
     genswarms-dashboard object. Loopback port → no token; exposed →
     `token:` set on the object, and you'll pass its env NAME.
   - Engine REST (configure/debug/operate): the engine BEAM must serve it
     (`genswarms.up`, or `Genswarms.Application.start_web_server(port: …)`
     in the host's boot script) with `GENSWARMS_API_TOKEN` /
     `GENSWARMS_CONFIG_API_TOKEN` set on the ENGINE side.
2. **Add the entry** to fleet.json — token fields are env var NAMES, never
   secret values:
   ```json
   "new-swarm": {
     "dashboard_url": "http://host:4001",
     "dashboard_token_env": "NEWSWARM_DASH_TOKEN",
     "engine_url": "http://host:4000",
     "config_token_env": "NEWSWARM_CONFIG_TOKEN",
     "operate_token_env": "NEWSWARM_OPERATE_TOKEN"
   }
   ```
   Omit surfaces the swarm doesn't expose — the entry then simply has fewer
   tiers.
3. **Token env values**: if the entry reuses env vars the MCP server process
   already has (or the endpoints are tokenless loopback), you are done. If
   it needs NEW env vars, add them to the server's `env` block (Claude
   Code: the `mcpServers.genswarms-fleet.env` map in `.claude.json`) and
   reconnect once (`/mcp`) — env is read at process start, only the fleet
   FILE hot-reloads.
4. **Verify**: `get_dashboard("new-swarm")`. Note the `swarm` parameter's
   description string still lists the startup-time swarm names — cosmetic;
   the call works for any swarm currently in the file.

## Cautions

- `enable_operate` is a deliberate file-level opt-in; do not flip it on to
  "make a tool appear" without the user asking for operate powers.
- `patch_object_config` restarts the object (state resets, topology kept).
  Patch maps replace the whole top-level key — send the full map, not a
  diff of a nested field.
- Never write secret VALUES into fleet.json or config patches; the
  ecosystem contract is env var names end-to-end.
