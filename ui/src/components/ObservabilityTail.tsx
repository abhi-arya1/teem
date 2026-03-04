import { useMemo, useState } from "react";
import { useStore } from "../store";

export default function ObservabilityTail(): JSX.Element {
  const toolCalls = useStore((state) => state.toolCalls);
  const agents = useStore((state) => state.agents);
  const [agentFilter, setAgentFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    if (agentFilter === "all") {
      return toolCalls;
    }
    return toolCalls.filter((call) => call.agent === agentFilter);
  }, [toolCalls, agentFilter]);

  return (
    <aside className="observability">
      <div className="observability-head">
        <h3>Observability Tail</h3>
        <select value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}>
          <option value="all">All agents</option>
          {agents.map((agent) => (
            <option key={agent.name} value={agent.name}>
              {agent.display_name}
            </option>
          ))}
        </select>
      </div>

      <div className="tool-call-list">
        {filtered.map((call) => (
          <details key={call.id} className="tool-call-item">
            <summary>
              <span>{call.agent}</span>
              <code>{call.tool_name}</code>
              <span>{call.duration_ms}ms</span>
            </summary>
            <pre>{JSON.stringify({ input: call.input, output: call.output }, null, 2)}</pre>
          </details>
        ))}
      </div>
    </aside>
  );
}
