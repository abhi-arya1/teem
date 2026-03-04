import {
  getApprovalById,
  getChannelByName,
  getMessageById,
  insertApproval,
  insertMessage,
  updateApprovalStatus,
  updateMessageEmbeds,
  upsertChannel,
} from "../shared/db";
import { getWorkspaceConfig } from "../shared/config";
import type { Approval, Message, MessageActionPayload, MessageEmbed } from "../shared/types";

function nowIso(): string {
  return new Date().toISOString();
}

function opencodeBaseUrl(): string {
  const workspace = getWorkspaceConfig();
  const host = process.env.OPENCODE_HOST || workspace.runtime.opencode_host;
  const port = Number(process.env.OPENCODE_PORT || workspace.runtime.opencode_port);
  return `http://${host}:${port}`;
}

function opencodeHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (password) {
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  return headers;
}

async function resolveOpenCodePermission(
  approval: Approval,
  decision: "approved" | "denied",
): Promise<{ ok: boolean; reason?: string }> {
  const responseValue = decision === "approved" ? "allow" : "deny";

  const response = await fetch(
    `${opencodeBaseUrl()}/session/${encodeURIComponent(approval.session_id)}/permissions/${encodeURIComponent(approval.permission_id)}`,
    {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify({ response: responseValue, remember: false }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    return {
      ok: false,
      reason: `OpenCode permission response failed (${response.status}): ${body}`,
    };
  }

  return { ok: true };
}

function ensureApprovalChannelId(): string {
  const workspace = getWorkspaceConfig();
  const approvalChannelName = workspace.defaults.approval_channel;
  const existing = getChannelByName(approvalChannelName);
  if (existing) {
    return existing.id;
  }

  const channel = {
    id: `ch_${approvalChannelName}`,
    name: approvalChannelName,
    type: "public" as const,
    participants: [],
    created_at: nowIso(),
  };
  upsertChannel(channel);
  return channel.id;
}

function approvalEmbed(approval: Approval): MessageEmbed {
  const resolved = approval.status !== "pending";

  return {
    kind: "card",
    embed_id: `approval-card-${approval.id}`,
    card_kind: "approval",
    title: `Permission request: ${approval.tool_name}`,
    body_markdown: `Agent @${approval.agent} requested permission for \`${approval.tool_name}\`.`,
    status: approval.status,
    fields: [
      { label: "Agent", value: approval.agent },
      { label: "Risk", value: approval.risk_level },
      { label: "Session", value: approval.session_id },
      { label: "Permission", value: approval.permission_id },
    ],
    actions: [
      {
        action_id: "approve",
        label: "Approve",
        style: "primary",
        callback_ref: `approval:${approval.id}:approve`,
        disabled: resolved,
      },
      {
        action_id: "deny",
        label: "Deny",
        style: "danger",
        callback_ref: `approval:${approval.id}:deny`,
        disabled: resolved,
      },
    ],
  };
}

export function classifyRisk(toolName: string): Approval["risk_level"] {
  const lowRisk = new Set(["find", "find.file", "find.symbol", "file.read", "file.status"]);
  if (lowRisk.has(toolName)) {
    return "low";
  }
  if (toolName.includes("delete") || toolName.includes("remove") || toolName === "shell") {
    return "high";
  }
  return "medium";
}

export function createApprovalMessage(
  payload: {
    id: string;
    session_id: string;
    permission_id: string;
    agent: string;
    tool_name: string;
    risk_level: Approval["risk_level"];
    request: Record<string, unknown>;
  },
  broadcast: (event: unknown) => void,
): Approval {
  const timestamp = nowIso();
  const channelId = ensureApprovalChannelId();

  const approval: Approval = {
    id: payload.id,
    agent: payload.agent,
    session_id: payload.session_id,
    permission_id: payload.permission_id,
    tool_name: payload.tool_name,
    risk_level: payload.risk_level,
    request_json: payload.request,
    status: "pending",
    resolved_by: null,
    resolved_at: null,
    message_id: `msg_approval_${payload.id}`,
    created_at: timestamp,
  };

  insertApproval(approval);

  const message: Message = {
    id: approval.message_id ?? `msg_approval_fallback_${payload.id}`,
    channel_id: channelId,
    from: "system",
    content: `Approval needed for @${approval.agent}`,
    mentions: [approval.agent],
    thread_id: null,
    timestamp,
    embeds: [approvalEmbed(approval)],
  };

  insertMessage(message);
  broadcast({ type: "message.new", payload: message });

  return approval;
}

export async function handleMessageAction(
  payload: MessageActionPayload,
  broadcast: (event: unknown) => void,
): Promise<void> {
  const match = payload.callback_ref.match(/^approval:([^:]+):(approve|deny)$/);
  if (!match) {
    return;
  }

  const [, approvalId, action] = match;
  const approval = getApprovalById(approvalId);
  if (!approval || approval.status !== "pending") {
    return;
  }

  const desiredStatus: Approval["status"] = action === "approve" ? "approved" : "denied";
  const result = await resolveOpenCodePermission(approval, desiredStatus);

  const finalStatus: Approval["status"] = result.ok ? desiredStatus : "error";
  const updated = updateApprovalStatus(approvalId, {
    status: finalStatus,
    resolved_by: payload.actor,
  });

  if (!updated || !updated.message_id) {
    return;
  }

  const message = getMessageById(updated.message_id);
  if (!message) {
    return;
  }

  const nextEmbeds = (message.embeds ?? []).map((embed) => {
    if (embed.card_kind !== "approval") {
      return embed;
    }
    return approvalEmbed(updated);
  });

  updateMessageEmbeds(message.id, nextEmbeds);

  const replacement: Message = {
    ...message,
    content:
      finalStatus === "error"
        ? `${message.content}\nResolution failed: ${result.reason ?? "unknown error"}`
        : message.content,
    embeds: nextEmbeds,
  };

  insertMessage(replacement);
  broadcast({ type: "message.new", payload: replacement });
  broadcast({
    type: "approval.resolved",
    payload: {
      id: updated.id,
      status: finalStatus as "approved" | "denied" | "error",
      reason: result.reason,
    },
  });
}
