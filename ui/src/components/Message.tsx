import type { Message as MessageType } from "../../../shared/types";
import { Streamdown } from "streamdown";
import { useStore } from "../store";

interface Props {
  message: MessageType;
}

export default function Message({ message }: Props): JSX.Element {
  const agents = useStore((state) => state.agents);
  const sendAction = useStore((state) => state.sendMessageAction);

  const agent = agents.find((item) => item.name === message.from);
  const isUser = message.from === "user";

  return (
    <div className={`message ${isUser ? "message-user" : "message-agent"}`}>
      <div className="message-avatar" style={{ backgroundColor: agent?.color ?? "#6B7280" }}>
        {agent?.emoji ?? (isUser ? "U" : "S")}
      </div>
      <div className="message-main">
        <div className="message-meta">
          <strong>{agent?.display_name ?? message.from}</strong>
          <span>{new Date(message.timestamp).toLocaleTimeString()}</span>
        </div>
        <div className="message-content">
          <Streamdown>{message.content}</Streamdown>
        </div>

        {(message.embeds ?? []).map((embed) => (
          <div key={embed.embed_id} className="embed-card">
            <div className="embed-header">
              <strong>{embed.title}</strong>
              {embed.status ? <span className="embed-status">{embed.status}</span> : null}
            </div>
            <p>{embed.body_markdown}</p>
            {embed.fields?.length ? (
              <ul>
                {embed.fields.map((field) => (
                  <li key={`${embed.embed_id}-${field.label}`}>
                    <strong>{field.label}:</strong> {field.value}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="embed-actions">
              {(embed.actions ?? []).map((action) => (
                <button
                  key={action.action_id}
                  disabled={Boolean(action.disabled)}
                  className={`embed-btn ${action.style ?? "secondary"}`}
                  onClick={() => sendAction(message.channel_id, message.id, action.callback_ref)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
