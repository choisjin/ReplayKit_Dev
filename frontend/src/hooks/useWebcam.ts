import { useState, useRef, useCallback, useEffect } from 'react';
import { App } from 'antd';
import { useTranslation } from '../i18n';
import axios from 'axios';

// 백엔드 OpenCV 기반 webcam service 클라이언트.
// 이전의 브라우저 MediaRecorder 버전을 대체. 녹화/프리뷰 모두 백엔드에서 수행됨.
// 외부 API 시그니처는 유지되어 호출 측 코드 변경 최소화.

interface WebcamStatus {
  open: boolean;
  device_index: number;
  width: number;
  height: number;
  fps: number;
  recording: boolean;
  recording_path: string;
  recording_duration_s: number;
  frames_written: number;
  overlay_position: string;
}

interface DeviceInfo {
  index: number;
  label: string;
}

export function useWebcam() {
  const { t } = useTranslation();
  const { message } = App.useApp();

  // UI state
  const [webcamOpen, setWebcamOpen] = useState(false);
  const [webcamIndex, setWebcamIndex] = useState(0);
  const [webcamDevices, setWebcamDevices] = useState<DeviceInfo[]>([]);
  const [webcamRecording, setWebcamRecording] = useState(false);
  const [webcamSettingsOpen, setWebcamSettingsOpen] = useState(false);
  const [webcamCapabilities, setWebcamCapabilities] = useState<Record<string, any>>({});
  const [webcamSettings, setWebcamSettings] = useState<Record<string, number>>({});
  const [webcamResolution, setWebcamResolution] = useState('');
  const [webcamResolutions, setWebcamResolutions] = useState<string[]>([]);

  // 타임스탬프 오버레이 설정 (프런트 ↔ 백엔드 sync)
  const [timestampPosition, setTimestampPositionState] = useState<'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'off'>('bottom-right');
  const [timestampColor, setTimestampColorState] = useState('#ffffff');
  const [timestampFontSize, setTimestampFontSizeState] = useState(0); // 0 = auto

  // 프런트 측 레거시 호환: WebcamPip가 여전히 webcamVideoRef를 사용할 수 있음.
  // 백엔드 전환 후에는 실제로 참조하지 않음 (WebcamPip는 img 태그로 교체됨).
  const webcamVideoRef = useRef<HTMLVideoElement>(null);

  // 상태 폴링
  const statusTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async (): Promise<WebcamStatus | null> => {
    try {
      const r = await axios.get('/api/webcam/status');
      const s: WebcamStatus = r.data;
      setWebcamOpen(s.open);
      setWebcamRecording(s.recording);
      if (s.width && s.height) setWebcamResolution(`${s.width}x${s.height}`);
      return s;
    } catch {
      return null;
    }
  }, []);

  // 주기적으로 백엔드 상태 폴링 (recording 상태 반영)
  useEffect(() => {
    statusTimerRef.current = setInterval(() => { fetchStatus(); }, 2000);
    return () => {
      if (statusTimerRef.current) clearInterval(statusTimerRef.current);
    };
  }, [fetchStatus]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (statusTimerRef.current) clearInterval(statusTimerRef.current);
    };
  }, []);

  const enumerateWebcams = useCallback(async () => {
    try {
      const r = await axios.get('/api/webcam/devices');
      setWebcamDevices(r.data.devices || []);
    } catch {
      setWebcamDevices([]);
    }
  }, []);

  const probeWebcamResolutions = useCallback(async (deviceIndex: number) => {
    try {
      const r = await axios.get(`/api/webcam/resolutions/${deviceIndex}`);
      const list: string[] = r.data.resolutions || [];
      setWebcamResolutions(list);
      return list;
    } catch {
      setWebcamResolutions([]);
      return [];
    }
  }, []);

  const startWebcam = useCallback(async (deviceIndex: number, resolution?: string) => {
    try {
      let w = 640, h = 480;
      if (resolution) {
        const [ws, hs] = resolution.split('x').map(Number);
        if (ws && hs) { w = ws; h = hs; }
      }
      await axios.post('/api/webcam/open', { device_index: deviceIndex, width: w, height: h });
      await fetchStatus();
    } catch (e: any) {
      message.error(t('webcam.openFailed') + ': ' + (e?.response?.data?.detail || e.message || e));
    }
  }, [fetchStatus, message, t]);

  const stopWebcam = useCallback(async () => {
    try {
      await axios.post('/api/webcam/close');
    } catch { /* ignore */ }
    setWebcamOpen(false);
    setWebcamRecording(false);
  }, []);

  const handleWebcamToggle = useCallback(async (keys: string | string[]) => {
    const isOpen = Array.isArray(keys) ? keys.includes('webcam') : keys === 'webcam';
    if (isOpen) {
      await enumerateWebcams();
      await startWebcam(webcamIndex);
      await probeWebcamResolutions(webcamIndex);
    } else {
      await stopWebcam();
    }
  }, [webcamIndex, enumerateWebcams, startWebcam, stopWebcam, probeWebcamResolutions]);

  const handleWebcamChange = useCallback(async (idx: number) => {
    setWebcamIndex(idx);
    if (webcamOpen) {
      await startWebcam(idx);
      await probeWebcamResolutions(idx);
    }
  }, [webcamOpen, startWebcam, probeWebcamResolutions]);

  const handleWebcamResolutionChange = useCallback(async (res: string) => {
    setWebcamResolution(res);
    await startWebcam(webcamIndex, res);
  }, [webcamIndex, startWebcam]);

  // 타임스탬프 오버레이 설정 — 백엔드로 전달
  const syncOverlayToBackend = useCallback(async (pos?: string, color?: string, fontSize?: number) => {
    try {
      await axios.post('/api/webcam/overlay', {
        position: pos,
        color_hex: color,
        font_scale: fontSize !== undefined ? (fontSize || 0) / 24.0 : undefined, // 대략 24px = scale 1.0
      });
    } catch { /* ignore */ }
  }, []);

  const setTimestampPosition = useCallback((pos: typeof timestampPosition) => {
    setTimestampPositionState(pos);
    syncOverlayToBackend(pos);
  }, [syncOverlayToBackend]);

  const setTimestampColor = useCallback((color: string) => {
    setTimestampColorState(color);
    syncOverlayToBackend(undefined, color);
  }, [syncOverlayToBackend]);

  const setTimestampFontSize = useCallback((size: number) => {
    setTimestampFontSizeState(size);
    syncOverlayToBackend(undefined, undefined, size);
  }, [syncOverlayToBackend]);

  // ------------------------------------------------------------
  // 자동 녹화 (재생 시 호출됨) — 이제 백엔드 재생 태스크가 자동으로 처리하므로
  // 프런트 호출은 no-op으로 유지해 호출 측 코드 변경 없이 작동하게 함.
  // 실제 녹화 시작/종료는 backend main.py의 _start_webcam_recording_for_playback에서.
  // ------------------------------------------------------------
  const startRecordingAuto = useCallback(async (): Promise<boolean> => {
    // 백엔드가 playback 시작 시 자동으로 녹화 시작 → 여기는 상태 확인만
    const s = await fetchStatus();
    return !!(s && s.open);
  }, [fetchStatus]);

  const stopRecordingAuto = useCallback((): Promise<Blob> => {
    // 백엔드가 playback 종료 시 자동으로 녹화 정지 → 여기는 빈 blob 반환 (호환성용)
    return Promise.resolve(new Blob([], { type: 'video/mp4' }));
  }, []);

  // 수동 녹화 — 사용자가 WebcamPip에서 Record 버튼 클릭
  const startWebcamRecording = useCallback(async () => {
    if (!webcamOpen) {
      message.error(t('webcam.notActive'));
      return;
    }
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      // 상대 경로: backend가 해석해서 기본 위치에 저장 (manual_webcam 폴더)
      const outputPath = `manual_webcam/${ts}.mp4`;
      await axios.post('/api/webcam/record/start', { output_path: outputPath });
      setWebcamRecording(true);
      message.success(t('webcam.recordStart'));
    } catch (e: any) {
      message.error((e?.response?.data?.detail || e.message || e));
    }
  }, [webcamOpen, message, t]);

  const stopWebcamRecording = useCallback(async () => {
    try {
      const r = await axios.post('/api/webcam/record/stop');
      setWebcamRecording(false);
      const savedPath = r.data?.path || '';
      if (savedPath) {
        message.success(t('webcam.recordSaveCompletePath', { path: savedPath }));
      } else {
        message.success(t('webcam.recordSaveComplete'));
      }
    } catch (e: any) {
      message.error((e?.response?.data?.detail || e.message || e));
    }
  }, [message, t]);

  const pauseRecording = useCallback(async () => {
    try { await axios.post('/api/webcam/record/pause'); } catch { /* ignore */ }
  }, []);

  const resumeRecording = useCallback(async () => {
    try { await axios.post('/api/webcam/record/resume'); } catch { /* ignore */ }
  }, []);

  // ------------------------------------------------------------
  // 레거시 호환 stubs (브라우저 MediaRecorder 시절 API — 이제 더 이상 사용 안 됨)
  // ------------------------------------------------------------
  const loadWebcamCapabilities = useCallback(() => {
    // 백엔드가 OpenCV로 직접 제어 — 세부 capabilities는 Level 2에서 노출 예정
    setWebcamCapabilities({});
    setWebcamSettings({});
  }, []);

  const applyWebcamSetting = useCallback(async (_key: string, _value: number) => {
    // Level 2: backend set_camera_property
  }, []);

  const uploadFnRef = useRef<((blob: Blob, filename: string) => Promise<string>) | null>(null);
  const setUploadFn = useCallback((fn: ((blob: Blob, filename: string) => Promise<string>) | null) => {
    uploadFnRef.current = fn;
  }, []);

  const isStreamReady = useCallback(() => {
    return webcamOpen;
  }, [webcamOpen]);

  return {
    webcamOpen,
    webcamIndex,
    webcamDevices: webcamDevices.map(d => ({ deviceId: String(d.index), label: d.label, kind: 'videoinput' })) as any,
    webcamVideoRef,
    webcamRecording,
    webcamSettingsOpen,
    setWebcamSettingsOpen,
    webcamCapabilities,
    webcamSettings,
    webcamResolution,
    webcamResolutions,
    handleWebcamToggle,
    handleWebcamChange,
    handleWebcamResolutionChange,
    startWebcamRecording,
    stopWebcamRecording,
    loadWebcamCapabilities,
    applyWebcamSetting,
    stopWebcam,
    setUploadFn,
    timestampPosition,
    setTimestampPosition,
    timestampColor,
    setTimestampColor,
    timestampFontSize,
    setTimestampFontSize,
    startRecordingAuto,
    stopRecordingAuto,
    pauseRecording,
    resumeRecording,
    isStreamReady,
  };
}
