import { BaseAgent } from "./base-agent";
import { ensureAgentSession, initOpenCodeRuntime, registerAgentMcpServers } from "./opencode";
import { getWorkspaceConfig, loadAgentConfigs, writeSupermemoryConfig } from "../shared/config";

async function main(): Promise<void> {
  const workspace = getWorkspaceConfig();
  const orchestratorBase =
    process.env.ORCHESTRATOR_WS_URL ||
    `ws://127.0.0.1:${process.env.ORCHESTRATOR_PORT || workspace.runtime.orchestrator_port}/ws`;

  writeSupermemoryConfig(workspace);
  await initOpenCodeRuntime();

  const agents = loadAgentConfigs();
  for (const agent of agents) {
    await registerAgentMcpServers(agent);
    const sessionId = await ensureAgentSession(agent);

    const runner = new BaseAgent(agent, workspace, sessionId, orchestratorBase);
    runner.start();
  }

  // eslint-disable-next-line no-console
  console.log(`Agent runner started with ${agents.length} agents`);
}

void main();
