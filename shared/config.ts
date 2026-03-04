import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { AgentConfig, WorkspaceConfig } from "./types";

const mcpAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("bearer_env"),
    env: z.string().min(1),
    header: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("api_key_env"),
    env: z.string().min(1),
    in: z.enum(["header", "query"]),
    name: z.string().min(1),
  }),
  z.object({
    type: z.literal("basic_env"),
    username_env: z.string().min(1),
    password_env: z.string().min(1),
  }),
  z.object({
    type: z.literal("header_env"),
    header: z.string().min(1),
    env: z.string().min(1),
  }),
  z.object({
    type: z.literal("oauth_ref"),
    connection: z.string().min(1),
  }),
]);

const workspaceSchema = z.object({
  workspace: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    timezone: z.string().min(1),
  }),
  company: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    mission: z.string().optional(),
  }),
  project: z.object({
    name: z.string().min(1).default("Chat product"),
    description: z.string().min(1).default("A WhatsApp-like messaging app."),
    root_dir: z.string().min(1).default("project"),
    product_stage: z.string().min(1).default("prototype"),
  }),
  branding: z.object({
    emoji: z.string().min(1),
    color: z.string().regex(/^#(?:[0-9a-fA-F]{3}){1,2}$/),
  }),
  runtime: z.object({
    orchestrator_port: z.number().int().min(1).max(65535),
    ui_port: z.number().int().min(1).max(65535),
    db_path: z.string().min(1),
    opencode_host: z.string().min(1).default("127.0.0.1"),
    opencode_port: z.number().int().min(1).max(65535).default(4096),
  }),
  defaults: z.object({
    model: z.string().min(1),
    tick_interval_ms: z.number().int().positive(),
    approval_channel: z.string().min(1),
    default_channel: z.string().min(1).default("general"),
  }),
  memory: z.object({
    provider: z.literal("opencode-supermemory"),
    similarity_threshold: z.number().min(0).max(1),
    max_memories: z.number().int().positive(),
    inject_profile: z.boolean(),
    compaction_threshold: z.number().min(0).max(1),
    container_tag_prefix: z.string().min(1),
    user_container_tag: z.string().nullable(),
    project_container_tag: z.string().nullable(),
  }),
});

const agentSchema = z
  .object({
    name: z.string().min(1),
    display_name: z.string().min(1),
    emoji: z.string().min(1),
    color: z.string().regex(/^#(?:[0-9a-fA-F]{3}){1,2}$/),
    system_prompt: z.string().min(1),
    provider: z.literal("anthropic").default("anthropic"),
    model: z.string().min(1),
    tick_interval_ms: z.number().int().positive().optional(),
    channels: z.union([z.literal("any"), z.array(z.string().min(1))]).optional(),
    can_dm_agents: z.union([z.literal(true), z.array(z.string().min(1))]).optional(),
    mcp_servers: z
      .array(
        z.object({
          name: z.string().min(1),
          config: z.object({
            transport: z.enum(["http", "sse"]).default("http"),
            url: z.string().url(),
            auth: mcpAuthSchema.default({ type: "none" }),
          }),
        }),
      )
      .default([]),
  })
  .transform((cfg) => ({
    ...cfg,
    model: normalizeAnthropicModel(cfg.model),
  }));

let workspaceCache: WorkspaceConfig | null = null;

export function normalizeAnthropicModel(input: string): string {
  if (input.startsWith("anthropic/")) {
    return input;
  }
  if (input.startsWith("claude-")) {
    return `anthropic/${input}`;
  }
  throw new Error(`Model must use anthropic namespace. Received: ${input}`);
}

export function loadWorkspaceConfig(configPath = join(process.cwd(), "config", "workspace.yaml")): WorkspaceConfig {
  const raw = readFileSync(configPath, "utf8");
  const parsed = YAML.parse(raw);
  const validated = workspaceSchema.parse(parsed);
  validated.defaults.model = normalizeAnthropicModel(validated.defaults.model);
  return validated as WorkspaceConfig;
}

export function getWorkspaceConfig(): WorkspaceConfig {
  if (!workspaceCache) {
    workspaceCache = loadWorkspaceConfig();
  }
  return workspaceCache;
}

export function loadAgentConfigs(
  directory = join(process.cwd(), "agents"),
  workspace = getWorkspaceConfig(),
): AgentConfig[] {
  const files = readdirSync(directory)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  return files.map((file) => {
    const fullPath = join(directory, file);
    const raw = readFileSync(fullPath, "utf8");
    const parsed = YAML.parse(raw);
    const validated = agentSchema.parse(parsed);

    return {
      ...validated,
      tick_interval_ms: validated.tick_interval_ms ?? workspace.defaults.tick_interval_ms,
      channels: validated.channels ?? [workspace.defaults.default_channel],
      can_dm_agents: validated.can_dm_agents ?? [],
    } as AgentConfig;
  });
}

export function writeSupermemoryConfig(workspace = getWorkspaceConfig()): string {
  const target = join(process.cwd(), ".opencode", "supermemory.jsonc");
  mkdirSync(join(process.cwd(), ".opencode"), { recursive: true });

  const content = JSON.stringify(
    {
      similarityThreshold: workspace.memory.similarity_threshold,
      maxMemories: workspace.memory.max_memories,
      injectProfile: workspace.memory.inject_profile,
      compactionThreshold: workspace.memory.compaction_threshold,
      containerTagPrefix: workspace.memory.container_tag_prefix,
      userContainerTag: workspace.memory.user_container_tag,
      projectContainerTag: workspace.memory.project_container_tag,
    },
    null,
    2,
  );

  writeFileSync(target, `${content}\n`, "utf8");
  return target;
}
