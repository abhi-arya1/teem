import type { Message } from "../shared/types";
import { AgentRegistry } from "./registry";

function nowIso(): string {
  return new Date().toISOString();
}

export function startScheduler(
  registry: AgentRegistry,
  sendToAgent: (name: string, event: { type: "message.new"; payload: Message }) => void,
): () => void {
  const lastTick = new Map<string, number>();

  const interval = setInterval(() => {
    const now = Date.now();
    for (const agent of registry.list()) {
      const last = lastTick.get(agent.name) ?? 0;
      if (now - last < agent.tick_interval_ms) {
        continue;
      }

      lastTick.set(agent.name, now);
      const tick: Message = {
        id: `tick_${agent.name}_${now}`,
        channel_id: "__tick__",
        from: "__scheduler__",
        content: "__tick__",
        mentions: [],
        thread_id: null,
        timestamp: nowIso(),
      };

      sendToAgent(agent.name, { type: "message.new", payload: tick });
    }
  }, 5000);

  return () => {
    clearInterval(interval);
  };
}
