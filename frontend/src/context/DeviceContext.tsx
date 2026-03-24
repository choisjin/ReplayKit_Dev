import { createContext, useContext, useState, useEffect, useRef, ReactNode, useCallback } from 'react';
import JMuxer from 'jmuxer';
import { deviceApi } from '../services/api';

export interface ManagedDevice {
  id: string;
  type: string; // "adb" | "serial" | "module" | "hkmc6th" | "vision_camera"
  category: string; // "primary" | "auxiliary"
  address: string;
  status: string;
  name: string;
  info: Record<string, any>;
}

interface DeviceContextType {
  primaryDevices: ManagedDevice[];
  auxiliaryDevices: ManagedDevice[];
  loading: boolean;
  fetchDevices: () => Promise<void>;
  connectDevice: (type: string, address: string, baudrate?: number, name?: string, category?: string, module?: string, connect_type?: string, extra_fields?: Record<string, any>, device_id?: string, port?: number) => Promise<string>;
  disconnectDevice: (deviceId: string) => Promise<string>;
  // Screenshot for a specific primary device
  screenshotDeviceId: string;
  setScreenshotDeviceId: (id: string) => void;
  screenshot: string;
  // Screenshot polling interval (ms)
  pollInterval: number;
  setPollInterval: (ms: number) => void;
  // HKMC screen type for screenshot polling
  screenType: string;
  setScreenType: (st: string) => void;
  // Force immediate screenshot refresh (call after action)
  refreshScreenshot: () => void;
  // Screen streaming alive indicator (true = frames arriving)
  screenAlive: boolean;
  // H.264 direct streaming mode
  h264Mode: boolean;
  h264Size: { width: number; height: number };
  videoRef: React.RefObject<HTMLVideoElement | null>;
  sendControl: (msg: object) => void;
}

const DeviceContext = createContext<DeviceContextType | null>(null);

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [primaryDevices, setPrimaryDevices] = useState<ManagedDevice[]>([]);
  const [auxiliaryDevices, setAuxiliaryDevices] = useState<ManagedDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [screenshotDeviceId, setScreenshotDeviceId] = useState('');
  const [screenshot, setScreenshot] = useState('');
  const [pollInterval, setPollInterval] = useState(500);
  const [screenType, setScreenType] = useState('front_center');
  const [screenAlive, setScreenAlive] = useState(false);
  const [h264Mode, setH264Mode] = useState(false);
  const [h264Size, setH264Size] = useState({ width: 1080, height: 1920 });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const h264ModeRef = useRef(false);
  const jmuxerRef = useRef<JMuxer | null>(null);
  const screenAliveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Frame arrived → mark alive, reset 3s timeout
  const markFrameAlive = useCallback(() => {
    setScreenAlive(true);
    if (screenAliveTimerRef.current) clearTimeout(screenAliveTimerRef.current);
    screenAliveTimerRef.current = setTimeout(() => setScreenAlive(false), 3000);
  }, []);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const screenshotDeviceIdRef = useRef('');
  const screenTypeRef = useRef('front_center');
  const wsRef = useRef<WebSocket | null>(null);
  const prevBlobUrlRef = useRef<string>('');

  // Keep refs in sync with state for use in pollFn/refreshScreenshot
  useEffect(() => {
    screenshotDeviceIdRef.current = screenshotDeviceId;
  }, [screenshotDeviceId]);

  useEffect(() => {
    screenTypeRef.current = screenType;
  }, [screenType]);

  const updateDeviceLists = (data: any) => {
    if (data.primary) setPrimaryDevices(data.primary);
    if (data.auxiliary) setAuxiliaryDevices(data.auxiliary);
  };

  const fetchDevices = async () => {
    setLoading(true);
    try {
      const res = await deviceApi.list();
      updateDeviceLists(res.data);
    } catch { /* ignore */ }
    setLoading(false);
  };

  const connectDevice = async (type: string, address: string, baudrate?: number, name?: string, category?: string, module?: string, connect_type?: string, extra_fields?: Record<string, any>, device_id?: string, port?: number): Promise<string> => {
    const res = await deviceApi.connect(type, address, baudrate, name, category, module, connect_type, extra_fields, device_id, port);
    updateDeviceLists(res.data);
    return res.data.result;
  };

  const disconnectDevice = async (deviceId: string): Promise<string> => {
    const res = await deviceApi.disconnect(deviceId);
    updateDeviceLists(res.data);
    return res.data.result;
  };

  useEffect(() => {
    fetchDevices();
    // 디바이스 상태 주기 갱신 (자동 재연결 포함) — 10초 간격
    const devicePollId = setInterval(fetchDevices, 10000);
    return () => clearInterval(devicePollId);
  }, []);

  // --- 디바이스 변경 시 screenType 자동 설정 ---
  const prevDeviceIdRef = useRef('');
  useEffect(() => {
    if (screenshotDeviceId === prevDeviceIdRef.current) return;
    prevDeviceIdRef.current = screenshotDeviceId;
    if (!screenshotDeviceId) return;
    const dev = primaryDevices.find(d => d.id === screenshotDeviceId);
    if (!dev) return;
    if (dev.type === 'hkmc6th') {
      setScreenType('front_center');
    } else if (dev.type === 'vision_camera') {
      setScreenType('default');
    } else if (dev.type === 'adb' && (dev.info?.displays?.length ?? 0) > 1) {
      setScreenType(String(dev.info.displays[0]?.id ?? 0));
    } else {
      setScreenType('0');
    }
  }, [screenshotDeviceId, primaryDevices]);

  // --- WebSocket cleanup helper ---
  const closeWs = useCallback(() => {
    if (jmuxerRef.current) {
      try { jmuxerRef.current.destroy(); } catch { /* ignore */ }
      jmuxerRef.current = null;
    }
    h264ModeRef.current = false;
    setH264Mode(false);
    if (wsRef.current) {
      // 이전 WebSocket의 이벤트 핸들러 제거 (close 완료 전 프레임 수신 방지)
      wsRef.current.onmessage = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    if (prevBlobUrlRef.current) {
      URL.revokeObjectURL(prevBlobUrlRef.current);
      prevBlobUrlRef.current = '';
    }
  }, []);

  // --- Check if device is HKMC ---
  const isHkmcDevice = useCallback((deviceId: string) => {
    const dev = primaryDevices.find(d => d.id === deviceId);
    return dev?.type === 'hkmc6th';
  }, [primaryDevices]);

  // --- Check if ADB device has multi-display ---
  const hasMultiDisplay = useCallback((deviceId: string) => {
    const dev = primaryDevices.find(d => d.id === deviceId);
    return dev?.type === 'adb' && (dev.info?.displays?.length ?? 0) > 1;
  }, [primaryDevices]);

  // --- sendControl: WebSocket으로 터치/키 컨트롤 전송 ---
  const sendControl = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // --- WebSocket screen streaming (H.264 / JPEG) ---
  const startWsStream = useCallback((deviceId: string, st: string) => {
    closeWs();
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProto}//${window.location.host}/ws/screen`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ device_id: deviceId, screen_type: st }));
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        // JSON 메시지: 모드 협상 또는 에러
        try {
          const msg = JSON.parse(event.data);
          if (msg.mode === 'h264') {
            h264ModeRef.current = true;
            setH264Mode(true);
            setH264Size({ width: msg.width || 1080, height: msg.height || 1920 });
            // JMuxer 초기화 (video 엘리먼트 바인딩)
            setTimeout(() => {
              if (videoRef.current && !jmuxerRef.current) {
                jmuxerRef.current = new JMuxer({
                  node: videoRef.current,
                  mode: 'video',
                  flushingTime: 0,
                  fps: 30,
                  debug: false,
                });
              }
            }, 100);
          } else if (msg.mode === 'jpeg') {
            h264ModeRef.current = false;
            setH264Mode(false);
          } else if (msg.type === 'frame' && msg.image) {
            const mime = msg.format === 'jpeg' ? 'image/jpeg' : 'image/png';
            if (screenshotDeviceIdRef.current === deviceId) {
              setScreenshot(`data:${mime};base64,${msg.image}`);
              markFrameAlive();
            }
          }
        } catch { /* ignore */ }
      } else if (event.data instanceof ArrayBuffer) {
        if (h264ModeRef.current && jmuxerRef.current) {
          // H.264 NAL 데이터 → JMuxer → <video>
          jmuxerRef.current.feed({ video: new Uint8Array(event.data) });
          markFrameAlive();
        } else {
          // JPEG 바이너리 → Blob URL → <img>/<canvas>
          const blob = new Blob([event.data], { type: 'image/jpeg' });
          if (prevBlobUrlRef.current) {
            URL.revokeObjectURL(prevBlobUrlRef.current);
          }
          const url = URL.createObjectURL(blob);
          prevBlobUrlRef.current = url;
          if (screenshotDeviceIdRef.current === deviceId) {
            setScreenshot(url);
            markFrameAlive();
          }
        }
      }
    };

    ws.onerror = () => {
      // WebSocket 실패 시 폴링 폴백으로 전환
      closeWs();
    };

    ws.onclose = () => {
      wsRef.current = null;
    };
  }, [closeWs, markFrameAlive]);

  // Prevent overlapping poll requests
  const pollInFlightRef = useRef(false);

  // Simple poll function (for non-HKMC or fallback)
  const pollFn = useCallback(async () => {
    const deviceId = screenshotDeviceIdRef.current;
    if (!deviceId) return;
    if (pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    try {
      const res = await deviceApi.screenshot(deviceId, screenTypeRef.current);
      if (deviceId === screenshotDeviceIdRef.current && res.data.image) {
        const fmt = res.data.format || 'jpeg';
        const mime = fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
        setScreenshot(`data:${mime};base64,${res.data.image}`);
        markFrameAlive();
      }
    } catch { /* ignore */ }
    pollInFlightRef.current = false;
  }, []);

  const refreshScreenshot = useCallback(async () => {
    const deviceId = screenshotDeviceIdRef.current;
    if (!deviceId) return;
    // HKMC WebSocket 연결 중이면 별도 요청 불필요 (자동 갱신)
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;
    await pollFn();
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = setInterval(pollFn, pollInterval);
    }
  }, [pollInterval, pollFn]);

  // Screenshot source management: WebSocket for HKMC, polling for ADB
  useEffect(() => {
    // 기존 정리
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    closeWs();

    if (!screenshotDeviceId) {
      setScreenshot('');
      return;
    }

    // 모든 디바이스 WebSocket 스트리밍 (scrcpy H.264 또는 screencap 폴백은 백엔드에서 처리)
    startWsStream(screenshotDeviceId, screenType);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      closeWs();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenshotDeviceId, screenType]);

  return (
    <DeviceContext.Provider value={{
      primaryDevices,
      auxiliaryDevices,
      loading,
      fetchDevices,
      connectDevice,
      disconnectDevice,
      screenshotDeviceId,
      setScreenshotDeviceId,
      screenshot,
      pollInterval,
      setPollInterval,
      screenType,
      setScreenType,
      refreshScreenshot,
      screenAlive,
      h264Mode,
      h264Size,
      videoRef,
      sendControl,
    }}>
      {children}
    </DeviceContext.Provider>
  );
}

export function useDevice() {
  const ctx = useContext(DeviceContext);
  if (!ctx) throw new Error('useDevice must be used within DeviceProvider');
  return ctx;
}
