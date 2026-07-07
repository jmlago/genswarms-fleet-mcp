#!/usr/bin/env node
/**
 * genswarms-fleet-mcp — MCP server over a fleet of GenSwarms swarms.
 *
 * A THIN ADAPTER over two pinned HTTP surfaces; it holds no authority:
 *
 *   tier 1 (observe)   → dashboard read API — responses arrive ALREADY
 *                        redacted against each package's config_schema
 *   tier 2 (configure) → engine config surface — the engine's op gate
 *                        (x-mutable only, host-escape keys rejected) is the
 *                        authority; changes land in the overlay audit trail.
 *                        Works with the narrow GENSWARMS_CONFIG_API_TOKEN.
 *   tier 3 (operate)   → send_task / restart_agent / snapshot / list_objects.
 *                        OPT-IN via enable_operate in the fleet file; not
 *                        even registered otherwise. The catalog deliberately
 *                        EXCLUDES create/delete swarm, add/remove agent or
 *                        object, scale, route_message and clear_overlay —
 *                        that is operator-CLI territory.
 *
 * Multi-swarm: every tool takes `swarm`; one connector sees the fleet.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { anySwarmHas, currentFleet, loadFleet, swarmSpec, token, type SwarmSpec } from "./config.js";
import { errorResult, request, toToolResult } from "./http.js";

const fleet = loadFleet();
const MAX_CHARS = fleet.max_result_chars ?? 20_000;

const server = new McpServer({ name: "genswarms-fleet-mcp", version: "0.1.0" });

const swarmParam = z
  .string()
  .describe(`Swarm name. Configured: ${Object.keys(fleet.swarms).join(", ")}`);

// ── plumbing ─────────────────────────────────────────────────────────────────

/** Fleet keys are the LOCAL identity; spec.name (when set) is what the remote
 * host calls the swarm. Every tool builds paths with the fleet key, so the
 * rewrite lives here, once. The trailing slash keeps 'wingston' from matching
 * inside 'wingston-prod'. */
function wirePath(spec: SwarmSpec, swarm: string, path: string): string {
  if (!spec.name) return path;
  return path.replace(`/api/swarms/${swarm}/`, `/api/swarms/${spec.name}/`);
}

async function dashboard(swarm: string, path: string, query?: Record<string, string>) {
  const spec = swarmSpec(currentFleet(), swarm);
  if (!spec.dashboard_url) return errorResult(`swarm '${swarm}' has no dashboard_url (tier 1 unavailable)`);
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const res = await request("GET", spec.dashboard_url, wirePath(spec, swarm, path) + qs, token(spec.dashboard_token_env));
  return toToolResult(res, MAX_CHARS);
}

async function engine(
  swarm: string,
  method: string,
  path: string,
  tokenEnv: "config_token_env" | "operate_token_env",
  json?: unknown,
) {
  const spec = swarmSpec(currentFleet(), swarm);
  if (!spec.engine_url) return errorResult(`swarm '${swarm}' has no engine_url (tiers 2/3 unavailable)`);
  const res = await request(method, spec.engine_url, wirePath(spec, swarm, path), token(spec[tokenEnv]), json);
  return toToolResult(res, MAX_CHARS);
}

function guarded<A extends unknown[]>(fn: (...args: A) => Promise<any>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  };
}

// ── tier 1: observe (dashboard read API) ─────────────────────────────────────

if (anySwarmHas(fleet, "dashboard_url")) {
  server.tool(
    "get_dashboard",
    "Live snapshot of a swarm: status, agents/objects summary, pool, sessions, warnings, topology edges.",
    { swarm: swarmParam },
    guarded(async ({ swarm }) => dashboard(swarm, `/api/swarms/${swarm}/dashboard`)),
  );

  server.tool(
    "get_events",
    "Structured engine events (lifecycle, errors). Filter by level/category/agent/minutes.",
    {
      swarm: swarmParam,
      level: z.string().optional().describe("debug|info|warning|error"),
      category: z.string().optional(),
      agent: z.string().optional(),
      minutes: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
    guarded(async ({ swarm, ...filters }) => {
      const query: Record<string, string> = {};
      for (const [k, v] of Object.entries(filters)) if (v !== undefined) query[k] = String(v);
      return dashboard(swarm, `/api/swarms/${swarm}/events`, query);
    }),
  );

  server.tool(
    "get_session_history",
    "A session's durable transcript (what the user and agent said).",
    {
      swarm: swarmParam,
      session_id: z.string(),
      max_turns: z.number().int().positive().max(200).optional(),
    },
    guarded(async ({ swarm, session_id, max_turns }) =>
      dashboard(
        swarm,
        `/api/swarms/${swarm}/sessions/${encodeURIComponent(session_id)}/history`,
        max_turns ? { max_turns: String(max_turns) } : undefined,
      ),
    ),
  );

  server.tool(
    "get_session_logs",
    "Raw agent-slot logs for a LIVE session (ephemeral; wiped on slot recycle).",
    { swarm: swarmParam, session_id: z.string() },
    guarded(async ({ swarm, session_id }) =>
      dashboard(swarm, `/api/swarms/${swarm}/sessions/${encodeURIComponent(session_id)}/logs`),
    ),
  );

  server.tool(
    "get_config",
    "Effective object config (seed ⊕ overlay), redacted per each package's config_schema — secrets never appear; x-mutable fields are flagged.",
    { swarm: swarmParam },
    guarded(async ({ swarm }) => dashboard(swarm, `/api/swarms/${swarm}/config`)),
  );
}

// ── tier 2: configure (engine config surface, narrow token) ─────────────────

if (anySwarmHas(fleet, "engine_url")) {
  server.tool(
    "patch_object_config",
    "Hot-edit an object's config. Schema-gated SERVER-SIDE: only keys the package marked x-mutable are accepted (422 otherwise); the object restarts with the merged config, topology intact, and the change lands in the overlay audit trail. Works with the config-scoped engine token.",
    {
      swarm: swarmParam,
      object: z.string().describe("Object name, e.g. whatsapp, mailbox, cron"),
      config: z
        .record(z.unknown())
        .describe("Partial config patch — check get_config for which fields are mutable"),
    },
    guarded(async ({ swarm, object, config }) =>
      engine(
        swarm,
        "PATCH",
        `/api/swarms/${swarm}/objects/${encodeURIComponent(object)}/config`,
        "config_token_env",
        { config },
      ),
    ),
  );

  server.tool(
    "get_overlay",
    "The swarm's mutation audit trail: every runtime change (config patches, topology edits) as ordered events.",
    { swarm: swarmParam },
    guarded(async ({ swarm }) =>
      engine(swarm, "GET", `/api/swarms/${swarm}/overlay`, "config_token_env"),
    ),
  );

  // ── tier 2.5: agent debugging (engine read API; needs the full engine token,
  // not the config-scoped one — read-only, so not gated by enable_operate).
  // The missing surface when diagnosing WHY an agent misbehaves: what tasks it
  // received, what it answered, and its conversation log — dashboards only
  // show sessions, not agent turns.

  server.tool(
    "list_agents",
    "Agents of a swarm with live state (engine view): backend, state, inbox size, last activity.",
    { swarm: swarmParam },
    guarded(async ({ swarm }) =>
      engine(swarm, "GET", `/api/swarms/${swarm}/agents`, "operate_token_env"),
    ),
  );

  server.tool(
    "get_agent_history",
    "An agent's message history (incoming tasks/asks and outgoing turns) — the first stop when an agent is silent or wrong.",
    {
      swarm: swarmParam,
      agent: z.string().describe("Agent name, e.g. diagnostico"),
      limit: z.number().int().positive().max(500).optional(),
    },
    guarded(async ({ swarm, agent, limit }) =>
      engine(
        swarm,
        "GET",
        `/api/swarms/${swarm}/agents/${encodeURIComponent(agent)}/history${limit ? `?limit=${limit}` : ""}`,
        "operate_token_env",
      ),
    ),
  );

  server.tool(
    "get_agent_logs",
    "An agent's conversation log (user/assistant/tool lines from its runtime session).",
    { swarm: swarmParam, agent: z.string().describe("Agent name") },
    guarded(async ({ swarm, agent }) =>
      engine(
        swarm,
        "GET",
        `/api/swarms/${swarm}/agents/${encodeURIComponent(agent)}/logs`,
        "operate_token_env",
      ),
    ),
  );
}

// ── tier 3: operate (opt-in; full engine token) ──────────────────────────────

if (fleet.enable_operate && anySwarmHas(fleet, "engine_url")) {
  server.tool(
    "send_task",
    "Send a task to an agent (the test/probe surface). The agent processes it like any routed message; read the outcome via get_events / get_session_logs.",
    { swarm: swarmParam, agent: z.string(), task: z.string() },
    guarded(async ({ swarm, agent, task }) =>
      engine(
        swarm,
        "POST",
        `/api/swarms/${swarm}/agents/${encodeURIComponent(agent)}/task`,
        "operate_token_env",
        { task },
      ),
    ),
  );

  server.tool(
    "restart_agent",
    "Restart one agent (its in-flight work is lost; the swarm keeps running).",
    { swarm: swarmParam, agent: z.string() },
    guarded(async ({ swarm, agent }) =>
      engine(
        swarm,
        "POST",
        `/api/swarms/${swarm}/agents/${encodeURIComponent(agent)}/restart`,
        "operate_token_env",
      ),
    ),
  );

  server.tool(
    "list_objects",
    "Objects with their lifecycle state (engine view).",
    { swarm: swarmParam },
    guarded(async ({ swarm }) =>
      engine(swarm, "GET", `/api/swarms/${swarm}/objects`, "operate_token_env"),
    ),
  );

  server.tool(
    "snapshot",
    "The swarm's effective config (seed ⊕ overlay) rendered as Elixir source — commit this to make runtime mutations permanent.",
    { swarm: swarmParam },
    guarded(async ({ swarm }) =>
      engine(swarm, "POST", `/api/swarms/${swarm}/snapshot`, "operate_token_env"),
    ),
  );
}

// ── go ───────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
