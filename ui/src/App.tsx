import { useEffect, useMemo, useRef, useState } from "react";
import Message from "./components/Message";
import ObservabilityTail from "./components/ObservabilityTail";
import { useStore } from "./store";
import { fetchChannelHistory } from "./ws";

export default function App(): JSX.Element {
  const workspace = useStore((state) => state.workspace);
  const channels = useStore((state) => state.channels);
  const agents = useStore((state) => state.agents);
  const notes = useStore((state) => state.notes);
  const activeChannelId = useStore((state) => state.activeChannelId);
  const setActiveChannel = useStore((state) => state.setActiveChannel);
  const messages = useStore((state) => state.messages[activeChannelId ?? ""] ?? []);
  const sendMessage = useStore((state) => state.sendMessage);
  const sendTypingState = useStore((state) => state.sendTypingState);
  const typingAgents = useStore((state) => state.typingAgents[activeChannelId ?? ""] ?? []);
  const notesOpen = useStore((state) => state.notesOpen);
  const toggleNotes = useStore((state) => state.toggleNotes);
  const observabilityOpen = useStore((state) => state.observabilityOpen);
  const toggleObservability = useStore((state) => state.toggleObservability);

  const [input, setInput] = useState("");
  const typingTimerRef = useRef<number | null>(null);

  const activeChannel = useMemo(
    () => channels.find((channel) => channel.id === activeChannelId) ?? null,
    [channels, activeChannelId],
  );

  useEffect(() => {
    if (!activeChannelId) {
      return;
    }

    void fetchChannelHistory(activeChannelId);
  }, [activeChannelId]);

  useEffect(() => {
    return () => {
      if (typingTimerRef.current) {
        window.clearTimeout(typingTimerRef.current);
      }
      if (activeChannelId) {
        sendTypingState(activeChannelId, false);
      }
    };
  }, [activeChannelId, sendTypingState]);

  function submit(): void {
    if (!activeChannelId || !input.trim()) {
      return;
    }
    sendMessage(activeChannelId, input.trim());
    sendTypingState(activeChannelId, false);
    if (typingTimerRef.current) {
      window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    setInput("");
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <header>
          <h1>{workspace?.workspace.name ?? "AgentSlack"}</h1>
          <p>{workspace?.company.name ?? "Workspace"}</p>
        </header>

        <section>
          <h2>Channels</h2>
          <ul>
            {channels.map((channel) => (
              <li key={channel.id}>
                <button
                  className={channel.id === activeChannelId ? "active" : ""}
                  onClick={() => setActiveChannel(channel.id)}
                >
                  #{channel.name}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2>Agents</h2>
          <ul>
            {agents.map((agent) => (
              <li key={agent.name}>
                <span>{agent.emoji}</span> {agent.display_name}
              </li>
            ))}
          </ul>
        </section>
      </aside>

      <main className="main-pane">
        <header className="channel-head">
          <div>
            <strong>{activeChannel ? `#${activeChannel.name}` : "Select a channel"}</strong>
            <p>{workspace?.workspace.description}</p>
          </div>
          <div className="header-actions">
            <button onClick={toggleNotes}>{notesOpen ? "Hide Notes" : "Notes"}</button>
            <button onClick={toggleObservability}>{observabilityOpen ? "Hide Tail" : "Tail"}</button>
          </div>
        </header>

        <section className="messages">
          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </section>

        {typingAgents.length ? (
          <div className="typing">{typingAgents.join(", ")} typing...</div>
        ) : null}

        <footer className="composer">
          <textarea
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              if (!activeChannelId) {
                return;
              }
              sendTypingState(activeChannelId, true);
              if (typingTimerRef.current) {
                window.clearTimeout(typingTimerRef.current);
              }
              typingTimerRef.current = window.setTimeout(() => {
                sendTypingState(activeChannelId, false);
                typingTimerRef.current = null;
              }, 900);
            }}
            placeholder="Message channel..."
            rows={3}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button onClick={submit}>Send</button>
        </footer>

        {notesOpen ? (
          <section className="notes-drawer">
            <h3>Notes</h3>
            <ul>
              {notes.map((note) => (
                <li key={note.id}>
                  <strong>{note.title}</strong>
                  <p>{note.content}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>

      {observabilityOpen ? <ObservabilityTail /> : null}
    </div>
  );
}
