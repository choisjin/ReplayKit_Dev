import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Button, Card, Col, Image, Input, Modal, Radio, Row, Select, Slider, Space, InputNumber, message, List, Tag, Popover, Tooltip, Splitter } from 'antd';
import { PlayCircleOutlined, PauseOutlined, PlusOutlined, SwapOutlined, FolderOpenOutlined, SaveOutlined, DeleteOutlined, BranchesOutlined, ScissorOutlined, CameraOutlined, ThunderboltOutlined, CheckCircleOutlined, CloseCircleOutlined, WarningOutlined, EditOutlined, CopyOutlined, ZoomInOutlined, ZoomOutOutlined, HolderOutlined, SettingOutlined, StopOutlined } from '@ant-design/icons';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { deviceApi, scenarioApi } from '../services/api';
import { useDevice } from '../context/DeviceContext';
import { useSettings } from '../context/SettingsContext';
import { useTranslation } from '../i18n';
import type { TranslationKey } from '../i18n/translations';
import DLTViewer from '../components/DLTViewer';
import { useDLTSessions } from '../hooks/useDLTSessions';

const { Option } = Select;
const { TextArea } = Input;

// 드래그 가능한 스텝 아이템 래퍼
const SortableStepItem = ({ id, index, isDark, children }: { id: string; index: number; isDark: boolean; children: React.ReactNode }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    display: 'flex',
    padding: '4px 8px',
    gap: 8,
    background: index % 2 === 0 ? undefined : 'rgba(255,255,255,0.04)',
    borderBottom: isDark ? '1px solid #303030' : '1px solid #f0f0f0',
  };
  return (
    <div ref={setNodeRef} style={style}>
      <div {...attributes} {...listeners} style={{ cursor: 'grab', display: 'flex', alignItems: 'center', color: '#999', flexShrink: 0 }}>
        <HolderOutlined />
      </div>
      {children}
    </div>
  );
};

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
  // iSAP per-device 지원 필드 (HKMC는 기본값)
  cmd?: number;
  key?: number;
  visible?: boolean;
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

// HKMC key sub commands
const HKMC_SHORT_KEY = 0x43;
const HKMC_LONG_KEY = 0x44;
const HKMC_LONG_PRESS_MS = 3000;

export default function RecordPage() {
  const { t } = useTranslation();
  const {
    primaryDevices, auxiliaryDevices, fetchDevices,
    screenshotDeviceId, setScreenshotDeviceId, screenshot,
    h264Mode, h264Size, videoRef, sendControl,
    screenType, setScreenType, refreshScreenshot,
    screenAlive, streamFps,
    pauseScreenStream, resumeScreenStream,
  } = useDevice();

  const [recording, setRecording] = useState(false);
  const [scenarioName, setScenarioName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);

  // Scenario load/edit
  const [savedScenarios, setSavedScenarios] = useState<string[]>([]);
  const [editingExisting, setEditingExisting] = useState(false);
  const [originalScenarioName, setOriginalScenarioName] = useState('');

  // 시나리오 메타데이터 보존 (device_map, created_at 등 프론트엔드에서 편집하지 않는 필드)
  const scenarioMetaRef = useRef<Record<string, any>>({});

  // 변경사항 추적 (저장된 스텝과 비교)
  const savedStepsRef = useRef<string>('[]');
  const saveScenarioRef = useRef<() => Promise<void>>(async () => {});
  const isDirty = useCallback(() => {
    // steps.length === 0 인 경우에도 저장된 스냅샷이 비어있지 않으면 dirty
    // (전체 삭제 후 저장 버튼이 사라져 이어녹화 시 서버에서 복원되는 버그 방지)
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

  // DLT 뷰어 (스텝 테스트 시 모달) — 세션 시작 시 자동 오픈
  const dltSessionHook = useDLTSessions();
  const [dltModalOpen, setDltModalOpen] = useState(false);
  useEffect(() => {
    if (dltSessionHook.lastEvent?.type === 'session_started') {
      setDltModalOpen(true);
    }
  }, [dltSessionHook.lastEvent]);

  // Wait step insertion
  const [waitDurationMs, setWaitDurationMs] = useState(1000);
  const waitDurationRef = useRef(1000);

  // Per-step controls (for manual step input)
  const [delayMs] = useState(1000);
  const [compareModePopoverIndex, setCompareModePopoverIndex] = useState<number | null>(null);

  // 모듈 스텝 추가: 선택된 "디바이스" (해당 디바이스에 매칭된 모듈을 사용)
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [moduleFunctions, setModuleFunctions] = useState<{ name: string; description?: string; params: { name: string; required: boolean; default?: string; description?: string }[] }[]>([]);
  const [selectedModuleFunc, setSelectedModuleFunc] = useState('');
  const [moduleFuncArgs, setModuleFuncArgs] = useState<Record<string, string>>({});
  const [moduleDescription, setModuleDescription] = useState('');
  const [dltBackground, setDltBackground] = useState(false);

  // HKMC hardware keys
  const [hkmcKeys, setHkmcKeys] = useState<HkmcKeyInfo[]>([]);
  // iSAP 키 설정 모달
  const [isapKeysModalOpen, setIsapKeysModalOpen] = useState(false);
  const [isapKeysDraft, setIsapKeysDraft] = useState<HkmcKeyInfo[]>([]);
  const [isapKeysSaving, setIsapKeysSaving] = useState(false);

  // Random 스트레스 설정 (localStorage 기반, device + screen_type별)
  type RandRegion = { x: number; y: number; width: number; height: number } | null;
  const [randHkKeysConfig, setRandHkKeysConfig] = useState<string[] | null>(null); // null = 전체
  const [randSkRegion, setRandSkRegion] = useState<RandRegion>(null);
  const [randDragRegion, setRandDragRegion] = useState<RandRegion>(null);
  const [randHkModalOpen, setRandHkModalOpen] = useState(false);
  const [randRegionModal, setRandRegionModal] = useState<null | 'sk' | 'drag'>(null);
  // Random 반복 실행
  const [randRepeatCount, setRandRepeatCount] = useState<number>(1);
  const [randIntervalMs, setRandIntervalMs] = useState<number>(200);
  const [randRunning, setRandRunning] = useState<boolean>(false);
  const [randProgress, setRandProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const randStopRef = useRef<boolean>(false);
  // ALL RAND 실행 중에는 개별 HK/SK/DRAG 액션이 별도 스텝으로 기록되지 않도록 억제
  const suppressStepAddRef = useRef<boolean>(false);
  // 하드키 롱프레스 타이머 — 리렌더에도 유지 (키이름 → {downTs, timer})
  const hkTimerRef = useRef<Map<string, { downTs: number; timer: number }>>(new Map());
  // Region 모달용 canvas/drag ref
  const randRegionCanvasRef = useRef<HTMLCanvasElement>(null);
  const randRegionScreenshotRef = useRef<string>('');
  const randRegionDragRef = useRef<{ startX: number; startY: number; curX: number; curY: number; active: boolean }>({
    startX: 0, startY: 0, curX: 0, curY: 0, active: false,
  });
  const [hkmcSubCommands, setHkmcSubCommands] = useState<Record<string, number>>({});

  // HKMC 디스플레이 모드: standard(기본형) / integrated(일체형 — 클러스터+AVN)
  const [hkmcDisplayMode, setHkmcDisplayMode] = useState<'standard' | 'integrated'>('standard');

  // 뷰포트 크롭: 넓은 화면에서 원하는 영역만 확대 표시 (좌표는 원본 유지)
  // 값은 0~1 비율 (0=시작, 1=끝). localStorage에 디바이스별 저장
  const [viewCropEnabled, setViewCropEnabled] = useState(false);
  const [viewCropX, setViewCropX] = useState<[number, number]>([0, 1]);
  const [viewCropY, setViewCropY] = useState<[number, number]>([0, 1]);

  // 멀티터치: 핑거 수 (1=일반, 2=투핑거, 3=쓰리핑거)
  const [fingerCount, setFingerCount] = useState(1);
  // 멀티터치 핑거 간격 (디바이스 픽셀)
  const [fingerSpread, setFingerSpread] = useState(100);
  // 줌 제스처 모드: 'normal' | 'zoom_in' | 'zoom_out'
  const [gestureMode, setGestureMode] = useState<'normal' | 'zoom_in' | 'zoom_out'>('normal');
  // 연속터치 모드
  const [repeatTapMode, setRepeatTapMode] = useState(false);
  const [repeatTapModalOpen, setRepeatTapModalOpen] = useState(false);
  const [repeatTapCount, setRepeatTapCount] = useState(5);
  const [repeatTapInterval, setRepeatTapInterval] = useState(100);
  const repeatTapCoordsRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // 웹캠 설정(노출) 모달
  const [webcamExposureOpen, setWebcamExposureOpen] = useState(false);
  const [webcamExposureInfo, setWebcamExposureInfo] = useState<{ supported: boolean; value?: number; auto?: boolean; min?: number; max?: number; step?: number }>({ supported: false });
  const [webcamExposureLoading, setWebcamExposureLoading] = useState(false);

  // 뷰포트 크롭 상태 localStorage 로드 (디바이스 변경 시)
  useEffect(() => {
    if (!screenshotDeviceId) return;
    try {
      const raw = localStorage.getItem(`viewCrop_${screenshotDeviceId}`);
      if (raw) {
        const saved = JSON.parse(raw);
        setViewCropEnabled(saved.enabled ?? false);
        setViewCropX(saved.x ?? [0, 1]);
        setViewCropY(saved.y ?? [0, 1]);
      } else {
        setViewCropEnabled(false);
        setViewCropX([0, 1]);
        setViewCropY([0, 1]);
      }
    } catch { /* ignore */ }
  }, [screenshotDeviceId]);

  // 뷰포트 크롭 상태 localStorage 저장
  useEffect(() => {
    if (!screenshotDeviceId) return;
    localStorage.setItem(`viewCrop_${screenshotDeviceId}`, JSON.stringify({
      enabled: viewCropEnabled, x: viewCropX, y: viewCropY,
    }));
  }, [screenshotDeviceId, viewCropEnabled, viewCropX, viewCropY]);

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
  // 활성 bg 폴링 refs (모달 닫힘 시 정리용)
  const activeBgPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeBgTaskIdRef = useRef<string | null>(null);

  const stopActiveBgPoll = useCallback((cancelBackend: boolean = true) => {
    if (activeBgPollRef.current) {
      clearInterval(activeBgPollRef.current);
      activeBgPollRef.current = null;
    }
    const tid = activeBgTaskIdRef.current;
    if (tid && cancelBackend) {
      scenarioApi.cancelCmdTask(tid).catch(() => {});
    }
    activeBgTaskIdRef.current = null;
  }, []);

  // 컴포넌트 언마운트 시 활성 폴링 정리
  useEffect(() => {
    return () => {
      if (activeBgPollRef.current) {
        clearInterval(activeBgPollRef.current);
        activeBgPollRef.current = null;
      }
      const tid = activeBgTaskIdRef.current;
      if (tid) {
        scenarioApi.cancelCmdTask(tid).catch(() => {});
        activeBgTaskIdRef.current = null;
      }
    };
  }, []);

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
        const needsScreenType = (dev?.type === 'hkmc6th' || dev?.type === 'isap_agent') || (dev?.type === 'adb' && (dev.info?.displays?.length ?? 0) > 1);
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

  // 연결된 주 디바이스만 필터
  const connectedPrimaryDevices = primaryDevices.filter(d => d.status === 'device' || d.status === 'connected');

  // Auto-select first connected primary device for screen
  useEffect(() => {
    if (!screenshotDeviceId && connectedPrimaryDevices.length > 0) {
      setScreenshotDeviceId(connectedPrimaryDevices[0].id);
    }
    // 선택된 디바이스가 연결 끊기면 해제
    if (screenshotDeviceId && !connectedPrimaryDevices.find(d => d.id === screenshotDeviceId)) {
      const next = connectedPrimaryDevices.length > 0 ? connectedPrimaryDevices[0].id : '';
      setScreenshotDeviceId(next);
    }
  }, [primaryDevices]);

  // Get current screen device info
  const screenDevice = primaryDevices.find(d => d.id === screenshotDeviceId);
  const isScreenHkmc = screenDevice?.type === 'hkmc6th' || screenDevice?.type === 'isap_agent';
  const isScreenCCRC = isScreenHkmc && screenDevice?.info?.device_model === 'CCRC';

  // CCRC: front_center/cluster 비허용 → 자동으로 rear_right로 교정
  useEffect(() => {
    if (isScreenCCRC && (screenType === 'front_center' || screenType === 'cluster' || !screenType)) {
      setScreenType('rear_right');
    }
  }, [isScreenCCRC, screenType, setScreenType]);
  const isScreenAdb = screenDevice?.type === 'adb';
  // 카메라류(vision_camera/webcam)는 관찰 전용 — 조작(탭/스와이프/키) 금지
  const isScreenReadonly = screenDevice?.type === 'vision_camera' || screenDevice?.type === 'webcam';
  const adbDisplays: { id: number; name: string; sf_id?: string; width?: number; height?: number }[] = screenDevice?.info?.displays || [];
  const hasMultiDisplay = isScreenAdb && adbDisplays.length > 1;
  // 멀티 디스플레이: 선택된 디스플레이 해상도 사용
  const selectedDisplay = hasMultiDisplay ? adbDisplays.find(d => String(d.id) === screenType) : null;
  // HKMC: screens[screenType]에서 해상도 읽기, ADB 멀티: selectedDisplay, 기본: resolution
  const hkmcScreen = isScreenHkmc ? screenDevice?.info?.screens?.[screenType] : null;
  const deviceRes = selectedDisplay?.width
    ? { width: selectedDisplay.width, height: selectedDisplay.height }
    : hkmcScreen?.width
      ? { width: hkmcScreen.width, height: hkmcScreen.height }
      : screenDevice?.info?.resolution ?? { width: 1080, height: 1920 };

  // 모듈이 매칭된 디바이스 목록 (dropdown의 옵션)
  // - 보조 디바이스: info.module이 설정된 것
  // - 주 디바이스(ADB): 가상 module="Android"로 노출 → Android 모듈의 함수 사용 가능
  // 연결된 디바이스만 표시 (disconnected/offline/error/reconnecting 등은 제외)
  const isDeviceConnected = (d: { status?: string }) => d.status === 'connected' || d.status === 'device';
  const moduleDevices = [
    ...auxiliaryDevices.filter(d => d.info?.module && isDeviceConnected(d)),
    ...primaryDevices
      .filter(d => d.type === 'adb' && isDeviceConnected(d))
      .map(d => ({ ...d, info: { ...d.info, module: 'Android' } })),
  ];

  // 선택된 디바이스에서 모듈 이름 derive
  const selectedDevice = moduleDevices.find(d => d.id === selectedDeviceId);
  const selectedModuleName = selectedDevice?.info?.module as string | undefined;

  // 선택된 디바이스의 모듈 함수 목록 로드
  useEffect(() => {
    if (!selectedModuleName) {
      setModuleFunctions([]);
      setModuleDescription('');
      setSelectedModuleFunc('');
      setModuleFuncArgs({});
      return;
    }
    deviceApi.getModuleFunctions(selectedModuleName).then(res => {
      setModuleFunctions(res.data.functions || []);
      setModuleDescription(res.data.module_description || '');
      setSelectedModuleFunc('');
      setModuleFuncArgs({});
    }).catch(() => { setModuleFunctions([]); setModuleDescription(''); });
  }, [selectedModuleName]);

  // Random stress 설정 저장 여부 추적 (디바이스 전환 중 초기 로드와 auto-save 충돌 방지)
  const randCfgLoadedRef = useRef(false);

  // Random stress 설정: device + screen_type 바뀔 때마다 localStorage에서 로드
  // 저장 대상: HK pool, SK region, DRAG region, 반복 횟수, 간격(ms)
  useEffect(() => {
    randCfgLoadedRef.current = false;
    if (!screenshotDeviceId) {
      setRandHkKeysConfig(null);
      setRandSkRegion(null);
      setRandDragRegion(null);
      setRandRepeatCount(1);
      setRandIntervalMs(200);
      randCfgLoadedRef.current = true;
      return;
    }
    const base = `rand_cfg_${screenshotDeviceId}_${screenType || 'default'}`;
    try {
      const hk = localStorage.getItem(`${base}_hk`);
      setRandHkKeysConfig(hk ? JSON.parse(hk) : null);
    } catch { setRandHkKeysConfig(null); }
    try {
      const sk = localStorage.getItem(`${base}_sk`);
      setRandSkRegion(sk ? JSON.parse(sk) : null);
    } catch { setRandSkRegion(null); }
    try {
      const drag = localStorage.getItem(`${base}_drag`);
      setRandDragRegion(drag ? JSON.parse(drag) : null);
    } catch { setRandDragRegion(null); }
    try {
      const rc = localStorage.getItem(`${base}_repeat`);
      const parsed = rc ? parseInt(rc, 10) : NaN;
      setRandRepeatCount(isNaN(parsed) || parsed < 1 ? 1 : parsed);
    } catch { setRandRepeatCount(1); }
    try {
      const iv = localStorage.getItem(`${base}_interval`);
      const parsed = iv ? parseInt(iv, 10) : NaN;
      setRandIntervalMs(isNaN(parsed) || parsed < 0 ? 200 : parsed);
    } catch { setRandIntervalMs(200); }
    // 로드 완료 후 auto-save 활성화 (같은 tick 내 set 이후)
    randCfgLoadedRef.current = true;
  }, [screenshotDeviceId, screenType]);

  const _randStorageBase = useCallback(() =>
    screenshotDeviceId ? `rand_cfg_${screenshotDeviceId}_${screenType || 'default'}` : '',
    [screenshotDeviceId, screenType]);

  // randRepeatCount / randIntervalMs 변경 시 자동 저장 (HK/SK/DRAG는 모달 저장 경로에서 처리됨)
  useEffect(() => {
    if (!randCfgLoadedRef.current) return;
    const base = _randStorageBase();
    if (!base) return;
    try { localStorage.setItem(`${base}_repeat`, String(randRepeatCount)); } catch { /* ignore */ }
  }, [randRepeatCount, _randStorageBase]);

  useEffect(() => {
    if (!randCfgLoadedRef.current) return;
    const base = _randStorageBase();
    if (!base) return;
    try { localStorage.setItem(`${base}_interval`, String(randIntervalMs)); } catch { /* ignore */ }
  }, [randIntervalMs, _randStorageBase]);

  // Fetch hardware keys — HKMC/iSAP 모두 선택된 디바이스별로 재조회
  // (각 디바이스의 info에 저장된 per-device override가 병합되어 반환됨)
  useEffect(() => {
    const dev = primaryDevices.find(d => d.id === screenshotDeviceId);
    if (dev?.type === 'isap_agent') {
      deviceApi.listIsapKeys(dev.id).then(res => {
        setHkmcKeys(res.data.keys || []);
        setHkmcSubCommands(res.data.sub_commands || {});
      }).catch(() => {});
    } else if (dev?.type === 'hkmc6th') {
      deviceApi.listHkmcKeys(dev.id).then(res => {
        setHkmcKeys(res.data.keys || []);
        setHkmcSubCommands(res.data.sub_commands || {});
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenshotDeviceId, primaryDevices]);

  // Stop screenshot polling when leaving page
  useEffect(() => {
    return () => {
      setScreenshotDeviceId('');
    };
  }, []);

  // Helper: convert element coords to device coords (canvas 또는 video)
  // 기본은 deviceRes(agent/device 보고 해상도) 기준으로 매핑.
  // 단 iSAP은 agent의 reported size와 실제 JPEG dims가 다른 경우가 있어
  // (front_center: 보고 850 vs JPEG 1440) canvas/video의 natural 크기를
  // 직접 사용해 JPEG 픽셀 좌표를 그대로 agent에 전달한다.
  const toDeviceCoords = (el: HTMLCanvasElement | HTMLVideoElement, clientX: number, clientY: number) => {
    const rect = el.getBoundingClientRect();
    // border 영역 제외: clientLeft/clientTop = border 두께
    const bx = el.clientLeft || 0;
    const by = el.clientTop || 0;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    // iSAP: canvas/video의 natural(intrinsic) 크기를 좌표계로 사용
    const isIsap = screenDevice?.type === 'isap_agent';
    let refW = deviceRes.width;
    let refH = deviceRes.height;
    if (isIsap) {
      let natW = (el as HTMLCanvasElement).width || (el as HTMLVideoElement).videoWidth || 0;
      let natH = (el as HTMLCanvasElement).height || (el as HTMLVideoElement).videoHeight || 0;
      // viewCrop가 켜진 경우 canvas.width/height는 cropped region 크기이므로
      // crop 비율로 나눠 full natural 크기를 복원해야 좌표 계산이 일관된다.
      if (viewCropEnabled && natW > 0 && natH > 0) {
        const cropFracW = viewCropX[1] - viewCropX[0];
        const cropFracH = viewCropY[1] - viewCropY[0];
        if (cropFracW > 0 && cropFracH > 0) {
          natW = Math.round(natW / cropFracW);
          natH = Math.round(natH / cropFracH);
        }
      }
      if (natW > 0 && natH > 0) {
        refW = natW;
        refH = natH;
      }
    }
    if (viewCropEnabled) {
      const cropW = viewCropX[1] - viewCropX[0];
      const cropH = viewCropY[1] - viewCropY[0];
      const fracX = (clientX - rect.left - bx) / cw;
      const fracY = (clientY - rect.top - by) / ch;
      let x = Math.round((viewCropX[0] + fracX * cropW) * refW);
      const y = Math.round((viewCropY[0] + fracY * cropH) * refH);
      if (isScreenHkmc && hkmcDisplayMode === 'integrated') return { x: x + 1920, y };
      return { x, y };
    }
    const scaleX = refW / cw;
    const scaleY = refH / ch;
    let x = Math.round((clientX - rect.left - bx) * scaleX);
    const y = Math.round((clientY - rect.top - by) * scaleY);
    if (isScreenHkmc && hkmcDisplayMode === 'integrated') x += 1920;
    return { x, y };
  };

  // Map generic gesture actions to HKMC equivalents when target is HKMC device
  const resolveAction = useCallback((action: string, targetDevice: string): string => {
    const dev = allDevices.find(d => d.id === targetDevice);
    if (dev?.type !== 'hkmc6th' && dev?.type !== 'isap_agent') return action;
    if (action === 'tap') return 'hkmc_touch';
    if (action === 'swipe') return 'hkmc_swipe';
    if (action === 'long_press') return 'hkmc_touch'; // Agent has no long_press, treat as touch
    return action;
  }, [allDevices]);

  // Inject screen_type into params for HKMC / ADB multi-display actions
  const resolveParams = useCallback((action: string, params: Record<string, any>, targetDevice: string): Record<string, any> => {
    const dev = allDevices.find(d => d.id === targetDevice);
    if ((dev?.type === 'hkmc6th' || dev?.type === 'isap_agent') && (action === 'hkmc_touch' || action === 'hkmc_swipe' || action === 'hkmc_key' || action === 'repeat_tap')) {
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

  // 웹캠 노출 설정 모달 열기 — 현재 값을 먼저 조회 후 모달 open
  const openWebcamExposureModal = useCallback(async () => {
    if (!screenshotDeviceId) return;
    setWebcamExposureOpen(true);
    setWebcamExposureLoading(true);
    try {
      const res = await deviceApi.getWebcamExposure(screenshotDeviceId);
      setWebcamExposureInfo(res.data);
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('record.webcamExposureFailed'));
      setWebcamExposureInfo({ supported: false });
    }
    setWebcamExposureLoading(false);
  }, [screenshotDeviceId, message, t]);

  // Execute or record an action (화면 제스처/HKMC키 전용 — 모듈 스텝 추가와는 별개 경로)
  const executeAction = useCallback(async (action: string, params: Record<string, any>, desc: string) => {
    const targetDevice = screenshotDeviceId;
    if (!targetDevice) return;

    // 관찰 전용 디바이스(vision_camera/webcam)에서는 조작 동작 불가
    const targetDev = primaryDevices.find(d => d.id === targetDevice);
    if (targetDev?.type === 'vision_camera' || targetDev?.type === 'webcam') {
      return;
    }

    const resolvedAction = resolveAction(action, targetDevice);
    const resolvedParams = resolveParams(resolvedAction, params, targetDevice);

    const alreadyExecuted = false;

    if (recording && !suppressStepAddRef.current) {
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
          const detail = e.response?.data?.detail;
          message.error(typeof detail === 'string' ? detail : t('record.inputFailed'));
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
        const detail = e.response?.data?.detail;
        message.error(typeof detail === 'string' ? detail : t('record.stepRecordFailed'));
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
          const detail = e.response?.data?.detail;
          message.error(typeof detail === 'string' ? detail : t('record.inputFailed'));
        });
        // Short delay then refresh (device needs a moment to process input)
        setTimeout(() => refreshScreenshot(), 150);
      }
    }
  }, [recording, screenshotDeviceId, delayMs, refreshScreenshot, resolveAction, resolveParams, steps.length, primaryDevices]);

  // ----------------------------------------------------------------
  // Random stress helpers (HKMC/iSAP 전용)
  // 참조 스트레스 스크립트(CCIC) RAND_HK/SK/DRAG 패턴을 버튼화
  // ----------------------------------------------------------------
  const _randBounds = useCallback((): { w: number; h: number } => {
    // iSAP은 agent 보고 해상도와 JPEG 크기가 다를 수 있어 canvas natural 사용.
    // HKMC/ADB는 deviceRes(agent 보고 해상도)를 신뢰 — canvas는 viewCrop 시
    // 잘린 영역 크기만 반영하므로 좌표 범위가 틀어진다.
    if (screenDevice?.type === 'isap_agent') {
      const el = canvasRef.current;
      if (el && el.width > 0 && el.height > 0) return { w: el.width, h: el.height };
    }
    return { w: deviceRes.width || 1920, h: deviceRes.height || 720 };
  }, [deviceRes, screenDevice]);

  const _pickRandInRegion = useCallback((region: RandRegion): { x: number; y: number } => {
    const { w, h } = _randBounds();
    let x0 = 0, y0 = 0, xMax = w, yMax = h;
    if (region) {
      x0 = Math.max(0, region.x);
      y0 = Math.max(0, region.y);
      xMax = Math.min(w, region.x + region.width);
      yMax = Math.min(h, region.y + region.height);
    }
    const rw = Math.max(1, xMax - x0);
    const rh = Math.max(1, yMax - y0);
    return {
      x: Math.floor(x0 + Math.random() * rw),
      y: Math.floor(y0 + Math.random() * rh),
    };
  }, [_randBounds]);

  const randHK = useCallback(() => {
    // 기본 pool: visible=true + dial이 아닌 키
    let candidates = hkmcKeys.filter(k => k.visible !== false && !k.is_dial);
    // 사용자 설정 pool이 있으면 교집합으로 제한
    if (randHkKeysConfig && randHkKeysConfig.length > 0) {
      const set = new Set(randHkKeysConfig);
      candidates = candidates.filter(k => set.has(k.name));
    }
    if (candidates.length === 0) {
      message.warning('랜덤 대상 키가 없음 (키 설정 확인)');
      return;
    }
    const k = candidates[Math.floor(Math.random() * candidates.length)];
    const isLong = Math.random() < 0.2; // 20% 확률 Long press
    const sub = isLong ? HKMC_LONG_KEY : HKMC_SHORT_KEY;
    const label = `RAND HK: ${k.name}${isLong ? ' (Long)' : ''}`;
    executeAction('hkmc_key', { key_name: k.name, sub_cmd: sub, screen_type: screenType }, label);
  }, [hkmcKeys, randHkKeysConfig, screenType, executeAction]);

  const randSK = useCallback(() => {
    let { x, y } = _pickRandInRegion(randSkRegion);
    // 일체형: 클러스터(0-1920) + AVN(1920-3840) 합산 좌표계 → AVN 영역 오프셋
    if (isScreenHkmc && hkmcDisplayMode === 'integrated') x += 1920;
    const label = `RAND SK: (${x},${y})`;
    executeAction('hkmc_touch', { x, y, screen_type: screenType }, label);
  }, [_pickRandInRegion, randSkRegion, screenType, executeAction, isScreenHkmc, hkmcDisplayMode]);

  const randDrag = useCallback(() => {
    const p1 = _pickRandInRegion(randDragRegion);
    const p2 = _pickRandInRegion(randDragRegion);
    if (isScreenHkmc && hkmcDisplayMode === 'integrated') {
      p1.x += 1920;
      p2.x += 1920;
    }
    const label = `RAND DRAG: (${p1.x},${p1.y})→(${p2.x},${p2.y})`;
    executeAction('hkmc_swipe', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, duration_ms: 300, screen_type: screenType }, label);
  }, [_pickRandInRegion, randDragRegion, screenType, executeAction, isScreenHkmc, hkmcDisplayMode]);

  const allRand = useCallback(() => {
    // 참조 스크립트 가중치: HK 20% / SK 70% / DRAG 10%
    const roll = Math.random();
    if (roll < 0.20) randHK();
    else if (roll < 0.90) randSK();
    else randDrag();
  }, [randHK, randSK, randDrag]);

  // 반복 실행 헬퍼: randRepeatCount 만큼 fn을 간격(randIntervalMs) 두고 실행.
  // executeAction이 fire-and-forget이므로 setTimeout 체이닝으로 직렬화.
  // 녹화 중이면 각 iteration마다 step이 순차 추가됨 (재생 시 동일 순서 실행).
  const runRandomRepeat = useCallback((fn: () => void) => {
    if (randRunning) return;
    const total = Math.max(1, Math.floor(randRepeatCount || 1));
    const interval = Math.max(0, Math.floor(randIntervalMs || 0));
    randStopRef.current = false;
    setRandRunning(true);
    setRandProgress({ current: 0, total });
    let i = 0;
    const tick = () => {
      if (randStopRef.current || i >= total) {
        setRandRunning(false);
        return;
      }
      try {
        fn();
      } catch (e) {
        console.error('RAND action error:', e);
      }
      i += 1;
      setRandProgress({ current: i, total });
      if (i < total && !randStopRef.current) {
        setTimeout(tick, interval);
      } else {
        setRandRunning(false);
      }
    };
    tick();
  }, [randRunning, randRepeatCount, randIntervalMs]);

  const stopRandRepeat = useCallback(() => {
    randStopRef.current = true;
    // ALL RAND 중단 시 스텝 기록 억제 플래그도 해제
    suppressStepAddRef.current = false;
  }, []);

  // ALL RAND 전용 핸들러:
  //  - 녹화 중: 통합 설정을 담은 all_random 스텝 1개를 추가하고, 로컬 스트레스 실행은
  //    suppressStepAddRef로 개별 HK/SK/DRAG 스텝 기록을 억제하여 이중 기록을 방지
  //  - 비녹화: 기존 동작과 동일 (즉시 스트레스 실행만)
  const allRandHandler = useCallback(async () => {
    if (randRunning) return;
    const total = Math.max(1, Math.floor(randRepeatCount || 1));
    const interval = Math.max(0, Math.floor(randIntervalMs || 0));
    const targetDevice = screenshotDeviceId;

    if (recording && targetDevice) {
      // 녹화 중 — 개별 RAND 액션의 스텝 기록을 즉시 차단한 뒤,
      // 통합 설정 스텝 1개 기록 + 로컬 스트레스 실행을 수행한다.
      // (억제 플래그를 addStep 대기 이전에 설정해야 경합·오류 상황에서도 이중 기록 방지)
      suppressStepAddRef.current = true;
      randStopRef.current = false;
      setRandRunning(true);
      setRandProgress({ current: 0, total });

      const { w, h } = (() => {
        if (screenDevice?.type === 'isap_agent') {
          const el = canvasRef.current;
          if (el && el.width > 0 && el.height > 0) return { w: el.width, h: el.height };
        }
        return { w: deviceRes.width || 1920, h: deviceRes.height || 720 };
      })();

      const hkPool = (randHkKeysConfig && randHkKeysConfig.length > 0)
        ? randHkKeysConfig
        : hkmcKeys.filter(k => k.visible !== false && !k.is_dial).map(k => k.name);

      const params: Record<string, any> = {
        repeat_count: total,
        interval_ms: interval,
        weights: { hk: 0.20, sk: 0.70, drag: 0.10 },
        hk_keys: hkPool,
        sk_region: randSkRegion,
        drag_region: randDragRegion,
        screen_type: screenType,
        x_offset: (isScreenHkmc && hkmcDisplayMode === 'integrated') ? 1920 : 0,
        res_width: w,
        res_height: h,
      };
      const desc = `ALL RAND ×${total} @${interval}ms (HK:${hkPool.length}${randSkRegion ? ' SK▣' : ''}${randDragRegion ? ' DRAG▣' : ''})`;

      pendingStepsRef.current += 1;
      setHasPendingSteps(true);
      try {
        const res = await scenarioApi.addStep({
          type: 'all_random',
          device_id: targetDevice,
          params,
          description: desc,
          delay_after_ms: delayMs,
          skip_execute: true,
        });
        setSteps((prev) => [...prev, res.data.step]);
      } catch (e: any) {
        const detail = e.response?.data?.detail;
        message.error(typeof detail === 'string' ? detail : t('record.stepRecordFailed'));
        // 통합 스텝 기록 실패 시에는 로컬 실행도 하지 않고 종료 (의도치 않은 개별 동작 방지)
        suppressStepAddRef.current = false;
        setRandRunning(false);
        pendingStepsRef.current -= 1;
        if (pendingStepsRef.current <= 0) {
          pendingStepsRef.current = 0;
          setHasPendingSteps(false);
        }
        return;
      }
      pendingStepsRef.current -= 1;
      if (pendingStepsRef.current <= 0) {
        pendingStepsRef.current = 0;
        setHasPendingSteps(false);
      }

      // 로컬 스트레스 실행 (suppressStepAddRef로 개별 스텝 이미 차단됨)
      let i = 0;
      const tick = () => {
        if (randStopRef.current || i >= total) {
          suppressStepAddRef.current = false;
          setRandRunning(false);
          return;
        }
        try { allRand(); } catch (e) { console.error('ALL RAND error:', e); }
        i += 1;
        setRandProgress({ current: i, total });
        if (i < total && !randStopRef.current) {
          setTimeout(tick, interval);
        } else {
          suppressStepAddRef.current = false;
          setRandRunning(false);
        }
      };
      tick();
    } else {
      // 비녹화 — 기존 동작
      runRandomRepeat(allRand);
    }
  }, [randRunning, randRepeatCount, randIntervalMs, recording, screenshotDeviceId, screenDevice, deviceRes, randHkKeysConfig, hkmcKeys, randSkRegion, randDragRegion, screenType, isScreenHkmc, hkmcDisplayMode, delayMs, t, allRand, runRandomRepeat]);

  // Region 모달 canvas 그리기 (screenshot + 기존/현재 드래그 사각형)
  const drawRandRegionCanvas = useCallback((dragRect?: { x: number; y: number; w: number; h: number }) => {
    const canvas = randRegionCanvasRef.current;
    const src = randRegionScreenshotRef.current;
    if (!canvas || !src) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new window.Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      // 기존 저장된 영역 (현재 모달 모드 기준)
      const saved = randRegionModal === 'sk' ? randSkRegion : randRegionModal === 'drag' ? randDragRegion : null;
      if (saved && !dragRect) {
        // 바깥 dim + 내부 선명
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.clearRect(saved.x, saved.y, saved.width, saved.height);
        ctx.drawImage(img, saved.x, saved.y, saved.width, saved.height,
                      saved.x, saved.y, saved.width, saved.height);
        ctx.strokeStyle = '#faad14';
        ctx.lineWidth = 3;
        ctx.strokeRect(saved.x, saved.y, saved.width, saved.height);
        ctx.fillStyle = '#faad14';
        ctx.font = '22px sans-serif';
        ctx.fillText(`${saved.width}×${saved.height}`, saved.x + 4, saved.y - 6);
      }
      // 현재 드래그 중인 사각형
      if (dragRect && dragRect.w > 5 && dragRect.h > 5) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.clearRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
        ctx.drawImage(img, dragRect.x, dragRect.y, dragRect.w, dragRect.h,
                      dragRect.x, dragRect.y, dragRect.w, dragRect.h);
        ctx.strokeStyle = '#1890ff';
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
        ctx.setLineDash([]);
        ctx.fillStyle = '#1890ff';
        ctx.font = '22px sans-serif';
        ctx.fillText(`${dragRect.w}×${dragRect.h}`, dragRect.x + 4, dragRect.y - 6);
      }
    };
    img.src = src;
  }, [randRegionModal, randSkRegion, randDragRegion]);

  const randRegionMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = randRegionCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    randRegionDragRef.current = { startX: x, startY: y, curX: x, curY: y, active: true };
  }, []);

  const randRegionMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!randRegionDragRef.current.active) return;
    const canvas = randRegionCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    randRegionDragRef.current.curX = x;
    randRegionDragRef.current.curY = y;
    const { startX, startY } = randRegionDragRef.current;
    drawRandRegionCanvas({
      x: Math.min(startX, x), y: Math.min(startY, y),
      w: Math.abs(x - startX), h: Math.abs(y - startY),
    });
  }, [drawRandRegionCanvas]);

  const randRegionMouseUp = useCallback(() => {
    if (!randRegionDragRef.current.active) return;
    randRegionDragRef.current.active = false;
    const { startX, startY, curX, curY } = randRegionDragRef.current;
    const rx = Math.min(startX, curX);
    const ry = Math.min(startY, curY);
    const rw = Math.abs(curX - startX);
    const rh = Math.abs(curY - startY);
    if (rw > 10 && rh > 10) {
      const region = { x: rx, y: ry, width: rw, height: rh };
      const base = _randStorageBase();
      if (randRegionModal === 'sk') {
        setRandSkRegion(region);
        if (base) localStorage.setItem(`${base}_sk`, JSON.stringify(region));
      } else if (randRegionModal === 'drag') {
        setRandDragRegion(region);
        if (base) localStorage.setItem(`${base}_drag`, JSON.stringify(region));
      }
      // 저장 후 다시 그려서 노란 테두리로 표시
      setTimeout(() => drawRandRegionCanvas(), 30);
    }
  }, [_randStorageBase, randRegionModal, drawRandRegionCanvas]);

  const openRandRegionModal = useCallback(async (mode: 'sk' | 'drag') => {
    randRegionScreenshotRef.current = await snapshotScreenshot();
    setRandRegionModal(mode);
    setTimeout(() => drawRandRegionCanvas(), 80);
  }, [snapshotScreenshot, drawRandRegionCanvas]);

  const clearRandRegion = useCallback((mode: 'sk' | 'drag') => {
    const base = _randStorageBase();
    if (mode === 'sk') {
      setRandSkRegion(null);
      if (base) localStorage.removeItem(`${base}_sk`);
    } else {
      setRandDragRegion(null);
      if (base) localStorage.removeItem(`${base}_drag`);
    }
    setTimeout(() => drawRandRegionCanvas(), 30);
  }, [_randStorageBase, drawRandRegionCanvas]);

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
    await ensureSavedForImageOp();
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
    // 라이브 스크린 미러와 test-step이 동일 HKMC 에이전트의 _capture_lock을 두고 경쟁하면
    // 백엔드가 오래된 캡처 버퍼를 반환할 수 있다. 테스트 동안 스트림을 일시정지한다.
    pauseScreenStream();
    try {
      const { _imageVer, ...currentStep } = steps[stepIdx];
      // 현재 라이브 뷰의 device/screen_type을 override로 전달 — 스텝에 저장된 값이
      // 사용자가 실제로 보고 있는 화면과 다를 때 발생하는 stale image 문제 회피
      const overrides = screenshotDeviceId
        ? { screenshotDeviceId, screenType }
        : undefined;
      const res = await scenarioApi.testStep(scenarioName, stepIdx, currentStep, overrides);
      const result = { ...res.data, _ts: Date.now() };
      setTestResult(result);
      setTestResultModalOpen(true);
      resumeScreenStream();
      refreshScreenshot();
      // 백그라운드 CMD/SSH 결과 폴링: 메시지에 [BG_TASK:bg_x]가 있으면 서버에 폴링
      const bgMatch = result.message?.match?.(/\[BG_TASK:(bg_\d+)\]/);
      if (bgMatch) {
        const taskId = bgMatch[1];
        result.message = `${t('record.cmdRunning')}...`;
        setTestResult({ ...result });
        // 이전 폴링이 남아있으면 먼저 정리
        stopActiveBgPoll(false);
        activeBgTaskIdRef.current = taskId;
        const poll = setInterval(async () => {
          try {
            const r = await scenarioApi.getCmdResult(taskId);
            if (r.data.status === 'running') {
              // 라이브 업데이트: 현재까지 누적된 stdout을 보여줌 (send_command_stream 용)
              const liveStdout = r.data.stdout ?? '';
              if (liveStdout) {
                setTestResult((prev: any) => ({ ...prev, message: liveStdout }));
              }
            } else {
              clearInterval(poll);
              if (activeBgPollRef.current === poll) {
                activeBgPollRef.current = null;
                activeBgTaskIdRef.current = null;
              }
              // 서버가 계산한 final_message + final_status 사용
              const finalMsg = r.data.final_message ?? r.data.stdout ?? '';
              const finalStatus = r.data.final_status;
              setTestResult((prev: any) => ({
                ...prev,
                message: finalMsg,
                status: finalStatus ?? prev.status,
              }));
            }
          } catch {
            clearInterval(poll);
            if (activeBgPollRef.current === poll) {
              activeBgPollRef.current = null;
              activeBgTaskIdRef.current = null;
            }
          }
        }, 500);
        activeBgPollRef.current = poll;
      }
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('record.stepTestFailed'));
      resumeScreenStream();
    } finally {
      setTestingStepIndex(null);
    }
  }, [scenarioName, steps, refreshScreenshot, pauseScreenStream, resumeScreenStream, screenshotDeviceId, screenType]);

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
      await ensureSavedForImageOp();
      // 모달에 표시된 이미지(모달 열 때 찍어둔 스냅샷)를 그대로 사용해야 함.
      // 백엔드에서 다시 캡처하면 그사이 화면이 바뀌어(예: 팝업이 사라짐) 잘못된 영역이 크롭됨.
      const modalImage = captureScreenshotRef.current;
      if (!modalImage) {
        message.error(t('record.expectedImageSaveFailed'));
        return;
      }
      try {
        const res = await scenarioApi.saveExpectedImage(
          scenarioName, captureStepIndex, modalImage, crop,
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
  }, [captureStepIndex, scenarioName, screenshotDeviceId, t]);

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
      // 기대 이미지가 없으면 자동 저장 — 모달에 표시된 스냅샷 사용 (백엔드 재캡처 금지)
      const step = steps[excludeRoiEditingIndex];
      if (!step?.expected_image && scenarioName && screenshotDeviceId) {
        await ensureSavedForImageOp();
        const modalImage = excludeRoiScreenshotRef.current;
        if (!modalImage) {
          message.error(t('record.cropSaveFailed'));
          return;
        }
        try {
          const capRes = await scenarioApi.saveExpectedImage(scenarioName, excludeRoiEditingIndex, modalImage);
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
      await ensureSavedForImageOp();
      // 모달에 표시된 스냅샷을 기대이미지로 저장 — 백엔드 재캡처 시 팝업 사라진 최신 화면이 들어오는 버그 회피
      const modalImage = multiCropScreenshotRef.current;
      if (!modalImage) {
        message.error(t('record.cropSaveFailed'));
        return;
      }
      try {
        // preserve_crops=true: 기존 multi_crop 아이템을 유지 (아래 cropFromExpected에서 추가/교체)
        const capRes = await scenarioApi.saveExpectedImage(scenarioName, multiCropEditingIndex, modalImage, undefined, undefined, undefined, true);
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
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!screenshotDeviceId) return;
    const el = canvasRef.current;
    if (!el) return;
    const { x, y } = toDeviceCoords(el, e.clientX, e.clientY);
    gestureRef.current = { startX: x, startY: y, startTime: Date.now(), active: true };
  }, [screenshotDeviceId, deviceRes, hkmcDisplayMode, isScreenHkmc, viewCropEnabled, viewCropX, viewCropY]);

  const handleMouseMove = useCallback((_e: React.MouseEvent<HTMLCanvasElement>) => {
    // 스와이프 시각 피드백용으로 남겨둠 (필요 시 확장)
  }, []);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!screenshotDeviceId || !gestureRef.current.active) return;
    gestureRef.current.active = false;
    const el = canvasRef.current;
    if (!el) return;

    const { startX, startY, startTime } = gestureRef.current;
    const { x: endX, y: endY } = toDeviceCoords(el, e.clientX, e.clientY);
    const dist = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);
    const elapsed = Date.now() - startTime;

    // 줌인/줌아웃 모드: 스와이프한 방향과 거리만큼 핀치 제스처
    if (gestureMode !== 'normal') {
      const dx = endX - startX;
      const dy = endY - startY;
      const spread = Math.max(10, Math.sqrt(dx * dx + dy * dy));
      const gap = 5;
      // 드래그 방향 단위벡터 (드래그 안 했으면 수평 기본)
      const len = Math.sqrt(dx * dx + dy * dy);
      const ux = len > 3 ? dx / len : 1;
      const uy = len > 3 ? dy / len : 0;
      const cx = Math.round((startX + endX) / 2);
      const cy = Math.round((startY + endY) / 2);
      let fingers;
      if (gestureMode === 'zoom_in') {
        // 줌인: 중심에서 드래그 방향으로 벌어짐
        fingers = [
          { x1: Math.round(cx - ux * gap), y1: Math.round(cy - uy * gap), x2: Math.round(cx - ux * spread), y2: Math.round(cy - uy * spread) },
          { x1: Math.round(cx + ux * gap), y1: Math.round(cy + uy * gap), x2: Math.round(cx + ux * spread), y2: Math.round(cy + uy * spread) },
        ];
      } else {
        // 줌아웃: 드래그 방향 바깥에서 중심으로 오므려짐
        fingers = [
          { x1: Math.round(cx - ux * spread), y1: Math.round(cy - uy * spread), x2: Math.round(cx - ux * gap), y2: Math.round(cy - uy * gap) },
          { x1: Math.round(cx + ux * spread), y1: Math.round(cy + uy * spread), x2: Math.round(cx + ux * gap), y2: Math.round(cy + uy * gap) },
        ];
      }
      const durationMs = Math.max(200, Math.min(elapsed, 2000));
      const label = gestureMode === 'zoom_in' ? t('record.zoomIn') : t('record.zoomOut');
      const params = { fingers, duration_ms: durationMs };
      executeAction('multi_touch', params, `${label} (${startX},${startY})→(${endX},${endY})`);
      setLastGesture(`${label} (${startX},${startY})→(${endX},${endY})`);
      return;
    }

    // 멀티터치 핑거 좌표 생성 (중심점 기준 대칭 오프셋)
    const buildFingers = (cx1: number, cy1: number, cx2: number, cy2: number): { x1: number; y1: number; x2: number; y2: number }[] => {
      const spread = fingerSpread;
      if (fingerCount === 2) {
        return [
          { x1: cx1 - spread, y1: cy1, x2: cx2 - spread, y2: cy2 },
          { x1: cx1 + spread, y1: cy1, x2: cx2 + spread, y2: cy2 },
        ];
      }
      if (fingerCount === 3) {
        return [
          { x1: cx1, y1: cy1 - spread, x2: cx2, y2: cy2 - spread },
          { x1: cx1 - spread, y1: cy1 + Math.round(spread * 0.5), x2: cx2 - spread, y2: cy2 + Math.round(spread * 0.5) },
          { x1: cx1 + spread, y1: cy1 + Math.round(spread * 0.5), x2: cx2 + spread, y2: cy2 + Math.round(spread * 0.5) },
        ];
      }
      return [{ x1: cx1, y1: cy1, x2: cx2, y2: cy2 }];
    };

    if (fingerCount > 1) {
      // 멀티터치 모드
      if (dist > SWIPE_DISTANCE_THRESHOLD) {
        const durationMs = Math.max(200, Math.min(elapsed, 3000));
        const fingers = buildFingers(startX, startY, endX, endY);
        const params = { fingers, duration_ms: durationMs };
        executeAction('multi_touch', params, `${fingerCount}-finger swipe (${startX},${startY})→(${endX},${endY})`);
        setLastGesture(`${fingerCount}-finger swipe (${startX},${startY})→(${endX},${endY})`);
      } else {
        // 멀티터치 탭
        const fingers = buildFingers(startX, startY, startX, startY);
        const params = { fingers, duration_ms: 0 };
        executeAction('multi_touch', params, `${fingerCount}-finger tap (${startX},${startY})`);
        setLastGesture(`${fingerCount}-finger tap (${startX},${startY})`);
      }
    } else if (dist > SWIPE_DISTANCE_THRESHOLD) {
      const durationMs = Math.max(200, Math.min(elapsed, 3000));
      const params = { x1: startX, y1: startY, x2: endX, y2: endY, duration_ms: durationMs };
      executeAction('swipe', params, `swipe (${startX},${startY})→(${endX},${endY}) ${durationMs}ms`);
      setLastGesture(`${t('record.gestureSwipe')} (${startX},${startY})→(${endX},${endY})`);
    } else if (elapsed >= LONG_PRESS_THRESHOLD_MS) {
      const params = { x: startX, y: startY, duration_ms: elapsed };
      executeAction('long_press', params, `long_press (${startX},${startY}) ${elapsed}ms`);
      setLastGesture(`${t('record.gestureLongPress')} (${startX},${startY}) ${elapsed}ms`);
    } else if (repeatTapMode) {
      // 연속터치 모드: 좌표 저장 후 모달 열기
      repeatTapCoordsRef.current = { x: startX, y: startY };
      setRepeatTapModalOpen(true);
    } else {
      const params = { x: startX, y: startY };
      executeAction('tap', params, `tap (${startX},${startY})`);
      setLastGesture(`${t('record.gestureTap')} (${startX},${startY})`);
    }
  }, [screenshotDeviceId, executeAction, deviceRes, hkmcDisplayMode, isScreenHkmc, viewCropEnabled, viewCropX, viewCropY, fingerCount, fingerSpread, gestureMode, repeatTapMode]);

  const executeRepeatTap = useCallback(() => {
    const { x, y } = repeatTapCoordsRef.current;
    const params = { x, y, count: repeatTapCount, interval_ms: repeatTapInterval };
    executeAction('repeat_tap', params, `repeat_tap (${x},${y}) ×${repeatTapCount} @${repeatTapInterval}ms`);
    setLastGesture(`${t('record.repeatTap')} (${x},${y}) ×${repeatTapCount}`);
    setRepeatTapModalOpen(false);
    setRepeatTapMode(false);
  }, [executeAction, repeatTapCount, repeatTapInterval]);

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

  const addManualStep = async () => {
    if (!recording) return;
    if (!selectedDeviceId || !selectedModuleName) {
      message.warning(t('record.selectModule'));
      return;
    }
    if (!selectedModuleFunc) {
      message.warning(t('record.selectFunction2'));
      return;
    }
    // DLTViewer: WaitLog + 백그라운드 체크 시 StartMonitor로 자동 전환
    let funcName = selectedModuleFunc;
    if (selectedModuleName === 'DLTViewer' && selectedModuleFunc === 'WaitLog' && dltBackground) {
      funcName = 'StartMonitor';
    }
    const params = { module: selectedModuleName, function: funcName, args: { ...moduleFuncArgs } };

    try {
      const res = await scenarioApi.addStep({
        type: 'module_command',
        device_id: selectedDeviceId,
        params,
        description: `${selectedModuleName}::${funcName}()`,
        delay_after_ms: delayMs,
        skip_execute: true,
      });
      setSteps((prev) => [...prev, res.data.step]);
      message.success(t('record.stepAdded', { id: res.data.step.id }));
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('record.stepAddFailed'));
    }
  };

  // Fetch saved scenario list
  const [recordFolders, setRecordFolders] = useState<Record<string, string[]>>({});
  const [recordSelectedFolder, setRecordSelectedFolder] = useState<string>('__all__');

  const fetchSavedScenarios = async () => {
    try {
      const [scRes, fRes] = await Promise.all([scenarioApi.list(), scenarioApi.getFolders()]);
      setSavedScenarios(scRes.data.scenarios);
      setRecordFolders(fRes.data.folders || {});
    } catch { /* ignore */ }
  };

  const filteredSavedScenarios = React.useMemo(() => {
    if (recordSelectedFolder === '__all__') return savedScenarios;
    const items = recordFolders[recordSelectedFolder] || [];
    return savedScenarios.filter(n => items.includes(n));
  }, [savedScenarios, recordFolders, recordSelectedFolder]);

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
      // 프론트엔드에서 편집하지 않는 시나리오 메타데이터 보존
      const { name: _n, description: _d, steps: _s, ...meta } = res.data;
      scenarioMetaRef.current = meta;
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
        ...scenarioMetaRef.current,
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

  // 기대이미지 백엔드 API 호출 전 미저장 변경사항 동기화
  // 프론트엔드 steps 상태를 백엔드 in-memory 시나리오로 즉시 동기화.
  // 녹화 중 이동·복사·재정렬로 인한 step_index 불일치를 방지.
  const syncFrontendStepsToBackend = async (): Promise<boolean> => {
    if (!recording || !scenarioName.trim()) return true;
    const reindexed = steps.map((s, i) => {
      const { _imageVer, ...rest } = s;
      return { ...rest, id: i + 1 };
    });
    try {
      await scenarioApi.syncSteps(scenarioName.trim(), reindexed);
      return true;
    } catch (e: any) {
      console.warn('sync-steps failed:', e?.response?.data?.detail || e);
      return false;
    }
  };

  // 백엔드의 _resolve_scenario가 디스크에서 시나리오를 로드하거나 in-memory
  // _current_scenario 를 사용하므로, 프론트엔드에서 스텝을 삭제/이동한 후
  // 저장/동기화하지 않으면 인덱스가 불일치함.
  //  - editingExisting: 디스크 save
  //  - recording (신규): in-memory sync
  const ensureSavedForImageOp = async (): Promise<boolean> => {
    if (!scenarioName.trim()) return true;
    // 녹화 중 신규 시나리오: 디스크 저장이 아닌 in-memory sync
    if (recording && !editingExisting) {
      return await syncFrontendStepsToBackend();
    }
    if (!editingExisting) return true;
    if (!isDirty()) return true;
    try {
      const newName = scenarioName.trim();
      const reindexed = steps.map((s, i) => {
        const { _imageVer, ...rest } = s;
        return { ...rest, id: i + 1 };
      });
      await scenarioApi.update(newName, {
        ...scenarioMetaRef.current,
        name: newName,
        description,
        steps: reindexed,
      });
      const savedSteps = reindexed.map((s, i) => ({ ...s, _imageVer: steps[i]?._imageVer }));
      setSteps(savedSteps);
      savedStepsRef.current = JSON.stringify(reindexed);
      return true;
    } catch {
      return false;
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
      return filtered.map((s, i) => ({
        ...s,
        id: i + 1,
        on_pass_goto: remapGoto(s.on_pass_goto, mapping),
        on_fail_goto: remapGoto(s.on_fail_goto, mapping),
      }));
    });
    message.success(t('record.stepDeleted', { index: index + 1 }));
  };

  const moveStepDnD = (oldIndex: number, newIndex: number) => {
    if (oldIndex === newIndex) return;
    let reordered: Step[] = [];
    setSteps((prev) => {
      const arr = [...prev];
      const [moved] = arr.splice(oldIndex, 1);
      arr.splice(newIndex, 0, moved);
      const oldIds = prev.map((_, i) => i + 1);
      const newIds = [...oldIds];
      newIds.splice(oldIndex, 1);
      newIds.splice(newIndex, 0, oldIds[oldIndex]);
      // old 1-based → new 1-based mapping
      const posMapping = new Map<number, number>();
      for (let i = 0; i < prev.length; i++) {
        posMapping.set(i + 1, newIds.indexOf(i + 1) + 1);
      }
      reordered = arr.map((s, i) => ({
        ...s,
        id: i + 1,
        on_pass_goto: remapGoto(s.on_pass_goto, posMapping),
        on_fail_goto: remapGoto(s.on_fail_goto, posMapping),
      }));
      return reordered;
    });
    // 녹화 중이면 백엔드 in-memory 시나리오도 즉시 동기화
    if (recording && scenarioName.trim() && reordered.length > 0) {
      const payload = reordered.map((s, i) => {
        const { _imageVer, ...rest } = s;
        return { ...rest, id: i + 1 };
      });
      scenarioApi.syncSteps(scenarioName.trim(), payload).catch((e: any) => {
        console.warn('sync-steps after move failed:', e?.response?.data?.detail || e);
      });
    }
  };

  // 스텝 복사/이동 모달 상태
  const [importStepModalOpen, setImportStepModalOpen] = useState(false);
  const [importMode, setImportMode] = useState<'copy' | 'move'>('copy');
  const [importInsertIndex, setImportInsertIndex] = useState(0); // 삽입 위치 (해당 인덱스 뒤에 삽입)
  const [importSourceName, setImportSourceName] = useState('__current__');
  const [importSourceSteps, setImportSourceSteps] = useState<Step[]>([]);
  const [importChecked, setImportChecked] = useState<Set<number>>(new Set());
  const [importLoading, setImportLoading] = useState(false);

  const openImportStepModal = (afterIndex: number, mode: 'copy' | 'move' = 'copy') => {
    setImportMode(mode);
    setImportInsertIndex(afterIndex);
    // move 모드: 항상 현재 시나리오에서만 선택 (벌크 재정렬)
    setImportSourceName('__current__');
    setImportSourceSteps(steps);
    setImportChecked(new Set());
    setImportStepModalOpen(true);
  };

  const loadImportSource = async (name: string) => {
    setImportSourceName(name);
    setImportChecked(new Set());
    if (name === '__current__') {
      setImportSourceSteps(steps);
      return;
    }
    if (!name) {
      setImportSourceSteps([]);
      return;
    }
    try {
      const res = await scenarioApi.get(name);
      setImportSourceSteps(res.data.steps || []);
    } catch {
      message.error(t('common.loadFailed'));
      setImportSourceSteps([]);
    }
  };

  const executeImportSteps = async () => {
    if (importChecked.size === 0) return;
    const sortedIndices = Array.from(importChecked).sort((a, b) => a - b);

    // MOVE 모드: 현재 시나리오 내 벌크 재정렬. 프론트엔드에서 계산 후 녹화 중이면 백엔드 sync.
    if (importMode === 'move') {
      let reordered: Step[] = [];
      setSteps(prev => {
        // 선택 안 된 스텝과 선택된 스텝을 분리
        const removedSet = new Set(sortedIndices);
        const moved: Step[] = [];
        const kept: Step[] = [];
        prev.forEach((s, i) => {
          if (removedSet.has(i)) moved.push(s);
          else kept.push(s);
        });
        // 삽입 위치: importInsertIndex 이하에서 제거된 개수만큼 보정
        const removedBeforeOrAt = sortedIndices.filter(i => i <= importInsertIndex).length;
        const insertAtInKept = importInsertIndex + 1 - removedBeforeOrAt;
        const clamped = Math.max(0, Math.min(insertAtInKept, kept.length));
        // 이동된 스텝의 조건부 이동(on_pass_goto/on_fail_goto)은 초기화
        const movedCleared: Step[] = moved.map(s => ({ ...s, on_pass_goto: null, on_fail_goto: null }));
        const movedSet = new Set<Step>(movedCleared);
        const finalArr = [...kept.slice(0, clamped), ...movedCleared, ...kept.slice(clamped)];

        // Goto 재매핑 (남은 스텝들의 참조만): old 1-based → new 1-based
        // 이동된 스텝을 가리키던 참조는 null로 초기화 (정책상 끊어짐)
        const posMap = new Map<number, number>();
        moved.forEach((_s, mi) => {
          const oldPos1 = sortedIndices[mi] + 1;
          posMap.set(oldPos1, -1); // -1 sentinel: 참조 끊기
        });
        let newIdx = 0;
        kept.forEach((s) => {
          const oldIdx = prev.indexOf(s);
          const oldPos1 = oldIdx + 1;
          if (newIdx === clamped) newIdx += movedCleared.length;
          posMap.set(oldPos1, newIdx + 1);
          newIdx += 1;
        });

        const remapOrNull = (v: number | null | undefined): number | null | undefined => {
          if (v == null || v === -1) return v;
          const mapped = posMap.get(v);
          if (mapped === -1 || mapped === undefined) return null; // 이동된 스텝 참조 → 끊기
          return mapped;
        };

        reordered = finalArr.map((s, i) => {
          // 이동된 스텝은 이미 goto 초기화됨
          if (movedSet.has(s)) {
            return { ...s, id: i + 1 };
          }
          return {
            ...s,
            id: i + 1,
            on_pass_goto: remapOrNull(s.on_pass_goto),
            on_fail_goto: remapOrNull(s.on_fail_goto),
          };
        });
        return reordered;
      });
      setImportStepModalOpen(false);
      message.success(t('record.stepsMoved', { count: sortedIndices.length }));
      // 녹화 중이면 백엔드 in-memory 시나리오도 즉시 동기화
      if (recording && scenarioName.trim() && reordered.length > 0) {
        const payload = reordered.map((s, i) => {
          const { _imageVer, ...rest } = s;
          return { ...rest, id: i + 1 };
        });
        scenarioApi.syncSteps(scenarioName.trim(), payload).catch((e: any) => {
          console.warn('sync-steps after bulk move failed:', e?.response?.data?.detail || e);
        });
      }
      return;
    }

    // COPY 모드: 기존 백엔드 import-steps 호출 (이미지 파일 복사 포함)
    const sourceName = importSourceName === '__current__' ? scenarioName : importSourceName;
    setImportLoading(true);
    try {
      const res = await scenarioApi.importSteps(scenarioName, sourceName, sortedIndices, false);
      const imported: Step[] = res.data.steps || [];
      let merged: Step[] = [];
      setSteps(prev => {
        const arr = [...prev];
        arr.splice(importInsertIndex + 1, 0, ...imported.map(s => ({ ...s, _imageVer: Date.now() })));
        merged = arr.map((s, i) => ({ ...s, id: i + 1 }));
        return merged;
      });
      setImportStepModalOpen(false);
      message.success(t('record.stepsImported', { count: imported.length }));
      // 녹화 중이면 백엔드 in-memory 시나리오도 즉시 동기화 (import-steps는 target을 변경하지 않음)
      if (recording && scenarioName.trim() && merged.length > 0) {
        const payload = merged.map((s, i) => {
          const { _imageVer, ...rest } = s;
          return { ...rest, id: i + 1 };
        });
        scenarioApi.syncSteps(scenarioName.trim(), payload).catch((e: any) => {
          console.warn('sync-steps after copy failed:', e?.response?.data?.detail || e);
        });
      }
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('common.saveFailed'));
    } finally {
      setImportLoading(false);
    }
  };

  const [waitPopoverIndex, setWaitPopoverIndex] = useState<number | null | 'end'>(null);

  const addWaitStepWithMode = async (mode: 'basic' | 'cycle' | 'random', opts: { duration_ms?: number; start_ms?: number; interval_ms?: number; min_ms?: number; max_ms?: number }, afterIndex?: number) => {
    setWaitPopoverIndex(null);
    let params: Record<string, any>;
    let desc: string;
    if (mode === 'cycle') {
      params = { duration_ms: opts.start_ms || 3000, wait_mode: 'cycle', wait_start: opts.start_ms || 3000, wait_interval: opts.interval_ms || 3000 };
      desc = `wait cycle ${opts.start_ms}+${opts.interval_ms}ms`;
    } else if (mode === 'random') {
      params = { duration_ms: opts.min_ms || 0, wait_mode: 'random', wait_min: opts.min_ms || 0, wait_max: opts.max_ms || 10000 };
      desc = `wait random ${opts.min_ms}~${opts.max_ms}ms`;
    } else {
      params = { duration_ms: opts.duration_ms || 1000 };
      desc = `wait ${opts.duration_ms || 1000}ms`;
    }
    const waitStep: Step = {
      id: 0,
      type: 'wait',
      device_id: null,
      params,
      delay_after_ms: 0,
      description: desc,
      expected_image: null,
    };

    if (recording) {
      // During recording: 프론트엔드 상태에 삽입(afterIndex 있으면 지정 위치, 없으면 맨 뒤)
      // + 백엔드에도 addStep 호출. 순서 차이는 저장 시점에 frontend state가 일괄 push됨.
      if (afterIndex !== undefined) {
        setSteps((prev) => {
          const arr = [...prev];
          const insertPos1Based = afterIndex + 2;
          arr.splice(afterIndex + 1, 0, waitStep);
          return arr.map((s, i) => ({
            ...s,
            id: i + 1,
            on_pass_goto: s.on_pass_goto != null && s.on_pass_goto !== -1 && s.on_pass_goto >= insertPos1Based ? s.on_pass_goto + 1 : s.on_pass_goto,
            on_fail_goto: s.on_fail_goto != null && s.on_fail_goto !== -1 && s.on_fail_goto >= insertPos1Based ? s.on_fail_goto + 1 : s.on_fail_goto,
          }));
        });
      } else {
        setSteps((prev) => [...prev, waitStep]);
      }
      pendingStepsRef.current += 1;
      setHasPendingSteps(true);
      try {
        const res = await scenarioApi.addStep({
          type: 'wait',
          device_id: '',
          params,
          description: desc,
          delay_after_ms: 0,
          skip_execute: true,
        });
        // 백엔드 응답으로 교체하되 프론트엔드가 재번호한 id는 유지
        setSteps((prev) => prev.map(s => s === waitStep ? { ...res.data.step, id: s.id } : s));
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

  const [wMode, setWMode] = useState<'basic' | 'cycle' | 'random'>('basic');
  const [wDuration, setWDuration] = useState(1000);
  const [wStart, setWStart] = useState(3000);
  const [wInterval, setWInterval] = useState(3000);
  const [wMin, setWMin] = useState(0);
  const [wMax, setWMax] = useState(10000);

  const renderWaitPopoverContent = (afterIndex?: number) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 200 }}>
      <Radio.Group size="small" value={wMode} onChange={(e) => setWMode(e.target.value)} optionType="button" buttonStyle="solid"
        options={[
          { label: t('record.waitBasic'), value: 'basic' },
          { label: t('record.waitCycle'), value: 'cycle' },
          { label: t('record.waitRandom'), value: 'random' },
        ]}
      />
      {wMode === 'basic' && (
        <InputNumber size="small" min={0} step={100} value={wDuration} onChange={(v) => setWDuration(v || 0)} suffix="ms" style={{ width: '100%' }} />
      )}
      {wMode === 'cycle' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Space><span style={{ fontSize: 12, minWidth: 30 }}>{t('record.waitStart')}:</span><InputNumber size="small" min={0} step={100} value={wStart} onChange={(v) => setWStart(v || 0)} suffix="ms" style={{ width: 120 }} /></Space>
          <Space><span style={{ fontSize: 12, minWidth: 30 }}>{t('record.waitInterval')}:</span><InputNumber size="small" min={0} step={100} value={wInterval} onChange={(v) => setWInterval(v || 0)} suffix="ms" style={{ width: 120 }} /></Space>
        </div>
      )}
      {wMode === 'random' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Space><span style={{ fontSize: 12, minWidth: 30 }}>Min:</span><InputNumber size="small" min={0} step={100} value={wMin} onChange={(v) => setWMin(v || 0)} suffix="ms" style={{ width: 120 }} /></Space>
          <Space><span style={{ fontSize: 12, minWidth: 30 }}>Max:</span><InputNumber size="small" min={0} step={100} value={wMax} onChange={(v) => setWMax(v || 0)} suffix="ms" style={{ width: 120 }} /></Space>
        </div>
      )}
      <Button size="small" type="primary" block onClick={() => {
        if (wMode === 'basic') addWaitStepWithMode('basic', { duration_ms: wDuration }, afterIndex);
        else if (wMode === 'cycle') addWaitStepWithMode('cycle', { start_ms: wStart, interval_ms: wInterval }, afterIndex);
        else addWaitStepWithMode('random', { min_ms: wMin, max_ms: wMax }, afterIndex);
      }}>{t('record.addWait')}</Button>
    </div>
  );

  // ── Device 일괄 전환 ──
  const [deviceSwapOpen, setDeviceSwapOpen] = useState(false);
  const [deviceSwapMap, setDeviceSwapMap] = useState<Record<string, string>>({});

  const openDeviceSwapPopover = () => {
    // 시나리오에 사용된 고유 device_id 추출
    const ids = new Set<string>();
    for (const s of steps) {
      if (s.device_id) ids.add(s.device_id);
      if (s.screenshot_device_id) ids.add(s.screenshot_device_id);
    }
    const map: Record<string, string> = {};
    ids.forEach(id => { map[id] = id; });
    setDeviceSwapMap(map);
    setDeviceSwapOpen(true);
  };

  const applyDeviceSwap = () => {
    // 변경된 매핑만 적용
    const changed = Object.entries(deviceSwapMap).filter(([from, to]) => from !== to);
    if (changed.length === 0) {
      setDeviceSwapOpen(false);
      return;
    }
    setSteps(prev => prev.map(s => {
      let updated = { ...s };
      if (s.device_id && deviceSwapMap[s.device_id]) {
        updated.device_id = deviceSwapMap[s.device_id];
      }
      if (s.screenshot_device_id && deviceSwapMap[s.screenshot_device_id]) {
        updated.screenshot_device_id = deviceSwapMap[s.screenshot_device_id];
      }
      return updated;
    }));
    setDeviceSwapOpen(false);
    message.success(t('record.deviceSwapDone'));
  };

  const renderDeviceSwapContent = () => {
    const entries = Object.entries(deviceSwapMap);
    if (entries.length === 0) {
      return <div style={{ color: '#888', fontSize: 12, padding: 8 }}>{t('record.noDeviceInSteps')}</div>;
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 280 }}>
        {entries.map(([from, to]) => (
          <div key={from} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Tag style={{ minWidth: 80, textAlign: 'center' }}>{from}</Tag>
            <span style={{ color: '#888' }}>→</span>
            <Select
              size="small"
              value={to}
              onChange={(v) => setDeviceSwapMap(prev => ({ ...prev, [from]: v }))}
              style={{ flex: 1 }}
              options={allDevices.filter(d => d.status === 'device' || d.status === 'connected').map(d => ({ label: `${d.id} ${d.name ? '(' + d.name + ')' : ''}`, value: d.id }))}
            />
          </div>
        ))}
        <Button size="small" type="primary" onClick={applyDeviceSwap}>{t('common.apply')}</Button>
      </div>
    );
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
    // module_command 편집 시 해당 모듈의 함수 가이드 로딩
    if (s.type === 'module_command' && s.params?.module) {
      deviceApi.getModuleFunctions(s.params.module).then(res => {
        setModuleFunctions(res.data.functions || []);
        setModuleDescription(res.data.module_description || '');
      }).catch(() => {});
    }
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
      // 빈 시나리오를 백엔드에 즉시 저장
      try {
        await scenarioApi.update(name, { name, description: '', steps: [] });
      } catch (e: any) {
        message.error(e.response?.data?.detail || t('common.saveFailed'));
        return;
      }
      setOriginalScenarioName(name);
      setDescription('');
      setSteps([]);
      savedStepsRef.current = '[]';
      setEditingExisting(true);
      setSavedScenarios(prev => prev.includes(name) ? prev : [...prev, name]);
      setScenarioName(name);
    });
  };

  // 기대이미지 미리보기: 어노테이션(exclude/crop ROI) 포함
  const showAnnotatedPreview = useCallback((step: Step) => {
    if (!step.expected_image || !scenarioName) return;
    const imgUrl = `/screenshots/${scenarioName}/${step.expected_image}?v=${step._imageVer || ''}`;
    const mode = step.compare_mode;
    // compare_mode에 해당하는 어노테이션만 그린다 — stale 필드(이전 모드 잔재)를 그리면
    // "다른 스텝의 ROI처럼 보이는" 버그가 발생함.
    // single_crop은 저장된 이미지 자체가 크롭 영역이므로 rect를 그리지 않음.
    const drawExclude = mode === 'full_exclude' && (step.exclude_rois?.length || 0) > 0;
    const drawMulti = mode === 'multi_crop' && (step.expected_images?.length || 0) > 0;
    if (!drawExclude && !drawMulti) {
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
      if (drawExclude) {
        step.exclude_rois!.forEach((r, i) => {
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
      if (drawMulti) {
        step.expected_images!.forEach((ci, i) => {
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
    // 비교모드별 기본 임계값 적용
    const thresholdMap: Record<string, number> = {
      full: settings.threshold_full,
      single_crop: settings.threshold_single_crop,
      full_exclude: settings.threshold_full_exclude,
      multi_crop: settings.threshold_multi_crop,
    };
    const defaultThreshold = thresholdMap[mode] ?? 0.95;
    setSteps(prev => prev.map((s, i) => i === index ? { ...s, similarity_threshold: defaultThreshold } : s));
    setTimeout(() => {
      if (mode === 'full') saveExpectedFull(index);
      else if (mode === 'single_crop') openCaptureModal(index);
      else if (mode === 'full_exclude') openExcludeRoiModal(index);
      else if (mode === 'multi_crop') openMultiCropModal(index);
    }, 100);
  }, [updateCompareMode, saveExpectedFull, openCaptureModal, openExcludeRoiModal, openMultiCropModal, settings]);

  // Draw screenshot on canvas
  useEffect(() => {
    if (!screenshot || !canvasRef.current) return;
    const img = new window.Image();
    img.onload = () => {
      const canvas = canvasRef.current!;
      if (viewCropEnabled) {
        // 크롭 영역만 캔버스에 그림 (왜곡 없이 원본 비율 유지)
        const sx = Math.round(viewCropX[0] * img.naturalWidth);
        const sy = Math.round(viewCropY[0] * img.naturalHeight);
        const sw = Math.round((viewCropX[1] - viewCropX[0]) * img.naturalWidth);
        const sh = Math.round((viewCropY[1] - viewCropY[0]) * img.naturalHeight);
        canvas.width = sw;
        canvas.height = sh;
        canvas.getContext('2d')?.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      } else {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d')?.drawImage(img, 0, 0);
      }
    };
    img.src = screenshot;
  }, [screenshot, viewCropEnabled, viewCropX, viewCropY]);

  const getDeviceTag = (deviceId: string | null) => {
    if (!deviceId) return <Tag>-</Tag>;
    const dev = allDevices.find(d => d.id === deviceId);
    if (!dev) return <Tag color="orange">{deviceId}</Tag>;
    const color = dev.category === 'primary' ? 'green' : 'purple';
    return <Tag color={color}>{dev.id}</Tag>;
  };

  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = steps.findIndex((_, i) => `step-${i}` === active.id);
    const newIndex = steps.findIndex((_, i) => `step-${i}` === over.id);
    if (oldIndex >= 0 && newIndex >= 0) moveStepDnD(oldIndex, newIndex);
  }, [steps, moveStepDnD]);

  // Memoize the step list so screenshot polling doesn't re-render it
  // (which would close Popovers and reset Select states)
  const stepListMemo = useMemo(() => (
    <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
    <SortableContext items={steps.map((_, i) => `step-${i}`)} strategy={verticalListSortingStrategy}>
    <div className="ant-list ant-list-sm">
      {steps.length === 0 && <div style={{ padding: 16, textAlign: 'center', color: '#888' }}>{t('record.noSteps')}</div>}
      {steps.map((s, index) => (
        <SortableStepItem key={`step-${index}`} id={`step-${index}`} index={index} isDark={isDark}>
          {/* 좌측: 스텝 정보 */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* 1행: 설명, 함수(인자), delay(우측정렬) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Tag color={s.type === 'wait' ? 'cyan' : 'blue'} style={{ margin: 0, minWidth: 28, textAlign: 'center', flexShrink: 0 }}>{index + 1}</Tag>
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
                    : s.type === 'all_random'
                    ? <><Tag color="magenta" style={{ margin: 0 }}>RAND</Tag> ×{s.params.repeat_count ?? 1} @{s.params.interval_ms ?? 0}ms (HK:{(s.params.hk_keys || []).length}{s.params.sk_region ? ' SK▣' : ''}{s.params.drag_region ? ' DRAG▣' : ''})</>
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
                  onFocus={(e) => (e.target as HTMLInputElement).select()}
                  suffix="ms"
                  style={{ width: 110, flexShrink: 0, marginLeft: 'auto' }}
                />
              )}
            </div>
            {/* 2행: 디바이스/타입/이미지/태그 (좌측 정렬) */}
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 2, flexWrap: 'wrap' }}>
              <span style={{ minWidth: 28, flexShrink: 0 }} />
              {getDeviceTag(s.device_id)}
              <Tag color={s.type === 'wait' ? 'cyan' : s.type === 'module_command' ? 'geekblue' : s.type.startsWith('hkmc_') ? 'volcano' : undefined}>{s.type === 'module_command' ? (s.params.module || 'module_command') : s.type}</Tag>
              {s.screen_type && <Tag color="geekblue" style={{ margin: 0 }}>{s.screen_type}</Tag>}
              {s.on_pass_goto != null && (
                <Tag color="green">P→{s.on_pass_goto === -1 ? 'END' : `#${s.on_pass_goto}`}</Tag>
              )}
              {s.on_fail_goto != null && (
                <Tag color="red">F→{s.on_fail_goto === -1 ? 'END' : `#${s.on_fail_goto}`}</Tag>
              )}
              {s.expected_image && scenarioName && (() => {
                const modeLabel = (s.expected_images?.length || 0) > 0 ? 'MULTI'
                  : (s.exclude_rois?.length || 0) > 0 ? 'EXCLUDE'
                  : s.roi ? 'CROP' : 'FULL';
                const threshPct = Math.round((s.similarity_threshold ?? 0.95) * 100);
                return (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 'auto', flexShrink: 0 }}>
                    <Tag
                      color="green"
                      style={{ margin: 0, cursor: 'pointer' }}
                      onClick={() => showAnnotatedPreview(s)}
                    >
                      <CameraOutlined style={{ marginRight: 4 }} />{modeLabel}
                    </Tag>
                    <Popover
                      trigger="click"
                      placement="bottom"
                      content={
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <InputNumber size="small" min={1} max={100} step={1}
                            value={threshPct}
                            onChange={(v) => { if (v != null) setSteps(prev => prev.map((st, i) => i === index ? { ...st, similarity_threshold: v / 100 } : st)); }}
                            suffix="%" style={{ width: 75 }}
                          />
                        </div>
                      }
                    >
                      <Tag style={{ margin: 0, cursor: 'pointer', fontSize: 11 }}>{threshPct}%</Tag>
                    </Popover>
                    <CloseCircleOutlined
                      onClick={async () => {
                        if (scenarioName) {
                          await ensureSavedForImageOp();
                          scenarioApi.removeExpectedImage(scenarioName, index).catch(() => {});
                        }
                        setSteps((prev) => prev.map((st, i) => i === index ? { ...st, expected_image: null, roi: null, exclude_rois: [], expected_images: [] } : st));
                      }}
                      style={{ fontSize: 14, color: '#ff4d4f', cursor: 'pointer' }}
                    />
                  </span>
                );
              })()}
            </div>
          </div>
          {/* 우측: 2행 아이콘 영역 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0, borderLeft: isDark ? '1px solid #333' : '1px solid #d9d9d9', paddingLeft: 8, alignSelf: 'stretch', justifyContent: 'center' }}>
            {/* 1행: 테스트 + 가져오기 + 삭제 (순서는 드래그로 변경) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, justifyContent: 'flex-end' }}>
              {scenarioName && (() => {
                const stepDev = allDevices.find(dd => dd.id === s.device_id);
                const devConnected = !stepDev || stepDev.status === 'device' || stepDev.status === 'connected';
                return (
                  <Button size="small" type="text" icon={<ThunderboltOutlined />} title={devConnected ? t('record.testStep') : t('record.deviceNotConnected')} loading={testingStepIndex === index} disabled={!devConnected} onClick={() => testStep(index)} style={{ color: devConnected ? '#faad14' : undefined, width: 28 }} />
                );
              })()}
              <Button size="small" type="text" icon={<PlusOutlined />} title={t('record.importSteps')} onClick={() => openImportStepModal(index, 'copy')} style={{ width: 28 }} />
              <Button size="small" type="text" title={t('record.moveSteps')} onClick={() => openImportStepModal(index, 'move')} style={{ width: 28, fontSize: 12, fontWeight: 600, color: '#faad14' }}>M</Button>
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
              <Popover
                open={waitPopoverIndex === index}
                onOpenChange={(v) => setWaitPopoverIndex(v ? index : null)}
                trigger="click"
                placement="bottomRight"
                content={renderWaitPopoverContent(index)}
              >
                <Button size="small" type="text" title={t('record.insertWait')} style={{ width: 28 }}>W</Button>
              </Popover>
              {scenarioName && (
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
        </SortableStepItem>
      ))}
    </div>
    </SortableContext>
    </DndContext>
  ), [steps, recording, updateStepJump, updateStepDescription, openEditStepModal, openRoiModal, screenshotDeviceId, scenarioName, saveExpectedFull, openCaptureModal, testStep, testingStepIndex, updateCompareMode, openExcludeRoiModal, openMultiCropModal, showAnnotatedPreview, selectCompareMode, compareModePopoverIndex, waitPopoverIndex, wMode, wDuration, wStart, wInterval, wMin, wMax, allDevices, t, dndSensors, handleDragEnd, openImportStepModal]);

  return (
    <div className="record-page" style={{ height: 'calc(100vh - 80px)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes hkGauge {
          0% { background-size: 0% 100%; }
          100% { background-size: 100% 100%; }
        }
        .hk-btn { position: relative; overflow: hidden; transition: color 0.15s, border-color 0.15s; }
        .hk-btn.pressing {
          background-image: linear-gradient(to right, #ff7875 0%, #ff4d4f 100%) !important;
          background-repeat: no-repeat !important;
          background-position: left center !important;
          background-size: 0% 100%;
          animation: hkGauge ${HKMC_LONG_PRESS_MS}ms linear forwards;
        }
        .hk-btn.pressing .ant-btn-icon,
        .hk-btn.pressing > span { position: relative; z-index: 1; }
        .hk-btn.long-done {
          background: #ff4d4f !important;
          border-color: #ff4d4f !important;
          color: #fff !important;
          animation: none;
        }
        .record-page .ant-tag { line-height: 22px; }
        .record-page .ant-input-sm,
        .record-page .ant-select-sm,
        .record-page .ant-select-sm .ant-select-selector,
        .record-page .ant-btn-sm,
        .record-page .ant-input-number-sm,
        .record-page .ant-input-number-sm .ant-input-number-input-wrap,
        .record-page .ant-input-number-sm .ant-input-number-input { height: 24px !important; min-height: 24px !important; }
        .record-page .ant-input-number-sm .ant-input-number-handler-wrap { display: none; }
      `}</style>
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
              connectedPrimaryDevices.length > 0 && (
                <Space size={4} wrap style={{ justifyContent: 'flex-end' }}>
                  <Select
                    value={screenshotDeviceId || undefined}
                    onChange={(id) => setScreenshotDeviceId(id)}
                    placeholder={t('record.primaryDevice')}
                    size="small"
                    style={{ minWidth: 140, maxWidth: 280 }}
                  >
                    {connectedPrimaryDevices.map(d => (
                      <Option key={d.id} value={d.id}>{d.name || d.id}</Option>
                    ))}
                  </Select>
                  {screenDevice && (
                    <Tag color={screenAlive ? 'green' : 'red'} style={{ marginLeft: 0 }}>
                      {screenAlive
                        ? `JPEG ${streamFps}fps`
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
                      {!isScreenCCRC && <Option value="front_center">{t('record.hkmcFront')}</Option>}
                      <Option value="rear_left">{t('record.hkmcRearL')}</Option>
                      <Option value="rear_right">{t('record.hkmcRearR')}</Option>
                      {!isScreenCCRC && <Option value="cluster">{t('record.hkmcCluster')}</Option>}
                      {screenDevice?.type === 'isap_agent' && <Option value="hud">HUD</Option>}
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
                  <Tooltip title={t('record.viewCrop')}>
                    <Button
                      size="small"
                      type={viewCropEnabled ? 'primary' : 'default'}
                      icon={<ScissorOutlined />}
                      onClick={() => {
                        setViewCropEnabled(v => !v);
                        if (viewCropEnabled) { setViewCropX([0, 1]); setViewCropY([0, 1]); }
                      }}
                    />
                  </Tooltip>
                  {screenDevice?.type === 'webcam' ? (
                    <Tooltip title={t('record.webcamSettings')}>
                      <Button
                        size="small"
                        icon={<SettingOutlined />}
                        onClick={() => openWebcamExposureModal()}
                      />
                    </Tooltip>
                  ) : (
                    <Tooltip title={t('record.repeatTap')}>
                      <Button
                        size="small"
                        type={repeatTapMode ? 'primary' : 'default'}
                        onClick={() => setRepeatTapMode(v => !v)}
                        style={{ fontWeight: repeatTapMode ? 700 : 400 }}
                      >
                        {t('record.repeatTapShort')}
                      </Button>
                    </Tooltip>
                  )}
                  {isScreenAdb && <>
                  <Tooltip title={t('record.multiTouch')}>
                    <Radio.Group
                      size="small"
                      value={fingerCount}
                      onChange={(e) => { setFingerCount(e.target.value); setGestureMode('normal'); }}
                      optionType="button"
                      buttonStyle="solid"
                      options={[
                        { label: '1', value: 1 },
                        { label: '2', value: 2 },
                        { label: '3', value: 3 },
                      ]}
                    />
                  </Tooltip>
                  {/* 줌인/아웃 버튼 — 임시 비활성 */}
                  {fingerCount > 1 && (
                    <Tooltip title={t('record.fingerSpread')}>
                      <InputNumber
                        size="small"
                        min={20} max={500} step={10}
                        value={fingerSpread}
                        onChange={(v) => setFingerSpread(v ?? 100)}
                        style={{ width: 70 }}
                        suffix="px"
                      />
                    </Tooltip>
                  )}
                  </>}
                </Space>
              )
            }
            style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}
            styles={{
              header: { flexWrap: 'wrap', height: 'auto', minHeight: 40, padding: '4px 12px' },
              body: { flex: 1, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', alignItems: 'center' },
            }}
          >
            {screenshotDeviceId && screenshot ? (
              <>
              <div style={{
                position: 'relative', display: 'inline-block', maxWidth: '100%',
                maxHeight: (viewCropEnabled || (isScreenHkmc && hkmcKeys.length > 0)) ? 'calc(100% - 120px)' : '100%',
              }}>
                {(() => {
                  // 뷰포트 크롭
                  // - 캔버스(JPEG): drawImage에서 크롭 영역만 그림 → CSS 불필요
                  // - 비디오(H264): object-view-box로 크롭 (브라우저 네이티브, 왜곡 없음)
                  const vc = viewCropEnabled;
                  const cx0 = viewCropX[0], cy0 = viewCropY[0];
                  const cx1 = viewCropX[1], cy1 = viewCropY[1];
                  const baseStyle: React.CSSProperties = {
                    maxWidth: '100%',
                    maxHeight: '100%',
                    border: isDark ? '1px solid #333' : '1px solid #d9d9d9',
                    borderRadius: 4,
                    cursor: testingStepIndex != null ? 'wait' : (isScreenReadonly ? 'not-allowed' : 'crosshair'),
                    userSelect: 'none' as const,
                  };
                  const interactive = testingStepIndex == null && !isScreenReadonly;
                  return (
                    <canvas
                      ref={canvasRef}
                      onMouseDown={interactive ? handleMouseDown : undefined}
                      onMouseMove={interactive ? handleMouseMove : undefined}
                      onMouseUp={interactive ? handleMouseUp : undefined}
                      style={baseStyle}
                    />
                  );
                })()}
                {testingStepIndex != null && (
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)', borderRadius: 4, pointerEvents: 'none' }}>
                    <Tag color="processing" style={{ fontSize: 14, padding: '4px 12px' }}>{t('record.stepTesting')}</Tag>
                  </div>
                )}
                </div>
                {viewCropEnabled && (
                  <div style={{ width: '100%', padding: '4px 0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: subTextColor }}>
                      <span style={{ minWidth: 16 }}>X</span>
                      <Slider
                        range
                        min={0} max={1} step={0.01}
                        value={viewCropX}
                        onChange={(v) => setViewCropX(v as [number, number])}
                        style={{ flex: 1 }}
                        tooltip={{ formatter: (v) => `${Math.round((v ?? 0) * 100)}%` }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: subTextColor }}>
                      <span style={{ minWidth: 16 }}>Y</span>
                      <Slider
                        range
                        min={0} max={1} step={0.01}
                        value={viewCropY}
                        onChange={(v) => setViewCropY(v as [number, number])}
                        style={{ flex: 1 }}
                        tooltip={{ formatter: (v) => `${Math.round((v ?? 0) * 100)}%` }}
                      />
                    </div>
                    <div style={{ fontSize: 10, color: subTextColor, textAlign: 'center' }}>
                      {t('record.viewCropRange', {
                        x1: String(Math.round(viewCropX[0] * deviceRes.width)),
                        x2: String(Math.round(viewCropX[1] * deviceRes.width)),
                        y1: String(Math.round(viewCropY[0] * deviceRes.height)),
                        y2: String(Math.round(viewCropY[1] * deviceRes.height)),
                      })}
                    </div>
                  </div>
                )}
                <div style={{ marginTop: 4, color: subTextColor, fontSize: 11 }}>
                  {lastGesture
                    ? `${lastGesture} → ${recording ? t('record.gestureRecord') : t('record.directExec')}`
                    : t('record.gestureHint', { device: screenDevice?.name || screenshotDeviceId || '' })}
                </div>
                {isScreenHkmc && hkmcKeys.length > 0 && testingStepIndex == null && (() => {
                  // visible=false 키는 숨김. 그룹별로 details로 묶어 표시.
                  // 그룹 순서: HKMC + iSAP 통합 순서
                  const GROUP_ORDER = ['MKBD', 'MKBD2', 'CCP', 'RRC', 'SWRC', 'SWRC2', 'MIRROR', 'CCRC', 'OVERHEAD', 'TRIP', 'GRIP', 'OPTICAL', 'RHEOSTAT'];
                  const visibleKeys = hkmcKeys.filter(k => k.visible !== false);
                  const byGroup: Record<string, HkmcKeyInfo[]> = {};
                  visibleKeys.forEach(k => {
                    const g = k.group || 'OTHER';
                    if (!byGroup[g]) byGroup[g] = [];
                    byGroup[g].push(k);
                  });
                  const groups = [
                    ...GROUP_ORDER.filter(g => byGroup[g]),
                    ...Object.keys(byGroup).filter(g => !GROUP_ORDER.includes(g)).sort(),
                  ];
                  const devType = screenDevice?.type;
                  const isIsap = devType === 'isap_agent';
                  const isHkmc = devType === 'hkmc6th';
                  const canConfigKeys = isIsap || isHkmc;
                  return (
                    <div style={{ marginTop: 4, width: '100%' }}>
                      {groups.map((group) => {
                        const keys = byGroup[group];
                        if (!keys || keys.length === 0) return null;
                        return (
                          <details key={group} style={{ marginBottom: 2 }}>
                            <summary style={{ fontSize: 11, color: subTextColor, cursor: 'pointer', userSelect: 'none' }}>{group} <span style={{ color: '#888' }}>({keys.length})</span></summary>
                            <div style={{ padding: '2px 0 2px 4px' }}>
                              {keys.map(k => (
                                <Button key={k.name} size="small"
                                  className="hk-btn"
                                  style={{ fontSize: 10, padding: '0 6px', height: 22, margin: '0 2px 2px 0' }}
                                  onMouseDown={(e) => {
                                    // 이전 잔여 타이머가 있으면 먼저 정리 (빠른 재클릭 방어)
                                    const prev = hkTimerRef.current.get(k.name);
                                    if (prev) clearTimeout(prev.timer);
                                    const btn = e.currentTarget;
                                    btn.classList.remove('long-done');
                                    btn.classList.add('pressing');
                                    const timer = window.setTimeout(() => { btn.classList.add('long-done'); }, HKMC_LONG_PRESS_MS);
                                    hkTimerRef.current.set(k.name, { downTs: Date.now(), timer });
                                  }}
                                  onMouseUp={(e) => {
                                    const entry = hkTimerRef.current.get(k.name);
                                    if (entry) {
                                      clearTimeout(entry.timer);
                                      const held = Date.now() - entry.downTs;
                                      const isLong = held >= HKMC_LONG_PRESS_MS;
                                      const sub = isLong ? HKMC_LONG_KEY : HKMC_SHORT_KEY;
                                      const label = k.name + (isLong ? ' (Long)' : '');
                                      executeAction('hkmc_key', { key_name: k.name, sub_cmd: sub, screen_type: screenType }, label);
                                    }
                                    hkTimerRef.current.delete(k.name);
                                    e.currentTarget.classList.remove('pressing', 'long-done');
                                  }}
                                  onMouseLeave={(e) => {
                                    const entry = hkTimerRef.current.get(k.name);
                                    if (entry) clearTimeout(entry.timer);
                                    hkTimerRef.current.delete(k.name);
                                    e.currentTarget.classList.remove('pressing', 'long-done');
                                  }}
                                  onContextMenu={(e) => {
                                    // 우클릭 시에도 타이머 정리 (우클릭 메뉴 열리면 mouseup 안 옴)
                                    e.preventDefault();
                                    const entry = hkTimerRef.current.get(k.name);
                                    if (entry) clearTimeout(entry.timer);
                                    hkTimerRef.current.delete(k.name);
                                    e.currentTarget.classList.remove('pressing', 'long-done');
                                  }}
                                >{k.name.replace(`${group}_`, '')}</Button>
                              ))}
                            </div>
                          </details>
                        );
                      })}
                      {canConfigKeys && (
                        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
                          <span style={{ fontSize: 11, color: subTextColor, marginRight: 2 }}>Random:</span>
                          {/* 반복 횟수 */}
                          <InputNumber
                            size="small"
                            min={1} max={100000}
                            value={randRepeatCount}
                            onChange={(v) => setRandRepeatCount(Math.max(1, Math.floor(v || 1)))}
                            style={{ width: 70, fontSize: 10 }}
                            title="반복 횟수"
                            disabled={randRunning}
                          />
                          {/* 간격 (ms) */}
                          <InputNumber
                            size="small"
                            min={0} max={60000} step={50}
                            value={randIntervalMs}
                            onChange={(v) => setRandIntervalMs(Math.max(0, Math.floor(v || 0)))}
                            style={{ width: 70, fontSize: 10 }}
                            title="간격 (ms)"
                            disabled={randRunning}
                            suffix="ms"
                          />
                          {/* HK */}
                          <Button.Group style={{ marginLeft: 2 }}>
                            <Button size="small" danger disabled={randRunning} style={{ fontSize: 10, padding: '0 6px', height: 22 }}
                              onClick={() => runRandomRepeat(randHK)}>
                              HK{randHkKeysConfig && randHkKeysConfig.length > 0 ? ` (${randHkKeysConfig.length})` : ''}
                            </Button>
                            <Button size="small" icon={<SettingOutlined />} disabled={randRunning} style={{ fontSize: 10, padding: '0 4px', height: 22 }}
                              onClick={() => setRandHkModalOpen(true)} title="HK 설정" />
                          </Button.Group>
                          {/* SK */}
                          <Button.Group style={{ marginLeft: 2 }}>
                            <Button size="small" danger disabled={randRunning} style={{ fontSize: 10, padding: '0 6px', height: 22 }}
                              onClick={() => runRandomRepeat(randSK)}>
                              SK{randSkRegion ? ' ▣' : ''}
                            </Button>
                            <Button size="small" icon={<SettingOutlined />} disabled={randRunning} style={{ fontSize: 10, padding: '0 4px', height: 22 }}
                              onClick={() => openRandRegionModal('sk')} title="SK 영역 설정" />
                          </Button.Group>
                          {/* DRAG */}
                          <Button.Group style={{ marginLeft: 2 }}>
                            <Button size="small" danger disabled={randRunning} style={{ fontSize: 10, padding: '0 6px', height: 22 }}
                              onClick={() => runRandomRepeat(randDrag)}>
                              DRAG{randDragRegion ? ' ▣' : ''}
                            </Button>
                            <Button size="small" icon={<SettingOutlined />} disabled={randRunning} style={{ fontSize: 10, padding: '0 4px', height: 22 }}
                              onClick={() => openRandRegionModal('drag')} title="DRAG 영역 설정" />
                          </Button.Group>
                          <Button size="small" type="primary" danger disabled={randRunning} style={{ fontSize: 10, padding: '0 8px', height: 22, marginLeft: 4 }}
                            onClick={() => allRandHandler()}>ALL RAND</Button>
                          {/* 진행 상태 / 중지 */}
                          {randRunning && (
                            <>
                              <span style={{ fontSize: 10, color: '#faad14', marginLeft: 6 }}>
                                {randProgress.current}/{randProgress.total}
                              </span>
                              <Button size="small" danger type="primary" icon={<StopOutlined />}
                                style={{ fontSize: 10, padding: '0 6px', height: 22, marginLeft: 2 }}
                                onClick={stopRandRepeat}>중지</Button>
                            </>
                          )}
                          <span style={{ flex: 1 }} />
                          <Button size="small" icon={<SettingOutlined />} style={{ fontSize: 10, height: 22 }}
                            onClick={() => { setIsapKeysDraft(hkmcKeys.map(k => ({ ...k }))); setIsapKeysModalOpen(true); }}>
                            키 설정
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </>
            ) : (
              <div style={{ color: mutedTextColor, textAlign: 'center', padding: 24 }}>
                {connectedPrimaryDevices.length === 0
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
              <Input size="small" value={scenarioName} disabled style={{ flex: 1, minWidth: 100 }} />
              <Input size="small" placeholder={t('record.descriptionPlaceholder')} value={description} onChange={(e) => setDescription(e.target.value)} style={{ flex: 2, minWidth: 120 }} />
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                <Tag color="red" style={{ margin: 0, lineHeight: '22px' }}>{t('record.recording')}</Tag>
                <Button size="small" danger icon={<PauseOutlined />} onClick={stopRecording} disabled={hasPendingSteps}>
                  {hasPendingSteps ? t('record.savingSteps') : t('record.stopRecording')}
                </Button>
              </span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {recording && (
            <Card
              size="small"
              title={t('record.manualStep')}
              extra={
                <Button
                  size="small"
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={addManualStep}
                  disabled={!selectedDeviceId || !selectedModuleFunc}
                >
                  {t('record.addStep')}
                </Button>
              }
              style={{ flex: 1, minWidth: 0 }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {/* 1행: 모듈 선택 (매칭된 디바이스별 항목) */}
                <Select
                  showSearch
                  value={selectedDeviceId || undefined}
                  onChange={setSelectedDeviceId}
                  placeholder={t('record.selectModule')}
                  size="small"
                  style={{ width: '100%' }}
                  optionFilterProp="label"
                  notFoundContent={t('record.noMatchedDevice')}
                  options={moduleDevices.map(d => ({
                    value: d.id,
                    label: `${d.info?.module} ${d.name || d.id}`,
                    _device: d,
                  }))}
                  optionRender={(opt) => {
                    const dev = (opt.data as any)._device;
                    const moduleName = dev?.info?.module || '';
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Tag color="purple" style={{ margin: 0 }}>{moduleName}</Tag>
                        <span style={{ fontSize: 12, color: isDark ? '#8bb4e0' : '#1677ff' }}>
                          → {dev?.name || dev?.address || dev?.id}
                        </span>
                      </span>
                    );
                  }}
                />
                {/* 2행: 함수 선택 + 파라미터 입력 */}
                {selectedModuleName && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {moduleDescription && (
                      <div style={{ padding: '4px 8px', background: isDark ? '#1a2a1a' : '#f6ffed', borderRadius: 4, fontSize: 12, color: isDark ? '#8bc48b' : '#52c41a', lineHeight: 1.5, border: `1px solid ${isDark ? '#1a3a1a' : '#d9f7be'}` }}>
                        {moduleDescription}
                      </div>
                    )}
                    <Select
                      showSearch
                      placeholder={t('record.selectFunction')}
                      value={selectedModuleFunc || undefined}
                      onChange={(v) => {
                        setSelectedModuleFunc(v);
                        const fn = moduleFunctions.find(f => f.name === v);
                        if (fn) {
                          const defaults: Record<string, string> = {};
                          fn.params.forEach(p => { if (p.default !== undefined) defaults[p.name] = p.default.replace(/^'(.*)'$/, '$1'); });
                          setModuleFuncArgs(defaults);
                        } else {
                          setModuleFuncArgs({});
                        }
                      }}
                      size="small"
                      style={{ width: '100%' }}
                      options={moduleFunctions.map(f => ({
                        label: `${f.name}(${f.params.map(p => p.required ? p.name : p.name + '?').join(', ')})`,
                        value: f.name,
                      }))}
                    />
                    {selectedModuleFunc && (() => {
                      const fn = moduleFunctions.find(f => f.name === selectedModuleFunc);
                      if (!fn) return null;
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {fn.description && (
                            <div style={{ padding: '4px 8px', background: isDark ? '#1a2332' : '#f0f7ff', borderRadius: 4, fontSize: 12, color: isDark ? '#8bb4e0' : '#1677ff', lineHeight: 1.5, border: `1px solid ${isDark ? '#1a3a5c' : '#d6e8fc'}` }}>
                              {fn.description}
                            </div>
                          )}
                          {fn.params.length > 0 && fn.params.map(p => (
                            <div key={p.name} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <Space size={4} style={{ width: '100%' }}>
                                <Tag style={{ minWidth: 70, textAlign: 'center', margin: 0 }}>{p.name}{p.required && <span style={{ color: '#ff4d4f' }}>*</span>}</Tag>
                                <Input
                                  size="small"
                                  placeholder={p.required ? t('common.required') : `${t('common.default')}: ${p.default}`}
                                  value={moduleFuncArgs[p.name] ?? ''}
                                  onChange={(e) => setModuleFuncArgs(prev => ({ ...prev, [p.name]: e.target.value }))}
                                  style={{ flex: 1 }}
                                />
                              </Space>
                              {p.description && (
                                <div style={{ marginLeft: 78, fontSize: 11, color: isDark ? '#888' : '#999', lineHeight: 1.4 }}>
                                  {p.description}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                    {selectedModuleName === 'DLTViewer' && selectedModuleFunc === 'WaitLog' && (
                      <label style={{ fontSize: 12, color: subTextColor }}>
                        <input type="checkbox" checked={dltBackground} onChange={(e) => setDltBackground(e.target.checked)} />
                        {' '}{t('dlt.backgroundMonitor')}
                      </label>
                    )}
                  </div>
                )}
              </div>
            </Card>
            )}
            {!recording && (
            <Card size="small" title={t('record.control')} style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Row 1: 폴더 콤보 + 시나리오 콤보 + 관리 버튼 */}
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Select
                    size="small"
                    value={recordSelectedFolder}
                    onChange={setRecordSelectedFolder}
                    style={{ width: 100 }}
                    onOpenChange={(open) => { if (open) fetchSavedScenarios(); }}
                  >
                    <Option value="__all__">{t('scenario.allScenarios')}</Option>
                    {Object.keys(recordFolders).map(fn => (
                      <Option key={fn} value={fn}>{fn}</Option>
                    ))}
                  </Select>
                  <Select
                    size="small"
                    placeholder={t('record.loadScenario')}
                    style={{ flex: 1, minWidth: 140 }}
                    onChange={loadScenario}
                    value={scenarioName || undefined}
                    showSearch
                    onOpenChange={(open) => { if (open) fetchSavedScenarios(); }}
                  >
                    {filteredSavedScenarios.map(n => (
                      <Option key={n} value={n}>{n}</Option>
                    ))}
                  </Select>
                  {scenarioName && (
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
                    size="small"
                    placeholder={t('record.descriptionPlaceholder')}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    style={{ flex: 1, minWidth: 120 }}
                  />
                  <Tag color={editingExisting ? 'blue' : 'default'} style={{ margin: 0 }}>
                    {editingExisting ? t('record.editing') : t('record.waiting')}
                  </Tag>
                  <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={startRecording}>
                    {editingExisting ? t('record.resumeRecording') : t('record.startRecording')}
                  </Button>
                  {(steps.length > 0 || isDirty()) && (
                    <Button size="small" icon={<SaveOutlined />} onClick={saveScenario} type={isDirty() ? 'primary' : 'default'} danger={isDirty()}>
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
                <Popover
                  open={deviceSwapOpen}
                  onOpenChange={(v) => { if (v) openDeviceSwapPopover(); else setDeviceSwapOpen(false); }}
                  trigger="click"
                  placement="bottomRight"
                  content={renderDeviceSwapContent()}
                >
                  <Button size="small" icon={<SwapOutlined />} disabled={steps.length === 0}>{t('record.deviceSwap')}</Button>
                </Popover>
                <Popover
                  open={waitPopoverIndex === 'end'}
                  onOpenChange={(v) => setWaitPopoverIndex(v ? 'end' : null)}
                  trigger="click"
                  placement="bottomRight"
                  content={renderWaitPopoverContent()}
                >
                  <Button size="small" icon={<PlusOutlined />}>{t('record.addWait')}</Button>
                </Popover>
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
            const editFnGuide = moduleFunctions.find(f => f.name === editStepParams.function);
            return (
              <div>
                <div style={{ marginBottom: 8, fontWeight: 600 }}>{editStepParams.module}::{editStepParams.function}()</div>
                {editFnGuide?.description && (
                  <div style={{ padding: '4px 8px', marginBottom: 8, background: isDark ? '#1a2332' : '#f0f7ff', borderRadius: 4, fontSize: 12, color: isDark ? '#8bb4e0' : '#1677ff', lineHeight: 1.5, border: `1px solid ${isDark ? '#1a3a5c' : '#d6e8fc'}` }}>
                    {editFnGuide.description}
                  </div>
                )}
                {Object.keys(args).length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {Object.entries(args).map(([k, v]) => {
                      const paramGuide = editFnGuide?.params.find(p => p.name === k);
                      return (
                        <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <Space size={4} style={{ width: '100%' }}>
                            <Tag style={{ minWidth: 70, textAlign: 'center', margin: 0 }}>{k}</Tag>
                            <Input
                              size="small"
                              value={String(v ?? '')}
                              onChange={(e) => setEditStepParams({ ...editStepParams, args: { ...args, [k]: e.target.value } })}
                              style={{ flex: 1 }}
                            />
                          </Space>
                          {paramGuide?.description && (
                            <div style={{ marginLeft: 78, fontSize: 11, color: isDark ? '#888' : '#999', lineHeight: 1.4 }}>
                              {paramGuide.description}
                            </div>
                          )}
                        </div>
                      );
                    })}
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

      {/* 스텝 복사/이동 모달 */}
      <Modal
        title={importMode === 'move' ? t('record.moveSteps') : t('record.importSteps')}
        open={importStepModalOpen}
        onCancel={() => setImportStepModalOpen(false)}
        onOk={executeImportSteps}
        okText={`${importMode === 'move' ? t('record.moveSteps') : t('record.importSteps')} (${importChecked.size})`}
        okButtonProps={{ disabled: importChecked.size === 0, loading: importLoading }}
        width={600}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {importMode !== 'move' && (
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>{t('record.importSource')}</div>
              <Select
                style={{ width: '100%' }}
                value={importSourceName || undefined}
                onChange={loadImportSource}
              >
                <Option value="__current__">{t('record.currentScenario')}</Option>
                {savedScenarios.filter(n => n !== scenarioName).map(n => (
                  <Option key={n} value={n}>{n}</Option>
                ))}
              </Select>
            </div>
          )}
          <div style={{ fontSize: 12, color: '#888' }}>
            {t('record.importInsertAt', { index: importInsertIndex + 1 })}
            {' · '}{t('record.importSelectHint')}
          </div>
          <div style={{ maxHeight: 400, overflow: 'auto', border: '1px solid #303030', borderRadius: 4 }}>
            {importSourceSteps.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', color: '#888' }}>{t('record.noSteps')}</div>
            ) : importSourceSteps.map((s, i) => (
              <div
                key={i}
                onClick={() => setImportChecked(prev => {
                  const next = new Set(prev);
                  next.has(i) ? next.delete(i) : next.add(i);
                  return next;
                })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer',
                  background: importChecked.has(i) ? 'rgba(22,119,255,0.15)' : (i % 2 ? 'rgba(255,255,255,0.02)' : undefined),
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                <input type="checkbox" checked={importChecked.has(i)} readOnly style={{ flexShrink: 0 }} />
                <Tag style={{ margin: 0, minWidth: 28, textAlign: 'center' }}>{i + 1}</Tag>
                <span style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <Tag color="blue" style={{ margin: 0, marginRight: 4 }}>{s.type}</Tag>
                  {s.description || JSON.stringify(s.params).slice(0, 60)}
                </span>
                {s.expected_image && <CameraOutlined style={{ color: '#52c41a', flexShrink: 0 }} />}
              </div>
            ))}
          </div>
        </Space>
      </Modal>

      {/* 연속터치 모달 */}
      <Modal
        title={`${t('record.repeatTap')} (${repeatTapCoordsRef.current.x}, ${repeatTapCoordsRef.current.y})`}
        open={repeatTapModalOpen}
        onCancel={() => { setRepeatTapModalOpen(false); setRepeatTapMode(false); }}
        onOk={executeRepeatTap}
        okText={t('common.execute')}
        width={360}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 12 }} size={12}>
          <div>
            <div style={{ marginBottom: 4, fontSize: 13 }}>{t('record.repeatTapCount')}</div>
            <InputNumber min={2} max={200} value={repeatTapCount} onChange={v => setRepeatTapCount(v ?? 5)} style={{ width: '100%' }} />
          </div>
          <div>
            <div style={{ marginBottom: 4, fontSize: 13 }}>{t('record.repeatTapInterval')}</div>
            <InputNumber min={10} max={5000} step={10} value={repeatTapInterval} onChange={v => setRepeatTapInterval(v ?? 100)} style={{ width: '100%' }} addonAfter="ms" />
          </div>
        </Space>
      </Modal>

      {/* 웹캠 설정(노출) 모달 */}
      <Modal
        title={t('record.webcamSettings')}
        open={webcamExposureOpen}
        onCancel={() => setWebcamExposureOpen(false)}
        footer={null}
        width={420}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 12 }} size={16}>
          {!webcamExposureInfo.supported ? (
            <div style={{ color: '#888', textAlign: 'center', padding: 16 }}>
              {t('record.webcamExposureUnsupported')}
            </div>
          ) : (
            <>
              <div>
                <div style={{ marginBottom: 8, fontSize: 13 }}>{t('record.webcamExposureMode')}</div>
                <Radio.Group
                  value={webcamExposureInfo.auto ? 'auto' : 'manual'}
                  onChange={async (e) => {
                    if (!screenshotDeviceId) return;
                    setWebcamExposureLoading(true);
                    try {
                      if (e.target.value === 'auto') {
                        const res = await deviceApi.setWebcamExposure(screenshotDeviceId, undefined, true);
                        setWebcamExposureInfo(res.data);
                      } else {
                        const res = await deviceApi.setWebcamExposure(screenshotDeviceId, webcamExposureInfo.value ?? -6, false);
                        setWebcamExposureInfo(res.data);
                      }
                    } catch (err: any) {
                      message.error(err?.response?.data?.detail || t('record.webcamExposureFailed'));
                    }
                    setWebcamExposureLoading(false);
                  }}
                  optionType="button"
                  buttonStyle="solid"
                  disabled={webcamExposureLoading}
                >
                  <Radio.Button value="auto">{t('record.webcamExposureAuto')}</Radio.Button>
                  <Radio.Button value="manual">{t('record.webcamExposureManual')}</Radio.Button>
                </Radio.Group>
              </div>
              <div>
                <div style={{ marginBottom: 8, fontSize: 13 }}>
                  {t('record.webcamExposureValue')}: <strong>{webcamExposureInfo.value?.toFixed(1) ?? '-'}</strong>
                </div>
                <Slider
                  min={webcamExposureInfo.min ?? -13}
                  max={webcamExposureInfo.max ?? 0}
                  step={webcamExposureInfo.step ?? 1}
                  value={webcamExposureInfo.value ?? -6}
                  disabled={webcamExposureInfo.auto || webcamExposureLoading}
                  onChange={(v) => setWebcamExposureInfo({ ...webcamExposureInfo, value: v })}
                  onChangeComplete={async (v) => {
                    if (!screenshotDeviceId) return;
                    setWebcamExposureLoading(true);
                    try {
                      const res = await deviceApi.setWebcamExposure(screenshotDeviceId, v, false);
                      setWebcamExposureInfo(res.data);
                    } catch (err: any) {
                      message.error(err?.response?.data?.detail || t('record.webcamExposureFailed'));
                    }
                    setWebcamExposureLoading(false);
                  }}
                />
                <div style={{ fontSize: 11, color: '#888' }}>
                  {t('record.webcamExposureHint')}
                </div>
              </div>
            </>
          )}
        </Space>
      </Modal>

      {/* Step test result modal */}
      <Modal
        title={t('record.stepTestResult')}
        open={testResultModalOpen}
        onCancel={() => { stopActiveBgPoll(); setTestResultModalOpen(false); setTestResult(null); scenarioApi.cleanTestScreenshots(scenarioName).catch(() => {}); }}
        width={800}
        footer={<Button onClick={() => { stopActiveBgPoll(); setTestResultModalOpen(false); setTestResult(null); scenarioApi.cleanTestScreenshots(scenarioName).catch(() => {}); }}>{t('common.close')}</Button>}
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
            {testResult.message && (
              <div style={{
                marginBottom: 12, padding: '8px 10px', borderRadius: 4, fontSize: 13, fontFamily: 'monospace',
                background: testResult.status === 'fail' ? '#2a1215' : '#122010',
                border: `1px solid ${testResult.status === 'fail' ? '#5c2024' : '#274916'}`,
                color: testResult.status === 'fail' ? '#ff7875' : '#95de64',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}>{testResult.message}</div>
            )}
            <Row gutter={12}>
              {testResult.expected_image && (
                <Col span={testResult.actual_image ? 12 : 24}>
                  <div style={{ textAlign: 'center', fontSize: 12, marginBottom: 4, fontWeight: 600 }}>{t('record.expectedImageLabel')}</div>
                  {(() => {
                    const imgSrc = `/screenshots/${testResult.expected_annotated_image || testResult.expected_image}?t=${testResult._ts || ''}`;
                    // key=imgSrc: antd Image 컴포넌트가 preview src를 내부 캐싱하므로 src 변경 시 강제 리마운트
                    return <Image key={imgSrc} src={imgSrc} preview={{ src: imgSrc }} style={{ width: '100%', borderRadius: 4, border: isDark ? '1px solid #333' : '1px solid #d9d9d9' }} />;
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
                    // key=imgSrc: antd Image 컴포넌트가 preview src를 내부 캐싱하므로 src 변경 시 강제 리마운트
                    return <Image key={imgSrc} src={imgSrc} preview={{ src: imgSrc }} style={{ width: '100%', borderRadius: 4, border: isDark ? '1px solid #333' : '1px solid #d9d9d9' }} />;
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
      {/* 하드키 설정 모달 — HKMC/iSAP 디바이스별 키 값/표시 여부 관리 */}
      <Modal
        title={`키 설정${screenshotDeviceId ? ` — ${screenshotDeviceId}` : ''}`}
        open={isapKeysModalOpen}
        onCancel={() => setIsapKeysModalOpen(false)}
        width={720}
        confirmLoading={isapKeysSaving}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        onOk={async () => {
          if (!screenshotDeviceId) return;
          const devType = screenDevice?.type;
          setIsapKeysSaving(true);
          try {
            // full dict: 모든 키에 대해 cmd/key/visible 전송 (dial은 spec default 유지)
            const payload: Record<string, { cmd: number; key: number; visible: boolean }> = {};
            for (const k of isapKeysDraft) {
              payload[k.name] = {
                cmd: typeof k.cmd === 'number' ? k.cmd : 0,
                key: typeof k.key === 'number' ? k.key : 0,
                visible: k.visible !== false,
              };
            }
            if (devType === 'isap_agent') {
              await deviceApi.updateIsapKeys(screenshotDeviceId, payload);
              const r = await deviceApi.listIsapKeys(screenshotDeviceId);
              setHkmcKeys(r.data.keys || []);
            } else if (devType === 'hkmc6th') {
              await deviceApi.updateHkmcKeys(screenshotDeviceId, payload);
              const r = await deviceApi.listHkmcKeys(screenshotDeviceId);
              setHkmcKeys(r.data.keys || []);
            } else {
              throw new Error('Unsupported device type for key config');
            }
            message.success('저장됨');
            setIsapKeysModalOpen(false);
          } catch (e: any) {
            message.error(e.response?.data?.detail || '저장 실패');
          } finally {
            setIsapKeysSaving(false);
          }
        }}
      >
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <div style={{ fontSize: 11, color: subTextColor, marginBottom: 8 }}>
            체크박스로 표시할 키를 선택하고, 필요 시 key 값을 차종에 맞게 수정하세요. (cmd는 전문 지식 필요 시에만 변경)
          </div>
          {(() => {
            const GROUP_ORDER = ['MKBD', 'MKBD2', 'CCP', 'RRC', 'SWRC', 'SWRC2', 'MIRROR', 'CCRC', 'OVERHEAD', 'TRIP', 'GRIP', 'OPTICAL', 'RHEOSTAT'];
            const byGroup: Record<string, { k: HkmcKeyInfo; idx: number }[]> = {};
            isapKeysDraft.forEach((k, idx) => {
              const g = k.group || 'OTHER';
              if (!byGroup[g]) byGroup[g] = [];
              byGroup[g].push({ k, idx });
            });
            const groups = [
              ...GROUP_ORDER.filter(g => byGroup[g]),
              ...Object.keys(byGroup).filter(g => !GROUP_ORDER.includes(g)).sort(),
            ];
            return groups.map(group => {
              const items = byGroup[group];
              const allVisible = items.every(({ k }) => k.visible !== false);
              return (
                <details key={group} open style={{ marginBottom: 8, border: '1px solid #2a2a2a', borderRadius: 4, padding: 6 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                    {group} <span style={{ color: '#888', fontSize: 11 }}>({items.length})</span>
                    <Button size="small" type="link" style={{ fontSize: 10, padding: '0 4px' }}
                      onClick={(e) => {
                        e.preventDefault();
                        setIsapKeysDraft(prev => prev.map((x, i) =>
                          items.find(it => it.idx === i) ? { ...x, visible: !allVisible } : x));
                      }}>{allVisible ? '전체 해제' : '전체 선택'}</Button>
                  </summary>
                  <table style={{ width: '100%', fontSize: 11, marginTop: 4 }}>
                    <thead>
                      <tr style={{ color: '#888', textAlign: 'left' }}>
                        <th style={{ width: 40 }}>표시</th>
                        <th>이름</th>
                        <th style={{ width: 70 }}>cmd</th>
                        <th style={{ width: 70 }}>key</th>
                        <th style={{ width: 50 }}>dial</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map(({ k, idx }) => (
                        <tr key={k.name}>
                          <td>
                            <input type="checkbox" checked={k.visible !== false}
                              onChange={(e) => {
                                const v = e.target.checked;
                                setIsapKeysDraft(prev => prev.map((x, i) => i === idx ? { ...x, visible: v } : x));
                              }} />
                          </td>
                          <td style={{ fontFamily: 'monospace' }}>{k.name}</td>
                          <td>
                            <Input size="small" style={{ width: 60, fontFamily: 'monospace' }}
                              value={`0x${(k.cmd ?? 0).toString(16).toUpperCase().padStart(2, '0')}`}
                              onChange={(e) => {
                                const v = e.target.value.trim();
                                const n = v.startsWith('0x') || v.startsWith('0X') ? parseInt(v, 16) : parseInt(v);
                                if (!isNaN(n)) {
                                  setIsapKeysDraft(prev => prev.map((x, i) => i === idx ? { ...x, cmd: n } : x));
                                }
                              }} />
                          </td>
                          <td>
                            <Input size="small" style={{ width: 60, fontFamily: 'monospace' }}
                              value={`0x${(k.key ?? 0).toString(16).toUpperCase().padStart(2, '0')}`}
                              onChange={(e) => {
                                const v = e.target.value.trim();
                                const n = v.startsWith('0x') || v.startsWith('0X') ? parseInt(v, 16) : parseInt(v);
                                if (!isNaN(n)) {
                                  setIsapKeysDraft(prev => prev.map((x, i) => i === idx ? { ...x, key: n } : x));
                                }
                              }} />
                          </td>
                          <td>{k.is_dial ? '✓' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              );
            });
          })()}
        </div>
      </Modal>

      {/* RAND HK 설정 모달 — 랜덤 HK 풀 선택 */}
      <Modal
        title={`RAND HK 설정${screenshotDeviceId ? ` — ${screenshotDeviceId}` : ''}`}
        open={randHkModalOpen}
        onCancel={() => setRandHkModalOpen(false)}
        width={640}
        okText="닫기"
        cancelButtonProps={{ style: { display: 'none' } }}
        onOk={() => setRandHkModalOpen(false)}
      >
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <div style={{ fontSize: 11, color: subTextColor, marginBottom: 8 }}>
            RAND HK 실행 시 무작위로 선택될 키 풀을 지정합니다. 아무것도 선택하지 않으면 표시 중인 키(dial 제외) 전체가 사용됩니다.
          </div>
          <Space style={{ marginBottom: 8 }}>
            <Button size="small" onClick={() => {
              // all visible non-dial keys
              const all = hkmcKeys.filter(k => k.visible !== false && !k.is_dial).map(k => k.name);
              setRandHkKeysConfig(all);
              const base = _randStorageBase();
              if (base) localStorage.setItem(`${base}_hk`, JSON.stringify(all));
            }}>전체 선택</Button>
            <Button size="small" onClick={() => {
              setRandHkKeysConfig([]);
              const base = _randStorageBase();
              if (base) localStorage.setItem(`${base}_hk`, JSON.stringify([]));
            }}>전체 해제</Button>
            <Button size="small" type="link" onClick={() => {
              // null = 기본(전체)로 복구
              setRandHkKeysConfig(null);
              const base = _randStorageBase();
              if (base) localStorage.removeItem(`${base}_hk`);
            }}>기본값으로 복구</Button>
            <span style={{ fontSize: 11, color: subTextColor }}>
              현재: {randHkKeysConfig == null ? '기본(전체)' : `${randHkKeysConfig.length}개 선택`}
            </span>
          </Space>
          {(() => {
            const GROUP_ORDER = ['MKBD', 'MKBD2', 'CCP', 'RRC', 'SWRC', 'SWRC2', 'MIRROR', 'CCRC', 'OVERHEAD', 'TRIP', 'GRIP', 'OPTICAL', 'RHEOSTAT'];
            const pool = hkmcKeys.filter(k => k.visible !== false && !k.is_dial);
            const byGroup: Record<string, HkmcKeyInfo[]> = {};
            pool.forEach(k => {
              const g = k.group || 'OTHER';
              if (!byGroup[g]) byGroup[g] = [];
              byGroup[g].push(k);
            });
            const groups = [
              ...GROUP_ORDER.filter(g => byGroup[g]),
              ...Object.keys(byGroup).filter(g => !GROUP_ORDER.includes(g)).sort(),
            ];
            const selected = new Set(randHkKeysConfig || pool.map(k => k.name));
            const toggle = (name: string) => {
              const next = new Set(selected);
              if (next.has(name)) next.delete(name); else next.add(name);
              const arr = Array.from(next);
              setRandHkKeysConfig(arr);
              const base = _randStorageBase();
              if (base) localStorage.setItem(`${base}_hk`, JSON.stringify(arr));
            };
            return groups.map(group => {
              const items = byGroup[group];
              const groupSelected = items.filter(k => selected.has(k.name)).length;
              const allOn = groupSelected === items.length;
              return (
                <details key={group} open style={{ marginBottom: 8, border: '1px solid #2a2a2a', borderRadius: 4, padding: 6 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                    {group} <span style={{ color: '#888', fontSize: 11 }}>({groupSelected}/{items.length})</span>
                    <Button size="small" type="link" style={{ fontSize: 10, padding: '0 4px' }}
                      onClick={(e) => {
                        e.preventDefault();
                        const next = new Set(selected);
                        items.forEach(k => { if (allOn) next.delete(k.name); else next.add(k.name); });
                        const arr = Array.from(next);
                        setRandHkKeysConfig(arr);
                        const base = _randStorageBase();
                        if (base) localStorage.setItem(`${base}_hk`, JSON.stringify(arr));
                      }}>{allOn ? '그룹 해제' : '그룹 선택'}</Button>
                  </summary>
                  <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {items.map(k => {
                      const on = selected.has(k.name);
                      return (
                        <Button key={k.name} size="small" type={on ? 'primary' : 'default'}
                          style={{ fontSize: 10, padding: '0 6px', height: 22 }}
                          onClick={() => toggle(k.name)}>
                          {k.name.replace(`${group}_`, '')}
                        </Button>
                      );
                    })}
                  </div>
                </details>
              );
            });
          })()}
        </div>
      </Modal>

      {/* RAND SK / DRAG 영역 설정 모달 — 현재 화면 스크린샷에 드래그로 영역 지정 */}
      <Modal
        title={`RAND ${randRegionModal === 'sk' ? 'SK' : 'DRAG'} 영역 설정${screenshotDeviceId ? ` — ${screenshotDeviceId}` : ''}`}
        open={randRegionModal !== null}
        onCancel={() => setRandRegionModal(null)}
        width={'80vw'}
        style={{ top: 20 }}
        okText="닫기"
        cancelButtonProps={{ style: { display: 'none' } }}
        onOk={() => setRandRegionModal(null)}
      >
        <div style={{ fontSize: 11, color: subTextColor, marginBottom: 8 }}>
          스크린샷 위에서 드래그하여 영역을 지정하면 즉시 저장됩니다. 지정하지 않으면 전체 화면이 사용됩니다.
        </div>
        <Space style={{ marginBottom: 8 }}>
          <Button size="small" onClick={() => randRegionModal && clearRandRegion(randRegionModal)}>
            영역 해제 (전체 화면 사용)
          </Button>
          <Button size="small" onClick={async () => {
            randRegionScreenshotRef.current = await snapshotScreenshot();
            drawRandRegionCanvas();
          }}>스크린샷 새로고침</Button>
          <span style={{ fontSize: 11, color: subTextColor }}>
            {(() => {
              const r = randRegionModal === 'sk' ? randSkRegion : randDragRegion;
              return r ? `현재: ${r.x},${r.y} ${r.width}×${r.height}` : '현재: 전체 화면';
            })()}
          </span>
        </Space>
        <div style={{ maxHeight: '70vh', overflow: 'auto', border: '1px solid #333' }}>
          <canvas
            ref={randRegionCanvasRef}
            onMouseDown={randRegionMouseDown}
            onMouseMove={randRegionMouseMove}
            onMouseUp={randRegionMouseUp}
            onMouseLeave={() => { if (randRegionDragRef.current.active) randRegionMouseUp(); }}
            style={{ maxWidth: '100%', display: 'block', cursor: 'crosshair', userSelect: 'none' }}
          />
        </div>
      </Modal>

      <Image
        src={annotatedPreviewSrc}
        style={{ display: 'none' }}
        preview={{
          visible: annotatedPreviewVisible,
          onVisibleChange: (v) => setAnnotatedPreviewVisible(v),
        }}
      />

      {/* DLT 로그 뷰어 모달 — StartLogging 시 자동 오픈 */}
      <Modal
        title={t('dltViewer.title') || 'DLT 로그 뷰어'}
        open={dltModalOpen}
        onCancel={() => setDltModalOpen(false)}
        footer={null}
        width={1000}
        styles={{ body: { height: '70vh', padding: 0, overflow: 'hidden' } }}
        destroyOnClose={false}
      >
        <DLTViewer
          sessions={dltSessionHook.sessions}
          mode="modal"
          theme={settings.theme}
          onClose={() => setDltModalOpen(false)}
        />
      </Modal>
    </div>
  );
}
