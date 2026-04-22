import { createContext, useContext, useState, useEffect, useRef, ReactNode, useCallback } from 'react';
import JMuxer from 'jmuxer';
import { deviceApi } from '../services/api';

export interface ManagedDevice {
  id: string;
  type: string; // "adb" | "serial" | "module" | "hkmc_agent" | "isap_agent" | "vision_camera"
  category: string; // "primary" | "auxiliary"
  address: string;
  status: string;
  name: string;
  info: Record<string, any>;
  protected?: boolean;  // 시스템 기본 디바이스 (삭제/수정 불가)
}

interface DeviceContextType {
  primaryDevices: ManagedDevice[];
  auxiliaryDevices: ManagedDevice[];
  loading: boolean;
  fetchDevices: () => Promise<void>;
  connectDevice: (type: string, address: string, baudrate?: number, name?: string, category?: string, module?: string, connect_type?: string, extra_fields?: Record<string, any>, device_id?: string, port?: number, device_model?: string) => Promise<string>;
  disconnectDevice: (deviceId: string) => Promise<string>;
  updateDeviceLists: (data: any) => void;
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
  // 실시간 FPS
  streamFps: number;
  // 화면 스트리밍 일시정지/재개
  pauseScreenStream: () => void;
  resumeScreenStream: () => void;
  // 디바이스 폴링 일시정지/재개
  pauseDevicePolling: () => void;
  resumeDevicePolling: () => void;
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
  const [streamFps, setStreamFps] = useState(0);
  const fpsCountRef = useRef(0);
  const fpsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // FPS 계측 시작/정지
  const startFpsCounter = useCallback(() => {
    fpsCountRef.current = 0;
    if (fpsTimerRef.current) clearInterval(fpsTimerRef.current);
    fpsTimerRef.current = setInterval(() => {
      setStreamFps(fpsCountRef.current);
      fpsCountRef.current = 0;
    }, 1000);
  }, []);
  const stopFpsCounter = useCallback(() => {
    if (fpsTimerRef.current) { clearInterval(fpsTimerRef.current); fpsTimerRef.current = null; }
    setStreamFps(0);
  }, []);

  // Frame arrived → mark alive, reset 3s timeout, count fps
  const markFrameAlive = useCallback(() => {
    setScreenAlive(true);
    fpsCountRef.current += 1;
    if (screenAliveTimerRef.current) clearTimeout(screenAliveTimerRef.current);
    screenAliveTimerRef.current = setTimeout(() => setScreenAlive(false), 3000);
  }, []);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // WS 재연결 관리
  const wsRetryCountRef = useRef(0);
  const wsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const MAX_WS_RETRIES = 3;
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

  const connectDevice = async (type: string, address: string, baudrate?: number, name?: string, category?: string, module?: string, connect_type?: string, extra_fields?: Record<string, any>, device_id?: string, port?: number, device_model?: string): Promise<string> => {
    const res = await deviceApi.connect(type, address, baudrate, name, category, module, connect_type, extra_fields, device_id, port, device_model);
    updateDeviceLists(res.data);
    return res.data.result;
  };

  const disconnectDevice = async (deviceId: string): Promise<string> => {
    const res = await deviceApi.disconnect(deviceId);
    updateDeviceLists(res.data);
    return res.data.result;
  };

  const devicePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startDevicePolling = useCallback(() => {
    if (devicePollRef.current) return;
    devicePollRef.current = setInterval(fetchDevices, 10000);
  }, []);

  const pauseDevicePolling = useCallback(() => {
    if (devicePollRef.current) {
      clearInterval(devicePollRef.current);
      devicePollRef.current = null;
    }
  }, []);

  const resumeDevicePolling = useCallback(() => {
    startDevicePolling();
  }, [startDevicePolling]);

  useEffect(() => {
    fetchDevices();
    startDevicePolling();
    return () => pauseDevicePolling();
  }, []);

  // --- 디바이스 변경 시 screenType 자동 설정 ---
  const prevDeviceIdRef = useRef('');
  useEffect(() => {
    if (screenshotDeviceId === prevDeviceIdRef.current) return;
    prevDeviceIdRef.current = screenshotDeviceId;
    if (!screenshotDeviceId) return;
    const dev = primaryDevices.find(d => d.id === screenshotDeviceId);
    if (!dev) return;
    if (dev.type === 'hkmc_agent' || dev.type === 'isap_agent') {
      setScreenType('front_center');
    } else if (dev.type === 'vision_camera' || dev.type === 'webcam') {
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
    stopFpsCounter();
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
  }, [stopFpsCounter]);

  // --- Check if device is HKMC or iSAP Agent (both use TCP agent protocol) ---
  const isHkmcDevice = useCallback((deviceId: string) => {
    const dev = primaryDevices.find(d => d.id === deviceId);
    return dev?.type === 'hkmc_agent' || dev?.type === 'isap_agent';
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
  // startWsStream의 최신 참조를 유지 (재연결 콜백에서 사용)
  const startWsStreamRef = useRef<((deviceId: string, st: string) => void) | null>(null);

  const startWsStream = useCallback((deviceId: string, st: string) => {
    closeWs();
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProto}//${window.location.host}/ws/screen`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    // 예기치 않은 종료 시 재연결 스케줄링
    const scheduleReconnect = () => {
      if (screenshotDeviceIdRef.current !== deviceId) return;
      if (wsRetryCountRef.current >= MAX_WS_RETRIES) return;
      wsRetryCountRef.current += 1;
      const delay = 500 * wsRetryCountRef.current;
      wsRetryTimerRef.current = setTimeout(() => {
        wsRetryTimerRef.current = null;
        if (screenshotDeviceIdRef.current === deviceId && !wsRef.current) {
          startWsStreamRef.current?.(deviceId, st);
        }
      }, delay);
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ device_id: deviceId, screen_type: st }));
      startFpsCounter();
      wsRetryCountRef.current = 0; // 연결 성공 → 재시도 카운터 초기화
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
            // JMuxer는 useEffect에서 video 엘리먼트 준비 후 초기화
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
        if (h264ModeRef.current) {
          // H.264 NAL 데이터
          if (jmuxerRef.current) {
            jmuxerRef.current.feed({ video: new Uint8Array(event.data) });
          }
          // JMuxer 미초기화 시 데이터 드롭 (useEffect에서 곧 초기화됨)
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
      // 에러 → 정리 후 재연결 시도
      closeWs();
      scheduleReconnect();
    };

    ws.onclose = () => {
      // closeWs()가 호출했으면 onclose=null이므로 여기 도달 = 예기치 않은 서버 종료
      closeWs(); // JMuxer, FPS 등 전체 상태 정리
      scheduleReconnect();
    };
  }, [closeWs, markFrameAlive, startFpsCounter]);

  // 최신 startWsStream 참조 유지
  startWsStreamRef.current = startWsStream;

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

  // H.264 모드 시 JMuxer 초기화 (video 엘리먼트가 DOM에 렌더된 후 실행)
  useEffect(() => {
    if (!h264Mode) return;
    // video 엘리먼트가 렌더될 때까지 대기
    const initJMuxer = () => {
      if (videoRef.current && !jmuxerRef.current) {
        jmuxerRef.current = new JMuxer({
          node: videoRef.current,
          mode: 'video',
          flushingTime: 1,
          fps: 60,
          debug: false,
        });
      }
    };
    // 즉시 시도 + 폴백 (React 렌더 지연 대비)
    initJMuxer();
    if (!jmuxerRef.current) {
      const timer = setInterval(() => {
        initJMuxer();
        if (jmuxerRef.current) clearInterval(timer);
      }, 50);
      return () => clearInterval(timer);
    }
  }, [h264Mode]);

  // Screenshot source management: WebSocket for HKMC, polling for ADB
  // 디바운스로 screenType 자동 설정 완료 후 WS를 1회만 연결
  const wsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // 이전 디바운스/재연결 타이머 취소 + 카운터 리셋
    if (wsDebounceRef.current) {
      clearTimeout(wsDebounceRef.current);
      wsDebounceRef.current = null;
    }
    if (wsRetryTimerRef.current) {
      clearTimeout(wsRetryTimerRef.current);
      wsRetryTimerRef.current = null;
    }
    wsRetryCountRef.current = 0;

    // 기존 스트림 즉시 정리
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    closeWs();

    if (!screenshotDeviceId) {
      setScreenshot('');
      return;
    }

    // 100ms 디바운스: deviceId 변경 → screenType 자동 설정 → 확정 후 WS 1회 연결
    wsDebounceRef.current = setTimeout(() => {
      wsDebounceRef.current = null;
      startWsStream(screenshotDeviceId, screenType);
    }, 100);

    return () => {
      if (wsDebounceRef.current) {
        clearTimeout(wsDebounceRef.current);
        wsDebounceRef.current = null;
      }
      if (wsRetryTimerRef.current) {
        clearTimeout(wsRetryTimerRef.current);
        wsRetryTimerRef.current = null;
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      closeWs();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenshotDeviceId, screenType]);

  const pauseScreenStream = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    closeWs();
  }, [closeWs]);

  const resumeScreenStream = useCallback(() => {
    const deviceId = screenshotDeviceIdRef.current;
    if (!deviceId) return;
    startWsStream(deviceId, screenTypeRef.current);
  }, [startWsStream]);

  return (
    <DeviceContext.Provider value={{
      primaryDevices,
      auxiliaryDevices,
      loading,
      fetchDevices,
      connectDevice,
      disconnectDevice,
      updateDeviceLists,
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
      streamFps,
      pauseScreenStream,
      resumeScreenStream,
      pauseDevicePolling,
      resumeDevicePolling,
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
