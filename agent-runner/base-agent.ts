import type { AgentConfig, Message, WorkspaceConfig, WSEvent } from "../shared/types";
import { sendPrompt } from "./opencode";

interface HistoryEntry {
  from: string;
  content: string;
  timestamp: string;
}

interface AgentAction {
  kind: "dm" | "channel";
  target: string;
  content: string;
}

interface PromptResult {
  parts?: Array<{ type?: string; text?: string; content?: string }>;
  info?: Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomMessageId(): string {
  return `msg_${crypto.randomUUID()}`;
}

function parseActions(text: string): { actions: AgentAction[]; remaining: string } {
  const actions: AgentAction[] = [];
  const remainingLines: string[] = [];

  for (const line of text.split("\n")) {
    const dm = line.match(/^\[DM:([a-zA-Z0-9_-]+)\]\s+(.+)$/);
    if (dm) {
      actions.push({ kind: "dm", target: dm[1], content: dm[2] });
      continue;
    }

    const channel = line.match(/^\[CHANNEL:([a-zA-Z0-9_-]+)\]\s+(.+)$/);
    if (channel) {
      actions.push({ kind: "channel", target: channel[1], content: channel[2] });
      continue;
    }

    remainingLines.push(line);
  }

  return {
    actions,
    remaining: remainingLines.join("\n").trim(),
  };
}

function dmChannelId(a: string, b: string): string {
  const [left, right] = [a, b].sort();
  return `ch_dm_${left}_${right}`;
}

async function postInternal(path: string, body: Record<string, unknown>): Promise<void> {
  const orchestratorPort = process.env.ORCHESTRATOR_PORT || "3001";
  const response = await fetch(`http://127.0.0.1:${orchestratorPort}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agentslack-internal-token": process.env.AGENTSLACK_INTERNAL_TOKEN || "agentslack-dev-token",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Internal API ${path} failed (${response.status}): ${message}`);
  }
}

export class BaseAgent {
  private ws: WebSocket | null = null;
  private readonly queue: Message[] = [];
  private processing = false;
  private readonly historyByChannel = new Map<string, HistoryEntry[]>();
  private readonly userTypingUntil = new Map<string, number>();
  private readonly lastSentByChannel = new Map<string, { text: string; at: number }>();
  private lastTickPostAt = 0;
  private knownAgents = new Set<string>();

  constructor(
    private readonly config: AgentConfig,
    private readonly workspace: WorkspaceConfig,
    private readonly sessionId: string,
    private readonly orchestratorWsUrl: string,
  ) {}

  start(): void {
    this.connect();
  }

  private connect(): void {
    const url = `${this.orchestratorWsUrl}?role=agent&agent=${encodeURIComponent(this.config.name)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.send({
        type: "agent.registered",
        payload: {
          agent: this.config,
        },
      });
    });

    ws.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as WSEvent;
        this.onEvent(parsed);
      } catch {
        // Ignore malformed events.
      }
    });

    ws.addEventListener("close", () => {
      setTimeout(() => this.connect(), 3000);
    });
  }

  private onEvent(event: WSEvent): void {
    if (event.type === "message.new") {
      if (event.payload.from === this.config.name) {
        return;
      }
      this.queue.push(event.payload);
      void this.drain();
      return;
    }

    if (event.type === "agent.registered") {
      this.knownAgents.add(event.payload.agent.name);
      return;
    }

    if (event.type === "agent.unregistered") {
      this.knownAgents.delete(event.payload.agent);
      return;
    }

    if (event.type === "typing.state") {
      if (event.payload.role !== "user") {
        return;
      }
      const key = event.payload.channel_id;
      if (event.payload.is_typing) {
        this.userTypingUntil.set(key, Date.now() + 1800);
      } else {
        this.userTypingUntil.set(key, Date.now());
      }
    }
  }

  private send(event: WSEvent | { type: string; payload: unknown }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify(event));
  }

  private async drain(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next) {
          try {
            await this.handleMessage(next);
          } catch (error) {
            this.handleAgentError(next, error);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private handleAgentError(message: Message, error: unknown): void {
    const raw = error instanceof Error ? error.message : String(error);
    const summary = raw.length > 240 ? `${raw.slice(0, 240)}...` : raw;
    // eslint-disable-next-line no-console
    console.error(`[agent:${this.config.name}] ${summary}`);

    if (message.channel_id === "__tick__") {
      return;
    }

    const outbound: Message = {
      id: randomMessageId(),
      channel_id: message.channel_id,
      from: this.config.name,
      content: `I hit an execution error while processing that request: ${summary}`,
      mentions: [message.from === "user" ? "user" : message.from],
      thread_id: null,
      timestamp: nowIso(),
    };

    this.send({
      type: "message.new",
      payload: outbound,
    });
  }

  private rememberHistory(channelId: string, message: Message): void {
    const arr = this.historyByChannel.get(channelId) ?? [];
    arr.push({
      from: message.from,
      content: message.content,
      timestamp: message.timestamp,
    });

    if (arr.length > 200) {
      arr.splice(0, arr.length - 200);
    }

    this.historyByChannel.set(channelId, arr);
  }

  private buildPrompt(message: Message, isTick: boolean): string {
    const channelHistory = this.historyByChannel.get(message.channel_id) ?? [];
    const historyTail = channelHistory.slice(-12);

    const knownAgents = Array.from(this.knownAgents).sort();
    if (!knownAgents.includes(this.config.name)) {
      knownAgents.push(this.config.name);
    }

    const channelsDescription =
      this.config.channels === "any"
        ? "You can discover and participate in any channel in this workspace."
        : `You are assigned to channels: ${this.config.channels.join(", ")}.`;

    const dmDescription =
      this.config.can_dm_agents === true
        ? "You can proactively DM any known agent."
        : this.config.can_dm_agents.length
          ? `You may DM only: ${this.config.can_dm_agents.join(", ")}.`
          : "Do not initiate DMs unless explicitly requested.";

    const actionProtocol = `
Action protocol (important):
- Use [DM:agent-name] message text to send a direct message.
- Use [CHANNEL:channel-name] message text to post to a channel.
- For non-tick messages, include normal response text for the current channel.
- For tick messages, only post to channels if absolutely necessary and prefix the text with [PROACTIVE].
`;

    return `
You are ${this.config.display_name} (${this.config.name}) ${this.config.emoji}.

Workspace:
- Name: ${this.workspace.workspace.name}
- Description: ${this.workspace.workspace.description}
- Company: ${this.workspace.company.name}
- Company context: ${this.workspace.company.description}
- Timezone: ${this.workspace.workspace.timezone}
- Current time: ${nowIso()}

Product scope:
- Product: ${this.workspace.project.name}
- Product description: ${this.workspace.project.description}
- Product stage: ${this.workspace.project.product_stage}
- Working root directory: ${this.workspace.project.root_dir}
- You only have project context within this root and should not assume context from outside it.

Role instructions:
${this.config.system_prompt}

Collaboration:
- Known agents: ${knownAgents.join(", ") || "none"}
- ${channelsDescription}
- ${dmDescription}
- Approvals are handled through #${this.workspace.defaults.approval_channel} by the user.
- Supermemory is available through the opencode-supermemory plugin and should be used for persistent context.
- You are expected to make practical product, engineering, and research decisions as conversation evolves.
- Team coordination rules:
  1) If a user explicitly mentions another agent, do not interject.
  2) Do not duplicate status updates already posted by another agent.
  3) Delegate via DM when another role is better suited.
  4) Never claim implementation is complete unless you actually executed tools and verified results.

${actionProtocol}

Recent channel context:
${historyTail.map((entry) => `[${entry.timestamp}] ${entry.from}: ${entry.content}`).join("\n") || "(none)"}

Incoming event:
- type: ${isTick ? "tick" : "message"}
- channel_id: ${message.channel_id}
- from: ${message.from}
- content: ${message.content}

Behavior:
- If this is a tick, decide if proactive action is needed.
- Prefer silence over low-value chatter.
- Keep responses concise, concrete, and collaborative.
`.trim();
  }

  private async executeActions(actions: AgentAction[]): Promise<void> {
    for (const action of actions) {
      if (action.kind === "dm") {
        const canDm = this.config.can_dm_agents === true || this.config.can_dm_agents.includes(action.target);
        if (!canDm) {
          continue;
        }

        await postInternal("/internal/tool/send-dm", {
          from: this.config.name,
          to: action.target,
          content: action.content,
        });
        continue;
      }

      if (action.kind === "channel") {
        const canPost = this.config.channels === "any" || this.config.channels.includes(action.target);
        if (!canPost) {
          continue;
        }

        await postInternal("/internal/tool/post-message", {
          from: this.config.name,
          channel: action.target,
          content: action.content,
        });
      }
    }
  }

  private async waitForUserTyping(channelId: string): Promise<void> {
    while (true) {
      const until = this.userTypingUntil.get(channelId) ?? 0;
      const remaining = until - Date.now();
      if (remaining <= 0) {
        return;
      }
      await Bun.sleep(Math.min(remaining, 300));
    }
  }

  private hasExecutionEvidence(raw: unknown): boolean {
    const data = raw as PromptResult | undefined;
    const parts = Array.isArray(data?.parts) ? data.parts : [];
    return parts.some((part) => {
      const type = part.type ?? "";
      return (
        type === "tool" ||
        type === "patch" ||
        type === "file" ||
        type === "command" ||
        type === "shell"
      );
    });
  }

  private enforceCompletionClaimPolicy(text: string, raw: unknown): string {
    const hasClaim = /\b(i've|i have|done|completed|implemented|set up|ready|confirmed)\b/i.test(text);
    if (!hasClaim) {
      return text;
    }
    if (this.hasExecutionEvidence(raw)) {
      return text;
    }
    return "I have not executed and verified those changes yet. I can do that next if you want me to proceed.";
  }

  private shouldSuppressDuplicate(channelId: string, text: string): boolean {
    const last = this.lastSentByChannel.get(channelId);
    if (!last) {
      return false;
    }
    const isSame = last.text.trim() === text.trim();
    const recent = Date.now() - last.at < 120000;
    return isSame && recent;
  }

  private markSent(channelId: string, text: string): void {
    this.lastSentByChannel.set(channelId, { text, at: Date.now() });
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.from === this.config.name) {
      return;
    }

    const isTick = message.channel_id === "__tick__";
    if (!isTick) {
      await this.waitForUserTyping(message.channel_id);
      this.send({
        type: "agent.typing",
        payload: {
          agent: this.config.name,
          channel_id: message.channel_id,
        },
      });
    }

    this.rememberHistory(message.channel_id, message);

    const prompt = this.buildPrompt(message, isTick);
    const result = await sendPrompt({
      agent: this.config,
      sessionId: this.sessionId,
      text: prompt,
    });

    if (!result.text) {
      return;
    }

    const { actions, remaining } = parseActions(result.text);
    if (actions.length) {
      await this.executeActions(actions);
    }

    if (!remaining) {
      return;
    }

    let finalText = this.enforceCompletionClaimPolicy(remaining, result.raw);

    const targetChannelId = isTick
      ? this.config.channels === "any"
        ? `ch_${this.workspace.defaults.default_channel}`
        : `ch_${this.config.channels[0] ?? this.workspace.defaults.default_channel}`
      : message.channel_id;

    if (isTick) {
      const proactivePrefix = "[PROACTIVE]";
      if (!finalText.startsWith(proactivePrefix)) {
        return;
      }
      finalText = finalText.slice(proactivePrefix.length).trim();
      if (!finalText) {
        return;
      }
      if (Date.now() - this.lastTickPostAt < 180000) {
        return;
      }
      this.lastTickPostAt = Date.now();
    }

    if (this.shouldSuppressDuplicate(targetChannelId, finalText)) {
      return;
    }

    const outbound: Message = {
      id: randomMessageId(),
      channel_id: targetChannelId,
      from: this.config.name,
      content: finalText,
      mentions: [],
      thread_id: null,
      timestamp: nowIso(),
    };

    this.rememberHistory(targetChannelId, outbound);
    this.markSent(targetChannelId, finalText);

    this.send({
      type: "message.new",
      payload: outbound,
    });
  }
}
