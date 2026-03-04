import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { getWorkspaceConfig } from "./config";
import type { Approval, Channel, Message, Note, ToolCall, WorkspaceConfig } from "./types";

let dbInstance: Database | null = null;

function parseJson<T>(value: string | null): T {
  if (!value) {
    return [] as T;
  }
  return JSON.parse(value) as T;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function getDbPath(workspace = getWorkspaceConfig()): string {
  return process.env.DB_PATH || workspace.runtime.db_path;
}

function initializeSchema(db: Database, workspace: WorkspaceConfig): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      participants TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      "from" TEXT NOT NULL,
      content TEXT NOT NULL,
      mentions TEXT NOT NULL,
      thread_id TEXT,
      embeds TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author_agent TEXT NOT NULL,
      assigned_to TEXT,
      status TEXT NOT NULL,
      tags TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT,
      duration_ms INTEGER NOT NULL,
      step_type TEXT,
      token_usage TEXT,
      context_edits TEXT,
      approval_id TEXT,
      permission_id TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      session_id TEXT NOT NULL,
      permission_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      request_json TEXT NOT NULL,
      status TEXT NOT NULL,
      resolved_by TEXT,
      resolved_at TEXT,
      message_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      agent TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_meta (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const seeds = [
    { id: "ch_general", name: "general", type: "public" as const },
    { id: "ch_announcements", name: "announcements", type: "public" as const },
    {
      id: `ch_${workspace.defaults.approval_channel}`,
      name: workspace.defaults.approval_channel,
      type: "public" as const,
    },
  ];

  for (const channel of seeds) {
    upsertChannel(
      {
        ...channel,
        created_at: nowIso(),
      },
      db,
    );
  }

  upsertWorkspaceMeta(workspace, db);
}

export function getDb(workspace = getWorkspaceConfig()): Database {
  if (!dbInstance) {
    const filePath = getDbPath(workspace);
    const dir = dirname(filePath);
    if (dir && dir !== ".") {
      mkdirSync(dir, { recursive: true });
    }

    dbInstance = new Database(filePath, { create: true });
    initializeSchema(dbInstance, workspace);
  }
  return dbInstance;
}

export function upsertChannel(channel: Channel, db = getDb()): void {
  db.query(
    `
      INSERT INTO channels (id, name, type, participants, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        participants = excluded.participants
    `,
  ).run(
    channel.id,
    channel.name,
    channel.type,
    JSON.stringify(channel.participants ?? []),
    channel.created_at,
  );
}

export function getChannelById(channelId: string, db = getDb()): Channel | null {
  const row = db
    .query(`SELECT id, name, type, participants, created_at FROM channels WHERE id = ? LIMIT 1`)
    .get(channelId) as
    | {
        id: string;
        name: string;
        type: Channel["type"];
        participants: string | null;
        created_at: string;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    participants: parseJson<string[]>(row.participants),
    created_at: row.created_at,
  };
}

export function getChannelByName(name: string, db = getDb()): Channel | null {
  const row = db
    .query(`SELECT id, name, type, participants, created_at FROM channels WHERE name = ? LIMIT 1`)
    .get(name) as
    | {
        id: string;
        name: string;
        type: Channel["type"];
        participants: string | null;
        created_at: string;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    participants: parseJson<string[]>(row.participants),
    created_at: row.created_at,
  };
}

export function listChannels(db = getDb()): Channel[] {
  const rows = db
    .query(`SELECT id, name, type, participants, created_at FROM channels ORDER BY created_at ASC`)
    .all() as Array<{
    id: string;
    name: string;
    type: Channel["type"];
    participants: string | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    participants: parseJson<string[]>(row.participants),
    created_at: row.created_at,
  }));
}

export function insertMessage(message: Message, db = getDb()): void {
  db.query(
    `
      INSERT OR REPLACE INTO messages
      (id, channel_id, "from", content, mentions, thread_id, embeds, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    message.id,
    message.channel_id,
    message.from,
    message.content,
    JSON.stringify(message.mentions),
    message.thread_id,
    JSON.stringify(message.embeds ?? []),
    message.timestamp,
  );
}

export function getChannelMessages(channelId: string, limit = 100, db = getDb()): Message[] {
  const rows = db
    .query(
      `
        SELECT id, channel_id, "from", content, mentions, thread_id, embeds, timestamp
        FROM messages
        WHERE channel_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `,
    )
    .all(channelId, limit) as Array<{
    id: string;
    channel_id: string;
    from: string;
    content: string;
    mentions: string;
    thread_id: string | null;
    embeds: string | null;
    timestamp: string;
  }>;

  return rows
    .map((row) => ({
      id: row.id,
      channel_id: row.channel_id,
      from: row.from,
      content: row.content,
      mentions: parseJson<string[]>(row.mentions),
      thread_id: row.thread_id,
      embeds: parseJson<Message["embeds"]>(row.embeds),
      timestamp: row.timestamp,
    }))
    .reverse();
}

export function updateMessageEmbeds(messageId: string, embeds: Message["embeds"], db = getDb()): void {
  db.query(`UPDATE messages SET embeds = ? WHERE id = ?`).run(JSON.stringify(embeds ?? []), messageId);
}

export function getMessageById(messageId: string, db = getDb()): Message | null {
  const row = db
    .query(
      `
        SELECT id, channel_id, "from", content, mentions, thread_id, embeds, timestamp
        FROM messages
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(messageId) as
    | {
        id: string;
        channel_id: string;
        from: string;
        content: string;
        mentions: string;
        thread_id: string | null;
        embeds: string | null;
        timestamp: string;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    channel_id: row.channel_id,
    from: row.from,
    content: row.content,
    mentions: parseJson<string[]>(row.mentions),
    thread_id: row.thread_id,
    embeds: parseJson<Message["embeds"]>(row.embeds),
    timestamp: row.timestamp,
  };
}

export function insertNote(note: Note, db = getDb()): void {
  db.query(
    `
      INSERT OR REPLACE INTO notes
      (id, type, title, content, author_agent, assigned_to, status, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    note.id,
    note.type,
    note.title,
    note.content,
    note.author_agent,
    note.assigned_to,
    note.status,
    JSON.stringify(note.tags),
    note.created_at,
    note.updated_at,
  );
}

export function updateNote(
  id: string,
  patch: Partial<Pick<Note, "status" | "content" | "assigned_to" | "title">>,
  db = getDb(),
): Note | null {
  const existing = db
    .query(`SELECT * FROM notes WHERE id = ? LIMIT 1`)
    .get(id) as
    | {
        id: string;
        type: Note["type"];
        title: string;
        content: string;
        author_agent: string;
        assigned_to: string | null;
        status: Note["status"];
        tags: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!existing) {
    return null;
  }

  const updated: Note = {
    id: existing.id,
    type: existing.type,
    title: patch.title ?? existing.title,
    content: patch.content ?? existing.content,
    author_agent: existing.author_agent,
    assigned_to: patch.assigned_to ?? existing.assigned_to,
    status: patch.status ?? existing.status,
    tags: parseJson<string[]>(existing.tags),
    created_at: existing.created_at,
    updated_at: nowIso(),
  };

  insertNote(updated, db);
  return updated;
}

export function listNotes(
  filter: Partial<Pick<Note, "status" | "assigned_to" | "type">> = {},
  db = getDb(),
): Note[] {
  const clauses: string[] = [];
  const params: string[] = [];

  if (filter.status) {
    clauses.push(`status = ?`);
    params.push(filter.status);
  }
  if (filter.assigned_to) {
    clauses.push(`assigned_to = ?`);
    params.push(filter.assigned_to);
  }
  if (filter.type) {
    clauses.push(`type = ?`);
    params.push(filter.type);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.query(`SELECT * FROM notes ${where} ORDER BY updated_at DESC`).all(...params) as Array<{
    id: string;
    type: Note["type"];
    title: string;
    content: string;
    author_agent: string;
    assigned_to: string | null;
    status: Note["status"];
    tags: string;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    author_agent: row.author_agent,
    assigned_to: row.assigned_to,
    status: row.status,
    tags: parseJson<string[]>(row.tags),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export function insertToolCall(toolCall: ToolCall, db = getDb()): void {
  db.query(
    `
      INSERT OR REPLACE INTO tool_calls
      (id, agent, tool_name, input, output, duration_ms, step_type, token_usage, context_edits, approval_id, permission_id, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    toolCall.id,
    toolCall.agent,
    toolCall.tool_name,
    JSON.stringify(toolCall.input ?? {}),
    JSON.stringify(toolCall.output ?? null),
    toolCall.duration_ms,
    toolCall.step_type ?? null,
    JSON.stringify(toolCall.token_usage ?? null),
    JSON.stringify(toolCall.context_management_edits ?? null),
    toolCall.approval_id ?? null,
    toolCall.permission_id ?? null,
    toolCall.timestamp,
  );
}

export function listToolCalls(agent?: string, limit = 200, db = getDb()): ToolCall[] {
  let rows: Array<{
    id: string;
    agent: string;
    tool_name: string;
    input: string;
    output: string | null;
    duration_ms: number;
    step_type: string | null;
    token_usage: string | null;
    context_edits: string | null;
    approval_id: string | null;
    permission_id: string | null;
    timestamp: string;
  }>;

  if (agent) {
    rows = db
      .query(
        `
          SELECT * FROM tool_calls
          WHERE agent = ?
          ORDER BY timestamp DESC
          LIMIT ?
        `,
      )
      .all(agent, limit) as typeof rows;
  } else {
    rows = db
      .query(
        `
          SELECT * FROM tool_calls
          ORDER BY timestamp DESC
          LIMIT ?
        `,
      )
      .all(limit) as typeof rows;
  }

  return rows.map((row) => ({
    id: row.id,
    agent: row.agent,
    tool_name: row.tool_name,
    input: parseJson<Record<string, unknown>>(row.input),
    output: parseJson<unknown>(row.output),
    duration_ms: row.duration_ms,
    step_type: row.step_type ?? undefined,
    token_usage: row.token_usage ? parseJson<{ input: number; output: number }>(row.token_usage) : undefined,
    context_management_edits: row.context_edits ? parseJson<ToolCall["context_management_edits"]>(row.context_edits) : undefined,
    approval_id: row.approval_id ?? undefined,
    permission_id: row.permission_id ?? undefined,
    timestamp: row.timestamp,
  }));
}

export function insertApproval(approval: Approval, db = getDb()): void {
  db.query(
    `
      INSERT OR REPLACE INTO approvals
      (id, agent, session_id, permission_id, tool_name, risk_level, request_json, status, resolved_by, resolved_at, message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    approval.id,
    approval.agent,
    approval.session_id,
    approval.permission_id,
    approval.tool_name,
    approval.risk_level,
    JSON.stringify(approval.request_json),
    approval.status,
    approval.resolved_by,
    approval.resolved_at,
    approval.message_id,
    approval.created_at,
  );
}

export function updateApprovalStatus(
  id: string,
  patch: Pick<Approval, "status"> & { resolved_by?: string | null; message_id?: string | null },
  db = getDb(),
): Approval | null {
  const existing = db.query(`SELECT * FROM approvals WHERE id = ? LIMIT 1`).get(id) as
    | {
        id: string;
        agent: string;
        session_id: string;
        permission_id: string;
        tool_name: string;
        risk_level: Approval["risk_level"];
        request_json: string;
        status: Approval["status"];
        resolved_by: string | null;
        resolved_at: string | null;
        message_id: string | null;
        created_at: string;
      }
    | undefined;

  if (!existing) {
    return null;
  }

  const resolvedAt = patch.status === "pending" ? null : nowIso();
  const updated: Approval = {
    id: existing.id,
    agent: existing.agent,
    session_id: existing.session_id,
    permission_id: existing.permission_id,
    tool_name: existing.tool_name,
    risk_level: existing.risk_level,
    request_json: parseJson<Record<string, unknown>>(existing.request_json),
    status: patch.status,
    resolved_by: patch.resolved_by ?? existing.resolved_by,
    resolved_at: resolvedAt,
    message_id: patch.message_id ?? existing.message_id,
    created_at: existing.created_at,
  };

  insertApproval(updated, db);
  return updated;
}

export function getApprovalById(id: string, db = getDb()): Approval | null {
  const row = db.query(`SELECT * FROM approvals WHERE id = ? LIMIT 1`).get(id) as
    | {
        id: string;
        agent: string;
        session_id: string;
        permission_id: string;
        tool_name: string;
        risk_level: Approval["risk_level"];
        request_json: string;
        status: Approval["status"];
        resolved_by: string | null;
        resolved_at: string | null;
        message_id: string | null;
        created_at: string;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    agent: row.agent,
    session_id: row.session_id,
    permission_id: row.permission_id,
    tool_name: row.tool_name,
    risk_level: row.risk_level,
    request_json: parseJson<Record<string, unknown>>(row.request_json),
    status: row.status,
    resolved_by: row.resolved_by,
    resolved_at: row.resolved_at,
    message_id: row.message_id,
    created_at: row.created_at,
  };
}

export function listApprovals(status?: Approval["status"], limit = 200, db = getDb()): Approval[] {
  let rows: Array<{
    id: string;
    agent: string;
    session_id: string;
    permission_id: string;
    tool_name: string;
    risk_level: Approval["risk_level"];
    request_json: string;
    status: Approval["status"];
    resolved_by: string | null;
    resolved_at: string | null;
    message_id: string | null;
    created_at: string;
  }>;

  if (status) {
    rows = db
      .query(`SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
      .all(status, limit) as typeof rows;
  } else {
    rows = db.query(`SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?`).all(limit) as typeof rows;
  }

  return rows.map((row) => ({
    id: row.id,
    agent: row.agent,
    session_id: row.session_id,
    permission_id: row.permission_id,
    tool_name: row.tool_name,
    risk_level: row.risk_level,
    request_json: parseJson<Record<string, unknown>>(row.request_json),
    status: row.status,
    resolved_by: row.resolved_by,
    resolved_at: row.resolved_at,
    message_id: row.message_id,
    created_at: row.created_at,
  }));
}

export function upsertAgentSession(agent: string, sessionId: string, db = getDb()): void {
  const current = nowIso();
  db.query(
    `
      INSERT INTO agent_sessions (agent, session_id, created_at, last_used_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent) DO UPDATE SET
        session_id = excluded.session_id,
        last_used_at = excluded.last_used_at
    `,
  ).run(agent, sessionId, current, current);
}

export function getAgentSession(agent: string, db = getDb()): string | null {
  const row = db.query(`SELECT session_id FROM agent_sessions WHERE agent = ? LIMIT 1`).get(agent) as
    | { session_id: string }
    | undefined;
  return row?.session_id ?? null;
}

export function getAgentBySession(sessionId: string, db = getDb()): string | null {
  const row = db.query(`SELECT agent FROM agent_sessions WHERE session_id = ? LIMIT 1`).get(sessionId) as
    | { agent: string }
    | undefined;
  return row?.agent ?? null;
}

export function upsertWorkspaceMeta(workspace: WorkspaceConfig, db = getDb()): void {
  const id = "workspace_snapshot";
  db.query(
    `
      INSERT INTO workspace_meta (id, workspace_id, snapshot_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
    `,
  ).run(id, workspace.workspace.id, JSON.stringify(workspace), nowIso());
}

export function getWorkspaceMeta(db = getDb()): WorkspaceConfig | null {
  const row = db.query(`SELECT snapshot_json FROM workspace_meta WHERE id = 'workspace_snapshot' LIMIT 1`).get() as
    | { snapshot_json: string }
    | undefined;
  if (!row) {
    return null;
  }
  return parseJson<WorkspaceConfig>(row.snapshot_json);
}

if (import.meta.main) {
  getDb();
  const dbPath = getDbPath();
  // eslint-disable-next-line no-console
  console.log(`Initialized SQLite at ${join(process.cwd(), dbPath)}`);
}
