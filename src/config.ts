/**
 * Fleet registry. Loaded from the JSON file named by FLEET_MCP_CONFIG.
 *
 * Token posture (the ecosystem's x-secret contract): the config carries only
 * ENV VAR NAMES; values are resolved from the process env at call time and
 * never appear in the config file, tool results, or logs.
 *
 * Tiers per swarm are derived from what the spec provides:
 *   tier 1 (observe)   — dashboard_url            → dashboard read API
 *   tier 2 (configure) — engine_url               → schema-gated config PATCH + overlay
 *   tier 3 (operate)   — engine_url AND the fleet-level enable_operate flag
 *
 * enable_operate is a deliberate, file-level opt-in: tier-3 tools are not
 * even REGISTERED without it, so a harness connected to a default config
 * cannot discover them.
 */

import { readFileSync, statSync } from "node:fs";

export interface SwarmSpec {
  /** Swarm name on the remote wire (URL paths). Defaults to the fleet key.
   * Set it when two deployments of the SAME swarm (say local + prod, both
   * "wingston" on their engines) need distinct fleet keys. */
  name?: string;
  dashboard_url?: string;
  dashboard_token_env?: string;
  engine_url?: string;
  config_token_env?: string;
  operate_token_env?: string;
}

export interface Fleet {
  swarms: Record<string, SwarmSpec>;
  enable_operate?: boolean;
  max_result_chars?: number;
}

export function loadFleet(): Fleet {
  const path = process.env.FLEET_MCP_CONFIG;
  if (!path) {
    throw new Error(
      "FLEET_MCP_CONFIG is not set — point it at a fleet JSON file (see README)",
    );
  }
  const fleet = JSON.parse(readFileSync(path, "utf8")) as Fleet;
  if (!fleet.swarms || Object.keys(fleet.swarms).length === 0) {
    throw new Error("fleet config has no swarms");
  }
  return fleet;
}

// Hot-reload seam: per-CALL lookups re-read the file when its mtime moves, so
// a swarm added to the fleet is visible without restarting the server. Tool
// REGISTRATION (tier gating, enable_operate) deliberately stays startup-time:
// tier-3 tools must not appear because a file changed under a live session.
// A bad edit keeps the last good fleet (a running session never goes blind).
let cached: { fleet: Fleet; mtimeMs: number } | undefined;

export function currentFleet(): Fleet {
  const path = process.env.FLEET_MCP_CONFIG;
  if (!path) return loadFleet(); // unreachable in practice; keeps the error message
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (!cached || cached.mtimeMs !== mtimeMs) {
      cached = { fleet: loadFleet(), mtimeMs };
    }
  } catch (e) {
    if (!cached) throw e;
  }
  return cached.fleet;
}

export function swarmSpec(fleet: Fleet, swarm: string): SwarmSpec {
  const spec = fleet.swarms[swarm];
  if (!spec) {
    throw new Error(
      `unknown swarm '${swarm}' — configured: ${Object.keys(fleet.swarms).join(", ")}`,
    );
  }
  return spec;
}

/** Resolve an env-NAME ref to its value; undefined when unset. */
export function token(envName?: string): string | undefined {
  if (!envName) return undefined;
  const v = process.env[envName];
  return v && v !== "" ? v : undefined;
}

export function anySwarmHas(fleet: Fleet, key: keyof SwarmSpec): boolean {
  return Object.values(fleet.swarms).some((s) => Boolean(s[key]));
}
