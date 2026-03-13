import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Button, Card, Col, Image, Input, Modal, Row, Select, Space, InputNumber, message, List, Tag, Popover, Tooltip } from 'antd';
import { PlayCircleOutlined, PauseOutlined, PlusOutlined, SwapOutlined, FolderOpenOutlined, SaveOutlined, DeleteOutlined, ArrowUpOutlined, ArrowDownOutlined, BranchesOutlined, ScissorOutlined, CameraOutlined, ThunderboltOutlined, CheckCircleOutlined, CloseCircleOutlined, WarningOutlined, EditOutlined } from '@ant-design/icons';
import { deviceApi, scenarioApi } from '../services/api';
import { useDevice } from '../context/DeviceContext';
import { useSettings } from '../context/SettingsContext';
import { useWebcam } from '../hooks/useWebcam';
import WebcamPanel from '../components/WebcamPanel';
import { useTranslation } from '../i18n';
import type { TranslationKey } from '../i18n/translations';

const { Option } = Select;
const { TextArea } = Input;

// Extracted outside to prevent re-creation on every render
const JumpEditorInner = React.memo(({ step, index, steps, onUpdate, t }: {
  step: Step;
  index: number;
  steps: Step[];
  onUpdate: (index: number, field: 'on_pass_goto' | 'on_fail_goto', value: number | null) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) => (
  <Space direction="vertical" size={4} style={{ padding: 4 }}>
    <div style={{ fontSize: 12, fontWeight: 600 }}>{t('record.conditionalJumpTitle', { index: String(index + 1) })}</div>
    <Space size={4}>
      <Tag color="green" style={{ margin: 0 }}>Pass →</Tag>
      <Select
        size="small"
        allowClear
        placeholder={t('common.next')}
        value={step.on_pass_goto ?? undefined}
        onChange={(v) => onUpdate(index, 'on_pass_goto', v ?? null)}
        style={{ width: 120 }}
      >
        {steps.map((_s, i) => (
          <Option key={i} value={i + 1} disabled={i === index}>
            #{i + 1} {_s.type}
          </Option>
        ))}
        <Option value={-1}>{t('record.end')}</Option>
      </Select>
    </Space>
    <Space size={4}>
      <Tag color="red" style={{ margin: 0 }}>Fail →</Tag>
      <Select
        size="small"
        allowClear
        placeholder={t('common.next')}
        value={step.on_fail_goto ?? undefined}
        onChange={(v) => onUpdate(index, 'on_fail_goto', v ?? null)}
        style={{ width: 120 }}
      >
        {steps.map((_s, i) => (
          <Option key={i} value={i + 1} disabled={i === index}>
            #{i + 1} {_s.type}
          </Option>
        ))}
        <Option value={-1}>{t('record.end')}</Option>
      </Select>
    </Space>
  </Space>
));

interface ROI { x: number; y: number; width: number; height: number }
interface CropItem { image: string; label: string; roi?: ROI | null }

interface Step {
  id: number;
  type: string;
  device_id: string | null;
  params: Record<string, any>;
  delay_after_ms: number;
  description: string;
  expected_image: string | null;
  on_pass_goto?: number | null;
  on_fail_goto?: number | null;
  roi?: ROI | null;
  compare_mode?: 'full' | 'single_crop' | 'full_exclude' | 'multi_crop';
  exclude_rois?: ROI[];
  expected_images?: CropItem[];
}

// Annotated thumbnail: draws expected image with colored region rectangles
const AnnotatedThumbnail = React.memo(({ src, regions, color, height = 48 }: {
  src: string;
  regions: ROI[];
  color: string;
  height?: number;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const drawAnnotations = useCallback((canvas: HTMLCanvasElement, img: HTMLImageElement, w: number, h: number) => {
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    const sx = w / img.width;
    const sy = h / img.height;
    regions.forEach((r) => {
      ctx.fillStyle = color === 'red' ? 'rgba(255,77,79,0.3)' : 'rgba(82,196,26,0.3)';
      ctx.fillRect(r.x * sx, r.y * sy, r.width * sx, r.height * sy);
      ctx.strokeStyle = color === 'red' ? '#ff4d4f' : '#52c41a';
      ctx.lineWidth = Math.max(1.5, 2 * sx);
      ctx.strokeRect(r.x * sx, r.y * sy, r.width * sx, r.height * sy);
    });
  }, [regions, color]);

  useEffect(() => {
    const img = new window.Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const aspect = img.width / img.height;
      drawAnnotations(canvas, img, Math.round(height * aspect), height);
    };
    img.src = src;
  }, [src, regions, color, height, drawAnnotations]);

  const handleClick = useCallback(() => {
    const img = new window.Image();
    img.onload = () => {
      const offscreen = document.createElement('canvas');
      drawAnnotations(offscreen, img, img.width, img.height);
      setPreviewUrl(offscreen.toDataURL('image/png'));
    };
    img.src = src;
  }, [src, drawAnnotations]);

  return (
    <>
      <canvas ref={canvasRef} style={{ height, borderRadius: 2, cursor: 'pointer' }} onClick={handleClick} />
      {previewUrl && (
        <Image
          src={previewUrl}
          style={{ display: 'none' }}
          preview={{ visible: true, onVisibleChange: (v) => { if (!v) setPreviewUrl(null); } }}
        />
      )}
    </>
  );
});

// Gesture detection thresholds
const LONG_PRESS_THRESHOLD_MS = 500;
const SWIPE_DISTANCE_THRESHOLD = 20;

export default function RecordPage() {
  const { t } = useTranslation();
  const {
    primaryDevices, auxiliaryDevices, fetchDevices,
    screenshotDeviceId, setScreenshotDeviceId, screenshot,
    pollInterval, setPollInterval, refreshScreenshot,
  } = useDevice();

  const [recording, setRecording] = useState(false);
  const [scenarioName, setScenarioName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);

  // Scenario load/edit
  const [savedScenarios, setSavedScenarios] = useState<string[]>([]);
  const [editingExisting, setEditingExisting] = useState(false);
  const [originalScenarioName, setOriginalScenarioName] = useState('');

  // Pending background step count
  const pendingStepsRef = useRef(0);
  const [hasPendingSteps, setHasPendingSteps] = useState(false);

  // Detected gesture display
  const [lastGesture, setLastGesture] = useState('');

  // Settings
  const { settings, uploadWebcamRecording } = useSettings();

  // Webcam (shared hook)
  const webcam = useWebcam();
  const {
    webcamOpen, webcamIndex, webcamDevices, webcamVideoRef, webcamRecording,
    webcamSettingsOpen, setWebcamSettingsOpen, webcamCapabilities, webcamSettings,
    webcamResolution, webcamResolutions,
    handleWebcamToggle, handleWebcamChange, handleWebcamResolutionChange,
    startWebcamRecording, stopWebcamRecording, loadWebcamCapabilities, applyWebcamSetting,
    stopWebcam, setUploadFn,
  } = webcam;

  // Wire up webcam upload when save dir is configured
  useEffect(() => {
    if (settings.webcam_save_dir) {
      setUploadFn(uploadWebcamRecording);
    } else {
      setUploadFn(null);
    }
  }, [settings.webcam_save_dir, setUploadFn, uploadWebcamRecording]);

  // Wait step insertion
  const [waitDurationMs, setWaitDurationMs] = useState(1000);
  const waitDurationRef = useRef(1000);

  // Per-step controls (for manual step input)
  const [stepDeviceId, setStepDeviceId] = useState('');
  const [stepType, setStepType] = useState('tap');
  const [delayMs, setDelayMs] = useState(1000);
  const [stepDesc, setStepDesc] = useState('');
  const [serialData, setSerialData] = useState('');
  const [serialResponse, setSerialResponse] = useState('');
  const [serialSending, setSerialSending] = useState(false);

  // Module command
  const [moduleFunctions, setModuleFunctions] = useState<{ name: string; params: { name: string; required: boolean; default?: string }[] }[]>([]);
  const [selectedModuleFunc, setSelectedModuleFunc] = useState('');
  const [moduleFuncArgs, setModuleFuncArgs] = useState<Record<string, string>>({});

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const allDevices = [...primaryDevices, ...auxiliaryDevices];

  // Expected image manual capture
  const [captureStepIndex, setCaptureStepIndex] = useState<number | null>(null);
  const [captureModalOpen, setCaptureModalOpen] = useState(false);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const captureScreenshotRef = useRef<string>('');
  const captureDragRef = useRef<{ startX: number; startY: number; curX: number; curY: number; active: boolean }>({
    startX: 0, startY: 0, curX: 0, curY: 0, active: false,
  });

  // Step test
  const [testResultModalOpen, setTestResultModalOpen] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [testingStepIndex, setTestingStepIndex] = useState<number | null>(null);

  // Step command edit modal
  const [editStepIndex, setEditStepIndex] = useState<number | null>(null);
  const [editStepParams, setEditStepParams] = useState<Record<string, any>>({});
  const editCanvasRef = useRef<HTMLCanvasElement>(null);
  const editGestureRef = useRef<{ startX: number; startY: number; startTime: number; active: boolean }>({ startX: 0, startY: 0, startTime: 0, active: false });

  // ROI crop modal
  const [roiEditingIndex, setRoiEditingIndex] = useState<number | null>(null);
  const [roiModalOpen, setRoiModalOpen] = useState(false);
  const roiCanvasRef = useRef<HTMLCanvasElement>(null);
  const roiScreenshotRef = useRef<string>(''); // captured screenshot for ROI modal
  const roiDragRef = useRef<{ startX: number; startY: number; curX: number; curY: number; active: boolean }>({
    startX: 0, startY: 0, curX: 0, curY: 0, active: false,
  });

  // Exclude ROI modal (for full_exclude mode)
  const [excludeRoiEditingIndex, setExcludeRoiEditingIndex] = useState<number | null>(null);
  const [excludeRoiModalOpen, setExcludeRoiModalOpen] = useState(false);
  const [excludeRoiSelectedIdx, setExcludeRoiSelectedIdx] = useState<number | null>(null); // selected region to replace

  // Multi-crop modal (for multi_crop mode)
  const [multiCropModalOpen, setMultiCropModalOpen] = useState(false);
  const [multiCropEditingIndex, setMultiCropEditingIndex] = useState<number | null>(null);
  const [multiCropSelectedIdx, setMultiCropSelectedIdx] = useState<number | null>(null);
  const multiCropCanvasRef = useRef<HTMLCanvasElement>(null);
  const multiCropScreenshotRef = useRef<string>('');
  const multiCropDragRef = useRef<{ startX: number; startY: number; curX: number; curY: number; active: boolean }>({
    startX: 0, startY: 0, curX: 0, curY: 0, active: false,
  });

  const excludeRoiCanvasRef = useRef<HTMLCanvasElement>(null);
  const excludeRoiScreenshotRef = useRef<string>('');
  const excludeRoiDragRef = useRef<{ startX: number; startY: number; curX: number; curY: number; active: boolean }>({
    startX: 0, startY: 0, curX: 0, curY: 0, active: false,
  });

  // Gesture detection state
  const gestureRef = useRef<{
    startX: number; startY: number;
    startTime: number; active: boolean;
  }>({ startX: 0, startY: 0, startTime: 0, active: false });

  // Fetch devices on mount & sync recording state with backend
  useEffect(() => {
    fetchDevices();
    // If backend is still recording (e.g. server didn't restart cleanly), stop it
    scenarioApi.recordingStatus().then(res => {
      if (res.data.recording) {
        scenarioApi.stopRecording().catch(() => {});
      }
    }).catch(() => {});
  }, []);

  // Auto-select first primary device for screen
  useEffect(() => {
    if (!screenshotDeviceId && primaryDevices.length > 0) {
      const ready = primaryDevices.find(d => d.status === 'device' || d.status === 'connected');
      if (ready) setScreenshotDeviceId(ready.id);
    }
  }, [primaryDevices]);

  // Get selected step device info
  const stepDevice = allDevices.find(d => d.id === stepDeviceId);
  const isStepPrimary = stepDevice?.category === 'primary';
  const isStepAuxiliary = stepDevice?.category === 'auxiliary';

  // Get current screen device info
  const screenDevice = primaryDevices.find(d => d.id === screenshotDeviceId);
  const deviceRes = screenDevice?.info?.resolution ?? { width: 1080, height: 1920 };

  // Note: step device selection no longer auto-switches the screenshot.
  // The screenshot device is only changed via the explicit device selector.

  // Auto-select step types based on device category + fetch module functions
  const stepDeviceModule = allDevices.find(d => d.id === stepDeviceId)?.info?.module as string | undefined;

  useEffect(() => {
    if (isStepAuxiliary) {
      if (stepDeviceModule) {
        setStepType('module_command');
        deviceApi.getModuleFunctions(stepDeviceModule).then(res => {
          setModuleFunctions(res.data.functions || []);
          setSelectedModuleFunc('');
          setModuleFuncArgs({});
        }).catch(() => setModuleFunctions([]));
      } else {
        setStepType('serial_command');
        setModuleFunctions([]);
      }
    } else if (isStepPrimary && (stepType === 'serial_command' || stepType === 'module_command')) {
      setStepType('tap');
      setModuleFunctions([]);
    }
  }, [stepDeviceId]);

  // Stop screenshot polling & webcam when leaving page
  useEffect(() => {
    return () => {
      setScreenshotDeviceId('');
      stopWebcam();
    };
  }, []);

  // Helper: convert canvas coords to device coords
  const toDeviceCoords = (canvas: HTMLCanvasElement, clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    // Use canvas internal resolution (= actual image size) for accurate scaling
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: Math.round((clientX - rect.left) * scaleX),
      y: Math.round((clientY - rect.top) * scaleY),
    };
  };

  // Execute or record an action
  const executeAction = useCallback(async (action: string, params: Record<string, any>, desc: string) => {
    const targetDevice = recording ? (stepDeviceId || screenshotDeviceId) : screenshotDeviceId;
    if (!targetDevice) return;

    if (recording) {
      // Optimistic UI: show step immediately
      const tempId = steps.length + 1;
      const optimisticStep: Step = {
        id: tempId, type: action, device_id: targetDevice,
        params, delay_after_ms: delayMs, description: desc, expected_image: null,
      };
      setSteps((prev) => [...prev, optimisticStep]);

      // Execute on device immediately for fast response
      deviceApi.input(targetDevice, action, params).then(() => {
        refreshScreenshot();
      }).catch((e: any) => {
        message.error(e.response?.data?.detail || t('record.inputFailed'));
      });

      // Record step in background (skip_execute since we already ran it)
      pendingStepsRef.current += 1;
      setHasPendingSteps(true);
      scenarioApi.addStep({
        type: action,
        device_id: targetDevice,
        params,
        description: desc,
        delay_after_ms: delayMs,
        skip_execute: true,
      }).then(res => {
        // Replace optimistic step with real one
        setSteps((prev) => prev.map(s => s === optimisticStep ? res.data.step : s));
      }).catch((e: any) => {
        message.error(e.response?.data?.detail || t('record.stepRecordFailed'));
        setSteps((prev) => prev.filter(s => s !== optimisticStep));
      }).finally(() => {
        pendingStepsRef.current -= 1;
        if (pendingStepsRef.current <= 0) {
          pendingStepsRef.current = 0;
          setHasPendingSteps(false);
        }
      });
    } else {
      // Fire input and refresh in parallel — don't wait for input to complete
      deviceApi.input(targetDevice, action, params).catch((e: any) => {
        message.error(e.response?.data?.detail || t('record.inputFailed'));
      });
      // Short delay then refresh (device needs a moment to process input)
      setTimeout(() => refreshScreenshot(), 150);
    }
  }, [recording, stepDeviceId, screenshotDeviceId, delayMs, refreshScreenshot]);

  // --- ROI Modal logic ---
  // Draw on the ROI canvas using the captured screenshot (not reactive screenshot)
  const drawRoiCanvas = useCallback((dragRect?: { x: number; y: number; w: number; h: number }) => {
    const canvas = roiCanvasRef.current;
    const src = roiScreenshotRef.current;
    if (!canvas || !src) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new window.Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      // Existing ROI (green)
      if (roiEditingIndex != null && !dragRect) {
        const step = steps[roiEditingIndex];
        const roi = step?.roi;
        if (roi) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.clearRect(roi.x, roi.y, roi.width, roi.height);
          ctx.drawImage(img, roi.x, roi.y, roi.width, roi.height, roi.x, roi.y, roi.width, roi.height);
          ctx.strokeStyle = '#52c41a';
          ctx.lineWidth = 3;
          ctx.strokeRect(roi.x, roi.y, roi.width, roi.height);
          ctx.fillStyle = '#52c41a';
          ctx.font = '28px sans-serif';
          ctx.fillText(`${roi.width}×${roi.height}`, roi.x + 6, roi.y - 10);
        }
      }

      // Drag rectangle (red)
      if (dragRect && dragRect.w > 5 && dragRect.h > 5) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.clearRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
        ctx.drawImage(img, dragRect.x, dragRect.y, dragRect.w, dragRect.h, dragRect.x, dragRect.y, dragRect.w, dragRect.h);
        ctx.strokeStyle = '#ff4d4f';
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
        ctx.setLineDash([]);
        ctx.fillStyle = '#ff4d4f';
        ctx.font = '28px sans-serif';
        ctx.fillText(`${dragRect.w}×${dragRect.h}`, dragRect.x + 6, dragRect.y - 10);
      }
    };
    img.src = src;
  }, [roiEditingIndex, steps]);

  // --- Expected image capture (server-side screenshot, no large base64 transfer) ---
  const saveExpectedFull = useCallback(async (stepIdx: number) => {
    if (!scenarioName || !screenshotDeviceId) return;
    try {
      const res = await scenarioApi.captureExpectedImage(scenarioName, stepIdx, screenshotDeviceId);
      setSteps(prev => prev.map((s, i) => i === stepIdx ? { ...s, expected_image: res.data.filename } : s));
      message.success(t('record.expectedSaved', { index: stepIdx + 1 }));
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('record.expectedImageSaveFailed'));
    }
  }, [scenarioName, screenshotDeviceId]);

  const openCaptureModal = useCallback((stepIdx: number) => {
    captureScreenshotRef.current = screenshot || '';
    setCaptureStepIndex(stepIdx);
    setCaptureModalOpen(true);
  }, [screenshot]);

  const testStep = useCallback(async (stepIdx: number) => {
    if (!scenarioName) {
      message.warning(t('record.saveScenarioFirst'));
      return;
    }
    setTestingStepIndex(stepIdx);
    try {
      const currentStep = steps[stepIdx];
      const res = await scenarioApi.testStep(scenarioName, stepIdx, currentStep);
      setTestResult(res.data);
      setTestResultModalOpen(true);
      refreshScreenshot();
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('record.stepTestFailed'));
    } finally {
      setTestingStepIndex(null);
    }
  }, [scenarioName, steps, refreshScreenshot]);

  const drawCaptureCanvas = useCallback((dragRect?: { x: number; y: number; w: number; h: number }) => {
    const canvas = captureCanvasRef.current;
    const src = captureScreenshotRef.current;
    if (!canvas || !src) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new window.Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      if (dragRect && dragRect.w > 5 && dragRect.h > 5) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.clearRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
        ctx.drawImage(img, dragRect.x, dragRect.y, dragRect.w, dragRect.h, dragRect.x, dragRect.y, dragRect.w, dragRect.h);
        ctx.strokeStyle = '#1890ff';
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
        ctx.setLineDash([]);
        ctx.fillStyle = '#1890ff';
        ctx.font = '28px sans-serif';
        ctx.fillText(`${dragRect.w}×${dragRect.h}`, dragRect.x + 6, dragRect.y - 10);
      }
    };
    img.src = src;
  }, []);

  const captureMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = captureCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    captureDragRef.current = { startX: x, startY: y, curX: x, curY: y, active: true };
  }, []);

  const captureMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!captureDragRef.current.active) return;
    const canvas = captureCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    captureDragRef.current.curX = x;
    captureDragRef.current.curY = y;
    const { startX, startY } = captureDragRef.current;
    drawCaptureCanvas({
      x: Math.min(startX, x), y: Math.min(startY, y),
      w: Math.abs(x - startX), h: Math.abs(y - startY),
    });
  }, [drawCaptureCanvas]);

  const captureMouseUp = useCallback(async () => {
    if (!captureDragRef.current.active) return;
    captureDragRef.current.active = false;
    const { startX, startY, curX, curY } = captureDragRef.current;
    const rx = Math.min(startX, curX);
    const ry = Math.min(startY, curY);
    const rw = Math.abs(curX - startX);
    const rh = Math.abs(curY - startY);
    if (rw > 10 && rh > 10 && captureStepIndex != null && scenarioName && screenshotDeviceId) {
      const crop = { x: rx, y: ry, width: rw, height: rh };
      try {
        const res = await scenarioApi.captureExpectedImage(
          scenarioName, captureStepIndex, screenshotDeviceId, crop,
        );
        setSteps(prev => prev.map((s, i) => i === captureStepIndex ? { ...s, expected_image: res.data.filename } : s));
        message.success(t('record.cropExpectedSaved', { index: captureStepIndex + 1, size: `${rw}×${rh}` }));
        setCaptureModalOpen(false);
        setCaptureStepIndex(null);
      } catch (e: any) {
        console.error('Expected image save error:', e.response?.status, e.response?.data);
        message.error(e.response?.data?.detail || t('record.expectedImageSaveFailed'));
      }
    }
  }, [captureStepIndex, scenarioName, screenshotDeviceId]);

  useEffect(() => {
    if (captureModalOpen) setTimeout(() => drawCaptureCanvas(), 50);
  }, [captureModalOpen]);

  // Open ROI modal — freeze the current screenshot
  const openRoiModal = useCallback((index: number) => {
    roiScreenshotRef.current = screenshot || '';
    setRoiEditingIndex(index);
    setRoiModalOpen(true);
  }, [screenshot]);

  // ROI modal mouse handlers (native resolution)
  const roiMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = roiCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    roiDragRef.current = { startX: x, startY: y, curX: x, curY: y, active: true };
  }, []);

  const roiMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!roiDragRef.current.active) return;
    const canvas = roiCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    roiDragRef.current.curX = x;
    roiDragRef.current.curY = y;
    const { startX, startY } = roiDragRef.current;
    drawRoiCanvas({
      x: Math.min(startX, x), y: Math.min(startY, y),
      w: Math.abs(x - startX), h: Math.abs(y - startY),
    });
  }, [drawRoiCanvas]);

  const roiMouseUp = useCallback(() => {
    if (!roiDragRef.current.active) return;
    roiDragRef.current.active = false;
    const { startX, startY, curX, curY } = roiDragRef.current;
    const rx = Math.min(startX, curX);
    const ry = Math.min(startY, curY);
    const rw = Math.abs(curX - startX);
    const rh = Math.abs(curY - startY);
    if (rw > 10 && rh > 10 && roiEditingIndex != null) {
      const roi = { x: rx, y: ry, width: rw, height: rh };
      setSteps((prev) => prev.map((s, i) => i === roiEditingIndex ? { ...s, roi } : s));
      message.success(t('record.roiSet', { size: `${rw}×${rh}`, pos: `${rx},${ry}` }));
      setRoiModalOpen(false);
      setRoiEditingIndex(null);
    }
  }, [roiEditingIndex]);

  // Draw ROI canvas when modal opens
  useEffect(() => {
    if (roiModalOpen) {
      setTimeout(() => drawRoiCanvas(), 50);
    }
  }, [roiModalOpen]);

  // --- Compare mode helpers ---
  const updateCompareMode = useCallback((index: number, mode: string) => {
    setSteps(prev => prev.map((s, i) => i === index ? { ...s, compare_mode: mode as Step['compare_mode'] } : s));
  }, []);

  // --- Exclude ROI modal handlers ---
  const drawExcludeRoiCanvas = useCallback((dragRect?: { x: number; y: number; w: number; h: number }) => {
    const canvas = excludeRoiCanvasRef.current;
    const src = excludeRoiScreenshotRef.current;
    if (!canvas || !src) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new window.Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      // Draw existing exclude regions
      const stepIdx = excludeRoiEditingIndex;
      if (stepIdx != null) {
        const existing = steps[stepIdx]?.exclude_rois || [];
        existing.forEach((r, ri) => {
          const isSelected = ri === excludeRoiSelectedIdx;
          ctx.fillStyle = isSelected ? 'rgba(24, 144, 255, 0.35)' : 'rgba(255, 0, 0, 0.3)';
          ctx.fillRect(r.x, r.y, r.width, r.height);
          ctx.strokeStyle = isSelected ? '#1890ff' : '#ff4d4f';
          ctx.lineWidth = isSelected ? 3 : 2;
          ctx.strokeRect(r.x, r.y, r.width, r.height);
          ctx.fillStyle = '#fff';
          ctx.font = isSelected ? 'bold 22px sans-serif' : '20px sans-serif';
          ctx.fillText(`#${ri + 1}`, r.x + 4, r.y + 22);
        });
      }
      // Draw current drag rectangle
      if (dragRect && dragRect.w > 5 && dragRect.h > 5) {
        ctx.fillStyle = 'rgba(255, 0, 0, 0.25)';
        ctx.fillRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
        ctx.strokeStyle = '#ff4d4f';
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
        ctx.setLineDash([]);
        ctx.fillStyle = '#ff4d4f';
        ctx.font = '24px sans-serif';
        ctx.fillText(`${dragRect.w}×${dragRect.h}`, dragRect.x + 6, dragRect.y - 8);
      }
    };
    img.src = src;
  }, [excludeRoiEditingIndex, excludeRoiSelectedIdx, steps]);

  const openExcludeRoiModal = useCallback(async (index: number) => {
    excludeRoiScreenshotRef.current = screenshot || '';
    setExcludeRoiEditingIndex(index);
    setExcludeRoiSelectedIdx(null);
    // Auto-capture full screenshot as expected_image if not set
    const step = steps[index];
    if (!step?.expected_image && scenarioName && screenshotDeviceId) {
      try {
        const res = await scenarioApi.captureExpectedImage(scenarioName, index, screenshotDeviceId);
        setSteps(prev => prev.map((s, i) => i === index ? { ...s, expected_image: res.data.filename } : s));
        message.success(t('record.expectedFullCapture'));
      } catch {
        message.error(t('record.expectedCaptureFailed'));
        return;
      }
    }
    setExcludeRoiModalOpen(true);
  }, [screenshot, steps, scenarioName, screenshotDeviceId]);

  const excludeRoiMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = excludeRoiCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    excludeRoiDragRef.current = { startX: x, startY: y, curX: x, curY: y, active: true };
  }, []);

  const excludeRoiMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!excludeRoiDragRef.current.active) return;
    const canvas = excludeRoiCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    excludeRoiDragRef.current.curX = x;
    excludeRoiDragRef.current.curY = y;
    const { startX, startY } = excludeRoiDragRef.current;
    drawExcludeRoiCanvas({
      x: Math.min(startX, x), y: Math.min(startY, y),
      w: Math.abs(x - startX), h: Math.abs(y - startY),
    });
  }, [drawExcludeRoiCanvas]);

  const excludeRoiMouseUp = useCallback(() => {
    if (!excludeRoiDragRef.current.active) return;
    excludeRoiDragRef.current.active = false;
    const { startX, startY, curX, curY } = excludeRoiDragRef.current;
    const rx = Math.min(startX, curX);
    const ry = Math.min(startY, curY);
    const rw = Math.abs(curX - startX);
    const rh = Math.abs(curY - startY);
    if (rw > 10 && rh > 10 && excludeRoiEditingIndex != null) {
      const newRoi = { x: rx, y: ry, width: rw, height: rh };
      if (excludeRoiSelectedIdx != null) {
        // Replace selected region
        setSteps(prev => prev.map((s, i) => {
          if (i !== excludeRoiEditingIndex) return s;
          const rois = [...(s.exclude_rois || [])];
          rois[excludeRoiSelectedIdx] = newRoi;
          return { ...s, exclude_rois: rois };
        }));
        message.success(t('record.excludeModified', { index: excludeRoiSelectedIdx + 1, size: `${rw}×${rh}`, pos: `${rx},${ry}` }));
        setExcludeRoiSelectedIdx(null);
      } else {
        // Append new region
        setSteps(prev => prev.map((s, i) => {
          if (i !== excludeRoiEditingIndex) return s;
          return { ...s, exclude_rois: [...(s.exclude_rois || []), newRoi] };
        }));
        message.success(t('record.excludeAdded', { size: `${rw}×${rh}`, pos: `${rx},${ry}` }));
      }
      // Redraw canvas with updated regions after state update
      setTimeout(() => drawExcludeRoiCanvas(), 50);
    }
  }, [excludeRoiEditingIndex, excludeRoiSelectedIdx, drawExcludeRoiCanvas]);

  const removeExcludeRoi = useCallback((stepIdx: number, roiIdx: number) => {
    setSteps(prev => prev.map((s, i) => {
      if (i !== stepIdx) return s;
      const rois = [...(s.exclude_rois || [])];
      rois.splice(roiIdx, 1);
      return { ...s, exclude_rois: rois };
    }));
  }, []);

  useEffect(() => {
    if (excludeRoiModalOpen) setTimeout(() => drawExcludeRoiCanvas(), 50);
  }, [excludeRoiModalOpen, drawExcludeRoiCanvas]);

  // Redraw exclude canvas when steps change (region added/removed)
  useEffect(() => {
    if (excludeRoiModalOpen) setTimeout(() => drawExcludeRoiCanvas(), 50);
  }, [steps, excludeRoiModalOpen, drawExcludeRoiCanvas]);

  // --- Multi-crop modal helpers ---
  const drawMultiCropCanvas = useCallback((dragRect?: { x: number; y: number; w: number; h: number }) => {
    const canvas = multiCropCanvasRef.current;
    const src = multiCropScreenshotRef.current;
    if (!canvas || !src) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new window.Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      // Draw existing crop regions
      const stepIdx = multiCropEditingIndex;
      if (stepIdx != null) {
        const cropItems = steps[stepIdx]?.expected_images || [];
        cropItems.forEach((ci, ri) => {
          if (!ci.roi) return;
          const isSelected = ri === multiCropSelectedIdx;
          ctx.strokeStyle = isSelected ? '#1890ff' : '#52c41a';
          ctx.lineWidth = isSelected ? 4 : 2;
          ctx.strokeRect(ci.roi.x, ci.roi.y, ci.roi.width, ci.roi.height);
          ctx.fillStyle = isSelected ? 'rgba(24,144,255,0.15)' : 'rgba(82,196,26,0.15)';
          ctx.fillRect(ci.roi.x, ci.roi.y, ci.roi.width, ci.roi.height);
          // Label
          ctx.fillStyle = isSelected ? '#1890ff' : '#52c41a';
          ctx.font = '24px sans-serif';
          ctx.fillText(ci.label || `#${ri + 1}`, ci.roi.x + 4, ci.roi.y + 24);
        });
      }
      // Draw current drag rectangle
      if (dragRect && dragRect.w > 0 && dragRect.h > 0) {
        ctx.strokeStyle = '#faad14';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(250,173,20,0.15)';
        ctx.fillRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
      }
    };
    img.src = src;
  }, [multiCropEditingIndex, multiCropSelectedIdx, steps]);

  const openMultiCropModal = useCallback(async (stepIdx: number) => {
    multiCropScreenshotRef.current = screenshot || '';
    setMultiCropEditingIndex(stepIdx);
    setMultiCropSelectedIdx(null);
    // Auto-capture full screenshot as expected_image if not set
    const step = steps[stepIdx];
    if (!step?.expected_image && scenarioName && screenshotDeviceId) {
      try {
        const res = await scenarioApi.captureExpectedImage(scenarioName, stepIdx, screenshotDeviceId);
        setSteps(prev => prev.map((s, i) => i === stepIdx ? { ...s, expected_image: res.data.filename } : s));
        message.success(t('record.expectedFullCapture'));
      } catch (e: any) {
        message.error(t('record.expectedCaptureFailed'));
        return;
      }
    }
    setMultiCropModalOpen(true);
  }, [screenshot, steps, scenarioName, screenshotDeviceId]);

  const multiCropMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = multiCropCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    multiCropDragRef.current = { startX: x, startY: y, curX: x, curY: y, active: true };
  }, []);

  const multiCropMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!multiCropDragRef.current.active) return;
    const canvas = multiCropCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    multiCropDragRef.current.curX = x;
    multiCropDragRef.current.curY = y;
    const { startX, startY } = multiCropDragRef.current;
    drawMultiCropCanvas({
      x: Math.min(startX, x), y: Math.min(startY, y),
      w: Math.abs(x - startX), h: Math.abs(y - startY),
    });
  }, [drawMultiCropCanvas]);

  const multiCropMouseUp = useCallback(async () => {
    if (!multiCropDragRef.current.active) return;
    multiCropDragRef.current.active = false;
    const { startX, startY, curX, curY } = multiCropDragRef.current;
    const rx = Math.min(startX, curX);
    const ry = Math.min(startY, curY);
    const rw = Math.abs(curX - startX);
    const rh = Math.abs(curY - startY);
    if (rw > 10 && rh > 10 && multiCropEditingIndex != null && scenarioName) {
      const crop = { x: rx, y: ry, width: rw, height: rh };
      try {
        const replaceIdx = multiCropSelectedIdx ?? undefined;
        const res = await scenarioApi.cropFromExpected(scenarioName, multiCropEditingIndex, crop, '', replaceIdx);
        const roi: ROI = res.data.roi;
        const filename: string = res.data.filename;
        setSteps(prev => prev.map((s, i) => {
          if (i !== multiCropEditingIndex) return s;
          const imgs = [...(s.expected_images || [])];
          if (multiCropSelectedIdx != null && multiCropSelectedIdx < imgs.length) {
            imgs[multiCropSelectedIdx] = { ...imgs[multiCropSelectedIdx], image: filename, roi };
          } else {
            imgs.push({ image: filename, label: '', roi });
          }
          return { ...s, expected_images: imgs };
        }));
        if (multiCropSelectedIdx != null) {
          message.success(t('record.cropModified', { index: multiCropSelectedIdx + 1, size: `${rw}×${rh}` }));
          setMultiCropSelectedIdx(null);
        } else {
          message.success(t('record.cropAdded', { size: `${rw}×${rh}` }));
        }
        setTimeout(() => drawMultiCropCanvas(), 50);
      } catch (e: any) {
        message.error(e.response?.data?.detail || t('record.cropSaveFailed'));
      }
    }
  }, [multiCropEditingIndex, multiCropSelectedIdx, scenarioName, drawMultiCropCanvas]);

  const removeMultiCropItem = useCallback((cropIdx: number) => {
    if (multiCropEditingIndex == null) return;
    setSteps(prev => prev.map((s, i) => {
      if (i !== multiCropEditingIndex) return s;
      const imgs = [...(s.expected_images || [])];
      imgs.splice(cropIdx, 1);
      return { ...s, expected_images: imgs };
    }));
    if (multiCropSelectedIdx === cropIdx) setMultiCropSelectedIdx(null);
    else if (multiCropSelectedIdx != null && multiCropSelectedIdx > cropIdx) setMultiCropSelectedIdx(multiCropSelectedIdx - 1);
    setTimeout(() => drawMultiCropCanvas(), 50);
  }, [multiCropEditingIndex, multiCropSelectedIdx, drawMultiCropCanvas]);

  useEffect(() => {
    if (multiCropModalOpen) setTimeout(() => drawMultiCropCanvas(), 50);
  }, [multiCropModalOpen, drawMultiCropCanvas]);

  useEffect(() => {
    if (multiCropModalOpen) setTimeout(() => drawMultiCropCanvas(), 50);
  }, [steps, multiCropModalOpen, drawMultiCropCanvas]);

  // Canvas gesture handlers (no ROI logic here)
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!screenshotDeviceId) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x, y } = toDeviceCoords(canvas, e.clientX, e.clientY);
    gestureRef.current = { startX: x, startY: y, startTime: Date.now(), active: true };
  }, [screenshotDeviceId, deviceRes]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!screenshotDeviceId || !gestureRef.current.active) return;
    gestureRef.current.active = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { startX, startY, startTime } = gestureRef.current;
    const { x: endX, y: endY } = toDeviceCoords(canvas, e.clientX, e.clientY);
    const dist = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);
    const elapsed = Date.now() - startTime;

    if (dist > SWIPE_DISTANCE_THRESHOLD) {
      const durationMs = Math.max(200, Math.min(elapsed, 3000));
      const params = { x1: startX, y1: startY, x2: endX, y2: endY, duration_ms: durationMs };
      executeAction('swipe', params, `swipe (${startX},${startY})→(${endX},${endY}) ${durationMs}ms`);
      setLastGesture(`${t('record.gestureSwipe')} (${startX},${startY})→(${endX},${endY})`);
    } else if (elapsed >= LONG_PRESS_THRESHOLD_MS) {
      const params = { x: startX, y: startY, duration_ms: elapsed };
      executeAction('long_press', params, `long_press (${startX},${startY}) ${elapsed}ms`);
      setLastGesture(`${t('record.gestureLongPress')} (${startX},${startY}) ${elapsed}ms`);
    } else {
      const params = { x: startX, y: startY };
      executeAction('tap', params, `tap (${startX},${startY})`);
      setLastGesture(`${t('record.gestureTap')} (${startX},${startY})`);
    }
  }, [screenshotDeviceId, executeAction, deviceRes]);

  const startRecording = async () => {
    if (!scenarioName.trim()) {
      message.warning(t('record.enterScenarioName'));
      return;
    }
    try {
      if (editingExisting) {
        // Resume recording on loaded scenario
        const res = await scenarioApi.resumeRecording(scenarioName);
        setRecording(true);
        setSteps(res.data.scenario.steps || []);
        message.success(`"${scenarioName}" ${t('record.startSuccess')} (${res.data.scenario.steps?.length || 0})`);
      } else {
        await scenarioApi.startRecording(scenarioName, description);
        setRecording(true);
        setSteps([]);
        message.success(t('record.startSuccess'));
      }
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('record.startFailed'));
    }
  };

  const stopRecording = async () => {
    try {
      const res = await scenarioApi.stopRecording();
      setRecording(false);
      setEditingExisting(true);
      fetchSavedScenarios();
      message.success(t('record.recordComplete', { count: res.data.scenario.steps.length }));
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('record.stopFailed'));
    }
  };

  // Send serial command directly (without recording)
  const sendSerialCommand = async () => {
    if (!stepDeviceId || !serialData.trim()) return;
    setSerialSending(true);
    try {
      const res = await deviceApi.input(stepDeviceId, 'serial_command', { data: serialData });
      setSerialResponse(res.data.response ?? '(no response)');
    } catch (e: any) {
      setSerialResponse(`Error: ${e.response?.data?.detail || e.message}`);
    }
    setSerialSending(false);
  };

  const addManualStep = async () => {
    if (!recording) return;
    let params: Record<string, any> = {};
    if (stepType === 'module_command') {
      if (!selectedModuleFunc) {
        message.warning(t('record.selectFunction2'));
        return;
      }
      params = { module: stepDeviceModule, function: selectedModuleFunc, args: { ...moduleFuncArgs } };
    } else if (stepType === 'serial_command') {
      params = { data: serialData };
    } else if (stepType === 'input_text') {
      params = { text: stepDesc };
    } else if (stepType === 'key_event') {
      params = { keycode: stepDesc || 'KEYCODE_BACK' };
    } else if (stepType === 'wait') {
      params = { duration_ms: delayMs };
    } else if (stepType === 'adb_command') {
      params = { command: stepDesc };
    }

    try {
      const res = await scenarioApi.addStep({
        type: stepType,
        device_id: stepDeviceId,
        params,
        description: stepDesc || (
          stepType === 'module_command' ? `${stepDeviceModule}::${selectedModuleFunc}()` :
          stepType === 'serial_command' ? `Serial: ${serialData.substring(0, 30)}` : ''
        ),
        delay_after_ms: delayMs,
        skip_execute: true,
      });
      setSteps((prev) => [...prev, res.data.step]);
      setStepDesc('');
      setSerialData('');
      message.success(t('record.stepAdded', { id: res.data.step.id }));
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('record.stepAddFailed'));
    }
  };

  // Fetch saved scenario list
  const fetchSavedScenarios = async () => {
    try {
      const res = await scenarioApi.list();
      setSavedScenarios(res.data.scenarios);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    fetchSavedScenarios();
  }, []);

  // Refresh loaded scenario & device list when record tab becomes active
  useEffect(() => {
    const onTabChange = (e: Event) => {
      if ((e as CustomEvent).detail === '/record') {
        fetchDevices();
        // Reload scenario if one is loaded (to pick up device name changes etc.)
        if (editingExisting && scenarioName) {
          scenarioApi.get(scenarioName).then(res => {
            setSteps(res.data.steps || []);
            setDescription(res.data.description || '');
          }).catch(() => {});
        }
        fetchSavedScenarios();
      }
    };
    window.addEventListener('tab-change', onTabChange);
    return () => window.removeEventListener('tab-change', onTabChange);
  }, [editingExisting, scenarioName]);

  // Load existing scenario for editing
  const loadScenario = async (name: string) => {
    if (recording) {
      message.warning(t('record.cannotLoadWhileRecording'));
      return;
    }
    try {
      const res = await scenarioApi.get(name);
      setScenarioName(res.data.name);
      setOriginalScenarioName(res.data.name);
      setDescription(res.data.description || '');
      setSteps(res.data.steps || []);
      setEditingExisting(true);
      message.success(t('record.scenarioLoaded', { name, count: res.data.steps?.length || 0 }));
    } catch {
      message.error(t('record.loadFailed'));
    }
  };

  // Save edited scenario
  const saveScenario = async () => {
    if (!scenarioName.trim()) {
      message.warning(t('record.enterScenarioName'));
      return;
    }
    try {
      const newName = scenarioName.trim();
      // If name changed, rename first
      if (originalScenarioName && originalScenarioName !== newName) {
        await scenarioApi.rename(originalScenarioName, newName);
        setOriginalScenarioName(newName);
      }
      // Re-index step IDs
      const reindexed = steps.map((s, i) => ({ ...s, id: i + 1 }));
      await scenarioApi.update(newName, {
        name: newName,
        description,
        steps: reindexed,
      });
      setSteps(reindexed);
      setScenarioName(newName);
      message.success(t('common.saveComplete'));
      fetchSavedScenarios();
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('common.saveFailed'));
    }
  };

  // Helper: remap goto references after step reorder/delete
  const remapGoto = (val: number | null | undefined, mapping: Map<number, number>): number | null | undefined => {
    if (val == null) return val;
    if (val === -1) return -1; // END stays END
    return mapping.get(val) ?? null; // removed target → clear
  };

  // Step editing helpers
  const deleteStep = async (index: number) => {
    // If recording, also remove from backend in-memory scenario
    if (recording) {
      try {
        await scenarioApi.deleteStep(index);
      } catch (e: any) {
        message.error(e.response?.data?.detail || t('record.stepDeleteFailed'));
        return;
      }
    }
    setSteps((prev) => {
      const filtered = prev.filter((_, i) => i !== index);
      // Build old-index+1 → new-index+1 mapping
      const mapping = new Map<number, number>();
      let newIdx = 1;
      for (let i = 0; i < prev.length; i++) {
        if (i !== index) {
          mapping.set(i + 1, newIdx);
          newIdx++;
        }
      }
      return filtered.map(s => ({
        ...s,
        on_pass_goto: remapGoto(s.on_pass_goto, mapping),
        on_fail_goto: remapGoto(s.on_fail_goto, mapping),
      }));
    });
    message.success(t('record.stepDeleted', { index: index + 1 }));
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    setSteps((prev) => {
      const arr = [...prev];
      [arr[index], arr[target]] = [arr[target], arr[index]];
      // Build old-position → new-position mapping
      const mapping = new Map<number, number>();
      for (let i = 0; i < arr.length; i++) {
        mapping.set(i + 1, i + 1);
      }
      mapping.set(index + 1, target + 1);
      mapping.set(target + 1, index + 1);
      return arr.map(s => ({
        ...s,
        on_pass_goto: remapGoto(s.on_pass_goto, mapping),
        on_fail_goto: remapGoto(s.on_fail_goto, mapping),
      }));
    });
  };

  const addWaitStep = async (afterIndex?: number) => {
    const dur = waitDurationRef.current;
    const waitStep: Step = {
      id: 0,
      type: 'wait',
      device_id: null,
      params: { duration_ms: dur },
      delay_after_ms: 0,
      description: `wait ${dur}ms`,
      expected_image: null,
    };

    if (recording) {
      // During recording: also record to backend
      setSteps((prev) => [...prev, waitStep]);
      pendingStepsRef.current += 1;
      setHasPendingSteps(true);
      try {
        const res = await scenarioApi.addStep({
          type: 'wait',
          device_id: '',
          params: { duration_ms: dur },
          description: `wait ${dur}ms`,
          delay_after_ms: 0,
          skip_execute: true,
        });
        setSteps((prev) => prev.map(s => s === waitStep ? res.data.step : s));
      } catch (e: any) {
        message.error(e.response?.data?.detail || t('record.waitAddFailed'));
        setSteps((prev) => prev.filter(s => s !== waitStep));
      } finally {
        pendingStepsRef.current -= 1;
        if (pendingStepsRef.current <= 0) {
          pendingStepsRef.current = 0;
          setHasPendingSteps(false);
        }
      }
    } else if (afterIndex !== undefined) {
      setSteps((prev) => {
        const arr = [...prev];
        arr.splice(afterIndex + 1, 0, waitStep);
        return arr;
      });
    } else {
      setSteps((prev) => [...prev, waitStep]);
    }
  };

  const updateStepJump = useCallback((index: number, field: 'on_pass_goto' | 'on_fail_goto', value: number | null) => {
    setSteps((prev) => prev.map((s, i) => i === index ? { ...s, [field]: value } : s));
  }, []);

  const updateStepDescription = useCallback((index: number, value: string) => {
    setSteps((prev) => prev.map((s, i) => i === index ? { ...s, description: value } : s));
  }, []);

  // --- Step command edit modal ---
  const openEditStepModal = useCallback((index: number) => {
    const s = steps[index];
    setEditStepIndex(index);
    setEditStepParams({ ...s.params });
  }, [steps]);

  const drawEditCanvas = useCallback(() => {
    const canvas = editCanvasRef.current;
    if (!canvas || !screenshot) return;
    const img = new window.Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d')?.drawImage(img, 0, 0);
    };
    img.src = screenshot;
  }, [screenshot]);

  const editCanvasToDevice = useCallback((canvas: HTMLCanvasElement, clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: Math.round((clientX - rect.left) * scaleX),
      y: Math.round((clientY - rect.top) * scaleY),
    };
  }, []);

  const editMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = editCanvasRef.current;
    if (!canvas) return;
    const { x, y } = editCanvasToDevice(canvas, e.clientX, e.clientY);
    editGestureRef.current = { startX: x, startY: y, startTime: Date.now(), active: true };
  }, [editCanvasToDevice]);

  const editMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!editGestureRef.current.active || editStepIndex == null) return;
    editGestureRef.current.active = false;
    const canvas = editCanvasRef.current;
    if (!canvas) return;
    const { startX, startY, startTime } = editGestureRef.current;
    const { x: endX, y: endY } = editCanvasToDevice(canvas, e.clientX, e.clientY);
    const dist = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);
    const elapsed = Date.now() - startTime;
    const step = steps[editStepIndex];

    if (step.type === 'swipe') {
      const durationMs = Math.max(200, Math.min(elapsed, 3000));
      const newParams = { x1: startX, y1: startY, x2: endX, y2: endY, duration_ms: durationMs };
      setEditStepParams(newParams);
      setSteps((prev) => prev.map((s, i) => i === editStepIndex ? { ...s, params: newParams } : s));
      setEditStepIndex(null);
      message.success(t('record.stepSwipeUpdated', { index: editStepIndex + 1 }));
    } else if (step.type === 'long_press') {
      const dur = Math.max(500, elapsed);
      const newParams = { x: startX, y: startY, duration_ms: dur };
      setEditStepParams(newParams);
      setSteps((prev) => prev.map((s, i) => i === editStepIndex ? { ...s, params: newParams } : s));
      setEditStepIndex(null);
      message.success(t('record.longPressUpdated', { index: editStepIndex + 1 }));
    } else {
      // tap — just use start coords
      const newParams = { x: startX, y: startY };
      setEditStepParams(newParams);
      setSteps((prev) => prev.map((s, i) => i === editStepIndex ? { ...s, params: newParams } : s));
      setEditStepIndex(null);
      message.success(t('record.tapUpdated', { index: editStepIndex + 1 }));
    }
  }, [editStepIndex, steps, editCanvasToDevice]);

  const applyEditStepParams = useCallback(() => {
    if (editStepIndex == null) return;
    setSteps((prev) => prev.map((s, i) => i === editStepIndex ? { ...s, params: { ...editStepParams } } : s));
    setEditStepIndex(null);
    message.success(t('record.stepUpdated', { index: editStepIndex + 1 }));
  }, [editStepIndex, editStepParams]);

  const clearEditing = () => {
    setScenarioName('');
    setOriginalScenarioName('');
    setDescription('');
    setSteps([]);
    setEditingExisting(false);
  };

  // Draw screenshot on canvas
  useEffect(() => {
    if (!screenshot || !canvasRef.current) return;
    const img = new window.Image();
    img.onload = () => {
      const canvas = canvasRef.current!;
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d')?.drawImage(img, 0, 0);
    };
    img.src = screenshot;
  }, [screenshot]);

  const getStepTypes = () => {
    if (isStepAuxiliary) {
      const types = [
        { value: 'serial_command', label: t('record.serialCommand') },
        { value: 'wait', label: t('record.wait') },
      ];
      if (stepDeviceModule) {
        types.unshift({ value: 'module_command', label: t('record.moduleLabel', { name: stepDeviceModule }) });
      }
      return types;
    }
    return [
      { value: 'tap', label: 'Tap' },
      { value: 'long_press', label: t('record.longPress') },
      { value: 'swipe', label: 'Swipe' },
      { value: 'input_text', label: t('record.inputText') },
      { value: 'key_event', label: t('record.keyEvent') },
      { value: 'wait', label: t('record.wait') },
      { value: 'adb_command', label: t('record.adbCommand') },
    ];
  };

  const getDeviceTag = (deviceId: string | null) => {
    if (!deviceId) return <Tag>-</Tag>;
    const dev = allDevices.find(d => d.id === deviceId);
    if (!dev) return <Tag color="orange">{deviceId}</Tag>;
    const color = dev.category === 'primary' ? 'green' : 'purple';
    return <Tag color={color}>{dev.id}{dev.name && dev.name !== dev.id ? ` (${dev.name})` : ''}</Tag>;
  };

  // Memoize the step list so screenshot polling doesn't re-render it
  // (which would close Popovers and reset Select states)
  const stepListMemo = useMemo(() => (
    <List
      size="small"
      dataSource={steps}
      renderItem={(s, index) => (
        <List.Item style={{ display: 'flex', padding: '4px 8px', gap: 8 }}>
          {/* 좌측: 스텝 정보 (1행) + 도구 버튼 (2행) */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* 1행: 스텝 정보 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              <Tag color={s.type === 'wait' ? 'cyan' : 'blue'}>#{index + 1}</Tag>
              <Input
                size="small"
                placeholder="Remark"
                value={s.description}
                onChange={(e) => updateStepDescription(index, e.target.value)}
                style={{ flex: 1, maxWidth: 200 }}
              />
              {getDeviceTag(s.device_id)}
              <Tag color={s.type === 'wait' ? 'cyan' : undefined}>{s.type}</Tag>
              {s.expected_image && scenarioName && (
                <span style={{ display: 'inline-flex', alignItems: 'center', position: 'relative', marginRight: 4 }}>
                  {/* Annotated thumbnail for full_exclude / multi_crop; plain image otherwise */}
                  {s.compare_mode === 'full_exclude' && (s.exclude_rois?.length || 0) > 0 ? (
                    <Tooltip title={t('record.expectedWithExclude')}>
                      <span><AnnotatedThumbnail
                        src={`/screenshots/${scenarioName}/${s.expected_image}`}
                        regions={s.exclude_rois || []}
                        color="red"
                        height={40}
                      /></span>
                    </Tooltip>
                  ) : s.compare_mode === 'multi_crop' && (s.expected_images?.length || 0) > 0 ? (
                    <Tooltip title={t('record.expectedWithCrop')}>
                      <span><AnnotatedThumbnail
                        src={`/screenshots/${scenarioName}/${s.expected_image}`}
                        regions={(s.expected_images || []).map(ci => ci.roi).filter((r): r is ROI => !!r)}
                        color="green"
                        height={40}
                      /></span>
                    </Tooltip>
                  ) : (
                    <Tooltip title={t('record.expectedImageClick')}>
                      <Image
                        src={`/screenshots/${scenarioName}/${s.expected_image}`}
                        alt="expected"
                        style={{ height: 40, width: 22, objectFit: 'cover', borderRadius: 2, cursor: 'pointer' }}
                        preview={{ mask: false }}
                      />
                    </Tooltip>
                  )}
                  <Tooltip title={t('record.expectedReset')}>
                    <CloseCircleOutlined
                      onClick={() => setSteps((prev) => prev.map((st, i) => i === index ? { ...st, expected_image: null, roi: null, exclude_rois: [], expected_images: [] } : st))}
                      style={{ fontSize: 14, color: '#ff4d4f', cursor: 'pointer', marginLeft: 2 }}
                    />
                  </Tooltip>
                </span>
              )}
              <span style={{ minWidth: 100, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.type === 'wait'
                  ? t('record.waitDuration', { duration: s.params.duration_ms })
                  : s.type === 'module_command'
                  ? `${s.params.module}::${s.params.function}()`
                  : s.type === 'serial_command'
                  ? <><Tag color="purple" style={{ margin: 0 }}>Serial</Tag> {s.params.data}</>
                  : JSON.stringify(s.params)}
              </span>
              {s.type !== 'wait' && (
                <InputNumber
                  size="small"
                  min={0}
                  max={30000}
                  step={100}
                  value={s.delay_after_ms}
                  onChange={(v) => setSteps(prev => prev.map((st, i) => i === index ? { ...st, delay_after_ms: v || 0 } : st))}
                  addonAfter="ms"
                  style={{ width: 110, marginLeft: 8 }}
                />
              )}
              {s.roi && (
                <Tag color="orange" style={{ marginLeft: 4 }}>
                  ROI {s.roi.width}×{s.roi.height}
                </Tag>
              )}
              {s.compare_mode === 'full_exclude' && (s.exclude_rois?.length || 0) > 0 && (
                <Tag color="red" style={{ marginLeft: 4 }}>{t('record.excludeCount', { count: s.exclude_rois!.length })}</Tag>
              )}
              {s.compare_mode === 'multi_crop' && (
                <Tag color="purple" style={{ marginLeft: 4 }}>
                  {t('record.cropCount', { count: s.expected_images?.length || 0 })}
                </Tag>
              )}
              {s.on_pass_goto != null && (
                <Tag color="green" style={{ marginLeft: 4 }}>
                  P→{s.on_pass_goto === -1 ? 'END' : `#${s.on_pass_goto}`}
                </Tag>
              )}
              {s.on_fail_goto != null && (
                <Tag color="red" style={{ marginLeft: 4 }}>
                  F→{s.on_fail_goto === -1 ? 'END' : `#${s.on_fail_goto}`}
                </Tag>
              )}
            </div>
            {/* 2행: 도구 버튼 */}
            <div style={{ display: 'flex', gap: 2, alignItems: 'center', marginTop: 2, paddingLeft: 36 }}>
            <Button
              size="small" type="text"
              icon={<EditOutlined />}
              title={t('record.editCommand')}
              onClick={() => openEditStepModal(index)}
              style={{ color: '#1890ff' }}
            />
            <Popover
              content={<JumpEditorInner step={s} index={index} steps={steps} onUpdate={updateStepJump} t={t} />}
              trigger="click"
              placement="left"
            >
              <Button
                size="small" type="text"
                icon={<BranchesOutlined />}
                title={t('record.conditionalJump')}
                style={s.on_pass_goto != null || s.on_fail_goto != null ? { color: '#722ed1' } : undefined}
              />
            </Popover>
            {!recording && (
              <Button
                size="small" type="text"
                title={t('record.insertWait')}
                onClick={() => addWaitStep(index)}
              >W</Button>
            )}
            {screenshotDeviceId && scenarioName && (
              <>
                <Select
                  size="small"
                  value={s.compare_mode || 'full'}
                  onChange={(v) => updateCompareMode(index, v)}
                  style={{ width: 105, fontSize: 11 }}
                  options={[
                    { value: 'full', label: t('record.fullScreen') },
                    { value: 'single_crop', label: t('record.singleCrop') },
                    { value: 'full_exclude', label: t('record.excludeArea') },
                    { value: 'multi_crop', label: t('record.multiCrop') },
                  ]}
                />
                {/* 전체화면: 카메라 (전체화면 캡처) */}
                {(!s.compare_mode || s.compare_mode === 'full') && (
                  <Button
                    size="small" type="text"
                    icon={<CameraOutlined />}
                    title={s.expected_image ? t('record.expectedRecapture') : t('record.expectedCapture')}
                    style={s.expected_image ? { color: '#52c41a' } : undefined}
                    onClick={() => saveExpectedFull(index)}
                  />
                )}
                {/* 단일크롭: 가위 (크롭 캡처) */}
                {s.compare_mode === 'single_crop' && (
                  <Button
                    size="small" type="text"
                    icon={<ScissorOutlined />}
                    title={s.expected_image ? t('record.expectedRecaptureCrop') : t('record.expectedCaptureCrop')}
                    style={s.expected_image ? { color: '#52c41a' } : undefined}
                    onClick={() => openCaptureModal(index)}
                  />
                )}
                {/* 영역제외: 가위 (제외 영역 편집) */}
                {s.compare_mode === 'full_exclude' && (
                  <Button
                    size="small" type="text"
                    icon={<ScissorOutlined />}
                    title={t('record.excludeAreaEdit')}
                    style={(s.exclude_rois?.length || 0) > 0 ? { color: '#ff4d4f' } : undefined}
                    onClick={() => openExcludeRoiModal(index)}
                  />
                )}
                {/* 멀티크롭: 가위 (크롭 영역 편집) */}
                {s.compare_mode === 'multi_crop' && (
                  <Button
                    size="small" type="text"
                    icon={<ScissorOutlined />}
                    title={t('record.cropAreaEdit')}
                    style={(s.expected_images?.length || 0) > 0 ? { color: '#52c41a' } : undefined}
                    onClick={() => openMultiCropModal(index)}
                  />
                )}
              </>
            )}
            </div>
          </div>
          {/* 우측: 순서변경 + 테스트 + 삭제 (가로 배치, 1-2행 전체 높이) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, borderLeft: '1px solid #333', paddingLeft: 8, alignSelf: 'stretch' }}>
            {!recording && (
              <>
                <Button
                  type="text" icon={<ArrowUpOutlined />}
                  disabled={index === 0}
                  onClick={() => moveStep(index, -1)}
                  style={{ fontSize: 16, width: 32, height: '100%' }}
                />
                <Button
                  type="text" icon={<ArrowDownOutlined />}
                  disabled={index === steps.length - 1}
                  onClick={() => moveStep(index, 1)}
                  style={{ fontSize: 16, width: 32, height: '100%' }}
                />
              </>
            )}
            {scenarioName && (s.type !== 'wait' || s.expected_image) && (
              <Button
                type="text"
                icon={<ThunderboltOutlined />}
                title={t('record.testStep')}
                loading={testingStepIndex === index}
                onClick={() => testStep(index)}
                style={{ color: '#faad14', fontSize: 16, width: 32, height: '100%' }}
              />
            )}
            <Button
              type="text" danger icon={<DeleteOutlined />}
              onClick={() => deleteStep(index)}
              style={{ fontSize: 16, width: 32, height: '100%' }}
            />
          </div>
        </List.Item>
      )}
      locale={{ emptyText: t('record.noSteps') }}
    />
  ), [steps, recording, updateStepJump, updateStepDescription, openEditStepModal, openRoiModal, screenshotDeviceId, scenarioName, saveExpectedFull, openCaptureModal, testStep, testingStepIndex, updateCompareMode, openExcludeRoiModal, openMultiCropModal, t]);

  // Determine if device screen is portrait (tall) or landscape
  const isPortrait = deviceRes.height > deviceRes.width;

  return (
    <div style={{ height: 'calc(100vh - 80px)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <style>{`@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
      <div style={{ flex: 1, display: 'flex', gap: 8, minHeight: 0 }}>
        {/* Left panel: Device screen + Webcam */}
        <div style={{
          width: isPortrait ? 460 : '45%',
          minWidth: isPortrait ? 400 : 400,
          maxWidth: isPortrait ? 520 : '50%',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          overflow: 'hidden',
        }}>
          <Card
            size="small"
            title={
              <Space>
                <SwapOutlined />
                <span>{t('record.deviceScreen')}</span>
              </Space>
            }
            extra={
              primaryDevices.length > 0 && (
                <Space size={4}>
                  <Select
                    value={screenshotDeviceId || undefined}
                    onChange={(id) => {
                      setScreenshotDeviceId(id);
                      setStepDeviceId(id);
                    }}
                    placeholder={t('record.primaryDevice')}
                    size="small"
                    style={{ width: 140 }}
                  >
                    {primaryDevices.map(d => (
                      <Option key={d.id} value={d.id}>{d.name || d.id}</Option>
                    ))}
                  </Select>
                  <InputNumber
                    size="small"
                    min={100}
                    max={5000}
                    step={100}
                    value={pollInterval}
                    onChange={(v) => setPollInterval(v || 500)}
                    addonAfter="ms"
                    style={{ width: 100 }}
                  />
                </Space>
              )
            }
            style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}
            styles={{ body: { flex: 1, overflow: 'hidden', padding: 8, display: 'flex', flexDirection: 'column', alignItems: 'center' } }}
          >
            {screenshotDeviceId && screenshot ? (
              <>
                <canvas
                  ref={canvasRef}
                  onMouseDown={handleMouseDown}
                  onMouseUp={handleMouseUp}
                  style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    border: '1px solid #333',
                    borderRadius: 4,
                    cursor: 'crosshair',
                    userSelect: 'none',
                  }}
                />
                <div style={{ marginTop: 4, color: '#888', fontSize: 11 }}>
                  {lastGesture
                    ? `${lastGesture} → ${recording ? t('record.gestureRecord') : t('record.directExec')}`
                    : t('record.gestureHint', { device: screenDevice?.name || screenshotDeviceId || '' })}
                </div>
              </>
            ) : (
              <div style={{ color: '#666', textAlign: 'center', padding: 24 }}>
                {primaryDevices.length === 0
                  ? t('record.addPrimaryDevice')
                  : t('record.selectPrimaryDevice')}
              </div>
            )}
          </Card>

          {/* Webcam panel */}
          <WebcamPanel webcam={webcam} />
        </div>

        {/* Right panel: Controls + Steps */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflow: 'hidden' }}>
          <Card size="small" title={t('record.control')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Row 1: 시나리오 불러오기 + 이름 */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Input
                  placeholder={t('record.scenarioNamePlaceholder')}
                  value={scenarioName}
                  onChange={(e) => setScenarioName(e.target.value)}
                  disabled={recording}
                  style={{ flex: 1 }}
                />
                {!recording && (
                  <Select
                    placeholder={t('record.loadScenario')}
                    style={{ flex: 1 }}
                    onChange={loadScenario}
                    value={undefined}
                    onDropdownVisibleChange={(open) => { if (open) fetchSavedScenarios(); }}
                  >
                    {savedScenarios.map(n => (
                      <Option key={n} value={n}>{n}</Option>
                    ))}
                  </Select>
                )}
                {!recording && editingExisting && (
                  <Button onClick={clearEditing}>{t('record.createNew')}</Button>
                )}
              </div>
              {/* Row 2: 설명 + 상태 + 녹화 버튼 */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Input
                  placeholder={t('record.descriptionPlaceholder')}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={recording}
                  style={{ flex: 1 }}
                />
                <Tag color={recording ? 'red' : editingExisting ? 'blue' : 'default'} style={{ margin: 0 }}>
                  {recording ? t('record.recording') : editingExisting ? t('record.editing') : t('record.waiting')}
                </Tag>
                {!recording ? (
                  <Button type="primary" icon={<PlayCircleOutlined />} onClick={startRecording}>
                    {editingExisting ? t('record.resumeRecording') : t('record.startRecording')}
                  </Button>
                ) : (
                  <Button danger icon={<PauseOutlined />} onClick={stopRecording} disabled={hasPendingSteps}>
                    {hasPendingSteps ? t('record.savingSteps') : t('record.stopRecording')}
                  </Button>
                )}
                {!recording && steps.length > 0 && (
                  <Button icon={<SaveOutlined />} onClick={saveScenario}>
                    {t('record.save')}
                  </Button>
                )}
              </div>
            </div>
          </Card>

          {recording && (
            <Card size="small" title={t('record.manualStep')} style={{ flexShrink: 0 }}>
              <Space direction="vertical" style={{ width: '100%' }}>
                {/* Device selector — grouped by category */}
                <Select
                  value={stepDeviceId || undefined}
                  onChange={setStepDeviceId}
                  placeholder={t('record.targetDevice')}
                  style={{ width: '100%' }}
                >
                  {primaryDevices.length > 0 && (
                    <Select.OptGroup label={t('record.primaryDevices')}>
                      {primaryDevices.map(d => (
                        <Option key={d.id} value={d.id}>
                          <Tag color="green" style={{ marginRight: 4 }}>{d.type.toUpperCase()}</Tag>
                          {d.name || d.id}
                        </Option>
                      ))}
                    </Select.OptGroup>
                  )}
                  {auxiliaryDevices.length > 0 && (
                    <Select.OptGroup label={t('record.auxiliaryDevices')}>
                      {auxiliaryDevices.map(d => (
                        <Option key={d.id} value={d.id}>
                          {d.info?.module
                            ? <><Tag color="purple" style={{ marginRight: 4 }}>{d.info.module}</Tag>{d.address || d.name || d.id}</>
                            : <><Tag color="purple" style={{ marginRight: 4 }}>{d.type.toUpperCase()}</Tag>{d.name || d.id}</>
                          }
                        </Option>
                      ))}
                    </Select.OptGroup>
                  )}
                </Select>

                <Space>
                  <Select value={stepType} onChange={setStepType} style={{ width: 170 }}>
                    {getStepTypes().map(t => (
                      <Option key={t.value} value={t.value}>{t.label}</Option>
                    ))}
                  </Select>
                  <InputNumber
                    min={100}
                    max={30000}
                    step={100}
                    value={delayMs}
                    onChange={(v) => setDelayMs(v || 1000)}
                    addonAfter="ms"
                  />
                </Space>

                {stepType === 'module_command' ? (
                  <>
                    <Select
                      showSearch
                      placeholder={t('record.selectFunction')}
                      value={selectedModuleFunc || undefined}
                      onChange={(v) => {
                        setSelectedModuleFunc(v);
                        // Pre-fill default args
                        const fn = moduleFunctions.find(f => f.name === v);
                        if (fn) {
                          const defaults: Record<string, string> = {};
                          fn.params.forEach(p => { if (p.default !== undefined) defaults[p.name] = p.default.replace(/^'(.*)'$/, '$1'); });
                          setModuleFuncArgs(defaults);
                        } else {
                          setModuleFuncArgs({});
                        }
                      }}
                      style={{ width: '100%' }}
                      options={moduleFunctions.map(f => ({
                        label: `${f.name}(${f.params.map(p => p.required ? p.name : p.name + '?').join(', ')})`,
                        value: f.name,
                      }))}
                    />
                    {selectedModuleFunc && (() => {
                      const fn = moduleFunctions.find(f => f.name === selectedModuleFunc);
                      if (!fn || fn.params.length === 0) return null;
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {fn.params.map(p => (
                            <Space key={p.name} size={4} style={{ width: '100%' }}>
                              <Tag style={{ minWidth: 70, textAlign: 'center', margin: 0 }}>{p.name}{p.required && <span style={{ color: '#ff4d4f' }}>*</span>}</Tag>
                              <Input
                                size="small"
                                placeholder={p.required ? t('common.required') : `${t('common.default')}: ${p.default}`}
                                value={moduleFuncArgs[p.name] ?? ''}
                                onChange={(e) => setModuleFuncArgs(prev => ({ ...prev, [p.name]: e.target.value }))}
                                style={{ flex: 1 }}
                              />
                            </Space>
                          ))}
                        </div>
                      );
                    })()}
                  </>
                ) : stepType === 'serial_command' ? (
                  <>
                    <TextArea
                      placeholder={t('record.serialPlaceholder')}
                      value={serialData}
                      onChange={(e) => setSerialData(e.target.value)}
                      onPressEnter={(e) => { if (e.ctrlKey) { e.preventDefault(); sendSerialCommand(); } }}
                      rows={3}
                    />
                    <Button
                      type="default"
                      icon={<ThunderboltOutlined />}
                      onClick={sendSerialCommand}
                      loading={serialSending}
                      disabled={!stepDeviceId || !serialData.trim()}
                      block
                    >
                      {t('record.serialSend')}
                    </Button>
                    {serialResponse && (
                      <div style={{
                        background: '#1a1a1a', border: '1px solid #333', borderRadius: 4,
                        padding: '4px 8px', fontSize: 12, fontFamily: 'monospace',
                        maxHeight: 100, overflow: 'auto', whiteSpace: 'pre-wrap', color: '#52c41a',
                      }}>
                        {serialResponse}
                      </div>
                    )}
                  </>
                ) : (
                  <Input
                    placeholder={
                      stepType === 'input_text' ? t('record.textPlaceholder') :
                      stepType === 'key_event' ? 'KEYCODE_BACK' :
                      stepType === 'adb_command' ? 'shell am start ...' :
                      t('record.stepDescription')
                    }
                    value={stepDesc}
                    onChange={(e) => setStepDesc(e.target.value)}
                  />
                )}

                {['input_text', 'key_event', 'wait', 'adb_command', 'serial_command', 'module_command'].includes(stepType) && (
                  <Button
                    icon={<PlusOutlined />}
                    onClick={addManualStep}
                    disabled={!stepDeviceId && stepType !== 'wait'}
                    block
                  >
                    {t('record.addStep')}
                  </Button>
                )}
              </Space>
            </Card>
          )}

          <Card
            size="small"
            title={t('record.recordedSteps', { count: steps.length })}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            styles={{ body: { flex: 1, overflow: 'auto', padding: '4px 8px' } }}
            extra={
              <Space size={4}>
                <InputNumber
                  size="small"
                  min={100}
                  max={30000}
                  step={100}
                  value={waitDurationMs}
                  onChange={(v) => { const val = v || 1000; setWaitDurationMs(val); waitDurationRef.current = val; }}
                  addonAfter="ms"
                  style={{ width: 120 }}
                />
                <Button size="small" icon={<PlusOutlined />} onClick={() => addWaitStep()}>
                  {t('record.addWait')}
                </Button>
              </Space>
            }
          >
            {stepListMemo}
          </Card>
        </div>
      </div>

      {/* Expected Image Crop Modal */}
      <Modal
        title={t('record.cropModalTitle', { index: (captureStepIndex ?? 0) + 1 })}
        open={captureModalOpen}
        onCancel={() => { setCaptureModalOpen(false); setCaptureStepIndex(null); }}
        width="90vw"
        style={{ top: 20 }}
        footer={
          <Button onClick={() => { setCaptureModalOpen(false); setCaptureStepIndex(null); }}>
            {t('common.cancel')}
          </Button>
        }
      >
        <div style={{ overflow: 'auto', maxHeight: '75vh', textAlign: 'center' }}>
          <canvas
            ref={captureCanvasRef}
            onMouseDown={captureMouseDown}
            onMouseMove={captureMouseMove}
            onMouseUp={captureMouseUp}
            style={{ cursor: 'crosshair', maxWidth: '100%' }}
          />
        </div>
        <div style={{ marginTop: 8, color: '#888', fontSize: 12, textAlign: 'center' }}>
          {t('record.cropModalHint')}
        </div>
      </Modal>

      {/* ROI Crop Modal — full resolution */}
      <Modal
        title={t('record.roiModalTitle', { index: (roiEditingIndex ?? 0) + 1 })}
        open={roiModalOpen}
        onCancel={() => { setRoiModalOpen(false); setRoiEditingIndex(null); }}
        width="90vw"
        style={{ top: 20 }}
        footer={
          <Space>
            <Button onClick={() => { setRoiModalOpen(false); setRoiEditingIndex(null); }}>
              {t('common.cancel')}
            </Button>
            {roiEditingIndex != null && steps[roiEditingIndex]?.roi && (
              <Button danger onClick={() => {
                setSteps((prev) => prev.map((s, i) => i === roiEditingIndex ? { ...s, roi: null } : s));
                message.info(t('record.roiCleared'));
                setRoiModalOpen(false);
                setRoiEditingIndex(null);
              }}>
                {t('record.roiClear')}
              </Button>
            )}
          </Space>
        }
      >
        <div style={{ overflow: 'auto', maxHeight: '75vh', textAlign: 'center' }}>
          <canvas
            ref={roiCanvasRef}
            onMouseDown={roiMouseDown}
            onMouseMove={roiMouseMove}
            onMouseUp={roiMouseUp}
            style={{ cursor: 'crosshair', maxWidth: '100%' }}
          />
        </div>
        <div style={{ marginTop: 8, color: '#888', fontSize: 12, textAlign: 'center' }}>
          {roiEditingIndex != null && steps[roiEditingIndex]?.roi
            ? t('record.roiCurrent', { size: `${steps[roiEditingIndex].roi!.width}×${steps[roiEditingIndex].roi!.height}`, pos: `${steps[roiEditingIndex].roi!.x}, ${steps[roiEditingIndex].roi!.y}` })
            : t('record.dragArea')}
        </div>
      </Modal>

      {/* Exclude ROI Modal — add/remove exclusion regions */}
      <Modal
        title={t('record.excludeModalTitle', { index: (excludeRoiEditingIndex ?? 0) + 1 })}
        open={excludeRoiModalOpen}
        onCancel={() => { setExcludeRoiModalOpen(false); setExcludeRoiEditingIndex(null); setExcludeRoiSelectedIdx(null); }}
        width="90vw"
        style={{ top: 20 }}
        footer={
          <Space>
            <Button onClick={() => { setExcludeRoiModalOpen(false); setExcludeRoiEditingIndex(null); setExcludeRoiSelectedIdx(null); }}>
              {t('common.close')}
            </Button>
            {excludeRoiEditingIndex != null && (steps[excludeRoiEditingIndex]?.exclude_rois?.length || 0) > 0 && (
              <Button danger onClick={() => {
                setSteps(prev => prev.map((s, i) => i === excludeRoiEditingIndex ? { ...s, exclude_rois: [] } : s));
                message.info(t('record.allExcludeCleared'));
              }}>
                {t('record.clearAll')}
              </Button>
            )}
          </Space>
        }
      >
        <div style={{ overflow: 'auto', maxHeight: '65vh', textAlign: 'center' }}>
          <canvas
            ref={excludeRoiCanvasRef}
            onMouseDown={excludeRoiMouseDown}
            onMouseMove={excludeRoiMouseMove}
            onMouseUp={excludeRoiMouseUp}
            style={{ cursor: 'crosshair', maxWidth: '100%' }}
          />
        </div>
        {excludeRoiEditingIndex != null && (steps[excludeRoiEditingIndex]?.exclude_rois?.length || 0) > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>{t('record.excludeList')}</div>
            <Space wrap>
              {steps[excludeRoiEditingIndex]?.exclude_rois?.map((r, ri) => (
                <Tag
                  key={ri}
                  color={excludeRoiSelectedIdx === ri ? 'blue' : 'red'}
                  closable
                  onClose={() => {
                    removeExcludeRoi(excludeRoiEditingIndex!, ri);
                    if (excludeRoiSelectedIdx === ri) setExcludeRoiSelectedIdx(null);
                    else if (excludeRoiSelectedIdx != null && excludeRoiSelectedIdx > ri) setExcludeRoiSelectedIdx(excludeRoiSelectedIdx - 1);
                  }}
                  style={{ cursor: 'pointer', border: excludeRoiSelectedIdx === ri ? '2px solid #1890ff' : undefined }}
                  onClick={() => {
                    setExcludeRoiSelectedIdx(prev => prev === ri ? null : ri);
                    setTimeout(() => drawExcludeRoiCanvas(), 50);
                  }}
                >
                  #{ri + 1} {r.width}×{r.height} @ ({r.x},{r.y}){excludeRoiSelectedIdx === ri ? ' ✎' : ''}
                </Tag>
              ))}
            </Space>
          </div>
        )}
      </Modal>

      {/* Multi-crop Modal — add/remove crop regions */}
      <Modal
        title={t('record.multiCropModalTitle', { index: (multiCropEditingIndex ?? 0) + 1 })}
        open={multiCropModalOpen}
        onCancel={() => { setMultiCropModalOpen(false); setMultiCropEditingIndex(null); setMultiCropSelectedIdx(null); }}
        width="90vw"
        style={{ top: 20 }}
        footer={
          <Space>
            <Button onClick={() => { setMultiCropModalOpen(false); setMultiCropEditingIndex(null); setMultiCropSelectedIdx(null); }}>
              {t('common.close')}
            </Button>
            {multiCropEditingIndex != null && (steps[multiCropEditingIndex]?.expected_images?.length || 0) > 0 && (
              <Button danger onClick={() => {
                setSteps(prev => prev.map((s, i) => i === multiCropEditingIndex ? { ...s, expected_images: [] } : s));
                setMultiCropSelectedIdx(null);
                message.info(t('record.allCropCleared'));
                setTimeout(() => drawMultiCropCanvas(), 50);
              }}>
                {t('record.clearAll')}
              </Button>
            )}
          </Space>
        }
      >
        <div style={{ overflow: 'auto', maxHeight: '65vh', textAlign: 'center' }}>
          <canvas
            ref={multiCropCanvasRef}
            onMouseDown={multiCropMouseDown}
            onMouseMove={multiCropMouseMove}
            onMouseUp={multiCropMouseUp}
            style={{ cursor: 'crosshair', maxWidth: '100%' }}
          />
        </div>
        {multiCropEditingIndex != null && (steps[multiCropEditingIndex]?.expected_images?.length || 0) > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>{t('record.cropList')}</div>
            <Space wrap>
              {steps[multiCropEditingIndex]?.expected_images?.map((ci, ci_idx) => (
                <Tag
                  key={ci_idx}
                  color={multiCropSelectedIdx === ci_idx ? 'blue' : 'green'}
                  closable
                  onClose={() => removeMultiCropItem(ci_idx)}
                  style={{ cursor: 'pointer', border: multiCropSelectedIdx === ci_idx ? '2px solid #1890ff' : undefined }}
                  onClick={() => {
                    setMultiCropSelectedIdx(prev => prev === ci_idx ? null : ci_idx);
                    setTimeout(() => drawMultiCropCanvas(), 50);
                  }}
                >
                  #{ci_idx + 1}{ci.label ? ` ${ci.label}` : ''}{ci.roi ? ` ${ci.roi.width}×${ci.roi.height}` : ''}{multiCropSelectedIdx === ci_idx ? ' ✎' : ''}
                </Tag>
              ))}
            </Space>
          </div>
        )}
      </Modal>

      {/* Step command edit modal */}
      <Modal
        title={editStepIndex != null ? t('record.editStepTitle', { index: editStepIndex + 1, type: steps[editStepIndex]?.type }) : ''}
        open={editStepIndex != null}
        onCancel={() => setEditStepIndex(null)}
        width={['tap', 'long_press', 'swipe'].includes(steps[editStepIndex ?? 0]?.type) ? '80vw' : 500}
        style={['tap', 'long_press', 'swipe'].includes(steps[editStepIndex ?? 0]?.type) ? { top: 20 } : undefined}
        footer={
          ['tap', 'long_press', 'swipe'].includes(steps[editStepIndex ?? 0]?.type)
            ? <Button onClick={() => setEditStepIndex(null)}>{t('common.cancel')}</Button>
            : (
              <Space>
                <Button onClick={() => setEditStepIndex(null)}>{t('common.cancel')}</Button>
                <Button type="primary" onClick={applyEditStepParams}>{t('record.apply')}</Button>
              </Space>
            )
        }
        afterOpenChange={(open) => {
          if (open && ['tap', 'long_press', 'swipe'].includes(steps[editStepIndex ?? 0]?.type)) {
            setTimeout(drawEditCanvas, 100);
          }
        }}
      >
        {editStepIndex != null && (() => {
          const step = steps[editStepIndex];
          if (!step) return null;

          if (['tap', 'long_press', 'swipe'].includes(step.type)) {
            return (
              <div>
                <div style={{ marginBottom: 8, color: '#888', fontSize: 12 }}>
                  {step.type === 'tap' && t('record.tapHint')}
                  {step.type === 'long_press' && t('record.longPressHint')}
                  {step.type === 'swipe' && t('record.swipeHint')}
                </div>
                <div style={{ marginBottom: 8 }}>
                  <Tag>{t('record.currentParams', { params: JSON.stringify(step.params) })}</Tag>
                </div>
                <div style={{ overflow: 'auto', maxHeight: '70vh', textAlign: 'center' }}>
                  <canvas
                    ref={editCanvasRef}
                    onMouseDown={editMouseDown}
                    onMouseUp={editMouseUp}
                    style={{ cursor: 'crosshair', maxWidth: '100%' }}
                  />
                </div>
              </div>
            );
          }

          if (step.type === 'input_text') {
            return (
              <div>
                <div style={{ marginBottom: 8, fontWeight: 600 }}>{t('record.inputTextLabel')}</div>
                <TextArea
                  rows={3}
                  value={editStepParams.text ?? ''}
                  onChange={(e) => setEditStepParams({ ...editStepParams, text: e.target.value })}
                />
              </div>
            );
          }

          if (step.type === 'key_event') {
            return (
              <div>
                <div style={{ marginBottom: 8, fontWeight: 600 }}>{t('record.keycodeLabel')}</div>
                <Input
                  value={editStepParams.keycode ?? ''}
                  onChange={(e) => setEditStepParams({ ...editStepParams, keycode: e.target.value })}
                  placeholder={t('record.keycodeExample')}
                />
              </div>
            );
          }

          if (step.type === 'wait') {
            return (
              <div>
                <div style={{ marginBottom: 8, fontWeight: 600 }}>{t('record.waitTimeLabel')}</div>
                <Space>
                  <InputNumber
                    min={100}
                    max={60000}
                    step={100}
                    value={editStepParams.duration_ms ?? 1000}
                    onChange={(v) => setEditStepParams({ ...editStepParams, duration_ms: v ?? 1000 })}
                    style={{ width: 150 }}
                  />
                  <span style={{ color: '#888' }}>ms</span>
                </Space>
              </div>
            );
          }

          if (step.type === 'adb_command') {
            return (
              <div>
                <div style={{ marginBottom: 8, fontWeight: 600 }}>{t('record.adbCommandLabel')}</div>
                <TextArea
                  rows={3}
                  value={editStepParams.command ?? ''}
                  onChange={(e) => setEditStepParams({ ...editStepParams, command: e.target.value })}
                  placeholder={t('record.adbExample')}
                />
              </div>
            );
          }

          if (step.type === 'serial_command') {
            return (
              <div>
                <div style={{ marginBottom: 8, fontWeight: 600 }}>{t('record.serialDataLabel')}</div>
                <TextArea
                  rows={3}
                  value={editStepParams.data ?? ''}
                  onChange={(e) => setEditStepParams({ ...editStepParams, data: e.target.value })}
                />
                <div style={{ marginTop: 8 }}>
                  <span style={{ marginRight: 8 }}>Read Timeout</span>
                  <InputNumber
                    min={0.1}
                    max={30}
                    step={0.1}
                    value={editStepParams.read_timeout ?? 1.0}
                    onChange={(v) => setEditStepParams({ ...editStepParams, read_timeout: v ?? 1.0 })}
                    style={{ width: 120 }}
                  />
                  <span style={{ color: '#888', marginLeft: 4 }}>s</span>
                </div>
              </div>
            );
          }

          if (step.type === 'module_command') {
            const args = editStepParams.args || {};
            return (
              <div>
                <div style={{ marginBottom: 8, fontWeight: 600 }}>{editStepParams.module}::{editStepParams.function}()</div>
                {Object.keys(args).length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {Object.entries(args).map(([k, v]) => (
                      <Space key={k} size={4} style={{ width: '100%' }}>
                        <Tag style={{ minWidth: 70, textAlign: 'center', margin: 0 }}>{k}</Tag>
                        <Input
                          size="small"
                          value={String(v ?? '')}
                          onChange={(e) => setEditStepParams({ ...editStepParams, args: { ...args, [k]: e.target.value } })}
                          style={{ flex: 1 }}
                        />
                      </Space>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: '#888' }}>{t('record.noParams')}</div>
                )}
              </div>
            );
          }

          return <div style={{ color: '#888' }}>{t('record.editNotSupported')}</div>;
        })()}
      </Modal>

      {/* Step test result modal */}
      <Modal
        title={t('record.stepTestResult')}
        open={testResultModalOpen}
        onCancel={() => { setTestResultModalOpen(false); setTestResult(null); }}
        width={800}
        footer={<Button onClick={() => { setTestResultModalOpen(false); setTestResult(null); }}>{t('common.close')}</Button>}
      >
        {testResult && (
          <div>
            <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              {testResult.status === 'pass' && <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 20 }} />}
              {testResult.status === 'fail' && <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 20 }} />}
              {testResult.status === 'warning' && <WarningOutlined style={{ color: '#faad14', fontSize: 20 }} />}
              {testResult.status === 'error' && <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 20 }} />}
              <Tag color={
                testResult.status === 'pass' ? 'green' :
                testResult.status === 'fail' ? 'red' :
                testResult.status === 'warning' ? 'orange' : 'red'
              } style={{ fontSize: 14 }}>
                {testResult.status.toUpperCase()}
              </Tag>
              {testResult.similarity_score != null && (
                <span>{t('record.similarityLabel')}: <strong>{(testResult.similarity_score * 100).toFixed(1)}%</strong></span>
              )}
              <span style={{ color: '#888', marginLeft: 'auto' }}>
                {testResult.execution_time_ms}ms
              </span>
            </div>
            {testResult.message && (
              <div style={{ marginBottom: 12, color: '#888', fontSize: 12 }}>{testResult.message}</div>
            )}
            <Row gutter={12}>
              {testResult.expected_image && (
                <Col span={testResult.actual_image ? 12 : 24}>
                  <div style={{ textAlign: 'center', fontSize: 12, marginBottom: 4, fontWeight: 600 }}>{t('record.expectedImageLabel')}</div>
                  <Image
                    src={`/screenshots/${testResult.expected_annotated_image || testResult.expected_image}?t=${Date.now()}`}
                    style={{ width: '100%', borderRadius: 4, border: '1px solid #333' }}
                  />
                </Col>
              )}
              {testResult.actual_image && (
                <Col span={testResult.expected_image ? 12 : 24}>
                  <div style={{ textAlign: 'center', fontSize: 12, marginBottom: 4, fontWeight: 600 }}>
                    {t('record.actualResult')}
                    {testResult.match_location && (
                      <span style={{ fontWeight: 400, color: '#ff4d4f', marginLeft: 4 }}>
                        ({t('record.matchLocation')}: {testResult.match_location.x},{testResult.match_location.y} {testResult.match_location.width}×{testResult.match_location.height})
                      </span>
                    )}
                  </div>
                  <Image
                    src={`/screenshots/${testResult.actual_annotated_image || testResult.actual_image}?t=${Date.now()}`}
                    style={{ width: '100%', borderRadius: 4, border: '1px solid #333' }}
                  />
                </Col>
              )}
            </Row>
            {testResult.diff_image && (
              <div style={{ marginTop: 12 }}>
                <div style={{ textAlign: 'center', fontSize: 12, marginBottom: 4, fontWeight: 600 }}>{t('record.diffHeatmap')}</div>
                <Image
                  src={`/screenshots/${testResult.diff_image}?t=${Date.now()}`}
                  style={{ width: '100%', borderRadius: 4, border: '1px solid #333' }}
                />
              </div>
            )}
            {!testResult.expected_image && !testResult.actual_image && (
              <div style={{ color: '#888', textAlign: 'center', padding: 24 }}>
                {t('record.noExpectedImage')}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
