import { useEffect, useRef, useState } from 'react';
import { DLTSessionInfo } from '../components/DLTViewer';

/**
 * /ws/dlt-lifecycle 를 구독하여 현재 활성 DLT 세션 목록을 유지하는 훅.
 *
 * 사용 예:
 *   const { sessions, lastEvent } = useDLTSessions();
 *   useEffect(() => {
 *     if (lastEvent?.type === 'session_started') { setViewerOpen(true); }
 *   }, [lastEvent]);
 */
export function useDLTSessions() {
  const [sessions, setSessions] = useState<DLTSessionInfo[]>([]);
  const [lastEvent, setLastEvent] = useState<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let closed = false;

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws/dlt-lifecycle`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'ping') return;
          setLastEvent(msg);
          if (msg.type === 'session_started' && msg.session_id) {
            setSessions((prev) => {
              const exists = prev.find((s) => s.session_id === msg.session_id);
              if (exists) return prev;
              return [...prev, {
                session_id: msg.session_id,
                host: msg.host,
                port: msg.port,
                save_path: msg.save_path,
                started_at: msg.started_at,
              }];
            });
          } else if (msg.type === 'session_stopped' && msg.session_id) {
            setSessions((prev) => prev.filter((s) => s.session_id !== msg.session_id));
          }
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        if (closed) return;
        // 2초 후 재연결
        reconnectTimerRef.current = window.setTimeout(connect, 2000);
      };
      ws.onerror = () => { /* onclose에서 재연결 처리 */ };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      try { wsRef.current?.close(); } catch { /* ignore */ }
      wsRef.current = null;
    };
  }, []);

  return { sessions, lastEvent };
}
