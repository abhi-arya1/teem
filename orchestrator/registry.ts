import type { AgentConfig } from "../shared/types";

export class AgentRegistry {
  private readonly byName = new Map<string, AgentConfig>();

  register(agent: AgentConfig): void {
    this.byName.set(agent.name, agent);
  }

  unregister(agentName: string): void {
    this.byName.delete(agentName);
  }

  get(agentName: string): AgentConfig | undefined {
    return this.byName.get(agentName);
  }

  list(): AgentConfig[] {
    return Array.from(this.byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  names(): string[] {
    return this.list().map((a) => a.name);
  }
}
