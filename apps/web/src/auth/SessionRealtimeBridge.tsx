import { useEffect, useState } from "react";
import { observeSessionReadiness } from "./session-readiness.mjs";

type ConnectionState = "disabled" | "connecting" | "ready" | "error";

export function SessionRealtimeBridge({ enabled }: { enabled: boolean }) {
  const [sseState, setSseState] = useState<ConnectionState>(enabled ? "connecting" : "disabled");
  const [webSocketState, setWebSocketState] = useState<ConnectionState>(enabled ? "connecting" : "disabled");

  useEffect(() => {
    if (!enabled) {
      setSseState("disabled");
      setWebSocketState("disabled");
      return undefined;
    }

    setSseState("connecting");
    setWebSocketState("connecting");

    const stopReadiness = observeSessionReadiness({
      EventSourceClass: EventSource,
      onState: (state: "ready" | "error") => setSseState(state),
    });

    const socketUrl = new URL("/ws/session", globalThis.location.href);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(socketUrl);
    socket.onmessage = (event) => {
      try {
        if (JSON.parse(String(event.data))?.type === "session.ready") setWebSocketState("ready");
      } catch {
        setWebSocketState("error");
      }
    };
    socket.onerror = () => setWebSocketState("error");

    return () => {
      stopReadiness();
      socket.close();
    };
  }, [enabled]);

  return (
    <span
      hidden
      data-session-realtime="true"
      data-sse-state={sseState}
      data-websocket-state={webSocketState}
    />
  );
}
