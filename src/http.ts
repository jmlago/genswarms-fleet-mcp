/** Thin HTTP helpers. The server is an ADAPTER: every authorization decision
 * (dashboard redaction, engine op gate, token scopes) is made server-side by
 * the APIs this talks to — an error body is relayed, never patched over. */

export interface HttpResult {
  ok: boolean;
  status: number;
  body: string;
}

export async function request(
  method: string,
  base: string,
  path: string,
  bearer?: string,
  json?: unknown,
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (bearer) headers["authorization"] = `Bearer ${bearer}`;
  if (json !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(new URL(path, base), {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  return { ok: res.ok, status: res.status, body: await res.text() };
}

/** Render an HTTP result as an MCP tool result: pretty JSON when possible,
 * truncated at the cap (harness context never blows up), isError on non-2xx. */
export function toToolResult(res: HttpResult, maxChars: number) {
  let text = res.body;
  try {
    text = JSON.stringify(JSON.parse(res.body), null, 2);
  } catch {
    // non-JSON bodies (e.g. snapshot .exs source) pass through as-is
  }

  let truncated = false;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
    truncated = true;
  }

  const prefix = res.ok ? "" : `HTTP ${res.status}\n`;
  return {
    content: [{ type: "text" as const, text: prefix + text + (truncated ? "" : "") }],
    isError: !res.ok,
  };
}

export function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
