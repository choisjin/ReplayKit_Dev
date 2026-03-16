import { createContext, useContext, useState, useEffect, useRef, ReactNode, useCallback } from 'react';
import { deviceApi } from '../services/api';

export interface ManagedDevice {
  id: string;
  type: string; // "adb" | "serial" | "module" | "hkmc6th"
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
  }, []);

  // --- WebSocket cleanup helper ---
  const closeWs = useCallback(() => {
    if (wsRef.current) {
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

  // --- WebSocket screen streaming (HKMC) ---
  const startWsStream = useCallback((deviceId: string, st: string) => {
    closeWs();
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProto}//${window.location.host}/ws/screen`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ device_id: deviceId, screen_type: st }));
    };

    ws.onmessage = (event) => {
      if (event.data instanceof Blob) {
        // 바이너리 JPEG 프레임
        if (prevBlobUrlRef.current) {
          URL.revokeObjectURL(prevBlobUrlRef.current);
        }
        const url = URL.createObjectURL(event.data);
        prevBlobUrlRef.current = url;
        if (screenshotDeviceIdRef.current === deviceId) {
          setScreenshot(url);
        }
      } else {
        // JSON 메시지 (에러 등)
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'frame' && msg.image) {
            const mime = msg.format === 'jpeg' ? 'image/jpeg' : 'image/png';
            if (screenshotDeviceIdRef.current === deviceId) {
              setScreenshot(`data:${mime};base64,${msg.image}`);
            }
          }
        } catch { /* ignore */ }
      }
    };

    ws.onerror = () => {
      // WebSocket 실패 시 폴링 폴백으로 전환
      closeWs();
    };

    ws.onclose = () => {
      wsRef.current = null;
    };
  }, [closeWs]);

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

    if (isHkmcDevice(screenshotDeviceId)) {
      // HKMC: WebSocket 바이너리 스트리밍
      startWsStream(screenshotDeviceId, screenType);
    } else {
      // ADB: HTTP 폴링
      pollFn();
      intervalRef.current = setInterval(pollFn, pollInterval);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      closeWs();
    };
  }, [screenshotDeviceId, pollInterval, screenType, pollFn, isHkmcDevice, startWsStream, closeWs]);

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
