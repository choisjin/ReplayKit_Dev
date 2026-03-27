import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Button, Card, Col, Image, Input, Modal, Row, Select, Space, InputNumber, message, List, Tag, Popover, Tooltip, Splitter } from 'antd';
import { PlayCircleOutlined, PauseOutlined, PlusOutlined, SwapOutlined, FolderOpenOutlined, SaveOutlined, DeleteOutlined, ArrowUpOutlined, ArrowDownOutlined, BranchesOutlined, ScissorOutlined, CameraOutlined, ThunderboltOutlined, CheckCircleOutlined, CloseCircleOutlined, WarningOutlined, EditOutlined, CopyOutlined } from '@ant-design/icons';
import { deviceApi, scenarioApi, customKeysApi } from '../services/api';
import { useDevice } from '../context/DeviceContext';
import { useSettings } from '../context/SettingsContext';
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
    <div style={{ fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
      {t('record.conditionalJumpTitle', { index: String(index + 1) })}
      {(step.on_pass_goto != null || step.on_fail_goto != null) && (
        <Button size="small" type="link" danger style={{ padding: 0, fontSize: 11, height: 'auto' }}
          onClick={() => { onUpdate(index, 'on_pass_goto', null); onUpdate(index, 'on_fail_goto', null); }}>
          {t('common.reset')}
        </Button>
      )}
    </div>
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
  screen_type?: string | null;
  params: Record<string, any>;
  delay_after_ms: number;
  description: string;
  expected_image: string | null;
  on_pass_goto?: number | null;
  on_fail_goto?: number | null;
  roi?: ROI | null;
  similarity_threshold?: number;
  compare_mode?: 'full' | 'single_crop' | 'full_exclude' | 'multi_crop';
  exclude_rois?: ROI[];
  expected_images?: CropItem[];
  screenshot_device_id?: string | null;
  _imageVer?: number; // 미리보기 캐시 버스팅용 (프론트엔드 전용)
}

interface HkmcKeyInfo {
  name: string;
  group: string;
  is_dial: boolean;
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
    h264Mode, h264Size, videoRef, sendControl,
    screenType, setScreenType, refreshScreenshot,
    screenAlive, streamFps,
  } = useDevice();

  const [recording, setRecording] = useState(false);
  const [scenarioName, setScenarioName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);

  // Scenario load/edit
  const [savedScenarios, setSavedScenarios] = useState<string[]>([]);
  const [editingExisting, setEditingExisting] = useState(false);
  const [originalScenarioName, setOriginalScenarioName] = useState('');

  // 변경사항 추적 (저장된 스텝과 비교)
  const savedStepsRef = useRef<string>('[]');
  const saveScenarioRef = useRef<() => Promise<void>>(async () => {});
  const isDirty = useCallback(() => {
    if (steps.length === 0) return false;
    const current = JSON.stringify(steps.map(({ _imageVer, ...rest }) => rest));
    return current !== savedStepsRef.current;
  }, [steps]);
  const confirmIfDirty = useCallback((): Promise<boolean> => {
    if (!isDirty()) return Promise.resolve(true);
    return new Promise(resolve => {
      Modal.confirm({
        title: t('record.unsavedTitle'),
        content: t('record.unsavedContent'),
        okText: t('common.save'),
        cancelText: t('record.discardChanges'),
        onOk: async () => { await saveScenarioRef.current(); resolve(true); },
        onCancel: () => resolve(true),
      });
    });
  }, [isDirty, t]);

  // 브라우저 닫기/새로고침 시 저장 확인
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty()) { e.preventDefault(); }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // 페이지 전환 시 확인할 수 있도록 window에 노출
  useEffect(() => {
    (window as any).__recordPageDirtyCheck = () => isDirty() ? confirmIfDirty() : Promise.resolve(true);
    return () => { delete (window as any).__recordPageDirtyCheck; };
  }, [isDirty, confirmIfDirty]);

  // Pending background step count
  const pendingStepsRef = useRef(0);
  const [hasPendingSteps, setHasPendingSteps] = useState(false);

  // Detected gesture display
  const [lastGesture, setLastGesture] = useState('');

  // Settings
  const { settings } = useSettings();
  const isDark = settings.theme === 'dark';
  const subTextColor = isDark ? '#aaa' : '#888';
  const mutedTextColor = isDark ? '#999' : '#666';

  // Wait step insertion
  const [waitDurationMs, setWaitDurationMs] = useState(1000);
  const waitDurationRef = useRef(1000);

  // Per-step controls (for manual step input)
  const [stepDeviceId, setStepDeviceId] = useState('');
  const [stepType, setStepType] = useState('tap');
  const [delayMs, setDelayMs] = useState(1000);
  const [stepDesc, setStepDesc] = useState('');
  const [cmdExpected, setCmdExpected] = useState('');
  const [cmdMatchMode, setCmdMatchMode] = useState<'contains' | 'exact'>('contains');
  const [cmdBackground, setCmdBackground] = useState(false);
  const [serialData, setSerialData] = useState('');
  const [serialResponse, setSerialResponse] = useState('');
  const [serialSending, setSerialSending] = useState(false);
  const [compareModePopoverIndex, setCompareModePopoverIndex] = useState<number | null>(null);

  // Module command
  const [moduleFunctions, setModuleFunctions] = useState<{ name: string; params: { name: string; required: boolean; default?: string }[] }[]>([]);
  const [selectedModuleFunc, setSelectedModuleFunc] = useState('');
  const [moduleFuncArgs, setModuleFuncArgs] = useState<Record<string, string>>({});
  const [dltBackground, setDltBackground] = useState(false);

  // HKMC hardware keys
  const [hkmcKeys, setHkmcKeys] = useState<HkmcKeyInfo[]>([]);
  const [hkmcSubCommands, setHkmcSubCommands] = useState<Record<string, number>>({});

  // HKMC 디스플레이 모드: standard(기본형) / integrated(일체형 — 클러스터+AVN)
  const [hkmcDisplayMode, setHkmcDisplayMode] = useState<'standard' | 'integrated'>('standard');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [annotatedPreviewSrc, setAnnotatedPreviewSrc] = useState('');
  const [annotatedPreviewVisible, setAnnotatedPreviewVisible] = useState(false);
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

  // blob URL → data URL 변환 (HKMC WebSocket blob URL은 다음 프레임에 revoke 됨)
  const snapshotScreenshot = useCallback(async (): Promise<string> => {
    // 백엔드에서 원본 해상도 스크린샷 직접 가져오기 (모달용)
    if (screenshotDeviceId) {
      try {
        const dev = primaryDevices.find(d => d.id === screenshotDeviceId);
        const needsScreenType = dev?.type === 'hkmc6th' || (dev?.type === 'adb' && (dev.info?.displays?.length ?? 0) > 1);
        const res = await deviceApi.screenshot(screenshotDeviceId, needsScreenType ? screenType : undefined);
        if (res.data.image) {
          const fmt = res.data.format || 'jpeg';
          return `data:image/${fmt};base64,${res.data.image}`;
        }
      } catch { /* 실패 시 아래 폴백 */ }
    }

    // 폴백: 메인 캔버스에서 캡처 (저해상도일 수 있음)
    const mainCanvas = canvasRef.current;
    if (mainCanvas && mainCanvas.width > 0 && mainCanvas.height > 0) {
      try {
        return mainCanvas.toDataURL('image/png');
      } catch { /* CORS 등 실패 시 아래 폴백 */ }
    }

    const src = screenshot || '';
    if (!src) return '';
    if (!src.startsWith('blob:')) return src;

    return new Promise<string>((resolve) => {
      const img = new window.Image();
      img.onload = () => {
        const cvs = document.createElement('canvas');
        cvs.width = img.naturalWidth;
        cvs.height = img.naturalHeight;
        const ctx = cvs.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0);
          resolve(cvs.toDataURL('image/png'));
        } else {
          resolve(src);
        }
      };
      img.onerror = () => resolve('');
      img.src = src;
    });
  }, [screenshotDeviceId, primaryDevices, screenType, screenshot]);

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
  const isStepHkmc = stepDevice?.type === 'hkmc6th';

  // Get current screen device info
  const screenDevice = primaryDevices.find(d => d.id === screenshotDeviceId);
  const isScreenHkmc = screenDevice?.type === 'hkmc6th';
  const isScreenAdb = screenDevice?.type === 'adb';
  const adbDisplays: { id: number; name: string; sf_id?: string; width?: number; height?: number }[] = screenDevice?.info?.displays || [];
  const hasMultiDisplay = isScreenAdb && adbDisplays.length > 1;
  // 멀티 디스플레이: 선택된 디스플레이 해상도 사용
  const selectedDisplay = hasMultiDisplay ? adbDisplays.find(d => String(d.id) === screenType) : null;
  const deviceRes = selectedDisplay?.width
    ? { width: selectedDisplay.width, height: selectedDisplay.height }
    : screenDevice?.info?.resolution ?? { width: 1080, height: 1920 };

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
    } else if (isStepHkmc) {
      setStepType('hkmc_touch');
      setModuleFunctions([]);
    } else if (isStepPrimary && (stepType === 'serial_command' || stepType === 'module_command' || stepType.startsWith('hkmc_'))) {
      setStepType('tap');
      setModuleFunctions([]);
    }
  }, [stepDeviceId]);

  // Fetch HKMC hardware keys once (when any HKMC device exists)
  useEffect(() => {
    const hasHkmc = primaryDevices.some(d => d.type === 'hkmc6th');
    if (hasHkmc && hkmcKeys.length === 0) {
      deviceApi.listHkmcKeys().then(res => {
        setHkmcKeys(res.data.keys || []);
        setHkmcSubCommands(res.data.sub_commands || {});
      }).catch(() => {});
    }
  }, [primaryDevices]);

  // Stop screenshot polling when leaving page
  useEffect(() => {
    return () => {
      setScreenshotDeviceId('');
    };
  }, []);

  // Helper: convert element coords to device coords (canvas 또는 video)
  // 항상 deviceRes(디바이스 실제 해상도) 기준으로 변환
  // → 스크린샷 해상도가 디바이스 해상도와 다르더라도 터치 좌표가 정확
  const toDeviceCoords = (el: HTMLCanvasElement | HTMLVideoElement, clientX: number, clientY: number) => {
    const rect = el.getBoundingClientRect();
    const scaleX = deviceRes.width / rect.width;
    const scaleY = deviceRes.height / rect.height;
    let x = Math.round((clientX - rect.left) * scaleX);
    const y = Math.round((clientY - rect.top) * scaleY);
    // HKMC 일체형: 클러스터(0~1920) + AVN(1920~3840), AVN 터치 시 x+1920 오프셋
    if (isScreenHkmc && hkmcDisplayMode === 'integrated') {
      x += 1920;
    }
    return { x, y };
  };

  // Map generic gesture actions to HKMC equivalents when target is HKMC device
  const resolveAction = useCallback((action: string, targetDevice: string): string => {
    const dev = allDevices.find(d => d.id === targetDevice);
    if (dev?.type !== 'hkmc6th') return action;
    if (action === 'tap') return 'hkmc_touch';
    if (action === 'swipe') return 'hkmc_swipe';
    if (action === 'long_press') return 'hkmc_touch'; // HKMC has no long_press, treat as touch
    return action;
  }, [allDevices]);

  // Inject screen_type into params for HKMC / ADB multi-display actions
  const resolveParams = useCallback((action: string, params: Record<string, any>, targetDevice: string): Record<string, any> => {
    const dev = allDevices.find(d => d.id === targetDevice);
    if (dev?.type === 'hkmc6th' && (action === 'hkmc_touch' || action === 'hkmc_swipe' || action === 'hkmc_key')) {
      return { ...params, screen_type: screenType };
    }
    // ADB multi-display: 모든 디스플레이에 screen_type 주입 (display 0 포함 — screencap에 SF display ID 필요)
    if (dev?.type === 'adb' && screenType && screenType !== 'front_center') {
      const isMultiDisplay = (dev.info?.displays?.length ?? 0) > 1;
      if (isMultiDisplay || screenType !== '0') {
        return { ...params, screen_type: screenType };
      }
    }
    return params;
  }, [allDevices, screenType]);

  // Execute or record an action
  const executeAction = useCallback(async (action: string, params: Record<string, any>, desc: string) => {
    // 화면 제스처/HKMC키는 항상 화면 디바이스로, 나머지는 스텝 디바이스로
    const isScreenAction = ['tap', 'swipe', 'long_press', 'hkmc_touch', 'hkmc_swipe', 'hkmc_key'].includes(action);
    const effectiveStepDevice = stepDeviceId && stepDeviceId !== '__common__' ? stepDeviceId : '';
    const targetDevice = recording
      ? (isScreenAction ? screenshotDeviceId : (effectiveStepDevice || screenshotDeviceId))
      : screenshotDeviceId;
    if (!targetDevice) return;

    const resolvedAction = resolveAction(action, targetDevice);
    const resolvedParams = resolveParams(resolvedAction, params, targetDevice);

    // H.264 모드에서 화면 제스처는 scrcpy 컨트롤로 이미 실행됨 → ADB 중복 실행 방지
    const alreadyExecuted = h264Mode && isScreenAction;

    if (recording) {
      // Optimistic UI: show step immediately
      const tempId = steps.length + 1;
      const optimisticStep: Step = {
        id: tempId, type: resolvedAction, device_id: targetDevice,
        params: resolvedParams, delay_after_ms: delayMs, description: desc, expected_image: null,
      };
      setSteps((prev) => [...prev, optimisticStep]);

      if (!alreadyExecuted) {
        // Execute on device immediately for fast response
        deviceApi.input(targetDevice, resolvedAction, resolvedParams).then(() => {
          refreshScreenshot();
        }).catch((e: any) => {
          message.error(e.response?.data?.detail || t('record.inputFailed'));
        });
      }

      // Record step in background (skip_execute since we already ran it)
      pendingStepsRef.current += 1;
      setHasPendingSteps(true);
      scenarioApi.addStep({
        type: resolvedAction,
        device_id: targetDevice,
        params: resolvedParams,
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
      if (!alreadyExecuted) {
        // Fire input and refresh in parallel — don't wait for input to complete
        deviceApi.input(targetDevice, resolvedAction, resolvedParams).catch((e: any) => {
          message.error(e.response?.data?.detail || t('record.inputFailed'));
        });
        // Short delay then refresh (device needs a moment to process input)
        setTimeout(() => refreshScreenshot(), 150);
      }
    }
  }, [recording, stepDeviceId, screenshotDeviceId, delayMs, refreshScreenshot, resolveAction, resolveParams, h264Mode]);

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
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
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
      const res = await scenarioApi.captureExpectedImage(scenarioName, stepIdx, screenshotDeviceId, undefined, undefined, undefined, (isScreenHkmc || hasMultiDisplay) ? screenType : undefined);
      setSteps(prev => prev.map((s, i) => i === stepIdx ? { ...s, expected_image: res.data.filename, screenshot_device_id: screenshotDeviceId, _imageVer: Date.now(), roi: null, exclude_rois: [], expected_images: [] } : s));
      message.success(t('record.expectedSaved', { index: stepIdx + 1 }));
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('record.expectedImageSaveFailed'));
    }
  }, [scenarioName, screenshotDeviceId, isScreenHkmc, hasMultiDisplay, screenType, t]);

  const openCaptureModal = useCallback(async (stepIdx: number) => {
    // 현재 화면 스냅샷만 (저장은 사용자가 크롭 확정 시)
    captureScreenshotRef.current = await snapshotScreenshot();
    setCaptureStepIndex(stepIdx);
    setCaptureModalOpen(true);
  }, [snapshotScreenshot]);

  const testStep = useCallback(async (stepIdx: number) => {
    if (!scenarioName) {
      message.warning(t('record.saveScenarioFirst'));
      return;
    }
    setTestingStepIndex(stepIdx);
    try {
      const { _imageVer, ...currentStep } = steps[stepIdx];
      const res = await scenarioApi.testStep(scenarioName, stepIdx, currentStep);
      const result = { ...res.data, _ts: Date.now() };
      setTestResult(result);
      setTestResultModalOpen(true);
      refreshScreenshot();
      // 백그라운드 CMD 결과 폴링
      const bgMatch = result.message?.match?.(/\[BG_TASK:(bg_\d+)\]/);
      if (bgMatch) {
        const taskId = bgMatch[1];
        result.message = `${t('record.cmdRunning')}...`;
        setTestResult({ ...result });
        const poll = setInterval(async () => {
          try {
            const r = await scenarioApi.getCmdResult(taskId);
            if (r.data.status !== 'running') {
              clearInterval(poll);
              const stdout = r.data.stdout || '';
              const step = steps[stepIdx];
              if (step?.type === 'cmd_check') {
                const expected = step.params?.expected || '';
                const matchMode = step.params?.match_mode || 'contains';
                const newMsg = `[CMD_CHECK]\nexpected(${matchMode}): ${expected}\n---\n${stdout}`;
                const passed = matchMode === 'exact' ? stdout.trim() === expected.trim() : stdout.includes(expected);
                setTestResult((prev: any) => ({ ...prev, message: newMsg, status: passed ? prev.status : 'fail' }));
              } else {
                setTestResult((prev: any) => ({ ...prev, message: stdout || `완료 (rc: ${r.data.rc})` }));
              }
            }
          } catch { clearInterval(poll); }
        }, 1000);
      }
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
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
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
          scenarioName, captureStepIndex, screenshotDeviceId, crop, undefined, undefined, (isScreenHkmc || hasMultiDisplay) ? screenType : undefined,
        );
        setSteps(prev => prev.map((s, i) => i === captureStepIndex ? { ...s, expected_image: res.data.filename, roi: crop, screenshot_device_id: screenshotDeviceId, _imageVer: Date.now(), exclude_rois: [], expected_images: [] } : s));
        message.success(t('record.cropExpectedSaved', { index: captureStepIndex + 1, size: `${rw}×${rh}` }));
        setCaptureModalOpen(false);
        setCaptureStepIndex(null);
      } catch (e: any) {
        console.error('Expected image save error:', e.response?.status, e.response?.data);
        message.error(e.response?.data?.detail || t('record.expectedImageSaveFailed'));
      }
    }
  }, [captureStepIndex, scenarioName, screenshotDeviceId, isScreenHkmc, hasMultiDisplay, screenType, t]);

  useEffect(() => {
    if (captureModalOpen) setTimeout(() => drawCaptureCanvas(), 50);
  }, [captureModalOpen]);

  // Open ROI modal — freeze the current screenshot
  const openRoiModal = useCallback(async (index: number) => {
    roiScreenshotRef.current = await snapshotScreenshot();
    setRoiEditingIndex(index);
    setRoiModalOpen(true);
  }, [snapshotScreenshot]);

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
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
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
    setExcludeRoiEditingIndex(index);
    setExcludeRoiSelectedIdx(null);
    excludeRoiScreenshotRef.current = await snapshotScreenshot();
    setExcludeRoiModalOpen(true);
  }, [snapshotScreenshot]);

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

  const excludeRoiMouseUp = useCallback(async () => {
    if (!excludeRoiDragRef.current.active) return;
    excludeRoiDragRef.current.active = false;
    const { startX, startY, curX, curY } = excludeRoiDragRef.current;
    const rx = Math.min(startX, curX);
    const ry = Math.min(startY, curY);
    const rw = Math.abs(curX - startX);
    const rh = Math.abs(curY - startY);
    if (rw > 10 && rh > 10 && excludeRoiEditingIndex != null) {
      // 기대 이미지가 없으면 자동 캡처
      const step = steps[excludeRoiEditingIndex];
      if (!step?.expected_image && scenarioName && screenshotDeviceId) {
        try {
          const capRes = await scenarioApi.captureExpectedImage(scenarioName, excludeRoiEditingIndex, screenshotDeviceId, undefined, undefined, undefined, (isScreenHkmc || hasMultiDisplay) ? screenType : undefined);
          setSteps(prev => prev.map((s, i) => i === excludeRoiEditingIndex ? { ...s, expected_image: capRes.data.filename, screenshot_device_id: screenshotDeviceId, _imageVer: Date.now(), roi: null, expected_images: [] } : s));
        } catch (e: any) {
          message.error(e.response?.data?.detail || t('record.cropSaveFailed'));
          return;
        }
      }
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
  }, [excludeRoiEditingIndex, excludeRoiSelectedIdx, drawExcludeRoiCanvas, steps, scenarioName, screenshotDeviceId, isScreenHkmc, hasMultiDisplay, screenType]);

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
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
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
    setMultiCropEditingIndex(stepIdx);
    setMultiCropSelectedIdx(null);
    multiCropScreenshotRef.current = await snapshotScreenshot();
    setMultiCropModalOpen(true);
  }, [snapshotScreenshot]);

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
    if (rw > 10 && rh > 10 && multiCropEditingIndex != null && scenarioName && screenshotDeviceId) {
      // 캔버스 ↔ deviceRes 비율 변환 (H.264 다운스케일 대응)
      const crop = { x: rx, y: ry, width: rw, height: rh };
      try {
        // 현재 화면으로 기대이미지 갱신 (모달 스냅샷과 좌표 일치 보장)
        const capRes = await scenarioApi.captureExpectedImage(scenarioName, multiCropEditingIndex, screenshotDeviceId, undefined, undefined, undefined, (isScreenHkmc || hasMultiDisplay) ? screenType : undefined);
        setSteps(prev => prev.map((s, i) => i === multiCropEditingIndex ? { ...s, expected_image: capRes.data.filename, screenshot_device_id: screenshotDeviceId, _imageVer: Date.now(), roi: null, exclude_rois: [] } : s));
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
  }, [multiCropEditingIndex, multiCropSelectedIdx, scenarioName, screenshotDeviceId, isScreenHkmc, hasMultiDisplay, screenType, drawMultiCropCanvas]);

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

  // Canvas/Video gesture handlers (no ROI logic here)
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement | HTMLVideoElement>) => {
    if (!screenshotDeviceId) return;
    const el = h264Mode ? videoRef.current : canvasRef.current;
    if (!el) return;
    const { x, y } = toDeviceCoords(el, e.clientX, e.clientY);
    gestureRef.current = { startX: x, startY: y, startTime: Date.now(), active: true };
    // H.264 모드: scrcpy 터치 즉시 주입 (DOWN)
    // toDeviceCoords가 deviceRes 기준 좌표를 반환하므로 w/h도 deviceRes 사용
    if (h264Mode) {
      sendControl({ type: 'touch', action: 0, x, y, w: deviceRes.width, h: deviceRes.height });
    }
  }, [screenshotDeviceId, deviceRes, h264Mode, sendControl, hkmcDisplayMode, isScreenHkmc]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement | HTMLVideoElement>) => {
    if (!h264Mode || !gestureRef.current.active) return;
    const el = videoRef.current;
    if (!el) return;
    const { x, y } = toDeviceCoords(el, e.clientX, e.clientY);
    sendControl({ type: 'touch', action: 2, x, y, w: deviceRes.width, h: deviceRes.height });
  }, [h264Mode, deviceRes, sendControl, hkmcDisplayMode, isScreenHkmc]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement | HTMLVideoElement>) => {
    if (!screenshotDeviceId || !gestureRef.current.active) return;
    gestureRef.current.active = false;
    const el = h264Mode ? videoRef.current : canvasRef.current;
    if (!el) return;

    const { startX, startY, startTime } = gestureRef.current;
    const { x: endX, y: endY } = toDeviceCoords(el, e.clientX, e.clientY);
    const dist = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);
    const elapsed = Date.now() - startTime;

    // H.264 모드: scrcpy 터치 즉시 주입 (UP) — 디바이스에 이미 반영됨
    if (h264Mode) {
      sendControl({ type: 'touch', action: 1, x: endX, y: endY, w: deviceRes.width, h: deviceRes.height });
    }

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
  }, [screenshotDeviceId, executeAction, deviceRes, h264Mode, sendControl, hkmcDisplayMode, isScreenHkmc]);

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
      // DLTViewer: WaitLog + 백그라운드 체크 시 StartMonitor로 자동 전환
      let funcName = selectedModuleFunc;
      if (stepDeviceModule === 'DLTViewer' && selectedModuleFunc === 'WaitLog' && dltBackground) {
        funcName = 'StartMonitor';
      }
      params = { module: stepDeviceModule, function: funcName, args: { ...moduleFuncArgs } };
    } else if (stepType === 'serial_command') {
      if (!serialData.trim()) { message.warning(t('record.enterValue')); return; }
      params = { data: serialData };
    } else if (stepType === 'input_text') {
      if (!stepDesc.trim()) { message.warning(t('record.enterValue')); return; }
      params = { text: stepDesc };
    } else if (stepType === 'key_event') {
      params = { keycode: stepDesc || 'KEYCODE_BACK' };
    } else if (stepType === 'wait') {
      params = { duration_ms: delayMs };
    } else if (stepType === 'adb_command') {
      if (!stepDesc.trim()) { message.warning(t('record.enterValue')); return; }
      params = { command: stepDesc };
    } else if (stepType === 'cmd_send') {
      if (!stepDesc.trim()) { message.warning(t('record.enterValue')); return; }
      params = { command: stepDesc, background: cmdBackground };
    } else if (stepType === 'cmd_check') {
      if (!stepDesc.trim()) { message.warning(t('record.enterValue')); return; }
      params = { command: stepDesc, expected: cmdExpected, match_mode: cmdMatchMode, background: cmdBackground };
    } else if (stepType === 'hkmc_key') {
      params = { key_name: stepDesc, screen_type: screenType };
    }

    try {
      const res = await scenarioApi.addStep({
        type: stepType,
        device_id: stepDeviceId === '__common__' ? '' : stepDeviceId,
        params,
        description: stepDesc || (
          stepType === 'module_command' ? `${stepDeviceModule}::${selectedModuleFunc}()` :
          stepType === 'serial_command' ? `Serial: ${serialData.substring(0, 30)}` :
          stepType === 'hkmc_key' ? (stepDesc ? `HKMC Key: ${stepDesc}` : 'HKMC Key') :
          stepType === 'cmd_send' ? `CMD: ${stepDesc.substring(0, 40)}` :
          stepType === 'cmd_check' ? `CHECK: ${stepDesc.substring(0, 30)}` : ''
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
    if (isDirty()) {
      const ok = await confirmIfDirty();
      if (!ok) return;
    }
    try {
      const res = await scenarioApi.get(name);
      setScenarioName(res.data.name);
      setOriginalScenarioName(res.data.name);
      setDescription(res.data.description || '');
      const loadedSteps = res.data.steps || [];
      setSteps(loadedSteps);
      savedStepsRef.current = JSON.stringify(loadedSteps.map(({ _imageVer, ...rest }: any) => rest));
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
      // Re-index step IDs, _imageVer 등 프론트엔드 전용 필드 제거
      const reindexed = steps.map((s, i) => {
        const { _imageVer, ...rest } = s;
        return { ...rest, id: i + 1 };
      });
      await scenarioApi.update(newName, {
        name: newName,
        description,
        steps: reindexed,
      });
      // _imageVer 복원 (캐시 버스팅 유지)
      const savedSteps = reindexed.map((s, i) => ({ ...s, _imageVer: steps[i]?._imageVer }));
      setSteps(savedSteps);
      savedStepsRef.current = JSON.stringify(reindexed);
      setScenarioName(newName);
      message.success(t('common.saveComplete'));
      fetchSavedScenarios();
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('common.saveFailed'));
    }
  };
  saveScenarioRef.current = saveScenario;

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
      return filtered.map((s, i) => ({
        ...s,
        id: i + 1,
        on_pass_goto: remapGoto(s.on_pass_goto, mapping),
        on_fail_goto: remapGoto(s.on_fail_goto, mapping),
      }));
    });
    message.success(t('record.stepDeleted', { index: index + 1 }));
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    setSteps((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
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
        const insertPos1Based = afterIndex + 2;
        arr.splice(afterIndex + 1, 0, waitStep);
        // 삽입 위치 이후의 goto 참조를 +1 시프트 + ID 재번호
        return arr.map((s, i) => ({
          ...s,
          id: i + 1,
          on_pass_goto: s.on_pass_goto != null && s.on_pass_goto !== -1 && s.on_pass_goto >= insertPos1Based ? s.on_pass_goto + 1 : s.on_pass_goto,
          on_fail_goto: s.on_fail_goto != null && s.on_fail_goto !== -1 && s.on_fail_goto >= insertPos1Based ? s.on_fail_goto + 1 : s.on_fail_goto,
        }));
      });
    } else {
      setSteps((prev) => [...prev, { ...waitStep, id: prev.length + 1 }]);
    }
  };

  const updateStepJump = useCallback((index: number, field: 'on_pass_goto' | 'on_fail_goto', value: number | null) => {
    setSteps((prev) => prev.map((s, i) => i === index ? { ...s, [field]: value } : s));
  }, []);

  const updateStepDescription = useCallback((index: number, value: string) => {
    setSteps((prev) => prev.map((s, i) => i === index ? { ...s, description: value } : s));
  }, []);

  // --- Step command edit modal ---
  const editScreenshotRef = useRef<string>('');

  const openEditStepModal = useCallback(async (index: number) => {
    const s = steps[index];
    // 스냅샷을 먼저 캡처 (모달 열기 전에 완료)
    editScreenshotRef.current = await snapshotScreenshot();
    setEditStepIndex(index);
    setEditStepParams({ ...s.params });
  }, [steps, snapshotScreenshot]);

  const drawEditCanvas = useCallback(() => {
    const canvas = editCanvasRef.current;
    const src = editScreenshotRef.current;
    if (!canvas || !src) return;
    const img = new window.Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')?.drawImage(img, 0, 0);
    };
    img.src = src;
  }, []);

  const editCanvasToDevice = useCallback((canvas: HTMLCanvasElement, clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    // 캔버스 내부 해상도(= 원본 이미지) / CSS 표시 크기 = 스케일 팩터
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

    if (step.type === 'swipe' || step.type === 'hkmc_swipe') {
      const durationMs = Math.max(200, Math.min(elapsed, 3000));
      const base = step.type === 'hkmc_swipe' ? { screen_type: step.params.screen_type } : {};
      const newParams = { ...base, x1: startX, y1: startY, x2: endX, y2: endY, duration_ms: durationMs };
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
      // tap / hkmc_touch — just use start coords
      const base = step.type === 'hkmc_touch' ? { screen_type: step.params.screen_type } : {};
      const newParams = { ...base, x: startX, y: startY };
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

  // 이름 입력 모달로 시나리오 작업 수행
  const promptScenarioName = (title: string, defaultValue: string, onConfirm: (name: string) => Promise<void>) => {
    let inputValue = defaultValue;
    Modal.confirm({
      title,
      content: <Input defaultValue={defaultValue} onChange={(e) => { inputValue = e.target.value; }} />,
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        const name = inputValue.trim();
        if (!name) { message.warning(t('record.enterScenarioName')); throw new Error('empty'); }
        // 중복 체크
        if (savedScenarios.includes(name) && name !== scenarioName) {
          return new Promise<void>((resolve, reject) => {
            Modal.confirm({
              title: t('record.duplicateName'),
              content: t('record.overwriteOrRename'),
              okText: t('record.overwrite'),
              cancelText: t('record.changeName'),
              onOk: async () => { await onConfirm(name); resolve(); },
              onCancel: () => reject(new Error('rename')),
            });
          });
        }
        await onConfirm(name);
      },
    });
  };

  const deleteScenario = async () => {
    if (!scenarioName || !editingExisting) return;
    Modal.confirm({
      title: t('record.confirmDelete', { name: scenarioName }),
      okText: t('common.delete'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          await scenarioApi.delete(scenarioName);
          message.success(t('record.scenarioDeleted'));
          clearEditing();
          fetchSavedScenarios();
        } catch (e: any) {
          message.error(e.response?.data?.detail || t('common.deleteFailed'));
        }
      },
    });
  };

  const copyScenario = () => {
    if (!scenarioName || !editingExisting) return;
    promptScenarioName(t('record.copyScenario'), `${scenarioName}_copy`, async (name) => {
      try {
        await scenarioApi.copy(scenarioName, name);
        message.success(t('record.scenarioCopied', { name }));
        fetchSavedScenarios();
        loadScenario(name);
      } catch (e: any) {
        message.error(e.response?.data?.detail || t('common.saveFailed'));
      }
    });
  };

  const renameScenario = () => {
    if (!scenarioName || !editingExisting) return;
    promptScenarioName(t('record.renameScenario'), scenarioName, async (name) => {
      try {
        await scenarioApi.rename(scenarioName, name);
        setScenarioName(name);
        setOriginalScenarioName(name);
        message.success(t('record.scenarioRenamed', { name }));
        fetchSavedScenarios();
      } catch (e: any) {
        message.error(e.response?.data?.detail || t('common.saveFailed'));
      }
    });
  };

  const createNewWithName = () => {
    promptScenarioName(t('record.createNewScenario'), '', async (name) => {
      clearEditing();
      setScenarioName(name);
    });
  };

  // 기대이미지 미리보기: 어노테이션(exclude/crop ROI) 포함
  const showAnnotatedPreview = useCallback((step: Step) => {
    if (!step.expected_image || !scenarioName) return;
    const imgUrl = `/screenshots/${scenarioName}/${step.expected_image}?v=${step._imageVer || ''}`;
    const hasAnnotations = (step.exclude_rois?.length || 0) > 0 || (step.expected_images?.length || 0) > 0 || !!step.roi;
    if (!hasAnnotations) {
      setAnnotatedPreviewSrc(imgUrl);
      setAnnotatedPreviewVisible(true);
      return;
    }
    const img = new window.Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      if (step.roi) {
        const r = step.roi;
        ctx.strokeStyle = '#52c41a';
        ctx.lineWidth = 3;
        ctx.strokeRect(r.x, r.y, r.width, r.height);
        ctx.fillStyle = 'rgba(82,196,26,0.15)';
        ctx.fillRect(r.x, r.y, r.width, r.height);
        ctx.fillStyle = '#52c41a';
        ctx.font = '24px sans-serif';
        ctx.fillText('CROP', r.x + 4, r.y + 26);
      }
      if (step.exclude_rois?.length) {
        step.exclude_rois.forEach((r, i) => {
          ctx.fillStyle = 'rgba(255, 0, 0, 0.3)';
          ctx.fillRect(r.x, r.y, r.width, r.height);
          ctx.strokeStyle = '#ff4d4f';
          ctx.lineWidth = 2;
          ctx.strokeRect(r.x, r.y, r.width, r.height);
          ctx.fillStyle = '#fff';
          ctx.font = '20px sans-serif';
          ctx.fillText(`#${i + 1}`, r.x + 4, r.y + 22);
        });
      }
      if (step.expected_images?.length) {
        step.expected_images.forEach((ci, i) => {
          if (!ci.roi) return;
          ctx.strokeStyle = '#52c41a';
          ctx.lineWidth = 2;
          ctx.strokeRect(ci.roi.x, ci.roi.y, ci.roi.width, ci.roi.height);
          ctx.fillStyle = 'rgba(82,196,26,0.15)';
          ctx.fillRect(ci.roi.x, ci.roi.y, ci.roi.width, ci.roi.height);
          ctx.fillStyle = '#52c41a';
          ctx.font = '24px sans-serif';
          ctx.fillText(ci.label || `#${i + 1}`, ci.roi.x + 4, ci.roi.y + 24);
        });
      }
      setAnnotatedPreviewSrc(canvas.toDataURL('image/png'));
      setAnnotatedPreviewVisible(true);
    };
    img.src = imgUrl;
  }, [scenarioName]);

  // 비교모드 Popover 닫고 → 모달 열기
  const selectCompareMode = useCallback((index: number, mode: string) => {
    setCompareModePopoverIndex(null);
    updateCompareMode(index, mode);
    setTimeout(() => {
      if (mode === 'full') saveExpectedFull(index);
      else if (mode === 'single_crop') openCaptureModal(index);
      else if (mode === 'full_exclude') openExcludeRoiModal(index);
      else if (mode === 'multi_crop') openMultiCropModal(index);
    }, 100);
  }, [updateCompareMode, saveExpectedFull, openCaptureModal, openExcludeRoiModal, openMultiCropModal]);

  // Draw screenshot on canvas
  useEffect(() => {
    if (!screenshot || !canvasRef.current) return;
    const img = new window.Image();
    img.onload = () => {
      const canvas = canvasRef.current!;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')?.drawImage(img, 0, 0);
    };
    img.src = screenshot;
  }, [screenshot]);

  const getStepTypes = () => {
    if (stepDeviceId === '__common__') {
      return [
        { value: 'wait', label: t('record.wait') },
        { value: 'cmd_send', label: t('record.cmdSend') },
        { value: 'cmd_check', label: t('record.cmdCheck') },
      ];
    }
    if (isStepAuxiliary) {
      const types = [
        { value: 'serial_command', label: t('record.serialCommand') },
        { value: 'wait', label: t('record.wait') },
        { value: 'cmd_send', label: t('record.cmdSend') },
        { value: 'cmd_check', label: t('record.cmdCheck') },
      ];
      if (stepDeviceModule) {
        types.unshift({ value: 'module_command', label: t('record.moduleLabel', { name: stepDeviceModule }) });
      }
      return types;
    }
    if (isStepHkmc) {
      return [
        { value: 'hkmc_touch', label: t('record.hkmcTouch') },
        { value: 'hkmc_swipe', label: t('record.hkmcSwipe') },
        { value: 'hkmc_key', label: t('record.hkmcKey') },
        { value: 'wait', label: t('record.wait') },
        { value: 'cmd_send', label: t('record.cmdSend') },
        { value: 'cmd_check', label: t('record.cmdCheck') },
      ];
    }
    return [
      { value: 'input_text', label: t('record.inputText') },
      { value: 'key_event', label: t('record.keyEvent') },
      { value: 'wait', label: t('record.wait') },
      { value: 'adb_command', label: t('record.adbCommand') },
      { value: 'cmd_send', label: t('record.cmdSend') },
      { value: 'cmd_check', label: t('record.cmdCheck') },
    ];
  };

  const getDeviceTag = (deviceId: string | null) => {
    if (!deviceId) return <Tag>-</Tag>;
    const dev = allDevices.find(d => d.id === deviceId);
    if (!dev) return <Tag color="orange">{deviceId}</Tag>;
    const color = dev.category === 'primary' ? 'green' : 'purple';
    return <Tag color={color}>{dev.id}</Tag>;
  };

  // Memoize the step list so screenshot polling doesn't re-render it
  // (which would close Popovers and reset Select states)
  const stepListMemo = useMemo(() => (
    <List
      size="small"
      dataSource={steps}
      renderItem={(s, index) => (
        <List.Item style={{ display: 'flex', padding: '4px 8px', gap: 8, background: index % 2 === 0 ? undefined : 'rgba(255,255,255,0.04)' }}>
          {/* 좌측: 스텝 정보 (1행: 설명+함수+delay) + (2행: 나머지) */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* 1행: 설명, 함수(인자), delay(우측정렬) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ flexShrink: 0, width: 32, textAlign: 'center', display: 'inline-block' }}><Tag color={s.type === 'wait' ? 'cyan' : 'blue'} style={{ margin: 0 }}>#{index + 1}</Tag></span>
              <Input
                size="small"
                placeholder="Remark"
                value={s.description}
                onChange={(e) => updateStepDescription(index, e.target.value)}
                style={{ flex: 1, minWidth: 60, maxWidth: 180 }}
              />
              {s.type !== 'wait' && (
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4, flex: 1 }}>
                  {s.type === 'module_command'
                    ? `${s.params.function}(${s.params.args ? Object.entries(s.params.args).map(([, v]) => `"${v}"`).join(', ') : ''})`
                    : s.type === 'serial_command'
                    ? <><Tag color="purple" style={{ margin: 0 }}>Serial</Tag> {s.params.data}</>
                    : s.type === 'hkmc_touch'
                    ? `touch (${s.params.x},${s.params.y})`
                    : s.type === 'hkmc_swipe'
                    ? `swipe (${s.params.x1},${s.params.y1})→(${s.params.x2},${s.params.y2})`
                    : s.type === 'hkmc_key'
                    ? <><Tag color="volcano" style={{ margin: 0 }}>KEY</Tag> {s.params.key_name || `cmd:${s.params.cmd}`}</>
                    : s.type === 'cmd_send'
                    ? <><Tag color="blue" style={{ margin: 0 }}>CMD</Tag> {s.params.command?.substring(0, 40)}</>
                    : s.type === 'cmd_check'
                    ? <><Tag color="orange" style={{ margin: 0 }}>CHECK</Tag> {s.params.command?.substring(0, 25)} → {s.params.match_mode === 'exact' ? '=' : '⊃'} {s.params.expected?.substring(0, 20)}</>
                    : JSON.stringify(s.params)}
                </span>
              )}
              {s.type === 'wait' ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 'auto', flexShrink: 0 }}>
                  <Tag color="cyan" style={{ margin: 0 }}>WAIT</Tag>
                  <InputNumber size="small" min={100} step={100} value={s.params.duration_ms} onChange={(v) => setSteps(prev => prev.map((st, i) => i === index ? { ...st, params: { ...st.params, duration_ms: v || 1000 } } : st))} suffix="ms" style={{ width: 110 }} />
                </span>
              ) : (
                <InputNumber
                  size="small"
                  min={0}
                  max={Infinity}
                  step={100}
                  value={s.delay_after_ms}
                  onChange={(v) => setSteps(prev => prev.map((st, i) => i === index ? { ...st, delay_after_ms: v || 0 } : st))}
                  suffix="ms"
                  style={{ width: 110, flexShrink: 0, marginLeft: 'auto' }}
                />
              )}
            </div>
            {/* 2행: 디바이스/타입/이미지/태그 (좌측 정렬) */}
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 2, paddingLeft: 36, flexWrap: 'wrap' }}>
              {getDeviceTag(s.device_id)}
              <Tag color={s.type === 'wait' ? 'cyan' : s.type === 'module_command' ? 'geekblue' : s.type.startsWith('hkmc_') ? 'volcano' : undefined}>{s.type === 'module_command' ? (s.params.module || 'module_command') : s.type}</Tag>
              {s.screen_type && <Tag color="geekblue" style={{ margin: 0 }}>{s.screen_type}</Tag>}
              {s.on_pass_goto != null && (
                <Tag color="green">P→{s.on_pass_goto === -1 ? 'END' : `#${s.on_pass_goto}`}</Tag>
              )}
              {s.on_fail_goto != null && (
                <Tag color="red">F→{s.on_fail_goto === -1 ? 'END' : `#${s.on_fail_goto}`}</Tag>
              )}
              {s.expected_image && scenarioName && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 'auto', flexShrink: 0 }}>
                  <Tag
                    color="green"
                    style={{ margin: 0, cursor: 'pointer' }}
                    onClick={() => showAnnotatedPreview(s)}
                  >
                    <CameraOutlined style={{ marginRight: 4 }} />
                    {(s.expected_images?.length || 0) > 0 ? 'MULTI'
                      : (s.exclude_rois?.length || 0) > 0 ? 'EXCLUDE'
                      : s.roi ? 'CROP'
                      : 'FULL'}
                  </Tag>
                  <CloseCircleOutlined
                    onClick={() => setSteps((prev) => prev.map((st, i) => i === index ? { ...st, expected_image: null, roi: null, exclude_rois: [], expected_images: [] } : st))}
                    style={{ fontSize: 14, color: '#ff4d4f', cursor: 'pointer' }}
                  />
                </span>
              )}
            </div>
          </div>
          {/* 우측: 2행 아이콘 영역 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0, borderLeft: isDark ? '1px solid #333' : '1px solid #d9d9d9', paddingLeft: 8, alignSelf: 'stretch', justifyContent: 'center' }}>
            {/* 1행: 순서변경 + 테스트 + 삭제 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, justifyContent: 'flex-end' }}>
              <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => moveStep(index, -1)} style={{ width: 28 }} />
              <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={index === steps.length - 1} onClick={() => moveStep(index, 1)} style={{ width: 28 }} />
              {scenarioName && (
                <Button size="small" type="text" icon={<ThunderboltOutlined />} title={t('record.testStep')} loading={testingStepIndex === index} onClick={() => testStep(index)} style={{ color: '#faad14', width: 28 }} />
              )}
              <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => Modal.confirm({ title: t('record.confirmDeleteStep', { index: index + 1 }), okText: t('common.delete'), okType: 'danger', cancelText: t('common.cancel'), onOk: () => deleteStep(index) })} style={{ width: 28 }} />
            </div>
            {/* 2행: 편집 + 조건부이동 + W + 카메라 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, justifyContent: 'flex-end' }}>
              <Button size="small" type="text" icon={<EditOutlined />} title={t('record.editCommand')} onClick={() => openEditStepModal(index)} style={{ color: '#1890ff', width: 28 }} />
              <Popover
                content={<JumpEditorInner step={s} index={index} steps={steps} onUpdate={updateStepJump} t={t} />}
                trigger="click"
                placement="left"
              >
                <Button size="small" type="text" icon={<BranchesOutlined />} title={t('record.conditionalJump')} style={{ width: 28, ...(s.on_pass_goto != null || s.on_fail_goto != null ? { color: '#722ed1' } : {}) }} />
              </Popover>
              <Button size="small" type="text" title={t('record.insertWait')} onClick={() => addWaitStep(index)} style={{ width: 28 }}>W</Button>
              {screenshotDeviceId && scenarioName && (
                <Popover
                  open={compareModePopoverIndex === index}
                  onOpenChange={(v) => setCompareModePopoverIndex(v ? index : null)}
                  trigger="click"
                  placement="bottomRight"
                  content={
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 130 }}>
                      <Button size="small" block onClick={() => selectCompareMode(index, 'full')}>
                        <CameraOutlined /> {t('record.fullScreen')}
                      </Button>
                      <Button size="small" block onClick={() => selectCompareMode(index, 'single_crop')}>
                        <ScissorOutlined /> {t('record.singleCrop')}
                      </Button>
                      <Button size="small" block onClick={() => selectCompareMode(index, 'full_exclude')}>
                        <ScissorOutlined /> {t('record.excludeArea')}
                      </Button>
                      <Button size="small" block onClick={() => selectCompareMode(index, 'multi_crop')}>
                        <ScissorOutlined /> {t('record.multiCrop')}
                      </Button>
                    </div>
                  }
                >
                  <Button size="small" type="text" icon={<CameraOutlined />} style={{ width: 28, ...(s.expected_image ? { color: '#52c41a' } : {}) }} />
                </Popover>
              )}
            </div>
          </div>
        </List.Item>
      )}
      locale={{ emptyText: t('record.noSteps') }}
    />
  ), [steps, recording, updateStepJump, updateStepDescription, openEditStepModal, openRoiModal, screenshotDeviceId, scenarioName, saveExpectedFull, openCaptureModal, testStep, testingStepIndex, updateCompareMode, openExcludeRoiModal, openMultiCropModal, showAnnotatedPreview, selectCompareMode, compareModePopoverIndex, t]);

  return (
    <div style={{ height: 'calc(100vh - 80px)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <style>{`@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
      <Splitter style={{ flex: 1, minHeight: 0 }}>
        <Splitter.Panel defaultSize="40%" min="20%" max="70%" style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' }}>
          {/* Left panel: Device screen + Webcam */}
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
                <Space size={4} wrap style={{ justifyContent: 'flex-end' }}>
                  <Select
                    value={screenshotDeviceId || undefined}
                    onChange={(id) => {
                      setScreenshotDeviceId(id);
                      setStepDeviceId(id);
                    }}
                    placeholder={t('record.primaryDevice')}
                    size="small"
                    style={{ minWidth: 140, maxWidth: 280 }}
                  >
                    {primaryDevices.map(d => (
                      <Option key={d.id} value={d.id}>{d.name || d.id}</Option>
                    ))}
                  </Select>
                  {screenDevice && (
                    <Tag color={screenAlive ? 'green' : 'red'} style={{ marginLeft: 0 }}>
                      {screenAlive
                        ? `${h264Mode ? 'H.264' : 'JPEG'} ${streamFps}fps`
                        : t('record.deviceDisconnected')}
                    </Tag>
                  )}
                  {!screenAlive && isScreenAdb && (
                    <Button
                      size="small"
                      danger
                      onClick={async () => {
                        try {
                          await deviceApi.adbRestart();
                          message.info(t('device.adbRestart'));
                        } catch {
                          message.error(t('device.adbRestartFailed'));
                        }
                      }}
                    >{t('device.reconnect')}</Button>
                  )}
                  {isScreenHkmc && (
                    <>
                    <Select
                      size="small"
                      value={screenType}
                      onChange={setScreenType}
                      style={{ minWidth: 120, maxWidth: 240 }}
                    >
                      <Option value="front_center">{t('record.hkmcFront')}</Option>
                      <Option value="rear_left">{t('record.hkmcRearL')}</Option>
                      <Option value="rear_right">{t('record.hkmcRearR')}</Option>
                      <Option value="cluster">{t('record.hkmcCluster')}</Option>
                    </Select>
                    <Select
                      size="small"
                      value={hkmcDisplayMode}
                      onChange={setHkmcDisplayMode}
                      style={{ minWidth: 90 }}
                    >
                      <Option value="standard">{t('record.hkmcStandard')}</Option>
                      <Option value="integrated">{t('record.hkmcIntegrated')}</Option>
                    </Select>
                    </>
                  )}
                  {hasMultiDisplay && (
                    <Select
                      size="small"
                      value={screenType}
                      onChange={setScreenType}
                      style={{ minWidth: 140, maxWidth: 280 }}
                    >
                      {adbDisplays.map(d => (
                        <Option key={d.id} value={String(d.id)}>{d.name}{d.width ? ` (${d.width}x${d.height})` : ` (ID:${d.id})`}</Option>
                      ))}
                    </Select>
                  )}
                </Space>
              )
            }
            style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}
            styles={{
              header: { flexWrap: 'wrap', height: 'auto', minHeight: 40, padding: '4px 12px' },
              body: { flex: 1, overflow: 'hidden', padding: 8, display: 'flex', flexDirection: 'column', alignItems: 'center' },
            }}
          >
            {screenshotDeviceId && (h264Mode || screenshot) ? (
              <>
              <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', maxHeight: '100%' }}>
                {h264Mode ? (
                  <video
                    ref={videoRef as React.RefObject<HTMLVideoElement>}
                    autoPlay
                    muted
                    playsInline
                    onMouseDown={testingStepIndex == null ? handleMouseDown : undefined}
                    onMouseMove={testingStepIndex == null ? handleMouseMove : undefined}
                    onMouseUp={testingStepIndex == null ? handleMouseUp : undefined}
                    style={{
                      maxWidth: '100%',
                      maxHeight: '100%',
                      border: isDark ? '1px solid #333' : '1px solid #d9d9d9',
                      borderRadius: 4,
                      cursor: testingStepIndex != null ? 'wait' : 'crosshair',
                      userSelect: 'none',
                    }}
                  />
                ) : (
                  <canvas
                    ref={canvasRef}
                    onMouseDown={testingStepIndex == null ? handleMouseDown : undefined}
                    onMouseUp={testingStepIndex == null ? handleMouseUp : undefined}
                    style={{
                      maxWidth: '100%',
                      maxHeight: '100%',
                      border: isDark ? '1px solid #333' : '1px solid #d9d9d9',
                      borderRadius: 4,
                      cursor: testingStepIndex != null ? 'wait' : 'crosshair',
                      userSelect: 'none',
                    }}
                  />
                )}
                {testingStepIndex != null && (
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)', borderRadius: 4, pointerEvents: 'none' }}>
                    <Tag color="processing" style={{ fontSize: 14, padding: '4px 12px' }}>{t('record.stepTesting')}</Tag>
                  </div>
                )}
                </div>
                <div style={{ marginTop: 4, color: subTextColor, fontSize: 11 }}>
                  {lastGesture
                    ? `${lastGesture} → ${recording ? t('record.gestureRecord') : t('record.directExec')}`
                    : t('record.gestureHint', { device: screenDevice?.name || screenshotDeviceId || '' })}
                </div>
                {isScreenHkmc && hkmcKeys.length > 0 && testingStepIndex == null && (() => {
                  const HARD_KEY_GROUPS: Record<string, string[]> = {
                    MKBD: ['MKBD_NAV', 'MKBD_RADIO', 'MKBD_MEDIA', 'MKBD_CUSTOM', 'MKBD_SETUP'],
                    CCP: ['CCP_BACK', 'CCP_HOME', 'CCP_MENU', 'CCP_POWER',
                          'CCP_VOLUME_ANTI_CLOCK', 'CCP_VOLUME_CLOCK',
                          'CCP_TUNE_ANTI_CLOCK', 'CCP_TUNE_CLOCK',
                          'CCP_JOGDIAL_ANTI_CLOCK', 'CCP_JOGDIAL_CLOCK',
                          'CCP_RIGHT', 'CCP_LEFT', 'CCP_UP', 'CCP_DOWN', 'CCP_ENTER', 'CCP_TUNE_PUSH'],
                    SWRC: ['SWRC_MUTE', 'SWRC_VOLUME_ANTI_CLOCK', 'SWRC_VOLUME_CLOCK',
                           'SWRC_PTT', 'SWRC_CUSTOM', 'SWRC_SEND', 'SWRC_END'],
                  };
                  const customKeys = hkmcKeys.filter(k => !Object.values(HARD_KEY_GROUPS).flat().includes(k.name));
                  const customGroups: Record<string, HkmcKeyInfo[]> = {};
                  customKeys.forEach(k => {
                    const g = k.group || 'CUSTOM';
                    if (!customGroups[g]) customGroups[g] = [];
                    customGroups[g].push(k);
                  });
                  return (
                    <div style={{ marginTop: 4, width: '100%' }}>
                      {Object.entries(HARD_KEY_GROUPS).map(([group, keyNames]) => {
                        const keys = hkmcKeys.filter(k => keyNames.includes(k.name));
                        if (keys.length === 0) return null;
                        return (
                          <details key={group} style={{ marginBottom: 2 }}>
                            <summary style={{ fontSize: 11, color: subTextColor, cursor: 'pointer', userSelect: 'none' }}>{group}</summary>
                            <div style={{ padding: '2px 0 2px 4px' }}>
                              {keys.map(k => (
                                <Button key={k.name} size="small"
                                  style={{ fontSize: 10, padding: '0 6px', height: 22, margin: '0 2px 2px 0' }}
                                  onClick={() => executeAction('hkmc_key', { key_name: k.name, screen_type: screenType }, k.name)}
                                >{k.name.replace(`${group}_`, '')}</Button>
                              ))}
                            </div>
                          </details>
                        );
                      })}
                      {Object.entries(customGroups).map(([group, keys]) => (
                        <details key={group} style={{ marginBottom: 2 }}>
                          <summary style={{ fontSize: 11, color: '#d4a017', cursor: 'pointer', userSelect: 'none' }}>{group}</summary>
                          <div style={{ padding: '2px 0 2px 4px' }}>
                            {keys.map(k => (
                              <Tag key={k.name} closable
                                onClose={async (e) => { e.preventDefault(); try { await customKeysApi.remove(k.name); const r = await deviceApi.listHkmcKeys(); setHkmcKeys(r.data.keys || []); } catch {} }}
                                style={{ fontSize: 10, cursor: 'pointer', margin: '0 2px 2px 0' }}
                                onClick={() => executeAction('hkmc_key', { key_name: k.name, screen_type: screenType }, k.name)}
                              >{k.name.replace(`${group}_`, '')}</Tag>
                            ))}
                          </div>
                        </details>
                      ))}
                      <Popover trigger="click" title={t('record.addCustomKey')} content={
                        <div style={{ width: 240 }}>
                          <Input size="small" placeholder={t('record.customKeyName')} id="ck-name" style={{ marginBottom: 4 }} />
                          <Input size="small" placeholder={t('record.customKeyGroup')} id="ck-group" defaultValue="CUSTOM" style={{ marginBottom: 4 }} />
                          <Select size="small" defaultValue={0x80} style={{ width: '100%', marginBottom: 4 }} id="ck-cmd"
                            options={[
                              { label: 'MKBD (0x60)', value: 0x60 }, { label: 'SWC (0x70)', value: 0x70 },
                              { label: 'CCP (0x80)', value: 0x80 }, { label: 'RRC (0x90)', value: 0x90 },
                            ]} onChange={(v) => { const el = document.getElementById('ck-cmd') as any; if (el) el.dataset.value = v; }}
                          />
                          <Input size="small" placeholder={t('record.customKeyCode')} id="ck-code" style={{ marginBottom: 4 }} />
                          <Button size="small" type="primary" block onClick={async () => {
                            const nameEl = document.getElementById('ck-name') as HTMLInputElement;
                            const groupEl = document.getElementById('ck-group') as HTMLInputElement;
                            const cmdEl = document.getElementById('ck-cmd') as any;
                            const codeEl = document.getElementById('ck-code') as HTMLInputElement;
                            const name = nameEl?.value?.trim();
                            const group = groupEl?.value?.trim() || 'CUSTOM';
                            const cmd = cmdEl?.dataset?.value ? parseInt(cmdEl.dataset.value) : 0x80;
                            const codeStr = codeEl?.value?.trim() || '0';
                            const keyCode = codeStr.startsWith('0x') ? parseInt(codeStr, 16) : parseInt(codeStr);
                            if (!name) { message.warning(t('record.enterKeyName')); return; }
                            const keyName = `${group}_${name}`;
                            try {
                              await customKeysApi.add({ name, group, key_name: keyName, cmd, key_code: keyCode });
                              const r = await deviceApi.listHkmcKeys();
                              setHkmcKeys(r.data.keys || []);
                              message.success(t('record.customKeyAdded'));
                              if (nameEl) nameEl.value = '';
                              if (codeEl) codeEl.value = '';
                            } catch (e: any) { message.error(e.response?.data?.detail || t('record.customKeyAddFailed')); }
                          }}>{t('record.add')}</Button>
                        </div>
                      }>
                        <Button size="small" icon={<PlusOutlined />} style={{ fontSize: 10, marginTop: 4 }}>{t('record.addCustomKey')}</Button>
                      </Popover>
                    </div>
                  );
                })()}
              </>
            ) : (
              <div style={{ color: mutedTextColor, textAlign: 'center', padding: 24 }}>
                {primaryDevices.length === 0
                  ? t('record.addPrimaryDevice')
                  : t('record.selectPrimaryDevice')}
              </div>
            )}
          </Card>

        </Splitter.Panel>

        <Splitter.Panel style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden', opacity: testingStepIndex != null ? 0.5 : 1, pointerEvents: testingStepIndex != null ? 'none' : 'auto' }}>
          {/* Right panel: Controls + Steps */}
          {recording && (
            /* 녹화 중: 1행 시나리오+설명+녹화상태 */
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
              <Input size="small" value={scenarioName} disabled style={{ width: 120 }} />
              <Input size="small" placeholder={t('record.descriptionPlaceholder')} value={description} onChange={(e) => setDescription(e.target.value)} style={{ width: 140 }} />
              <Tag color="red" style={{ margin: 0 }}>{t('record.recording')}</Tag>
              <Button size="small" danger icon={<PauseOutlined />} onClick={stopRecording} disabled={hasPendingSteps}>
                {hasPendingSteps ? t('record.savingSteps') : t('record.stopRecording')}
              </Button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {recording && (
            <Card
              size="small"
              title={t('record.manualStep')}
              extra={
                ['input_text', 'key_event', 'wait', 'adb_command', 'serial_command', 'module_command', 'hkmc_key', 'cmd_send', 'cmd_check'].includes(stepType) ? (
                  <Button
                    size="small"
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={addManualStep}
                    disabled={!stepDeviceId && stepType !== 'wait'}
                  >
                    {t('record.addStep')}
                  </Button>
                ) : undefined
              }
              style={{ flex: 1, minWidth: 0 }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {/* 1행: 대상 디바이스 + 스텝 타입 */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Select
                    value={stepDeviceId || undefined}
                    onChange={setStepDeviceId}
                    placeholder={t('record.targetDevice')}
                    size="small"
                    style={{ flex: 1, minWidth: 120 }}
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
                    <Select.OptGroup label="Common">
                      <Option key="__common__" value="__common__">
                        <Tag color="cyan" style={{ marginRight: 4 }}>CMD</Tag>Common
                      </Option>
                    </Select.OptGroup>
                  </Select>
                  <Select value={stepType} onChange={setStepType} size="small" style={{ width: 150 }}>
                    {getStepTypes().map(t => (
                      <Option key={t.value} value={t.value}>{t.label}</Option>
                    ))}
                  </Select>
                </div>
                {/* 2행: 스텝 설명/파라미터 + delay + 추가 버튼 */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
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
                    {stepDeviceModule === 'DLTViewer' && selectedModuleFunc === 'WaitLog' && (
                      <label style={{ fontSize: 12, color: subTextColor }}>
                        <input type="checkbox" checked={dltBackground} onChange={(e) => setDltBackground(e.target.checked)} />
                        {' '}{t('dlt.backgroundMonitor')}
                      </label>
                    )}
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
                        background: isDark ? '#1a1a1a' : '#f5f5f5', border: isDark ? '1px solid #333' : '1px solid #d9d9d9', borderRadius: 4,
                        padding: '4px 8px', fontSize: 12, fontFamily: 'monospace',
                        maxHeight: 100, overflow: 'auto', whiteSpace: 'pre-wrap', color: '#52c41a',
                      }}>
                        {serialResponse}
                      </div>
                    )}
                  </>
                ) : stepType === 'hkmc_key' ? (
                  <>
                    <Select
                      showSearch
                      placeholder={t('record.hkmcSelectKey')}
                      value={stepDesc || undefined}
                      onChange={(v) => setStepDesc(v)}
                      style={{ width: '100%' }}
                      options={hkmcKeys.map(k => ({
                        label: `[${k.group}] ${k.name.replace(`${k.group}_`, '')}${k.is_dial ? ' (dial)' : ''}`,
                        value: k.name,
                      }))}
                    />
                  </>
                ) : stepType === 'cmd_send' || stepType === 'cmd_check' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <Input placeholder={t('record.cmdPlaceholder')} value={stepDesc} onChange={(e) => setStepDesc(e.target.value)} />
                    {stepType === 'cmd_check' && (
                      <>
                        <Input placeholder={t('record.cmdExpected')} value={cmdExpected} onChange={(e) => setCmdExpected(e.target.value)} />
                        <Select size="small" value={cmdMatchMode} onChange={setCmdMatchMode} style={{ width: '100%' }}
                          options={[
                            { label: t('record.cmdContains'), value: 'contains' },
                            { label: t('record.cmdExact'), value: 'exact' },
                          ]}
                        />
                      </>
                    )}
                    <label style={{ fontSize: 12, color: subTextColor }}>
                      <input type="checkbox" checked={cmdBackground} onChange={(e) => setCmdBackground(e.target.checked)} />
                      {' '}{t('record.cmdBackground')}
                    </label>
                  </div>
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

                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0, alignItems: 'flex-end' }}>
                    <InputNumber
                      size="small"
                      min={100}
                      max={Infinity}
                      step={100}
                      value={delayMs}
                      onChange={(v) => setDelayMs(v || 1000)}
                      suffix="ms"
                      style={{ width: 120 }}
                    />
                  </div>
                </div>
              </div>
            </Card>
            )}
            {!recording && (
            <Card size="small" title={t('record.control')} style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Row 1: 시나리오 콤보 + 관리 버튼 */}
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Select
                    placeholder={t('record.loadScenario')}
                    style={{ flex: 1, minWidth: 140 }}
                    onChange={loadScenario}
                    value={editingExisting ? scenarioName : undefined}
                    onOpenChange={(open) => { if (open) fetchSavedScenarios(); }}
                  >
                    {savedScenarios.map(n => (
                      <Option key={n} value={n}>{n}</Option>
                    ))}
                  </Select>
                  {editingExisting && (
                    <>
                      <Button size="small" icon={<CopyOutlined />} title={t('record.copyScenario')} onClick={copyScenario} />
                      <Button size="small" icon={<EditOutlined />} title={t('record.renameScenario')} onClick={renameScenario} />
                      <Button size="small" danger icon={<DeleteOutlined />} title={t('common.delete')} onClick={deleteScenario} />
                    </>
                  )}
                  <Button size="small" icon={<PlusOutlined />} onClick={createNewWithName}>{t('record.createNew')}</Button>
                </div>
                {/* Row 2: 설명 + 상태 + 녹화 버튼 */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Input
                    placeholder={t('record.descriptionPlaceholder')}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    style={{ flex: 1, minWidth: 120 }}
                  />
                  <Tag color={editingExisting ? 'blue' : 'default'} style={{ margin: 0 }}>
                    {editingExisting ? t('record.editing') : t('record.waiting')}
                  </Tag>
                  <Button type="primary" icon={<PlayCircleOutlined />} onClick={startRecording}>
                    {editingExisting ? t('record.resumeRecording') : t('record.startRecording')}
                  </Button>
                  {steps.length > 0 && (
                    <Button icon={<SaveOutlined />} onClick={saveScenario} type={isDirty() ? 'primary' : 'default'} danger={isDirty()}>
                      {t('record.save')}{isDirty() ? ' *' : ''}
                    </Button>
                  )}
                </div>
              </div>
            </Card>
            )}
          </div>

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
                  max={Infinity}
                  step={100}
                  value={waitDurationMs}
                  onChange={(v) => { const val = v || 1000; setWaitDurationMs(val); waitDurationRef.current = val; }}
                  suffix="ms"
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
        </Splitter.Panel>
      </Splitter>

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
        <div style={{ marginTop: 8, color: subTextColor, fontSize: 12, textAlign: 'center' }}>
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
        <div style={{ marginTop: 8, color: subTextColor, fontSize: 12, textAlign: 'center' }}>
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
            <div style={{ fontSize: 12, color: subTextColor, marginBottom: 4 }}>{t('record.excludeList')}</div>
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
            <div style={{ fontSize: 12, color: subTextColor, marginBottom: 4 }}>{t('record.cropList')}</div>
            <Space wrap>
              {steps[multiCropEditingIndex]?.expected_images?.map((ci, ci_idx) => (
                <Tag
                  key={`crop-${ci.image || ci_idx}`}
                  color={multiCropSelectedIdx === ci_idx ? 'blue' : 'green'}
                  closable
                  onClose={(e) => { e.preventDefault(); removeMultiCropItem(ci_idx); }}
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
        width={['tap', 'long_press', 'swipe', 'hkmc_touch', 'hkmc_swipe'].includes(steps[editStepIndex ?? 0]?.type) ? '80vw' : 500}
        style={['tap', 'long_press', 'swipe', 'hkmc_touch', 'hkmc_swipe'].includes(steps[editStepIndex ?? 0]?.type) ? { top: 20 } : undefined}
        footer={
          ['tap', 'long_press', 'swipe', 'hkmc_touch', 'hkmc_swipe'].includes(steps[editStepIndex ?? 0]?.type)
            ? <Button onClick={() => setEditStepIndex(null)}>{t('common.cancel')}</Button>
            : (
              <Space>
                <Button onClick={() => setEditStepIndex(null)}>{t('common.cancel')}</Button>
                <Button type="primary" onClick={applyEditStepParams}>{t('record.apply')}</Button>
              </Space>
            )
        }
        afterOpenChange={(open) => {
          if (open && ['tap', 'long_press', 'swipe', 'hkmc_touch', 'hkmc_swipe'].includes(steps[editStepIndex ?? 0]?.type)) {
            setTimeout(drawEditCanvas, 100);
          }
        }}
      >
        {editStepIndex != null && (() => {
          const step = steps[editStepIndex];
          if (!step) return null;

          if (['tap', 'long_press', 'swipe', 'hkmc_touch', 'hkmc_swipe'].includes(step.type)) {
            return (
              <div>
                <div style={{ marginBottom: 8, color: subTextColor, fontSize: 12 }}>
                  {(step.type === 'tap' || step.type === 'hkmc_touch') && t('record.tapHint')}
                  {step.type === 'long_press' && t('record.longPressHint')}
                  {(step.type === 'swipe' || step.type === 'hkmc_swipe') && t('record.swipeHint')}
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
                    step={100}
                    value={editStepParams.duration_ms ?? 1000}
                    onChange={(v) => setEditStepParams({ ...editStepParams, duration_ms: v ?? 1000 })}
                    style={{ width: 150 }}
                  />
                  <span style={{ color: subTextColor }}>ms</span>
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

          if (step.type === 'cmd_send' || step.type === 'cmd_check') {
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div>
                  <div style={{ marginBottom: 4, fontWeight: 600 }}>{t('record.cmdPlaceholder')}</div>
                  <TextArea
                    rows={2}
                    value={editStepParams.command ?? ''}
                    onChange={(e) => setEditStepParams({ ...editStepParams, command: e.target.value })}
                  />
                </div>
                {step.type === 'cmd_check' && (
                  <>
                    <div>
                      <div style={{ marginBottom: 4, fontWeight: 600 }}>{t('record.cmdExpected')}</div>
                      <Input
                        value={editStepParams.expected ?? ''}
                        onChange={(e) => setEditStepParams({ ...editStepParams, expected: e.target.value })}
                      />
                    </div>
                    <div>
                      <div style={{ marginBottom: 4, fontWeight: 600 }}>{t('record.cmdContains')}</div>
                      <Select
                        value={editStepParams.match_mode ?? 'contains'}
                        onChange={(v) => setEditStepParams({ ...editStepParams, match_mode: v })}
                        style={{ width: '100%' }}
                        options={[
                          { label: t('record.cmdContains'), value: 'contains' },
                          { label: t('record.cmdExact'), value: 'exact' },
                        ]}
                      />
                    </div>
                  </>
                )}
                <label style={{ fontSize: 12, color: subTextColor }}>
                  <input
                    type="checkbox"
                    checked={editStepParams.background ?? false}
                    onChange={(e) => setEditStepParams({ ...editStepParams, background: e.target.checked })}
                  />
                  {' '}{t('record.cmdBackground')}
                </label>
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
                  <span style={{ color: subTextColor, marginLeft: 4 }}>s</span>
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
                  <div style={{ color: subTextColor }}>{t('record.noParams')}</div>
                )}
              </div>
            );
          }

          if (step.type === 'hkmc_key') {
            return (
              <div>
                <div style={{ marginBottom: 8, fontWeight: 600 }}>{t('record.hkmcKey')}</div>
                <Select
                  showSearch
                  value={editStepParams.key_name ?? ''}
                  onChange={(v) => setEditStepParams({ ...editStepParams, key_name: v })}
                  style={{ width: '100%' }}
                  options={hkmcKeys.map(k => ({
                    label: `[${k.group}] ${k.name.replace(`${k.group}_`, '')}${k.is_dial ? ' (dial)' : ''}`,
                    value: k.name,
                  }))}
                />
              </div>
            );
          }

          return <div style={{ color: subTextColor }}>{t('record.editNotSupported')}</div>;
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
              <span style={{ color: subTextColor, marginLeft: 'auto' }}>
                {testResult.execution_time_ms}ms
              </span>
            </div>
            {testResult.command && (
              <div style={{ marginBottom: 8, padding: '6px 10px', background: '#1a1a2e', borderRadius: 4, fontFamily: 'monospace', fontSize: 12 }}>
                <span style={{ color: subTextColor }}>$ </span><span style={{ color: '#e0e0e0' }}>{testResult.command}</span>
              </div>
            )}
            {testResult.message && (() => {
              const msg = testResult.message as string;
              const isCmdCheck = msg.startsWith('[CMD_CHECK]');
              if (isCmdCheck) {
                // [SIMILARITY] 구분자로 CMD 결과와 Similarity 분리
                const simIdx = msg.indexOf('\n[SIMILARITY]\n');
                const cmdPart = simIdx >= 0 ? msg.substring(0, simIdx) : msg;
                const lines = cmdPart.split('\n');
                const expectLine = lines[1] || '';
                const sepIdx = lines.indexOf('---');
                const output = lines.slice(sepIdx + 1).join('\n');
                const expectMatch = expectLine.match(/expected\((.*?)\):\s*(.*)/);
                const matchMode = expectMatch?.[1] || 'contains';
                const expectedVal = expectMatch?.[2] || '';
                // 하이라이트: output 내에서 expectedVal 부분을 모두 강조
                const highlightOutput = () => {
                  if (!expectedVal || !output) return <>{output}</>;
                  const parts: React.ReactNode[] = [];
                  let remaining = output;
                  let key = 0;
                  while (remaining.length > 0) {
                    const idx = remaining.indexOf(expectedVal);
                    if (idx === -1) { parts.push(<span key={key}>{remaining}</span>); break; }
                    if (idx > 0) parts.push(<span key={key++}>{remaining.substring(0, idx)}</span>);
                    parts.push(<span key={key++} style={{ background: '#faad14', color: '#000', fontWeight: 'bold', padding: '0 2px', borderRadius: 2 }}>{expectedVal}</span>);
                    remaining = remaining.substring(idx + expectedVal.length);
                  }
                  return <>{parts}</>;
                };
                // CMD_CHECK 결과에서 pass/fail 판정 (이미지 비교와 독립)
                const cmdPassed = output.includes(expectedVal);
                return (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ marginBottom: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Tag color={cmdPassed ? 'green' : 'red'} style={{ margin: 0 }}>CMD {cmdPassed ? 'PASS' : 'FAIL'}</Tag>
                      <span style={{ color: subTextColor }}>{matchMode === 'exact' ? 'Exact' : 'Contains'}:</span>
                      <strong style={{ color: cmdPassed ? '#52c41a' : '#ff4d4f' }}>{expectedVal}</strong>
                    </div>
                    <div style={{
                      padding: '8px 10px', borderRadius: 4, fontSize: 12, fontFamily: 'monospace',
                      background: cmdPassed ? '#122010' : '#2a1215',
                      border: `1px solid ${cmdPassed ? '#274916' : '#5c2024'}`,
                      color: '#d9d9d9',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 300, overflow: 'auto',
                    }}>{highlightOutput()}</div>
                  </div>
                );
              }
              return (
                <div style={{
                  marginBottom: 12, padding: '8px 10px', borderRadius: 4, fontSize: 13, fontFamily: 'monospace',
                  background: testResult.status === 'fail' ? '#2a1215' : '#122010',
                  border: `1px solid ${testResult.status === 'fail' ? '#5c2024' : '#274916'}`,
                  color: testResult.status === 'fail' ? '#ff7875' : '#95de64',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                }}>{msg}</div>
              );
            })()}
            <Row gutter={12}>
              {testResult.expected_image && (
                <Col span={testResult.actual_image ? 12 : 24}>
                  <div style={{ textAlign: 'center', fontSize: 12, marginBottom: 4, fontWeight: 600 }}>{t('record.expectedImageLabel')}</div>
                  {(() => {
                    const imgSrc = `/screenshots/${testResult.expected_annotated_image || testResult.expected_image}?t=${testResult._ts || ''}`;
                    return <Image src={imgSrc} preview={{ src: imgSrc }} style={{ width: '100%', borderRadius: 4, border: isDark ? '1px solid #333' : '1px solid #d9d9d9' }} />;
                  })()}
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
                  {(() => {
                    const imgSrc = `/screenshots/${testResult.actual_annotated_image || testResult.actual_image}?t=${testResult._ts || ''}`;
                    return <Image src={imgSrc} preview={{ src: imgSrc }} style={{ width: '100%', borderRadius: 4, border: isDark ? '1px solid #333' : '1px solid #d9d9d9' }} />;
                  })()}
                </Col>
              )}
            </Row>
            {/* Multi-crop sub_results 테이블 */}
            {testResult.compare_mode === 'multi_crop' && testResult.sub_results?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{t('record.cropResults')}</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #303030' }}>
                      <th style={{ padding: '4px 8px', textAlign: 'left' }}>#</th>
                      <th style={{ padding: '4px 8px', textAlign: 'left' }}>{t('record.label')}</th>
                      <th style={{ padding: '4px 8px', textAlign: 'center' }}>{t('common.status')}</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>{t('record.similarityLabel')}</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>{t('record.matchLocation')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {testResult.sub_results.map((sr: any, si: number) => (
                      <tr key={si} style={{ borderBottom: '1px solid #222' }}>
                        <td style={{ padding: '4px 8px' }}>{si + 1}</td>
                        <td style={{ padding: '4px 8px' }}>{sr.label || '-'}</td>
                        <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                          <Tag color={sr.status === 'pass' ? 'green' : sr.status === 'warning' ? 'orange' : 'red'}>{sr.status.toUpperCase()}</Tag>
                        </td>
                        <td style={{ padding: '4px 8px', textAlign: 'right' }}>{(sr.score * 100).toFixed(2)}%</td>
                        <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                          {sr.match_location ? `(${sr.match_location.x},${sr.match_location.y}) ${sr.match_location.width}×${sr.match_location.height}` : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!testResult.expected_image && !testResult.actual_image && (
              <div style={{ color: subTextColor, textAlign: 'center', padding: 24 }}>
                {t('record.noExpectedImage')}
              </div>
            )}
          </div>
        )}
      </Modal>
      <Image
        src={annotatedPreviewSrc}
        style={{ display: 'none' }}
        preview={{
          visible: annotatedPreviewVisible,
          onVisibleChange: (v) => setAnnotatedPreviewVisible(v),
        }}
      />
    </div>
  );
}
