// End-to-end over REAL MCP stdio: spawns dist/index.js, performs the
// initialize handshake, and drives tools/list + tools/call against the fake
// fleet — proving tier gating, multi-swarm routing, token pass-through and
// error relay.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { startFakeFleet } from "./fake-fleet.mjs";

const DASH = "dash-secret";
const CFG = "config-secret";
const OP = "operate-secret";

let fleet;

before(async () => {
  fleet = await startFakeFleet({ dashToken: DASH, configToken: CFG, operateToken: OP });
});

after(() => fleet.server.close());

function writeFleetConfig({ enableOperate }) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-mcp-"));
  const path = join(dir, "fleet.json");
  writeFileSync(
    path,
    JSON.stringify({
      enable_operate: enableOperate,
      swarms: {
        fix: {
          dashboard_url: `http://127.0.0.1:${fleet.port}`,
          dashboard_token_env: "T_DASH",
          engine_url: `http://127.0.0.1:${fleet.port}`,
          config_token_env: "T_CFG",
          operate_token_env: "T_OP",
        },
        // dashboard-only swarm: tiers 2/3 must error cleanly for it
        other: { dashboard_url: `http://127.0.0.1:${fleet.port}` },
      },
    }),
  );
  return path;
}

class McpChild {
  constructor(configPath) {
    this.child = spawn(process.execPath, ["dist/index.js"], {
      env: { ...process.env, FLEET_MCP_CONFIG: configPath, T_DASH: DASH, T_CFG: CFG, T_OP: OP },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.pending = new Map();
    this.nextId = 1;
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          waiter(msg);
        }
      } catch {
        /* ignore non-JSON */
      }
    });
  }

  rpc(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async start() {
    const init = await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    assert.equal(init.result.serverInfo.name, "genswarms-fleet-mcp");
    this.notify("notifications/initialized", {});
  }

  async toolNames() {
    const res = await this.rpc("tools/list", {});
    return res.result.tools.map((t) => t.name).sort();
  }

  async call(name, args) {
    const res = await this.rpc("tools/call", { name, arguments: args });
    const text = (res.result.content ?? []).map((c) => c.text).join("\n");
    return { isError: res.result.isError ?? false, text };
  }

  stop() {
    this.child.kill();
  }
}

test("tiers 1+2 registered, tier 3 absent when enable_operate=false", async () => {
  const mcp = new McpChild(writeFleetConfig({ enableOperate: false }));
  try {
    await mcp.start();
    const names = await mcp.toolNames();
    assert.deepEqual(names, [
      "get_config",
      "get_dashboard",
      "get_events",
      "get_overlay",
      "get_session_history",
      "get_session_logs",
      "patch_object_config",
    ]);
  } finally {
    mcp.stop();
  }
});

test("observe + configure flows: tokens routed per tier, gates relayed", async () => {
  const mcp = new McpChild(writeFleetConfig({ enableOperate: false }));
  try {
    await mcp.start();

    const dash = await mcp.call("get_dashboard", { swarm: "fix" });
    assert.equal(dash.isError, false);
    assert.match(dash.text, /"swarm": "fix"/);

    const events = await mcp.call("get_events", { swarm: "fix", level: "error", minutes: 30 });
    assert.match(events.text, /"level": "error"/);

    const config = await mcp.call("get_config", { swarm: "fix" });
    assert.match(config.text, /access_token_env/);

    // configure: mutable patch passes; the engine's 422 for immutable keys is relayed
    const ok = await mcp.call("patch_object_config", {
      swarm: "fix",
      object: "whatsapp",
      config: { templates: { x: "pt_PT" } },
    });
    assert.equal(ok.isError, false);
    assert.match(ok.text, /"status": "updated"/);

    const denied = await mcp.call("patch_object_config", {
      swarm: "fix",
      object: "whatsapp",
      config: { phone_id: "2" },
    });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /422[\s\S]*immutable_keys/);

    const overlay = await mcp.call("get_overlay", { swarm: "fix" });
    assert.match(overlay.text, /update_config/);

    // the fake saw the RIGHT bearer per surface (token routing)
    const dashCall = fleet.calls.find((c) => c.path.endsWith("/dashboard"));
    assert.equal(dashCall.auth, `Bearer ${DASH}`);
    const patchCall = fleet.calls.find((c) => c.method === "PATCH");
    assert.equal(patchCall.auth, `Bearer ${CFG}`);
  } finally {
    mcp.stop();
  }
});

test("multi-swarm: unknown swarm and missing-tier swarm error cleanly", async () => {
  const mcp = new McpChild(writeFleetConfig({ enableOperate: false }));
  try {
    await mcp.start();

    const unknown = await mcp.call("get_dashboard", { swarm: "nope" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /unknown swarm 'nope'/);

    const noEngine = await mcp.call("get_overlay", { swarm: "other" });
    assert.equal(noEngine.isError, true);
    assert.match(noEngine.text, /no engine_url/);
  } finally {
    mcp.stop();
  }
});

test("fleet.json hot-reload: a swarm added mid-session resolves without restart", async () => {
  const configPath = writeFleetConfig({ enableOperate: false });
  const mcp = new McpChild(configPath);
  try {
    await mcp.start();

    const before = await mcp.call("get_dashboard", { swarm: "late" });
    assert.equal(before.isError, true);
    assert.match(before.text, /unknown swarm 'late'/);

    // add "late" to the fleet file the server already loaded
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    cfg.swarms.late = {
      dashboard_url: `http://127.0.0.1:${fleet.port}`,
      dashboard_token_env: "T_DASH",
    };
    writeFileSync(configPath, JSON.stringify(cfg));
    // force a distinct mtime even on coarse-grained filesystems
    utimesSync(configPath, new Date(), new Date(Date.now() + 2000));

    // resolved and routed: the fake (which only serves "fix" paths) answers a
    // relayed HTTP 404 — anything but "unknown swarm" proves the reload
    const after = await mcp.call("get_dashboard", { swarm: "late" });
    assert.doesNotMatch(after.text, /unknown swarm/, `expected hot-reloaded swarm to route: ${after.text}`);
    assert.match(after.text, /404/);

    // a BROKEN edit must not blind the live session: last good fleet stays
    writeFileSync(configPath, "{ not json");
    utimesSync(configPath, new Date(), new Date(Date.now() + 4000));
    const resilient = await mcp.call("get_dashboard", { swarm: "late" });
    assert.doesNotMatch(resilient.text, /unknown swarm|JSON/);
  } finally {
    mcp.stop();
  }
});

test("tier 3: registered only with enable_operate, operate token routed", async () => {
  const mcp = new McpChild(writeFleetConfig({ enableOperate: true }));
  try {
    await mcp.start();
    const names = await mcp.toolNames();
    for (const t of ["send_task", "restart_agent", "snapshot", "list_objects"]) {
      assert.ok(names.includes(t), `${t} should be registered`);
    }
    // the dangerous control-plane tools are deliberately NOT in the catalog
    for (const t of ["create_swarm", "delete_swarm", "add_agent", "route_message", "clear_overlay"]) {
      assert.ok(!names.includes(t), `${t} must not exist`);
    }

    const sent = await mcp.call("send_task", { swarm: "fix", agent: "quoter", task: "ping" });
    assert.equal(sent.isError, false);
    assert.match(sent.text, /"status": "sent"/);

    const snap = await mcp.call("snapshot", { swarm: "fix" });
    assert.match(snap.text, /name: "fix"/);

    const taskCall = fleet.calls.find((c) => c.path.endsWith("/task"));
    assert.equal(taskCall.auth, `Bearer ${OP}`);
  } finally {
    mcp.stop();
  }
});
