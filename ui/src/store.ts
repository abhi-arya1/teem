import { create } from "zustand";
import type { AgentConfig, Channel, Message, Note, ToolCall, WSEvent, WorkspaceConfig } from "../../shared/types";

type TypingByChannel = Record<string, string[]>;

type MessageMap = Record<string, Message[]>;

type Sender = (event: WSEvent | { type: string; payload: unknown }) => void;

let wsSender: Sender | null = null;

export function bindSender(sender: Sender): void {
  wsSender = sender;
}

function upsertMessage(messages: Message[], incoming: Message): Message[] {
  const existing = messages.findIndex((msg) => msg.id === incoming.id);
  if (existing === -1) {
    return [...messages, incoming].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  const next = [...messages];
  next[existing] = incoming;
  return next;
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

interface StoreState {
  workspace: WorkspaceConfig | null;
  channels: Channel[];
  agents: AgentConfig[];
  messages: MessageMap;
  notes: Note[];
  toolCalls: ToolCall[];
  activeChannelId: string | null;
  notesOpen: boolean;
  observabilityOpen: boolean;
  typingAgents: TypingByChannel;

  hydrateInit: (payload: {
    channels: Channel[];
    agents: AgentConfig[];
    notes: Note[];
    workspace: WorkspaceConfig;
  }) => void;
  setChannelMessages: (channelId: string, messages: Message[]) => void;
  receiveMessage: (message: Message) => void;
  receiveToolCall: (toolCall: ToolCall) => void;
  receiveTyping: (agent: string, channelId: string) => void;
  setActiveChannel: (channelId: string) => void;
  setChannels: (channels: Channel[]) => void;
  setAgents: (agents: AgentConfig[]) => void;
  upsertNote: (note: Note) => void;
  sendMessage: (channelId: string, content: string) => void;
  sendMessageAction: (channelId: string, messageId: string, callbackRef: string) => void;
  sendTypingState: (channelId: string, isTyping: boolean) => void;
  toggleNotes: () => void;
  toggleObservability: () => void;
}

export const useStore = create<StoreState>((set, get) => ({
  workspace: null,
  channels: [],
  agents: [],
  messages: {},
  notes: [],
  toolCalls: [],
  activeChannelId: null,
  notesOpen: false,
  observabilityOpen: true,
  typingAgents: {},

  hydrateInit: (payload) => {
    const firstChannel = payload.channels[0]?.id ?? null;
    set({
      workspace: payload.workspace,
      channels: payload.channels,
      agents: payload.agents,
      notes: payload.notes,
      activeChannelId: get().activeChannelId ?? firstChannel,
    });
  },

  setChannelMessages: (channelId, messages) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [channelId]: messages,
      },
    }));
  },

  receiveMessage: (message) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [message.channel_id]: upsertMessage(state.messages[message.channel_id] ?? [], message),
      },
      typingAgents: {
        ...state.typingAgents,
        [message.channel_id]: (state.typingAgents[message.channel_id] ?? []).filter((name) => name !== message.from),
      },
    }));
  },

  receiveToolCall: (toolCall) => {
    set((state) => ({
      toolCalls: [toolCall, ...state.toolCalls].slice(0, 500),
    }));
  },

  receiveTyping: (agent, channelId) => {
    set((state) => {
      const current = state.typingAgents[channelId] ?? [];
      if (current.includes(agent)) {
        return state;
      }
      return {
        typingAgents: {
          ...state.typingAgents,
          [channelId]: [...current, agent],
        },
      };
    });
  },

  setActiveChannel: (channelId) => set({ activeChannelId: channelId }),

  setChannels: (channels) => set({ channels }),

  setAgents: (agents) => set({ agents }),

  upsertNote: (note) => {
    set((state) => {
      const idx = state.notes.findIndex((n) => n.id === note.id);
      if (idx === -1) {
        return { notes: [note, ...state.notes] };
      }
      const next = [...state.notes];
      next[idx] = note;
      return { notes: next };
    });
  },

  sendMessage: (channelId, content) => {
    if (!wsSender || !content.trim()) {
      return;
    }

    wsSender({
      type: "message.new",
      payload: {
        id: randomId("msg"),
        channel_id: channelId,
        from: "user",
        content,
        mentions: [],
        thread_id: null,
        timestamp: new Date().toISOString(),
      },
    });
  },

  sendMessageAction: (channelId, messageId, callbackRef) => {
    if (!wsSender) {
      return;
    }

    wsSender({
      type: "message.action",
      payload: {
        channel_id: channelId,
        message_id: messageId,
        callback_ref: callbackRef,
        actor: "user",
      },
    });
  },

  sendTypingState: (channelId, isTyping) => {
    if (!wsSender) {
      return;
    }

    wsSender({
      type: "typing.state",
      payload: {
        channel_id: channelId,
        actor: "user",
        role: "user",
        is_typing: isTyping,
      },
    });
  },

  toggleNotes: () => set((state) => ({ notesOpen: !state.notesOpen })),

  toggleObservability: () => set((state) => ({ observabilityOpen: !state.observabilityOpen })),
}));
