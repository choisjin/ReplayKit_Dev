import { createContext, useContext, useState, useEffect, useRef, ReactNode, useCallback } from 'react';
import { deviceApi } from '../services/api';

export interface ManagedDevice {
  id: string;
  type: string; // "adb" | "serial" | "module"
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
  connectDevice: (type: string, address: string, baudrate?: number, name?: string, category?: string, module?: string, connect_type?: string, extra_fields?: Record<string, any>) => Promise<string>;
  disconnectDevice: (deviceId: string) => Promise<string>;
  // Screenshot for a specific primary device
  screenshotDeviceId: string;
  setScreenshotDeviceId: (id: string) => void;
  screenshot: string;
  // Screenshot polling interval (ms)
  pollInterval: number;
  setPollInterval: (ms: number) => void;
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
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const screenshotDeviceIdRef = useRef('');

  // Keep ref in sync with state for use in refreshScreenshot
  useEffect(() => {
    screenshotDeviceIdRef.current = screenshotDeviceId;
  }, [screenshotDeviceId]);

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

  const connectDevice = async (type: string, address: string, baudrate?: number, name?: string, category?: string, module?: string, connect_type?: string, extra_fields?: Record<string, any>): Promise<string> => {
    const res = await deviceApi.connect(type, address, baudrate, name, category, module, connect_type, extra_fields);
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

  // Prevent overlapping poll requests
  const pollInFlightRef = useRef(false);

  // Simple poll function (no error-based recovery)
  const pollFn = useCallback(async () => {
    const deviceId = screenshotDeviceIdRef.current;
    if (!deviceId) return;
    if (pollInFlightRef.current) return; // skip if previous request still pending
    pollInFlightRef.current = true;
    try {
      const res = await deviceApi.screenshot(deviceId);
      // Only update if the device hasn't changed while the request was in-flight
      if (deviceId === screenshotDeviceIdRef.current) {
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
    await pollFn();
    // Reset polling timer so next poll is a full interval from now
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = setInterval(pollFn, pollInterval);
    }
  }, [pollInterval, pollFn]);

  // Screenshot polling for the selected primary device
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (!screenshotDeviceId) {
      setScreenshot('');
      return;
    }
    pollFn(); // immediate first fetch
    intervalRef.current = setInterval(pollFn, pollInterval);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
};
  }, [screenshotDeviceId, pollInterval, pollFn]);

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
