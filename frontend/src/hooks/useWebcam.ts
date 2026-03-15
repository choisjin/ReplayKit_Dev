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
    }
    try {
      const devices = webcamDevices.length > 0 ? webcamDevices : [];
      const videoConstraints: any = devices[deviceIndex]
        ? { deviceId: { exact: devices[deviceIndex].deviceId } }
        : {};
      if (resolution) {
        const [w, h] = resolution.split('x').map(Number);
        videoConstraints.width = { exact: w };
        videoConstraints.height = { exact: h };
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

    webcamChunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    const recorder = new MediaRecorder(webcamStreamRef.current, { mimeType });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) webcamChunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
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
  }, [t]);

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
  };
}
