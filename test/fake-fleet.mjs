// A fake fleet: one HTTP server emulating BOTH pinned surfaces (dashboard
// read API + engine config/operate API) with token enforcement, so the e2e
// test proves the MCP server routes, authenticates and relays errors
// correctly — no real swarm needed.

import { createServer } from "node:http";

export function startFakeFleet({ dashToken, configToken, operateToken }) {
  const calls = [];

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const auth = req.headers["authorization"] ?? null;
      const url = new URL(req.url, "http://x");
      calls.push({ method: req.method, path: url.pathname, auth, body });

      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      const p = url.pathname;

      // ── dashboard surface (bearer = consumer token) ────────────────────
      if (req.method === "GET" && p.startsWith("/api/swarms/fix/")) {
        // /overlay and /agents/* are ENGINE routes (their own tokens below) —
        // the single fake port serves both surfaces
        if (auth !== `Bearer ${dashToken}` && !p.includes("/overlay") && !p.includes("/agents")) {
          return send(401, { error: "unauthorized" });
        }
        if (p.endsWith("/dashboard")) {
          return send(200, { swarm: "fix", status: "running", summary: { agents: 1 }, warnings: [] });
        }
        if (p.endsWith("/events")) {
          return send(200, { events: [{ level: url.searchParams.get("level") ?? "info", message: "e1" }], swarm: "fix" });
        }
        if (p.includes("/sessions/") && p.endsWith("/history")) {
          return send(200, { session_id: "s1", turns: [], source: "store" });
        }
        if (p.includes("/sessions/") && p.endsWith("/logs")) {
          return send(200, { session_id: "s1", logs: [], source: "slot" });
        }
        if (p.endsWith("/config")) {
          return send(200, {
            swarm: "fix",
            objects: [{ name: "whatsapp", config: [{ key: "access_token_env", value: "WA_TOKEN", secret: true }] }],
          });
        }
      }

      // ── engine surface ─────────────────────────────────────────────────
      if (req.method === "PATCH" && p === "/api/swarms/fix/objects/whatsapp/config") {
        if (auth !== `Bearer ${configToken}`) return send(401, { error: "Invalid or missing API token" });
        const patch = JSON.parse(body).config ?? {};
        if ("phone_id" in patch) return send(422, { error: "immutable_keys: phone_id" });
        return send(200, { status: "updated", object: "whatsapp", keys: Object.keys(patch) });
      }
      if (req.method === "GET" && p === "/api/swarms/fix/overlay") {
        if (auth !== `Bearer ${configToken}`) return send(401, { error: "Invalid or missing API token" });
        return send(200, { swarm: "fix", events: [{ op: "update_config", payload: {} }] });
      }
      if (req.method === "GET" && p === "/api/swarms/fix/agents") {
        if (auth !== `Bearer ${operateToken}`) return send(401, { error: "Invalid or missing API token" });
        return send(200, { agents: [{ name: "quoter", state: "idle", backend: "bwrap" }] });
      }
      if (req.method === "GET" && p.startsWith("/api/swarms/fix/agents/") && p.endsWith("/history")) {
        if (auth !== `Bearer ${operateToken}`) return send(401, { error: "Invalid or missing API token" });
        return send(200, { history: [{ type: "incoming", from: "scope", content: "task" }] });
      }
      if (req.method === "GET" && p.startsWith("/api/swarms/fix/agents/") && p.endsWith("/logs")) {
        if (auth !== `Bearer ${operateToken}`) return send(401, { error: "Invalid or missing API token" });
        return send(200, { logs: [{ role: "user", content: "task" }] });
      }
      if (req.method === "POST" && p === "/api/swarms/fix/agents/quoter/task") {
        if (auth !== `Bearer ${operateToken}`) return send(401, { error: "Invalid or missing API token" });
        return send(200, { status: "sent", agent: "quoter" });
      }
      if (req.method === "POST" && p === "/api/swarms/fix/snapshot") {
        if (auth !== `Bearer ${operateToken}`) return send(401, { error: "Invalid or missing API token" });
        res.writeHead(200, { "content-type": "text/x-elixir" });
        return res.end('%{name: "fix", agents: []}');
      }

      send(404, { error: "not found" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, calls });
    });
  });
}
