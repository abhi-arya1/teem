import { getChannelById } from "../shared/db";
import type { AgentConfig, Message } from "../shared/types";
import { AgentRegistry } from "./registry";

export function parseMentions(content: string): string[] {
  const matches = content.matchAll(/(^|\s)@([a-zA-Z0-9_-]+)/g);
  const set = new Set<string>();
  for (const match of matches) {
    if (match[2]) {
      set.add(match[2]);
    }
  }
  return Array.from(set);
}

function agentWatchesChannel(agent: AgentConfig, channelName: string): boolean {
  if (agent.channels === "any") {
    return true;
  }
  return agent.channels.includes(channelName);
}

export function routeMessage(
  msg: Message,
  registry: AgentRegistry,
  sendToAgent: (name: string, event: unknown) => void,
): void {
  const targets = new Set<string>();
  const mentions = msg.mentions.length ? msg.mentions : parseMentions(msg.content);
  let hasExplicitAgentMentions = false;

  for (const mention of mentions) {
    if (registry.get(mention)) {
      targets.add(mention);
      hasExplicitAgentMentions = true;
    }
  }

  const channel = getChannelById(msg.channel_id);
  if (channel) {
    if (channel.type === "dm" && channel.participants?.length) {
      for (const participant of channel.participants) {
        if (participant !== msg.from && registry.get(participant)) {
          targets.add(participant);
        }
      }
    }

    if ((channel.type === "public" || channel.type === "solo") && !hasExplicitAgentMentions) {
      for (const agent of registry.list()) {
        if (agent.name === msg.from) {
          continue;
        }
        if (agentWatchesChannel(agent, channel.name)) {
          targets.add(agent.name);
        }
      }
    }
  }

  for (const target of targets) {
    sendToAgent(target, { type: "message.new", payload: msg });
  }
}
