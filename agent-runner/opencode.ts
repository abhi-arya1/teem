import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import { getAgentBySession, getAgentSession, upsertAgentSession } from "../shared/db";
import { getWorkspaceConfig } from "../shared/config";
import type { AgentConfig, MCPAuth } from "../shared/types";

interface OpenCodeRuntime {
  client: any;
  server?: { url?: string; close?: () => void };
}

let runtime: OpenCodeRuntime | null = null;

function opencodeBaseUrl(): string {
  const workspace = getWorkspaceConfig();
  const host = process.env.OPENCODE_HOST || workspace.runtime.opencode_host;
  const port = Number(process.env.OPENCODE_PORT || workspace.runtime.opencode_port);
  return `http://${host}:${port}`;
}

function baseHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (password) {
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  return headers;
}

async function isOpenCodeHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${opencodeBaseUrl()}/global/health`, {
      headers: baseHeaders(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function modelId(agent: AgentConfig): string {
  return agent.model.replace(/^anthropic\//, "");
}

function authToConfig(auth: MCPAuth): Record<string, unknown> {
  switch (auth.type) {
    case "none":
      return {};
    case "bearer_env": {
      const token = process.env[auth.env];
      return token
        ? {
            headers: {
              [auth.header ?? "Authorization"]: auth.header ? token : `Bearer ${token}`,
            },
          }
        : {};
    }
    case "api_key_env": {
      const value = process.env[auth.env];
      if (!value) {
        return {};
      }
      if (auth.in === "header") {
        return { headers: { [auth.name]: value } };
      }
      return { query: { [auth.name]: value } };
    }
    case "basic_env": {
      const user = process.env[auth.username_env];
      const pass = process.env[auth.password_env];
      if (!user || !pass) {
        return {};
      }
      return {
        headers: {
          Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
        },
      };
    }
    case "header_env": {
      const value = process.env[auth.env];
      return value ? { headers: { [auth.header]: value } } : {};
    }
    case "oauth_ref":
      return { oauth: { connection: auth.connection } };
    default:
      return {};
  }
}

export async function initOpenCodeRuntime(): Promise<OpenCodeRuntime> {
  if (runtime) {
    return runtime;
  }

  const workspace = getWorkspaceConfig();
  const host = process.env.OPENCODE_HOST || workspace.runtime.opencode_host;
  const port = Number(process.env.OPENCODE_PORT || workspace.runtime.opencode_port);

  if (process.env.OPENCODE_ATTACH_ONLY === "1") {
    const client = createOpencodeClient({ baseUrl: opencodeBaseUrl() });
    if (!(await isOpenCodeHealthy())) {
      throw new Error(
        `OPENCODE_ATTACH_ONLY=1 but no healthy OpenCode server found at ${opencodeBaseUrl()}. Start it with 'opencode serve --hostname ${host} --port ${port}'.`,
      );
    }
    runtime = { client };
  } else if (await isOpenCodeHealthy()) {
    // If user already has opencode running (e.g. TUI), attach instead of spawning another instance.
    const client = createOpencodeClient({ baseUrl: opencodeBaseUrl() });
    runtime = { client };
  } else {
    try {
      const started = await createOpencode({
        hostname: host,
        port,
        timeout: 10000,
        config: {
          model: workspace.defaults.model,
        },
      });

      runtime = {
        client: started.client,
        server: started.server,
      };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[opencode] embedded server startup failed, trying attach-only mode: ${String(error)}`);

      const client = createOpencodeClient({ baseUrl: opencodeBaseUrl() });
      if (!(await isOpenCodeHealthy())) {
        throw new Error(
          `Failed to start or attach to OpenCode server. Start 'opencode serve --hostname ${host} --port ${port}' or set OPENCODE_ATTACH_ONLY=1 with a running server.`,
        );
      }
      runtime = { client };
    }
  }

  try {
    if (process.env.ANTHROPIC_API_KEY) {
      await runtime.client.auth.set({
        path: { id: "anthropic" },
        body: { type: "api", key: process.env.ANTHROPIC_API_KEY },
      });
    }
  } catch {
    // Keep runtime usable even if auth endpoint shape changes.
  }

  return runtime;
}

export async function ensureAgentSession(agent: AgentConfig): Promise<string> {
  const workspace = getWorkspaceConfig();
  const directory = workspace.project.root_dir;
  const active = getAgentSession(agent.name);
  const runtimeRef = await initOpenCodeRuntime();
  const client = runtimeRef.client;

  if (active) {
    try {
      await client.session.get({ path: { id: active }, query: { directory } });
      upsertAgentSession(agent.name, active);
      return active;
    } catch {
      // Fall through to re-create session.
    }
  }

  const existing = await client.session.list({ query: { directory } });
  const sessions = existing.data ?? existing;
  const found = Array.isArray(sessions)
    ? sessions.find((session: { id?: string; title?: string }) => session.title === `agent:${agent.name}`)
    : null;

  if (found?.id) {
    upsertAgentSession(agent.name, found.id);
    return found.id;
  }

  const created = await client.session.create({ body: { title: `agent:${agent.name}` }, query: { directory } });
  const createdSession = created.data ?? created;
  const sessionId = createdSession.id as string;
  if (!sessionId) {
    throw new Error(`Failed to create session for ${agent.name}`);
  }

  upsertAgentSession(agent.name, sessionId);
  return sessionId;
}

export async function registerAgentMcpServers(agent: AgentConfig): Promise<void> {
  const base = opencodeBaseUrl();

  for (const server of agent.mcp_servers) {
    const payload = {
      name: server.name,
      config: {
        transport: server.config.transport,
        url: server.config.url,
        ...authToConfig(server.config.auth),
      },
    };

    try {
      await fetch(`${base}/mcp`, {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify(payload),
      });
    } catch {
      // Keep startup resilient; MCP failures surface in OpenCode status APIs.
    }
  }
}

export async function sendPrompt(args: {
  agent: AgentConfig;
  sessionId: string;
  text: string;
  noReply?: boolean;
}): Promise<{ text: string; raw: unknown }> {
  const workspace = getWorkspaceConfig();
  const runtimeRef = await initOpenCodeRuntime();
  const response = await runtimeRef.client.session.prompt({
    path: { id: args.sessionId },
    query: { directory: workspace.project.root_dir },
    body: {
      model: {
        providerID: "anthropic",
        modelID: modelId(args.agent),
      },
      noReply: args.noReply ?? false,
      parts: [{ type: "text", text: args.text }],
    },
    throwOnError: true,
  });

  const result = response as {
    data?: { info?: Record<string, unknown>; parts?: Array<{ type?: string; text?: string; content?: string }> };
    error?: unknown;
    response?: { status?: number };
  };

  if (result.error) {
    const status = result.response?.status ?? "unknown";
    const detail =
      typeof result.error === "string"
        ? result.error
        : typeof result.error === "object"
          ? JSON.stringify(result.error)
          : String(result.error);
    throw new Error(`OpenCode session.prompt failed (${status}): ${detail}`);
  }

  const data = result.data ?? (response as typeof result.data);
  const parts = Array.isArray(data?.parts) ? data.parts : [];
  const text = parts
    .map((part: { type?: string; text?: string; content?: string }) => {
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      if (typeof part.content === "string") {
        return part.content;
      }
      return "";
    })
    .join("\n")
    .trim();

  const infoError = data?.info?.error;
  if (infoError && !text) {
    const detail = typeof infoError === "string" ? infoError : JSON.stringify(infoError);
    throw new Error(`OpenCode response contained model error: ${detail}`);
  }

  return { text, raw: data };
}

export async function listOpenCodeAgents(): Promise<string[]> {
  const runtimeRef = await initOpenCodeRuntime();
  try {
    const response = await runtimeRef.client.app.agents();
    const data = response.data ?? response;
    if (!Array.isArray(data)) {
      return [];
    }
    return data
      .map((agent) => (typeof agent?.id === "string" ? agent.id : typeof agent?.name === "string" ? agent.name : ""))
      .filter((x): x is string => x.length > 0);
  } catch {
    return [];
  }
}

export function maybeAgentForSession(sessionId: string): string | null {
  return getAgentBySession(sessionId);
}
