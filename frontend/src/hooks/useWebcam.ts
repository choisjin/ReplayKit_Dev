import { useState, useRef, useCallback, useEffect } from 'react';
import { App } from 'antd';
import { useTranslation } from '../i18n';

export function useWebcam() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [webcamOpen, setWebcamOpen] = useState(false);
  const [webcamIndex, setWebcamIndex] = useState(0);
  const [webcamDevices, setWebcamDevices] = useState<MediaDeviceInfo[]>([]);
  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const [webcamRecording, setWebcamRecording] = useState(false);
  const webcamRecorderRef = useRef<MediaRecorder | null>(null);
  const webcamChunksRef = useRef<Blob[]>([]);
  const webcamFileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const [webcamSettingsOpen, setWebcamSettingsOpen] = useState(false);
  const [webcamCapabilities, setWebcamCapabilities] = useState<Record<string, any>>({});
  const [webcamSettings, setWebcamSettings] = useState<Record<string, number>>({});
  const [webcamResolution, setWebcamResolution] = useState('');
  const [webcamResolutions, setWebcamResolutions] = useState<string[]>([]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (overlayAnimFrameRef.current) cancelAnimationFrame(overlayAnimFrameRef.current);
      if (webcamStreamRef.current) {
        webcamStreamRef.current.getTracks().forEach(t => t.stop());
        webcamStreamRef.current = null;
      }
    };
  }, []);

  const enumerateWebcams = useCallback(async () => {
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
      tempStream.getTracks().forEach(t => t.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      setWebcamDevices(videoDevices);
    } catch {
      setWebcamDevices([]);
    }
  }, []);

  const probeWebcamResolutions = useCallback(async (deviceId?: string) => {
    const candidates = [
      { w: 3840, h: 2160 }, { w: 2560, h: 1440 }, { w: 1920, h: 1080 },
      { w: 1280, h: 720 }, { w: 960, h: 540 }, { w: 640, h: 480 }, { w: 320, h: 240 },
    ];
    const supported: string[] = [];
    for (const c of candidates) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            width: { exact: c.w },
            height: { exact: c.h },
          },
        });
        s.getTracks().forEach(t => t.stop());
        supported.push(`${c.w}x${c.h}`);
      } catch { /* not supported */ }
    }
    setWebcamResolutions(supported);
    return supported;
  }, []);

  const startWebcam = useCallback(async (deviceIndex: number, resolution?: string) => {
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach(t => t.stop());
      webcamStreamRef.current = null;
      // OS가 카메라를 해제할 시간 확보
      await new Promise(r => setTimeout(r, 300));
    }
    try {
      const devices = webcamDevices.length > 0 ? webcamDevices : [];
      const videoConstraints: any = devices[deviceIndex]
        ? { deviceId: { exact: devices[deviceIndex].deviceId } }
        : {};
      if (resolution) {
        const [w, h] = resolution.split('x').map(Number);
        videoConstraints.width = { ideal: w };
        videoConstraints.height = { ideal: h };
      }
      const constraints: MediaStreamConstraints = {
        video: Object.keys(videoConstraints).length > 0 ? videoConstraints : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      webcamStreamRef.current = stream;
      if (webcamVideoRef.current) {
        webcamVideoRef.current.srcObject = stream;
      }
      const track = stream.getVideoTracks()[0];
      if (track) {
        const settings = track.getSettings();
        setWebcamResolution(`${settings.width}x${settings.height}`);
      }
    } catch (e: any) {
      message.error(t('webcam.openFailed') + ': ' + (e.message || e));
    }
  }, [webcamDevices, t]);

  const stopWebcam = useCallback(() => {
    if (webcamRecorderRef.current && webcamRecorderRef.current.state !== 'inactive') {
      webcamRecorderRef.current.stop();
      webcamRecorderRef.current = null;
      setWebcamRecording(false);
    }
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach(t => t.stop());
      webcamStreamRef.current = null;
    }
    if (webcamVideoRef.current) {
      webcamVideoRef.current.srcObject = null;
    }
  }, []);

  const handleWebcamToggle = useCallback(async (keys: string | string[]) => {
    const isOpen = Array.isArray(keys) ? keys.includes('webcam') : keys === 'webcam';
    setWebcamOpen(isOpen);
    if (isOpen) {
      await enumerateWebcams();
      await startWebcam(webcamIndex);
      const devices = webcamDevices.length > 0 ? webcamDevices : [];
      probeWebcamResolutions(devices[webcamIndex]?.deviceId);
    } else {
      stopWebcam();
    }
  }, [webcamIndex, webcamDevices, enumerateWebcams, startWebcam, stopWebcam, probeWebcamResolutions]);

  const handleWebcamChange = useCallback(async (idx: number) => {
    setWebcamIndex(idx);
    if (webcamOpen) {
      await startWebcam(idx);
      const devices = webcamDevices.length > 0 ? webcamDevices : [];
      probeWebcamResolutions(devices[idx]?.deviceId);
    }
  }, [webcamOpen, webcamDevices, startWebcam, probeWebcamResolutions]);

  const handleWebcamResolutionChange = useCallback(async (res: string) => {
    setWebcamResolution(res);
    await startWebcam(webcamIndex, res);
  }, [webcamIndex, startWebcam]);

  // 타임스탬프 오버레이
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayAnimFrameRef = useRef<number>(0);
  const [timestampPosition, setTimestampPosition] = useState<'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'off'>('bottom-right');
  const timestampPosRef = useRef(timestampPosition);
  timestampPosRef.current = timestampPosition;

  /**
   * 웹캠 스트림 위에 타임스탬프를 오버레이하여 새 MediaStream을 반환.
   * 우측 하단에 yyyy-MM-dd HH:mm:ss 형식으로 표시.
   */
  const createOverlayStream = useCallback((sourceStream: MediaStream): MediaStream => {
    const videoTrack = sourceStream.getVideoTracks()[0];
    if (!videoTrack) return sourceStream;

    const settings = videoTrack.getSettings();
    const w = settings.width || 640;
    const h = settings.height || 480;

    let canvas = overlayCanvasRef.current;
    if (!canvas) {
      canvas = document.createElement('canvas');
      overlayCanvasRef.current = canvas;
    }
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d')!;
    const video = webcamVideoRef.current;

    const drawFrame = () => {
      if (!video || video.paused || video.ended) {
        overlayAnimFrameRef.current = requestAnimationFrame(drawFrame);
        return;
      }
      ctx.drawImage(video, 0, 0, w, h);

      const pos = timestampPosRef.current;
      if (pos !== 'off') {
        const now = new Date();
        const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

        const fontSize = Math.max(14, Math.round(h * 0.03));
        ctx.font = `${fontSize}px monospace`;
        const metrics = ctx.measureText(ts);
        const pad = 4;
        const margin = 6;
        const boxW = metrics.width + pad * 2;
        const boxH = fontSize + pad * 2;

        let bx: number, by: number, tx: number, ty: number;
        if (pos === 'top-left') {
          bx = margin; by = margin;
          ctx.textAlign = 'left'; ctx.textBaseline = 'top';
          tx = margin + pad; ty = margin + pad;
        } else if (pos === 'top-right') {
          bx = w - boxW - margin; by = margin;
          ctx.textAlign = 'right'; ctx.textBaseline = 'top';
          tx = w - margin - pad; ty = margin + pad;
        } else if (pos === 'bottom-left') {
          bx = margin; by = h - boxH - margin;
          ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
          tx = margin + pad; ty = h - margin - pad;
        } else {
          bx = w - boxW - margin; by = h - boxH - margin;
          ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
          tx = w - margin - pad; ty = h - margin - pad;
        }

        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(bx, by, boxW, boxH);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(ts, tx, ty);
      }

      overlayAnimFrameRef.current = requestAnimationFrame(drawFrame);
    };

    overlayAnimFrameRef.current = requestAnimationFrame(drawFrame);
    return canvas.captureStream(30);
  }, []);

  const stopOverlay = useCallback(() => {
    if (overlayAnimFrameRef.current) {
      cancelAnimationFrame(overlayAnimFrameRef.current);
      overlayAnimFrameRef.current = 0;
    }
  }, []);

  // Auto-recording: resolve promise with blob when stopped
  const autoRecordResolveRef = useRef<((blob: Blob) => void) | null>(null);

  const startRecordingAuto = useCallback(async (): Promise<boolean> => {
    if (!webcamStreamRef.current) return false;
    // Stop any existing recording
    if (webcamRecorderRef.current && webcamRecorderRef.current.state !== 'inactive') {
      webcamRecorderRef.current.stop();
    }
    stopOverlay();
    webcamChunksRef.current = [];
    const overlayStream = createOverlayStream(webcamStreamRef.current);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm';
    const recorder = new MediaRecorder(overlayStream, { mimeType });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) webcamChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stopOverlay();
      const blob = new Blob(webcamChunksRef.current, { type: mimeType });
      webcamChunksRef.current = [];
      if (autoRecordResolveRef.current) {
        autoRecordResolveRef.current(blob);
        autoRecordResolveRef.current = null;
      }
    };
    recorder.start(1000);
    webcamRecorderRef.current = recorder;
    setWebcamRecording(true);
    return true;
  }, [createOverlayStream, stopOverlay]);

  const stopRecordingAuto = useCallback((): Promise<Blob> => {
    return new Promise((resolve) => {
      autoRecordResolveRef.current = resolve;
      if (webcamRecorderRef.current && webcamRecorderRef.current.state !== 'inactive') {
        webcamRecorderRef.current.stop();
        webcamRecorderRef.current = null;
      }
      setWebcamRecording(false);
    });
  }, []);

  // Optional uploader: set by the consuming component to upload to server
  const uploadFnRef = useRef<((blob: Blob, filename: string) => Promise<string>) | null>(null);

  const setUploadFn = useCallback((fn: ((blob: Blob, filename: string) => Promise<string>) | null) => {
    uploadFnRef.current = fn;
  }, []);

  const startWebcamRecording = useCallback(async () => {
    if (!webcamStreamRef.current) {
      message.error(t('webcam.notActive'));
      return;
    }

    const useServerUpload = !!uploadFnRef.current;

    // If no server upload configured, use file picker as fallback
    if (!useServerUpload) {
      try {
        const fileHandle = await (window as any).showSaveFilePicker({
          suggestedName: `webcam_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`,
          types: [{ description: 'WebM Video', accept: { 'video/webm': ['.webm'] } }],
        });
        webcamFileHandleRef.current = fileHandle;
      } catch {
        return;
      }
    }

    stopOverlay();
    webcamChunksRef.current = [];
    const overlayStream = createOverlayStream(webcamStreamRef.current);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    const recorder = new MediaRecorder(overlayStream, { mimeType });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) webcamChunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      stopOverlay();
      const blob = new Blob(webcamChunksRef.current, { type: mimeType });
      webcamChunksRef.current = [];
      try {
        if (uploadFnRef.current) {
          const filename = `webcam_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
          const path = await uploadFnRef.current(blob, filename);
          message.success(t('webcam.recordSaveCompletePath', { path }));
        } else {
          const handle = webcamFileHandleRef.current;
          if (handle) {
            const writable = await (handle as any).createWritable();
            await writable.write(blob);
            await writable.close();
            message.success(t('webcam.recordSaveComplete'));
          }
        }
      } catch (e: any) {
        message.error(t('webcam.fileSaveFailed') + ': ' + (e.message || e));
      }
      webcamFileHandleRef.current = null;
    };
    recorder.start(1000);
    webcamRecorderRef.current = recorder;
    setWebcamRecording(true);
    message.success(t('webcam.recordStart'));
  }, [t, createOverlayStream, stopOverlay]);

  const stopWebcamRecording = useCallback(() => {
    if (webcamRecorderRef.current && webcamRecorderRef.current.state !== 'inactive') {
      webcamRecorderRef.current.stop();
      webcamRecorderRef.current = null;
    }
    setWebcamRecording(false);
  }, []);

  const loadWebcamCapabilities = useCallback(() => {
    if (!webcamStreamRef.current) return;
    const track = webcamStreamRef.current.getVideoTracks()[0];
    if (!track) return;
    const caps = (track as any).getCapabilities?.() || {};
    const settings = (track as any).getSettings?.() || {};
    const supported: Record<string, any> = {};
    const current: Record<string, number> = {};
    const WEBCAM_SETTING_KEYS = ['brightness', 'contrast', 'sharpness', 'exposureTime'];
    for (const key of WEBCAM_SETTING_KEYS) {
      if (caps[key] && typeof caps[key] === 'object' && 'min' in caps[key]) {
        supported[key] = caps[key];
        current[key] = settings[key] ?? caps[key].min;
      }
    }
    setWebcamCapabilities(supported);
    setWebcamSettings(current);
  }, []);

  const applyWebcamSetting = useCallback(async (key: string, value: number) => {
    if (!webcamStreamRef.current) return;
    const track = webcamStreamRef.current.getVideoTracks()[0];
    if (!track) return;
    try {
      if (key === 'exposureTime') {
        await (track as any).applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime: value }] });
      } else {
        await (track as any).applyConstraints({ advanced: [{ [key]: value }] });
      }
      setWebcamSettings(prev => ({ ...prev, [key]: value }));
    } catch (e: any) {
      message.error(t('webcam.settingFailed') + ': ' + (e.message || e));
    }
  }, [t]);

  return {
    webcamOpen,
    webcamIndex,
    webcamDevices,
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
    startRecordingAuto,
    stopRecordingAuto,
    pauseRecording: useCallback(() => {
      if (webcamRecorderRef.current && webcamRecorderRef.current.state === 'recording') {
        webcamRecorderRef.current.pause();
      }
    }, []),
    resumeRecording: useCallback(() => {
      if (webcamRecorderRef.current && webcamRecorderRef.current.state === 'paused') {
        webcamRecorderRef.current.resume();
      }
    }, []),
    /** 스트림이 활성 상태인지 확인 */
    isStreamReady: useCallback(() => {
      const stream = webcamStreamRef.current;
      if (!stream) return false;
      const tracks = stream.getVideoTracks();
      return tracks.length > 0 && tracks[0].readyState === 'live';
    }, []),
  };
}
