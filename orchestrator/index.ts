import type { ServerWebSocket } from "bun";
import {
  getAgentBySession,
  getChannelById,
  getChannelByName,
  getChannelMessages,
  getDb,
  insertMessage,
  insertNote,
  insertToolCall,
  listApprovals,
  listChannels,
  listNotes,
  listToolCalls,
  updateNote,
  upsertChannel,
} from "../shared/db";
import { getWorkspaceConfig } from "../shared/config";
import type {
  AgentConfig,
  Message,
  Note,
  TypingStatePayload,
  ToolCall,
  WSEvent,
  WorkspaceConfig,
} from "../shared/types";
import { createApprovalMessage, handleMessageAction, classifyRisk } from "./approvals";
import { AgentRegistry } from "./registry";
import { parseMentions, routeMessage } from "./router";
import { startScheduler } from "./scheduler";

interface SocketData {
  role: "browser" | "agent";
  agentName?: string;
}

const workspace = getWorkspaceConfig();
getDb(workspace);

const registry = new AgentRegistry();
const browserSockets = new Set<ServerWebSocket<SocketData>>();
const agentSockets = new Map<string, ServerWebSocket<SocketData>>();

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-agentslack-internal-token",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function json(payload: unknown, status = 200, req?: Request): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...(req ? corsHeaders(req) : {}),
    },
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function send(ws: ServerWebSocket<SocketData>, event: unknown): void {
  ws.send(JSON.stringify(event));
}

export function broadcast(event: unknown): void {
  for (const ws of browserSockets) {
    send(ws, event);
  }
}

export function sendToAgent(name: string, event: unknown): void {
  const ws = agentSockets.get(name);
  if (!ws) {
    return;
  }
  send(ws, event);
}

function channelIdFromName(name: string): string {
  return `ch_${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function ensurePublicChannel(name: string): string {
  const existing = getChannelByName(name);
  if (existing) {
    return existing.id;
  }

  const id = channelIdFromName(name);
  upsertChannel({
    id,
    name,
    type: "public",
    participants: [],
    created_at: nowIso(),
  });
  return id;
}

function dmChannelId(a: string, b: string): string {
  const [left, right] = [a, b].sort();
  return `ch_dm_${left}_${right}`;
}

function ensureDmChannel(a: string, b: string): string {
  const id = dmChannelId(a, b);
  const existing = listChannels().find((ch) => ch.id === id);
  if (existing) {
    return id;
  }

  upsertChannel({
    id,
    name: `dm-${[a, b].sort().join("-")}`,
    type: "dm",
    participants: [a, b].sort(),
    created_at: nowIso(),
  });

  return id;
}

function enrichMessage(raw: Partial<Message> & { channel?: string }, fallbackFrom: string): Message {
  const content = raw.content ?? "";
  const channelFromName = raw.channel ? ensurePublicChannel(raw.channel) : undefined;
  return {
    id: raw.id ?? randomId("msg"),
    channel_id: raw.channel_id ?? channelFromName ?? channelIdFromName(workspace.defaults.default_channel),
    from: raw.from ?? fallbackFrom,
    content,
    mentions: raw.mentions?.length ? raw.mentions : parseMentions(content),
    thread_id: raw.thread_id ?? null,
    timestamp: raw.timestamp ?? nowIso(),
    embeds: raw.embeds ?? [],
  };
}

function persistAndBroadcastMessage(msg: Message): void {
  insertMessage(msg);
  broadcast({ type: "message.new", payload: msg });
}

function sendTypingStateToAgents(payload: TypingStatePayload): void {
  const channel = getChannelById(payload.channel_id);
  if (!channel) {
    return;
  }

  const targets = new Set<string>();
  if (channel.type === "dm" && channel.participants?.length) {
    for (const participant of channel.participants) {
      if (participant !== payload.actor && registry.get(participant)) {
        targets.add(participant);
      }
    }
  } else {
    for (const agent of registry.list()) {
      if (agent.name === payload.actor) {
        continue;
      }
      if (agent.channels === "any" || agent.channels.includes(channel.name)) {
        targets.add(agent.name);
      }
    }
  }

  for (const target of targets) {
    sendToAgent(target, { type: "typing.state", payload });
  }
}

function upsertAgentChannels(agent: AgentConfig): void {
  const soloChannel = {
    id: `ch_solo_${agent.name}`,
    name: `@${agent.name}`,
    type: "solo" as const,
    participants: [agent.name],
    created_at: nowIso(),
  };
  upsertChannel(soloChannel);

  if (agent.channels !== "any") {
    for (const channelName of agent.channels) {
      ensurePublicChannel(channelName);
    }
  }
}

function requireInternalToken(req: Request): boolean {
  const token = req.headers.get("x-agentslack-internal-token");
  const expected = process.env.AGENTSLACK_INTERNAL_TOKEN || "agentslack-dev-token";
  return token === expected;
}

function openCodeBaseUrl(workspaceConfig: WorkspaceConfig): string {
  const host = process.env.OPENCODE_HOST || workspaceConfig.runtime.opencode_host;
  const port = Number(process.env.OPENCODE_PORT || workspaceConfig.runtime.opencode_port);
  return `http://${host}:${port}`;
}

function openCodeHeaders(): HeadersInit {
  const headers: Record<string, string> = {};
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (password) {
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }
  return headers;
}

function pickString(obj: Record<string, unknown>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return fallback;
}

function pickNumber(obj: Record<string, unknown>, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return fallback;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function handleOpenCodeEvent(eventType: string, payload: Record<string, unknown>): void {
  const normalizedType = pickString(payload, ["type"], eventType) || eventType;
  const properties = toRecord(payload.properties ?? payload.payload ?? payload);

  if (normalizedType === "permission.asked") {
    const sessionId = pickString(properties, ["sessionID", "sessionId", "session_id"]);
    const permissionId = pickString(properties, ["permissionID", "permissionId", "permission_id", "id"]);
    const toolName = pickString(properties, ["tool", "toolName", "name"], "unknown");
    const agent = getAgentBySession(sessionId) ?? "unknown-agent";

    if (!sessionId || !permissionId) {
      return;
    }

    const approval = createApprovalMessage(
      {
        id: `apr_${permissionId}`,
        session_id: sessionId,
        permission_id: permissionId,
        agent,
        tool_name: toolName,
        risk_level: classifyRisk(toolName),
        request: properties,
      },
      broadcast,
    );

    broadcast({
      type: "approval.requested",
      payload: {
        id: approval.id,
        session_id: approval.session_id,
        permission_id: approval.permission_id,
        agent: approval.agent,
        tool_name: approval.tool_name,
        risk_level: approval.risk_level,
        request: approval.request_json,
      },
    });
    return;
  }

  if (normalizedType === "tool.execute.after") {
    const sessionId = pickString(properties, ["sessionID", "sessionId", "session_id"]);
    const agent = getAgentBySession(sessionId) ?? pickString(properties, ["agent"], "unknown-agent");
    const toolCall: ToolCall = {
      id: randomId("tc"),
      agent,
      tool_name: pickString(properties, ["tool", "toolName", "name"], "unknown_tool"),
      input: toRecord(properties.args ?? properties.input),
      output: properties.output ?? properties.result ?? null,
      duration_ms: pickNumber(properties, ["durationMs", "duration_ms"], 0),
      timestamp: nowIso(),
      step_type: "tool.execute.after",
    };

    insertToolCall(toolCall);
    broadcast({ type: "tool.call", payload: toolCall });
    return;
  }

  if (normalizedType === "session.compacted") {
    const sessionId = pickString(properties, ["sessionID", "sessionId", "session_id"]);
    const agent = getAgentBySession(sessionId) ?? "unknown-agent";
    const toolCall: ToolCall = {
      id: randomId("tc"),
      agent,
      tool_name: "context.compacted",
      input: { session_id: sessionId },
      output: properties,
      duration_ms: 0,
      timestamp: nowIso(),
      step_type: "session.compacted",
    };

    insertToolCall(toolCall);
    broadcast({ type: "tool.call", payload: toolCall });
  }
}

async function subscribeOpenCodeEvents(): Promise<void> {
  const base = openCodeBaseUrl(workspace);

  // Keep a persistent tail for observability and permission handling.
  while (true) {
    try {
      const response = await fetch(`${base}/event`, { headers: openCodeHeaders() });
      if (!response.ok || !response.body) {
        await Bun.sleep(2000);
        continue;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });

        while (true) {
          const marker = buffer.indexOf("\n\n");
          if (marker === -1) {
            break;
          }

          const block = buffer.slice(0, marker);
          buffer = buffer.slice(marker + 2);

          const lines = block.split("\n");
          let eventType = "message";
          const dataParts: string[] = [];

          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataParts.push(line.slice(5).trim());
            }
          }

          if (!dataParts.length) {
            continue;
          }

          const dataRaw = dataParts.join("\n");
          try {
            const parsed = JSON.parse(dataRaw) as Record<string, unknown>;
            handleOpenCodeEvent(eventType, parsed);
          } catch {
            // Ignore non-JSON payloads.
          }
        }
      }
    } catch {
      await Bun.sleep(2000);
    }
  }
}

const stopScheduler = startScheduler(registry, sendToAgent);
void stopScheduler;
void subscribeOpenCodeEvents();

const server = Bun.serve<SocketData>({
  port: Number(process.env.ORCHESTRATOR_PORT || workspace.runtime.orchestrator_port),
  fetch(req, wsServer) {
    const toJson = (payload: unknown, status = 200): Response => json(payload, status, req);
    const withCors = (response: Response): Response => {
      const headers = new Headers(response.headers);
      const cors = corsHeaders(req);
      for (const [key, value] of Object.entries(cors)) {
        headers.set(key, value);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const role = url.searchParams.get("role") === "agent" ? "agent" : "browser";
      const agentName = url.searchParams.get("agent") ?? undefined;

      if (
        wsServer.upgrade(req, {
          data: {
            role,
            agentName,
          },
        })
      ) {
        return;
      }

      return withCors(new Response("WebSocket upgrade failed", { status: 400 }));
    }

    if (url.pathname === "/health") {
      return toJson({ ok: true, service: "orchestrator" });
    }

    if (url.pathname.startsWith("/channels/") && url.pathname.endsWith("/messages")) {
      const parts = url.pathname.split("/");
      const channelId = parts[2] || "";
      const limit = Number(url.searchParams.get("limit") || 100);
      return toJson({ channel_id: channelId, messages: getChannelMessages(channelId, limit) });
    }

    if (url.pathname === "/notes") {
      return toJson({ notes: listNotes() });
    }

    if (url.pathname === "/tool-calls") {
      const agent = url.searchParams.get("agent") || undefined;
      const limit = Number(url.searchParams.get("limit") || 200);
      return toJson({ tool_calls: listToolCalls(agent, limit) });
    }

    if (url.pathname === "/approvals") {
      const status = url.searchParams.get("status") as "pending" | "approved" | "denied" | "error" | null;
      return toJson({ approvals: listApprovals(status ?? undefined, 200) });
    }

    if (url.pathname === "/internal/tool/post-message" && req.method === "POST") {
      if (!requireInternalToken(req)) {
        return toJson({ error: "unauthorized" }, 401);
      }

      return req
        .json()
        .then((body) => {
          const input = body as Partial<Message> & { channel?: string };
          const msg = enrichMessage(input, String(input.from ?? "agent"));
          persistAndBroadcastMessage(msg);
          routeMessage(msg, registry, sendToAgent);
          return toJson({ ok: true, message: msg });
        })
        .catch((error: unknown) => toJson({ error: String(error) }, 400));
    }

    if (url.pathname === "/internal/tool/send-dm" && req.method === "POST") {
      if (!requireInternalToken(req)) {
        return toJson({ error: "unauthorized" }, 401);
      }

      return req
        .json()
        .then((body) => {
          const input = toRecord(body);
          const from = pickString(input, ["from"], "agent");
          const to = pickString(input, ["to"]);
          const content = pickString(input, ["content"]);

          if (!to || !content) {
            return toJson({ error: "'to' and 'content' are required" }, 400);
          }

          const channelId = ensureDmChannel(from, to);
          const message = enrichMessage(
            {
              channel_id: channelId,
              from,
              content,
              mentions: [to],
            },
            from,
          );

          persistAndBroadcastMessage(message);
          routeMessage(message, registry, sendToAgent);
          return toJson({ ok: true, message });
        })
        .catch((error: unknown) => toJson({ error: String(error) }, 400));
    }

    if (url.pathname === "/internal/tool/write-note" && req.method === "POST") {
      if (!requireInternalToken(req)) {
        return toJson({ error: "unauthorized" }, 401);
      }

      return req
        .json()
        .then((body) => {
          const input = toRecord(body);
          const note: Note = {
            id: randomId("note"),
            type: pickString(input, ["type"], "scratch") as Note["type"],
            title: pickString(input, ["title"], "Untitled"),
            content: pickString(input, ["content"]),
            author_agent: pickString(input, ["author_agent", "author"], "agent"),
            assigned_to: pickString(input, ["assigned_to"], "") || null,
            status: "open",
            tags: Array.isArray(input.tags) ? (input.tags.filter((x) => typeof x === "string") as string[]) : [],
            created_at: nowIso(),
            updated_at: nowIso(),
          };

          insertNote(note);
          broadcast({ type: "note.new", payload: note });
          return toJson({ ok: true, note });
        })
        .catch((error: unknown) => toJson({ error: String(error) }, 400));
    }

    if (url.pathname === "/internal/tool/update-note" && req.method === "POST") {
      if (!requireInternalToken(req)) {
        return toJson({ error: "unauthorized" }, 401);
      }

      return req
        .json()
        .then((body) => {
          const input = toRecord(body);
          const id = pickString(input, ["id"]);
          if (!id) {
            return toJson({ error: "'id' is required" }, 400);
          }

          const statusValue = pickString(input, ["status"], "");
          const statusPatch: Note["status"] | undefined =
            statusValue === "open" || statusValue === "done" || statusValue === "archived"
              ? statusValue
              : undefined;

          const patch = {
            status: statusPatch,
            content: pickString(input, ["content"], "") || undefined,
            assigned_to: pickString(input, ["assigned_to"], "") || undefined,
            title: pickString(input, ["title"], "") || undefined,
          };

          const updated = updateNote(id, patch);
          if (!updated) {
            return toJson({ error: "note not found" }, 404);
          }

          broadcast({ type: "note.updated", payload: updated });
          return toJson({ ok: true, note: updated });
        })
        .catch((error: unknown) => toJson({ error: String(error) }, 400));
    }

    if (url.pathname === "/internal/tool/read-notes" && req.method === "GET") {
      if (!requireInternalToken(req)) {
        return toJson({ error: "unauthorized" }, 401);
      }

      const status = url.searchParams.get("status") || undefined;
      const assignedTo = url.searchParams.get("assigned_to") || undefined;
      return toJson({ notes: listNotes({ status: status as Note["status"] | undefined, assigned_to: assignedTo }) });
    }

    return withCors(new Response("Not Found", { status: 404 }));
  },
  websocket: {
    open(ws) {
      if (ws.data.role === "browser") {
        browserSockets.add(ws);
        send(ws, {
          type: "init",
          payload: {
            channels: listChannels(),
            agents: registry.list(),
            notes: listNotes(),
            workspace,
          },
        } satisfies WSEvent);
        return;
      }

      if (ws.data.role === "agent" && ws.data.agentName) {
        agentSockets.set(ws.data.agentName, ws);
        broadcast({
          type: "agent.status",
          payload: {
            agent: ws.data.agentName,
            status: "connected",
          },
        });
      }
    },
    close(ws) {
      if (ws.data.role === "browser") {
        browserSockets.delete(ws);
        return;
      }

      if (ws.data.role === "agent" && ws.data.agentName) {
        const agentName = ws.data.agentName;
        agentSockets.delete(agentName);
        registry.unregister(agentName);
        broadcast({ type: "agent.unregistered", payload: { agent: agentName } });
        broadcast({ type: "agent.status", payload: { agent: agentName, status: "disconnected" } });
      }
    },
    async message(ws, raw) {
      let event: WSEvent;
      try {
        event = JSON.parse(String(raw)) as WSEvent;
      } catch {
        return;
      }

      if (event.type === "message.action") {
        await handleMessageAction(event.payload, broadcast);
        return;
      }

      if (event.type === "typing.state") {
        broadcast(event);
        sendTypingStateToAgents(event.payload);
        return;
      }

      if (event.type === "agent.registered") {
        registry.register(event.payload.agent);
        upsertAgentChannels(event.payload.agent);
        broadcast(event);
        broadcast({ type: "channel.list", payload: { channels: listChannels() } });
        return;
      }

      if (event.type === "message.new") {
        const fallbackSender = ws.data.role === "agent" ? ws.data.agentName || "agent" : "user";
        const msg = enrichMessage(event.payload, fallbackSender);
        persistAndBroadcastMessage(msg);
        routeMessage(msg, registry, sendToAgent);
        return;
      }

      if (event.type === "agent.typing") {
        broadcast(event);
        return;
      }

      if (event.type === "tool.call") {
        insertToolCall(event.payload);
        broadcast(event);
        return;
      }

      if (event.type === "note.new") {
        insertNote(event.payload);
        broadcast(event);
        return;
      }

      if (event.type === "note.updated") {
        const updated = updateNote(event.payload.id, {
          title: event.payload.title,
          content: event.payload.content,
          status: event.payload.status,
          assigned_to: event.payload.assigned_to ?? undefined,
        });
        if (updated) {
          broadcast({ type: "note.updated", payload: updated });
        }
        return;
      }

      if (event.type === "approval.requested") {
        createApprovalMessage(event.payload, broadcast);
      }
    },
  },
});

// eslint-disable-next-line no-console
console.log(`AgentSlack orchestrator listening on http://127.0.0.1:${server.port}`);
