export type Provider = "anthropic";

export type MCPAuth =
  | { type: "none" }
  | { type: "bearer_env"; env: string; header?: string }
  | { type: "api_key_env"; env: string; in: "header" | "query"; name: string }
  | { type: "basic_env"; username_env: string; password_env: string }
  | { type: "header_env"; header: string; env: string }
  | { type: "oauth_ref"; connection: string };

export interface MCPServerConfig {
  transport: "http" | "sse";
  url: string;
  auth: MCPAuth;
}

export interface AgentMCPServer {
  name: string;
  config: MCPServerConfig;
}

export interface AgentConfig {
  name: string;
  display_name: string;
  emoji: string;
  color: string;
  system_prompt: string;
  model: string;
  provider: Provider;
  tick_interval_ms: number;
  channels: "any" | string[];
  can_dm_agents: true | string[];
  mcp_servers: AgentMCPServer[];
}

export interface WorkspaceConfig {
  workspace: {
    id: string;
    name: string;
    description: string;
    timezone: string;
  };
  company: {
    name: string;
    description: string;
    mission?: string;
  };
  project: {
    name: string;
    description: string;
    root_dir: string;
    product_stage: string;
  };
  branding: {
    emoji: string;
    color: string;
  };
  runtime: {
    orchestrator_port: number;
    ui_port: number;
    db_path: string;
    opencode_host: string;
    opencode_port: number;
  };
  defaults: {
    model: string;
    tick_interval_ms: number;
    approval_channel: string;
    default_channel: string;
  };
  memory: {
    provider: "opencode-supermemory";
    similarity_threshold: number;
    max_memories: number;
    inject_profile: boolean;
    compaction_threshold: number;
    container_tag_prefix: string;
    user_container_tag: string | null;
    project_container_tag: string | null;
  };
}

export interface Channel {
  id: string;
  name: string;
  type: "public" | "dm" | "solo";
  participants?: string[];
  created_at: string;
}

export interface EmbedField {
  label: string;
  value: string;
}

export interface EmbedAction {
  action_id: string;
  label: string;
  style?: "primary" | "secondary" | "danger";
  callback_ref: string;
  disabled?: boolean;
}

export interface MessageEmbed {
  kind: "card";
  embed_id: string;
  card_kind: "approval" | "info" | "note";
  title: string;
  body_markdown: string;
  fields?: EmbedField[];
  status?: string;
  actions?: EmbedAction[];
}

export interface Message {
  id: string;
  channel_id: string;
  from: string;
  content: string;
  mentions: string[];
  thread_id: string | null;
  timestamp: string;
  embeds?: MessageEmbed[];
}

export interface Note {
  id: string;
  type: "todo" | "decision" | "history" | "scratch";
  title: string;
  content: string;
  author_agent: string;
  assigned_to: string | null;
  status: "open" | "done" | "archived";
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface ContextEdit {
  kind: string;
  details: string;
}

export interface ToolCall {
  id: string;
  agent: string;
  tool_name: string;
  input: Record<string, unknown>;
  output: unknown;
  duration_ms: number;
  timestamp: string;
  step_type?: string;
  token_usage?: { input: number; output: number };
  context_management_edits?: ContextEdit[];
  approval_id?: string;
  permission_id?: string;
}

export interface Approval {
  id: string;
  agent: string;
  session_id: string;
  permission_id: string;
  tool_name: string;
  risk_level: "low" | "medium" | "high";
  request_json: Record<string, unknown>;
  status: "pending" | "approved" | "denied" | "error";
  resolved_by: string | null;
  resolved_at: string | null;
  message_id: string | null;
  created_at: string;
}

export interface MessageActionPayload {
  channel_id: string;
  message_id: string;
  callback_ref: string;
  actor: string;
}

export interface TypingStatePayload {
  channel_id: string;
  actor: string;
  role: "user" | "agent";
  is_typing: boolean;
}

export type WSEvent =
  | {
      type: "init";
      payload: {
        channels: Channel[];
        agents: AgentConfig[];
        notes: Note[];
        workspace: WorkspaceConfig;
      };
    }
  | { type: "message.new"; payload: Message }
  | {
      type: "message.history";
      payload: { channel_id: string; messages: Message[] };
    }
  | { type: "message.action"; payload: MessageActionPayload }
  | { type: "typing.state"; payload: TypingStatePayload }
  | { type: "agent.typing"; payload: { agent: string; channel_id: string } }
  | { type: "agent.registered"; payload: { agent: AgentConfig } }
  | { type: "agent.unregistered"; payload: { agent: string } }
  | { type: "agent.status"; payload: { agent: string; status: "connected" | "disconnected" | "error" } }
  | { type: "channel.list"; payload: { channels: Channel[] } }
  | { type: "note.new"; payload: Note }
  | { type: "note.updated"; payload: Note }
  | { type: "notes.list"; payload: { notes: Note[] } }
  | { type: "tool.call"; payload: ToolCall }
  | {
      type: "approval.requested";
      payload: {
        id: string;
        session_id: string;
        permission_id: string;
        agent: string;
        tool_name: string;
        risk_level: "low" | "medium" | "high";
        request: Record<string, unknown>;
      };
    }
  | {
      type: "approval.resolved";
      payload: {
        id: string;
        status: "approved" | "denied" | "error";
        reason?: string;
      };
    };
