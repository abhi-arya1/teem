import type { WSEvent } from "../../shared/types";
import { bindSender, useStore } from "./store";

let socket: WebSocket | null = null;
let reconnectAttempt = 0;

function wsBaseUrl(): string {
  const configured = (import.meta.env.VITE_ORCHESTRATOR_WS_URL as string | undefined) || "";
  if (configured) {
    return configured;
  }

  const port = (import.meta.env.VITE_ORCHESTRATOR_PORT as string | undefined) || "3001";
  const host = window.location.hostname || "127.0.0.1";
  return `ws://${host}:${port}/ws`;
}

function send(event: WSEvent | { type: string; payload: unknown }): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(event));
}

function handleEvent(event: WSEvent): void {
  const state = useStore.getState();

  switch (event.type) {
    case "init":
      state.hydrateInit(event.payload);
      break;
    case "message.new":
      state.receiveMessage(event.payload);
      break;
    case "channel.list":
      state.setChannels(event.payload.channels);
      break;
    case "agent.registered": {
      const agents = [...state.agents.filter((agent) => agent.name !== event.payload.agent.name), event.payload.agent];
      state.setAgents(agents.sort((a, b) => a.name.localeCompare(b.name)));
      break;
    }
    case "agent.unregistered": {
      const agents = state.agents.filter((agent) => agent.name !== event.payload.agent);
      state.setAgents(agents);
      break;
    }
    case "agent.typing":
      state.receiveTyping(event.payload.agent, event.payload.channel_id);
      break;
    case "tool.call":
      state.receiveToolCall(event.payload);
      break;
    case "note.new":
    case "note.updated":
      state.upsertNote(event.payload);
      break;
    default:
      break;
  }
}

export function connectBrowserWs(): void {
  const url = `${wsBaseUrl()}?role=browser`;
  socket = new WebSocket(url);

  bindSender(send);

  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
  });

  socket.addEventListener("message", (event) => {
    try {
      const parsed = JSON.parse(String(event.data)) as WSEvent;
      handleEvent(parsed);
    } catch {
      // Ignore malformed events.
    }
  });

  socket.addEventListener("close", () => {
    reconnectAttempt += 1;
    const waitMs = Math.min(10000, 500 * 2 ** reconnectAttempt);
    window.setTimeout(() => connectBrowserWs(), waitMs);
  });
}

export async function fetchChannelHistory(channelId: string): Promise<void> {
  const orchestratorUrl =
    (import.meta.env.VITE_ORCHESTRATOR_HTTP_URL as string | undefined) ||
    `http://${window.location.hostname || "127.0.0.1"}:${(import.meta.env.VITE_ORCHESTRATOR_PORT as string | undefined) || "3001"}`;

  const response = await fetch(`${orchestratorUrl}/channels/${encodeURIComponent(channelId)}/messages?limit=100`);
  if (!response.ok) {
    return;
  }

  const payload = (await response.json()) as { channel_id: string; messages: unknown[] };
  useStore.getState().setChannelMessages(channelId, payload.messages as never);
}
