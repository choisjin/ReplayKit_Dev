import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Button, Card, Checkbox, Col, Collapse, Descriptions, Divider, Dropdown, Image, Input, InputNumber, List, Modal, Radio, Row, Select, Space, Splitter, Table, Tabs, Tag, Tooltip, Tree, Upload, message } from 'antd';
import type { TreeProps } from 'antd';
import {
  PlayCircleOutlined, PauseOutlined, DeleteOutlined, EyeOutlined,
  StopOutlined, CopyOutlined, MergeCellsOutlined,
  FolderOutlined, FolderAddOutlined, FileOutlined, MinusOutlined,
  ArrowUpOutlined, ArrowDownOutlined, EditOutlined, BranchesOutlined,
  DownOutlined, RightOutlined, ClearOutlined, UploadOutlined,
  ExportOutlined, ImportOutlined, CheckCircleOutlined, WarningOutlined,
} from '@ant-design/icons';
import { scenarioApi, deviceApi, resultsApi } from '../services/api';
import { useDevice } from '../context/DeviceContext';
import { useSettings } from '../context/SettingsContext';
import { useTranslation } from '../i18n';
import { useWebcamContext } from '../context/WebcamContext';
import { VideoCameraOutlined } from '@ant-design/icons';

// 기대 이미지 썸네일 (ROI/크롭/영역제외 오버레이)
const ExpectedThumbnail = React.memo(({ src, regions, color, height = 32 }: {
  src: string; regions: { x: number; y: number; width: number; height: number }[]; color: string; height?: number;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const draw = useCallback((canvas: HTMLCanvasElement, img: HTMLImageElement, w: number, h: number) => {
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    const sx = w / img.width, sy = h / img.height;
    regions.forEach(r => {
      ctx.fillStyle = color === '#ff4d4f' ? 'rgba(255,77,79,0.3)' : 'rgba(82,196,26,0.3)';
      ctx.fillRect(r.x * sx, r.y * sy, r.width * sx, r.height * sy);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, 2 * sx);
      ctx.strokeRect(r.x * sx, r.y * sy, r.width * sx, r.height * sy);
    });
  }, [regions, color]);
  useEffect(() => {
    const img = new window.Image();
    img.onload = () => { const c = canvasRef.current; if (c) { const a = img.width / img.height; draw(c, img, Math.round(height * a), height); } };
    img.src = src;
  }, [src, regions, color, height, draw]);
  return (
    <>
      <canvas ref={canvasRef} style={{ height, borderRadius: 2, cursor: 'pointer' }} onClick={() => {
        const img = new window.Image();
        img.onload = () => { const c = document.createElement('canvas'); draw(c, img, img.width, img.height); setPreviewUrl(c.toDataURL('image/png')); };
        img.src = src;
      }} />
      {previewUrl && <Image src={previewUrl} style={{ display: 'none' }} preview={{ visible: true, onVisibleChange: v => { if (!v) setPreviewUrl(null); } }} />}
    </>
  );
});

interface ScenarioDetail {
  name: string;
  description: string;
  device_serial: string;
  resolution: { width: number; height: number } | null;
  steps: any[];
  device_map: Record<string, string>;
  created_at: string;
}

interface ROI { x: number; y: number; width: number; height: number; }
interface MatchLocation { x: number; y: number; width: number; height: number; }

interface SubResultData {
  label: string;
  expected_image: string;
  score: number;
  status: string;
  match_location: MatchLocation | null;
}

interface StepResultData {
  step_id: number;
  repeat_index: number;
  timestamp: string | null;
  device_id: string;
  command: string;
  description: string;
  status: string;
  similarity_score: number | null;
  expected_image: string | null;
  expected_annotated_image: string | null;
  actual_image: string | null;
  actual_annotated_image: string | null;
  diff_image: string | null;
  roi: ROI | null;
  match_location: MatchLocation | null;
  message: string;
  delay_ms: number;
  execution_time_ms: number;
  compare_mode: string | null;
  sub_results: SubResultData[];
}

interface JumpTarget {
  scenario: number;  // group index (0-based), -1 = END
  step: number;      // step index within scenario (0-based)
}

interface StepJump {
  on_pass_goto: JumpTarget | null;
  on_fail_goto: JumpTarget | null;
}

interface GroupEntry {
  name: string;
  on_pass_goto: JumpTarget | null;
  on_fail_goto: JumpTarget | null;
  step_jumps?: Record<string, StepJump>;
}

const statusColor = (s: string) =>
  s === 'pass' ? 'green' : s === 'warning' ? 'orange' : s === 'error' ? 'volcano' : 'red';

const imageUrl = (path: string | null) => {
  if (!path) return null;
  let rel = path.replace(/\\/g, '/');
  const idx = rel.indexOf('/screenshots/');
  if (idx >= 0) rel = rel.substring(idx + '/screenshots/'.length);
  return '/screenshots/' + rel;
};

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  const remain = ms % 1000;
  if (sec < 60) return `${sec}.${String(remain).padStart(3, '0').slice(0, 1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
};

const formatTime = (iso: string, lang: string = 'ko') => {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US'); } catch { return iso; }
};

export default function ScenarioPage() {
  const { t, lang } = useTranslation();
  const { settings, saveExportZipToDir } = useSettings();
  const { webcam, ensureWebcamOpen } = useWebcamContext();
  const { pauseScreenStream, resumeScreenStream, primaryDevices, auxiliaryDevices } = useDevice();
  const [scenarios, setScenarios] = useState<string[]>([]);
  const [selectedScenario, setSelectedScenario] = useState<ScenarioDetail | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);

  // Playback
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [playingName, setPlayingName] = useState('');
  const [_currentStepId, setCurrentStepId] = useState<number | null>(null);
  const [stepResults, setStepResults] = useState<StepResultData[]>([]);
  const [playbackScenario, setPlaybackScenario] = useState<ScenarioDetail | null>(null);
  const [repeatCounts, setRepeatCounts] = useState<Record<string, number>>({});
  const [currentIteration, setCurrentIteration] = useState(1);
  const [totalIterations, setTotalIterations] = useState(1);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [folders, setFolders] = useState<Record<string, string[]>>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; type: 'folder' | 'scenario'; name: string } | null>(null);
  const getRepeatCount = (name: string) => repeatCounts[name] ?? 1;
  const setRepeatCount = (name: string, val: number) =>
    setRepeatCounts((prev) => ({ ...prev, [name]: val }));

  // 백그라운드 CMD 폴링
  const bgPollTimers = useRef<ReturnType<typeof setInterval>[]>([]);
  const startBgPolling = (results: StepResultData[]) => {
    bgPollTimers.current.forEach(t => clearInterval(t));
    bgPollTimers.current = [];
    results.forEach((sr, idx) => {
      const m = sr.message?.match?.(/\[BG_TASK:(bg_\d+)\]/);
      if (!m) return;
      const taskId = m[1];
      // 즉시 실행 중 표시
      setStepResults(prev => {
        const u = [...prev];
        u[idx] = { ...u[idx], message: `⏳ 백그라운드 명령 실행 중...` };
        return u;
      });
      const poll = setInterval(async () => {
        try {
          const r = await scenarioApi.getCmdResult(taskId);
          if (r.data.status === 'running') return;
          clearInterval(poll);
          const stdout = r.data.stdout || '';
          setStepResults(prev => {
            const u = [...prev];
            const step = u[idx];
            const cmd = step.command || '';
            if (cmd.startsWith('cmd_check:')) {
              const em = cmd.match(/\(expect(?:\[(\w+)\])?:\s*(.*)\)$/);
              const matchMode = em?.[1] || 'contains';
              const expected = em?.[2] || '';
              const passed = matchMode === 'exact' ? stdout.trim() === expected.trim() : stdout.includes(expected);
              u[idx] = { ...step, message: `[CMD_CHECK]\nexpected(${matchMode}): ${expected}\n---\n${stdout}`, status: passed ? step.status : 'fail' };
            } else {
              u[idx] = { ...step, message: stdout || `완료 (rc: ${r.data.rc})` };
            }
            return u;
          });
        } catch {
          clearInterval(poll);
          setStepResults(prev => {
            const u = [...prev];
            u[idx] = { ...u[idx], message: `[BG_TASK:${taskId}] 결과 소실` };
            return u;
          });
        }
      }, 1000);
      bgPollTimers.current.push(poll);
    });
  };

  // 웹캠 자동 녹화
  const [webcamAutoRecord, setWebcamAutoRecord] = useState(true);
  const webcamBlobsRef = useRef<{ repeatIndex: number; blob: Blob }[]>([]);
  const webcamRecordingActiveRef = useRef(false);
  const playbackScrollRef = useRef<HTMLDivElement>(null);

  // 재생 중 스텝 추가 시 자동 최하단 스크롤
  useEffect(() => {
    if (playing && playbackScrollRef.current) {
      playbackScrollRef.current.scrollTop = playbackScrollRef.current.scrollHeight;
    }
  }, [stepResults, playing]);

  // 시나리오 스텝 미리보기
  const [previewSteps, setPreviewSteps] = useState<any[]>([]);
  const [skipStepIds, setSkipStepIds] = useState<Set<number>>(new Set());
  const selectedNameRef = useRef(selectedName);
  selectedNameRef.current = selectedName;

  // 시나리오 선택 시 스텝 로드
  useEffect(() => {
    if (!selectedName) { setPreviewSteps([]); setSkipStepIds(new Set()); return; }
    scenarioApi.get(selectedName).then(res => {
      setPreviewSteps(res.data.steps || []);
      setSkipStepIds(new Set());
    }).catch(() => setPreviewSteps([]));
  }, [selectedName]);

  // Group play
  const [playingGroupName, setPlayingGroupName] = useState<string | null>(null);
  const [currentGroupScenario, setCurrentGroupScenario] = useState('');
  const [groupScenarioIndex, setGroupScenarioIndex] = useState(0);
  const [groupScenarioTotal, setGroupScenarioTotal] = useState(0);

  // Groups
  const [groups, setGroups] = useState<Record<string, GroupEntry[]>>({});
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [groupModalVisible, setGroupModalVisible] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [scenarioStepsCache, setScenarioStepsCache] = useState<Record<string, any[]>>({});
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());

  // Copy / Merge
  const [copyName, setCopyName] = useState('');
  const [copyModalVisible, setCopyModalVisible] = useState(false);
  const [mergeModalVisible, setMergeModalVisible] = useState(false);
  const [mergeTargets, setMergeTargets] = useState<string[]>([]);
  const [mergeName, setMergeName] = useState('');

  // Rename modal
  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [renameNewName, setRenameNewName] = useState('');

  // Compare modal
  const [compareStep, setCompareStep] = useState<StepResultData | null>(null);

  // 실시간 duration 카운트
  const stepStartTimeRef = useRef<number>(0);
  const [liveDuration, setLiveDuration] = useState(0);
  const liveDurationRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Device mapping
  const [deviceMapModalVisible, setDeviceMapModalVisible] = useState(false);
  const [deviceMapEditing, setDeviceMapEditing] = useState<Record<string, string>>({});
  const [deviceMapScenarioName, setDeviceMapScenarioName] = useState('');
  const [connectedDevices, setConnectedDevices] = useState<{ id: string; name: string; type: string; status: string }[]>([]);

  // Export / Import
  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [exportSelectedScenarios, setExportSelectedScenarios] = useState<string[]>([]);
  const [exportSelectedGroups, setExportSelectedGroups] = useState<string[]>([]);
  const [exportAll, setExportAll] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);

  const [importModalVisible, setImportModalVisible] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreviewData, setImportPreviewData] = useState<{ scenarios: { name: string; conflict: boolean }[]; groups: { name: string; conflict: boolean }[] } | null>(null);
  const [importResolutions, setImportResolutions] = useState<Record<string, { action: string; new_name?: string }>>({});
  const [importLoading, setImportLoading] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  // --- Filtered scenarios by group ---
  // 그룹 선택 시 그룹 멤버 순서 유지 (scenarios는 알파벳순이므로 filter 대신 map 사용)
  const filteredScenarios = selectedGroup
    ? (groups[selectedGroup] || []).map((m) => m.name).filter((n) => scenarios.includes(n))
    : scenarios;

  // --- Fetches ---
  const fetchScenarios = async () => {
    try {
      const res = await scenarioApi.list();
      setScenarios(res.data.scenarios);
    } catch { message.error(t('scenario.listFailed')); }
  };

  const fetchFolders = async () => {
    try {
      const res = await scenarioApi.getFolders();
      setFolders(res.data.folders || {});
    } catch { /* ignore */ }
  };

  const fetchGroups = async () => {
    try {
      const res = await scenarioApi.getGroups();
      setGroups(res.data.groups);
    } catch { /* ignore */ }
  };

  const fetchScenarioStepsCache = async (names: string[]) => {
    const cache: Record<string, any[]> = { ...scenarioStepsCache };
    const toFetch = names.filter((n) => !(n in cache));
    await Promise.all(toFetch.map(async (name) => {
      try {
        const res = await scenarioApi.get(name);
        cache[name] = res.data.steps ?? [];
      } catch { cache[name] = []; }
    }));
    setScenarioStepsCache(cache);
  };

  const formatStepLabel = (step: any, idx: number) => {
    const type = step.type || '';
    const p = step.params || {};
    let detail = '';
    if (type === 'tap') detail = `(${p.x},${p.y})`;
    else if (type === 'long_press') detail = `(${p.x},${p.y}) ${p.duration_ms || 1000}ms`;
    else if (type === 'swipe') detail = `(${p.x1},${p.y1})→(${p.x2},${p.y2})`;
    else if (type === 'input_text') detail = `"${p.text || ''}"`;
    else if (type === 'key_event') detail = p.keycode || '';
    else if (type === 'wait') detail = `${p.duration_ms || 1000}ms`;
    else if (type === 'adb_command') detail = p.command || '';
    else if (type === 'serial_command') detail = `"${p.data || ''}"`;
    else if (type === 'module_command') detail = `${p.function}(${p.args ? Object.values(p.args).map((v: any) => `"${v}"`).join(', ') : ''})`;
    const desc = step.description ? ` [${step.description}]` : '';
    return `#${idx + 1} ${type} ${detail}${desc}`;
  };

  useEffect(() => {
    fetchScenarios();
    fetchFolders();
    fetchGroups();
    const onTabChange = (e: Event) => {
      if ((e as CustomEvent).detail === '/scenarios') {
        fetchScenarios();
        fetchFolders();
        fetchGroups();
        // 스텝 미리보기 새로고침
        if (selectedNameRef.current) {
          scenarioApi.get(selectedNameRef.current).then(res => {
            setPreviewSteps(res.data.steps || []);
          }).catch(() => {});
        }
      }
    };
    window.addEventListener('tab-change', onTabChange);
    return () => { if (wsRef.current) wsRef.current.close(); window.removeEventListener('tab-change', onTabChange); bgPollTimers.current.forEach(t => clearInterval(t)); };
  }, []);

  // --- Scenario CRUD ---
  const viewScenario = async (name: string) => {
    try {
      const res = await scenarioApi.get(name);
      setSelectedScenario(res.data);
      setDetailVisible(true);
    } catch { message.error(t('scenario.loadFailed')); }
  };

  const deleteScenario = async (name: string) => {
    Modal.confirm({
      title: t('scenario.deleteTitle'),
      content: t('scenario.deleteConfirm', { name }),
      onOk: async () => {
        try {
          await scenarioApi.delete(name);
          message.success(t('common.deleteComplete'));
          if (selectedName === name) setSelectedName(null);
          fetchScenarios();
          fetchGroups();
        } catch { message.error(t('common.deleteFailed')); }
      },
    });
  };

  // --- Rename ---
  const openRenameModal = () => {
    if (!selectedName) return;
    setRenameNewName(selectedName);
    setRenameModalVisible(true);
  };

  const doRename = async () => {
    if (!selectedName || !renameNewName.trim() || renameNewName.trim() === selectedName) {
      setRenameModalVisible(false);
      return;
    }
    try {
      await scenarioApi.rename(selectedName, renameNewName.trim());
      message.success(t('scenario.renameSuccess'));
      setRenameModalVisible(false);
      setSelectedName(renameNewName.trim());
      fetchScenarios();
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('scenario.renameFailed'));
    }
  };

  // --- Copy ---
  const openCopyModal = () => {
    if (!selectedName) return;
    setCopyName(selectedName + '_copy');
    setCopyModalVisible(true);
  };

  const doCopy = async () => {
    if (!selectedName || !copyName.trim()) return;
    try {
      await scenarioApi.copy(selectedName, copyName.trim());
      message.success(t('scenario.copySuccess'));
      setCopyModalVisible(false);
      fetchScenarios();
    } catch { message.error(t('scenario.copyFailed')); }
  };

  // --- Merge ---
  const openMergeModal = () => {
    setMergeTargets([]);
    setMergeName('merged_scenario');
    setMergeModalVisible(true);
  };

  const doMerge = async () => {
    if (mergeTargets.length < 2 || !mergeName.trim()) {
      message.warning(t('scenario.mergeMinWarning'));
      return;
    }
    const trimmed = mergeName.trim();
    if (scenarios.includes(trimmed)) {
      Modal.confirm({
        title: t('scenario.mergeOverwriteTitle'),
        content: t('scenario.mergeOverwriteContent', { name: trimmed }),
        onOk: async () => {
          try {
            await scenarioApi.merge(mergeTargets, trimmed);
            message.success(t('scenario.mergeSuccess'));
            setMergeModalVisible(false);
            fetchScenarios();
          } catch { message.error(t('scenario.mergeFailed')); }
        },
      });
      return;
    }
    try {
      await scenarioApi.merge(mergeTargets, trimmed);
      message.success(t('scenario.mergeSuccess'));
      setMergeModalVisible(false);
      fetchScenarios();
    } catch { message.error(t('scenario.mergeFailed')); }
  };

  // --- Export / Import ---
  const doExport = async () => {
    setExportLoading(true);
    try {
      // Try server-side save first if path is configured
      try {
        const path = await saveExportZipToDir(
          exportAll ? [] : exportSelectedScenarios,
          exportAll ? [] : exportSelectedGroups,
          exportAll,
        );
        setExportModalVisible(false);
        message.success(t('scenario.exportSaveComplete', { path }));
        setExportLoading(false);
        return;
      } catch (serverErr: any) {
        const status = serverErr.response?.status;
        if (status !== 400) {
          const detail = serverErr.response?.data?.detail || serverErr.message || String(serverErr);
          message.error(t('scenario.exportSaveFailed', { detail }));
          setExportLoading(false);
          return;
        }
        // 400 = path not configured, fallback to browser download
      }

      const res = await scenarioApi.exportZip(
        exportAll ? [] : exportSelectedScenarios,
        exportAll ? [] : exportSelectedGroups,
        exportAll,
      );
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      const disposition = res.headers['content-disposition'] || '';
      const match = disposition.match(/filename="?(.+?)"?$/);
      a.download = match ? match[1] : 'recording_export.zip';
      a.click();
      window.URL.revokeObjectURL(url);
      setExportModalVisible(false);
      message.success(t('scenario.exportComplete'));
    } catch { message.error(t('scenario.exportFailed')); }
    setExportLoading(false);
  };

  const handleImportFile = async (file: File) => {
    setImportFile(file);
    setImportResolutions({});
    setImportPreviewData(null);
    setImportLoading(true);
    try {
      const res = await scenarioApi.importPreview(file);
      setImportPreviewData(res.data);
      // Set default resolutions
      const defaults: Record<string, { action: string; new_name?: string }> = {};
      for (const s of res.data.scenarios) {
        defaults[`s:${s.name}`] = { action: s.conflict ? 'skip' : 'import' };
      }
      for (const g of res.data.groups) {
        defaults[`g:${g.name}`] = { action: g.conflict ? 'skip' : 'import' };
      }
      setImportResolutions(defaults);
    } catch { message.error(t('scenario.importFailed')); }
    setImportLoading(false);
  };

  const doImport = async () => {
    if (!importFile || !importPreviewData) return;
    setImportLoading(true);
    try {
      const scenarioRes: Record<string, any> = {};
      const groupRes: Record<string, any> = {};
      for (const s of importPreviewData.scenarios) {
        const r = importResolutions[`s:${s.name}`] || { action: 'import' };
        scenarioRes[s.name] = r;
      }
      for (const g of importPreviewData.groups) {
        const r = importResolutions[`g:${g.name}`] || { action: 'import' };
        groupRes[g.name] = r;
      }
      const res = await scenarioApi.importApply(importFile, { scenarios: scenarioRes, groups: groupRes });
      const d = res.data;
      message.success(t('scenario.importComplete', { scenarios: String(d.imported_scenarios?.length || 0), groups: String(d.imported_groups?.length || 0) }));
      setImportModalVisible(false);
      setImportFile(null);
      setImportPreviewData(null);
      fetchScenarios();
      fetchGroups();
    } catch { message.error(t('scenario.importFailed')); }
    setImportLoading(false);
  };

  // --- Group actions ---
  const createGroup = async () => {
    if (!newGroupName.trim()) return;
    try {
      const res = await scenarioApi.createGroup(newGroupName.trim());
      setGroups(res.data.groups);
      setNewGroupName('');
      message.success(t('scenario.groupCreateSuccess'));
    } catch { message.error(t('scenario.groupCreateFailed')); }
  };

  const deleteGroup = (gName: string) => {
    Modal.confirm({
      title: t('scenario.groupDeleteConfirm', { name: gName }),
      okText: t('common.delete'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          const res = await scenarioApi.deleteGroup(gName);
          setGroups(res.data.groups);
          if (selectedGroup === gName) setSelectedGroup(null);
          message.success(t('scenario.groupDeleteSuccess'));
        } catch { message.error(t('scenario.groupDeleteFailed')); }
      },
    });
  };

  const addToGroup = async (gName: string, sName: string) => {
    try {
      const res = await scenarioApi.addToGroup(gName, sName);
      setGroups(res.data.groups);
      fetchScenarioStepsCache([sName]);
    } catch { message.error(t('scenario.groupAddFailed')); }
  };

  const removeFromGroup = async (gName: string, sName: string) => {
    try {
      const res = await scenarioApi.removeFromGroup(gName, sName);
      setGroups(res.data.groups);
    } catch { message.error(t('scenario.groupRemoveFailed')); }
  };

  const reorderGroup = async (gName: string, ordered: string[]) => {
    try {
      const res = await scenarioApi.reorderGroup(gName, ordered);
      setGroups(res.data.groups);
    } catch { message.error(t('scenario.reorderFailed')); }
  };

  const moveInGroup = (gName: string, members: GroupEntry[], idx: number, dir: -1 | 1) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= members.length) return;
    const arr = [...members];
    [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
    reorderGroup(gName, arr.map((m) => m.name));
  };

  const updateGroupStepJumps = async (gName: string, entryIdx: number, stepId: number, on_pass_goto: JumpTarget | null, on_fail_goto: JumpTarget | null) => {
    try {
      const res = await scenarioApi.updateGroupStepJumps(gName, entryIdx, stepId, on_pass_goto, on_fail_goto);
      setGroups(res.data.groups);
    } catch { message.error(t('scenario.stepJumpFailed')); }
  };

  const toggleExpandEntry = (key: string) => {
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // --- Playback ---
  const playScenario = async (name: string) => {
    let scenarioData: ScenarioDetail;
    try {
      const res = await scenarioApi.get(name);
      scenarioData = res.data;
      setPlaybackScenario(scenarioData);
    } catch { message.error(t('scenario.loadFailed')); return; }

    // 재생 확인 모달 표시 (디바이스 매핑 + 웹캠 녹화 설정)
    const dmap = scenarioData.device_map || {};
    // DeviceContext에서 이미 폴링된 디바이스 목록 사용 (API 재호출 불필요)
    const devices = [
      ...primaryDevices.map((d: any) => ({ id: d.id, name: d.name || d.id, type: d.type, status: d.status, address: d.address })),
      ...auxiliaryDevices.map((d: any) => ({ id: d.id, name: d.name || d.id, type: d.type, status: d.status, address: d.address })),
    ];
    setConnectedDevices(devices);
    // 시나리오의 매핑값(이전 환경 ID)을 현재 디바이스 ID로 자동 매칭
    const resolved: Record<string, string> = {};
    for (const [alias, savedId] of Object.entries(dmap)) {
      const exact = devices.find(d => d.id === savedId);
      if (exact) {
        resolved[alias] = savedId;
      } else {
        // ID가 안 맞으면 같은 alias 이름의 디바이스를 찾거나, 주소로 매칭
        const byAlias = devices.find(d => d.id === alias);
        if (byAlias) {
          resolved[alias] = byAlias.id;
        } else {
          resolved[alias] = savedId; // 매칭 실패 시 원래 값 유지
        }
      }
    }
    setDeviceMapEditing(resolved);
    setDeviceMapScenarioName(name);
    setDeviceMapModalVisible(true);
  };

  const startPlayback = async (name: string, deviceMap: Record<string, string>) => {
    pauseScreenStream();
    const repeat = getRepeatCount(name);
    // 웹캠 자동녹화: 웹캠 열기 + 연결 확인
    let doAutoRecord = false;
    if (webcamAutoRecord) {
      const ready = await ensureWebcamOpen();
      if (!ready) {
        message.error(t('webcam.webcamNotOpen'));
        return;
      }
      doAutoRecord = true;
    }
    setPlaying(true);
    setPlayingName(name);
    setStepResults([]);
    setCurrentStepId(null);
    setCurrentIteration(1);
    setTotalIterations(repeat);
    webcamBlobsRef.current = [];
    webcamRecordingActiveRef.current = false;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/playback`);
    wsRef.current = ws;

    const hasMap = Object.keys(deviceMap).length > 0;
    ws.onopen = () => {
      setCurrentStepId(1);
      const skipIds = Array.from(skipStepIds);
      ws.send(JSON.stringify({ action: 'play', scenario: name, verify: true, repeat, ...(hasMap ? { device_map: deviceMap } : {}), ...(skipIds.length > 0 ? { skip_steps: skipIds } : {}) }));
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'iteration_start') {
        setCurrentIteration(msg.iteration);
        // 회차별 웹캠 녹화 분리
        if (doAutoRecord && webcamRecordingActiveRef.current && msg.iteration > 1) {
          webcam.stopRecordingAuto().then((blob) => {
            webcamBlobsRef.current.push({ repeatIndex: msg.iteration - 1, blob });
            webcam.startRecordingAuto().then((ok) => { webcamRecordingActiveRef.current = ok; });
          });
        }
      } else if (msg.type === 'step_start') {
        // 첫 스텝 시작 = 디바이스 검사 통과 → 웹캠 녹화 시작
        if (doAutoRecord && !webcamRecordingActiveRef.current) {
          webcam.startRecordingAuto().then((ok) => { webcamRecordingActiveRef.current = ok; });
        }
        // 스텝 시작: running 상태로 테이블에 추가 + duration 카운트 시작
        const d = msg.data;
        const placeholder: StepResultData = {
          step_id: d.step_id, repeat_index: d.repeat_index,
          timestamp: new Date().toISOString(), device_id: d.device_id,
          command: d.command, description: d.description,
          status: 'running', similarity_score: null,
          expected_image: null, expected_annotated_image: null,
          actual_image: null, actual_annotated_image: null, diff_image: null,
          roi: null, match_location: null, message: '',
          delay_ms: d.delay_ms, execution_time_ms: 0,
          compare_mode: null, sub_results: [],
        };
        setStepResults((prev) => [...prev, placeholder]);
        setCurrentStepId(d.step_id);
        // 실시간 카운터
        stepStartTimeRef.current = Date.now();
        setLiveDuration(0);
        if (liveDurationRef.current) clearInterval(liveDurationRef.current);
        liveDurationRef.current = setInterval(() => {
          setLiveDuration(Date.now() - stepStartTimeRef.current);
        }, 200);
      } else if (msg.type === 'step_result') {
        // 스텝 완료: 마지막 running 행을 실제 결과로 교체
        if (liveDurationRef.current) { clearInterval(liveDurationRef.current); liveDurationRef.current = null; }
        const result: StepResultData = msg.data;
        setStepResults((prev) => {
          let idx = -1;
          for (let i = prev.length - 1; i >= 0; i--) { if (prev[i].step_id === result.step_id && prev[i].repeat_index === result.repeat_index) { idx = i; break; } }
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = result;
            return updated;
          }
          return [...prev, result];
        });
      } else if (msg.type === 'playback_complete') {
        if (liveDurationRef.current) { clearInterval(liveDurationRef.current); liveDurationRef.current = null; }
        setPlaying(false); setPaused(false); setCurrentStepId(null); resumeScreenStream();
        message.success(repeat > 1 ? t('scenario.playCompleteRepeat', { count: String(repeat) }) : t('scenario.playComplete'));
        ws.close();
        // 백그라운드 CMD 결과 폴링 시작
        setStepResults(prev => { startBgPolling(prev); return prev; });
        // 웹캠 녹화 종료 + 업로드
        if (doAutoRecord && webcamRecordingActiveRef.current) {
          const resultFilename = msg.result_filename || '';
          webcam.stopRecordingAuto().then(async (blob) => {
            const allBlobs = [...webcamBlobsRef.current, { repeatIndex: repeat > 1 ? repeat : 1, blob }];
            webcamRecordingActiveRef.current = false;
            if (resultFilename) {
              for (const item of allBlobs) {
                if (item.blob.size < 100) continue;
                try { await resultsApi.uploadRecording(item.blob, resultFilename, item.repeatIndex); } catch { message.error(t('webcam.uploadFailed')); }
              }
            }
            webcamBlobsRef.current = [];
          });
        }
      } else if (msg.type === 'preflight_error') {
        setPlaying(false); setCurrentStepId(null);
        Modal.error({
          title: t('scenario.deviceCheckFailed'),
          content: (
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              {(msg.errors || []).map((e: string, i: number) => (
                <div key={i} style={{ padding: '4px 0', color: '#ff4d4f' }}>• {e}</div>
              ))}
            </div>
          ),
        });
        ws.close();
      } else if (msg.type === 'error') {
        if (liveDurationRef.current) { clearInterval(liveDurationRef.current); liveDurationRef.current = null; }
        setPlaying(false); setCurrentStepId(null); resumeScreenStream();
        message.error(msg.message); ws.close();
        if (doAutoRecord && webcamRecordingActiveRef.current) { webcam.stopRecordingAuto(); webcamRecordingActiveRef.current = false; webcamBlobsRef.current = []; }
      } else if (msg.type === 'playback_stopped') {
        if (liveDurationRef.current) { clearInterval(liveDurationRef.current); liveDurationRef.current = null; }
        setPlaying(false); setPaused(false); setCurrentStepId(null); resumeScreenStream();
        const resultFilename = msg.result_filename || '';
        if (resultFilename) {
          message.info(t('scenario.playStoppedPartial'));
          // 완료된 회차까지 웹캠 녹화 저장
          if (doAutoRecord && webcamRecordingActiveRef.current) {
            webcam.stopRecordingAuto().then(async () => {
              webcamRecordingActiveRef.current = false;
              if (webcamBlobsRef.current.length > 0) {
                for (const item of webcamBlobsRef.current) {
                  try { await resultsApi.uploadRecording(item.blob, resultFilename, item.repeatIndex); } catch { /* ignore */ }
                }
              }
              webcamBlobsRef.current = [];
            });
          }
        } else {
          message.info(t('scenario.playStopped'));
          if (doAutoRecord && webcamRecordingActiveRef.current) { webcam.stopRecordingAuto(); webcamRecordingActiveRef.current = false; webcamBlobsRef.current = []; }
        }
        ws.close();
      } else if (msg.type === 'playback_paused') {
        setPaused(true);
        if (liveDurationRef.current) { clearInterval(liveDurationRef.current); liveDurationRef.current = null; }
        if (doAutoRecord && webcamRecordingActiveRef.current) webcam.pauseRecording();
        pauseScreenStream();
      } else if (msg.type === 'playback_resumed') {
        setPaused(false);
        if (doAutoRecord && webcamRecordingActiveRef.current) webcam.resumeRecording();
        resumeScreenStream();
      }
    };
    ws.onerror = () => { if (liveDurationRef.current) { clearInterval(liveDurationRef.current); liveDurationRef.current = null; } setPlaying(false); setPaused(false); setCurrentStepId(null); resumeScreenStream(); message.error(t('scenario.websocketFailed')); };
    ws.onclose = () => { wsRef.current = null; };
  };

  // --- Group playback ---
  const playGroup = async (gName: string) => {
    const members = groups[gName] || [];
    if (members.length === 0) { message.warning(t('scenario.noScenariosInGroup')); return; }

    // Collect device_maps from all member scenarios
    const mergedMap: Record<string, string> = {};
    for (const m of members) {
      try {
        const res = await scenarioApi.get(m.name);
        const dmap = res.data.device_map || {};
        Object.assign(mergedMap, dmap);
      } catch { /* ignore */ }
    }

    let devices: { id: string; name: string; type: string; status: string; address?: string }[] = [];
    try {
      const devRes = await deviceApi.list();
      devices = [
        ...(devRes.data.primary || []).map((d: any) => ({ id: d.id, name: d.name || d.id, type: d.type, status: d.status, address: d.address })),
        ...(devRes.data.auxiliary || []).map((d: any) => ({ id: d.id, name: d.name || d.id, type: d.type, status: d.status, address: d.address })),
      ];
      setConnectedDevices(devices);
    } catch { /* ignore */ }
    const resolved: Record<string, string> = {};
    for (const [alias, savedId] of Object.entries(mergedMap)) {
      const exact = devices.find(d => d.id === savedId);
      if (exact) {
        resolved[alias] = savedId;
      } else {
        const byAlias = devices.find(d => d.id === alias);
        resolved[alias] = byAlias ? byAlias.id : savedId;
      }
    }
    setDeviceMapEditing(resolved);
    setDeviceMapScenarioName(`group:${gName}`);
    setDeviceMapModalVisible(true);
  };

  const startGroupPlayback = async (gName: string, deviceMap: Record<string, string>) => {
    pauseScreenStream();
    const members = groups[gName] || [];
    const repeat = getRepeatCount(gName);
    // 웹캠 자동녹화: 웹캠 열기 + 연결 확인
    let doAutoRecord = false;
    if (webcamAutoRecord) {
      const ready = await ensureWebcamOpen();
      if (!ready) {
        message.error(t('webcam.webcamNotOpen'));
        return;
      }
      doAutoRecord = true;
    }

    setPlaying(true);
    setPlayingGroupName(gName);
    setPlayingName(members[0].name);
    setPlaybackScenario({ name: gName, description: '', device_serial: '', resolution: null, steps: [], device_map: {}, created_at: '' });
    setStepResults([]);
    setCurrentStepId(null);
    setCurrentIteration(1);
    setTotalIterations(repeat);
    setGroupScenarioIndex(0);
    setGroupScenarioTotal(members.length);
    setCurrentGroupScenario('');
    webcamBlobsRef.current = [];
    webcamRecordingActiveRef.current = false;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/playback`);
    wsRef.current = ws;

    const hasMap = Object.keys(deviceMap).length > 0;
    ws.onopen = () => {
      ws.send(JSON.stringify({ action: 'play_group', group_name: gName, scenarios: members, verify: true, repeat, ...(hasMap ? { device_map: deviceMap } : {}) }));
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'group_scenario_start') {
        setCurrentGroupScenario(msg.scenario_name);
        setGroupScenarioIndex(msg.scenario_index);
        setGroupScenarioTotal(msg.total_scenarios);
        setPlayingName(msg.scenario_name);
      } else if (msg.type === 'iteration_start') {
        setCurrentIteration(msg.iteration);
        // 회차별 웹캠 녹화 분리
        if (doAutoRecord && webcamRecordingActiveRef.current && msg.iteration > 1) {
          webcam.stopRecordingAuto().then((blob) => {
            webcamBlobsRef.current.push({ repeatIndex: msg.iteration - 1, blob });
            webcam.startRecordingAuto().then((ok) => { webcamRecordingActiveRef.current = ok; });
          });
        }
      } else if (msg.type === 'step_start') {
        // 첫 스텝 시작 = 디바이스 검사 통과 → 웹캠 녹화 시작
        if (doAutoRecord && !webcamRecordingActiveRef.current) {
          webcam.startRecordingAuto().then((ok) => { webcamRecordingActiveRef.current = ok; });
        }
        const d = msg.data;
        const placeholder: StepResultData = {
          step_id: d.step_id, repeat_index: d.repeat_index,
          timestamp: new Date().toISOString(), device_id: d.device_id,
          command: d.command, description: d.description,
          status: 'running', similarity_score: null,
          expected_image: null, expected_annotated_image: null,
          actual_image: null, actual_annotated_image: null, diff_image: null,
          roi: null, match_location: null, message: '',
          delay_ms: d.delay_ms, execution_time_ms: 0,
          compare_mode: null, sub_results: [],
        };
        setStepResults((prev) => [...prev, placeholder]);
        setCurrentStepId(d.step_id);
        stepStartTimeRef.current = Date.now();
        setLiveDuration(0);
        if (liveDurationRef.current) clearInterval(liveDurationRef.current);
        liveDurationRef.current = setInterval(() => {
          setLiveDuration(Date.now() - stepStartTimeRef.current);
        }, 200);
      } else if (msg.type === 'step_result') {
        if (liveDurationRef.current) { clearInterval(liveDurationRef.current); liveDurationRef.current = null; }
        const result: StepResultData = msg.data;
        setStepResults((prev) => {
          let idx = -1;
          for (let i = prev.length - 1; i >= 0; i--) { if (prev[i].step_id === result.step_id && prev[i].repeat_index === result.repeat_index) { idx = i; break; } }
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = result;
            return updated;
          }
          return [...prev, result];
        });
      } else if (msg.type === 'playback_complete') {
        if (liveDurationRef.current) { clearInterval(liveDurationRef.current); liveDurationRef.current = null; }
        setPlaying(false); setPaused(false); setPlayingGroupName(null); setCurrentStepId(null); resumeScreenStream();
        message.success(t('scenario.playComplete'));
        ws.close();
        // 백그라운드 CMD 결과 폴링 시작
        setStepResults(prev => { startBgPolling(prev); return prev; });
        if (doAutoRecord && webcamRecordingActiveRef.current) {
          const resultFilename = msg.result_filename || '';
          webcam.stopRecordingAuto().then(async (blob) => {
            const allBlobs = [...webcamBlobsRef.current, { repeatIndex: repeat > 1 ? repeat : 1, blob }];
            webcamRecordingActiveRef.current = false;
            if (resultFilename) {
              for (const item of allBlobs) {
                if (item.blob.size < 100) continue;
                try { await resultsApi.uploadRecording(item.blob, resultFilename, item.repeatIndex); } catch { message.error(t('webcam.uploadFailed')); }
              }
            }
            webcamBlobsRef.current = [];
          });
        }
      } else if (msg.type === 'preflight_error') {
        setPlaying(false); setPlayingGroupName(null); setCurrentStepId(null);
        Modal.error({
          title: t('scenario.deviceCheckFailed'),
          content: (
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              {(msg.errors || []).map((e: string, i: number) => (
                <div key={i} style={{ padding: '4px 0', color: '#ff4d4f' }}>• {e}</div>
              ))}
            </div>
          ),
        });
        ws.close();
      } else if (msg.type === 'error') {
        if (liveDurationRef.current) { clearInterval(liveDurationRef.current); liveDurationRef.current = null; }
        setPlaying(false); setPlayingGroupName(null); setCurrentStepId(null); resumeScreenStream();
        message.error(msg.message); ws.close();
        if (doAutoRecord && webcamRecordingActiveRef.current) { webcam.stopRecordingAuto(); webcamRecordingActiveRef.current = false; webcamBlobsRef.current = []; }
      } else if (msg.type === 'playback_stopped') {
        if (liveDurationRef.current) { clearInterval(liveDurationRef.current); liveDurationRef.current = null; }
        setPlaying(false); setPaused(false); setPlayingGroupName(null); setCurrentStepId(null); resumeScreenStream();
        const resultFilename = msg.result_filename || '';
        if (resultFilename) {
          message.info(t('scenario.playStoppedPartial'));
          if (doAutoRecord && webcamRecordingActiveRef.current) {
            webcam.stopRecordingAuto().then(async () => {
              webcamRecordingActiveRef.current = false;
              if (webcamBlobsRef.current.length > 0) {
                for (const item of webcamBlobsRef.current) {
                  try { await resultsApi.uploadRecording(item.blob, resultFilename, item.repeatIndex); } catch { /* ignore */ }
                }
              }
              webcamBlobsRef.current = [];
            });
          }
        } else {
          message.info(t('scenario.playStopped'));
          if (doAutoRecord && webcamRecordingActiveRef.current) { webcam.stopRecordingAuto(); webcamRecordingActiveRef.current = false; webcamBlobsRef.current = []; }
        }
        ws.close();
      } else if (msg.type === 'playback_paused') {
        setPaused(true);
        if (liveDurationRef.current) { clearInterval(liveDurationRef.current); liveDurationRef.current = null; }
        if (doAutoRecord && webcamRecordingActiveRef.current) webcam.pauseRecording();
        pauseScreenStream();
      } else if (msg.type === 'playback_resumed') {
        setPaused(false);
        if (doAutoRecord && webcamRecordingActiveRef.current) webcam.resumeRecording();
        resumeScreenStream();
      }
    };
    ws.onerror = () => { if (liveDurationRef.current) { clearInterval(liveDurationRef.current); liveDurationRef.current = null; } setPlaying(false); setPaused(false); setPlayingGroupName(null); setCurrentStepId(null); message.error(t('scenario.websocketFailed')); };
    ws.onclose = () => { wsRef.current = null; };
  };

  const stopPlayback = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: 'stop' }));
    }
  };

  const pausePlayback = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: 'pause' }));
    }
  };

  const resumePlayback = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: 'resume' }));
    }
  };

  // --- Columns ---
  const expectedImageUrl = (scenarioName: string, filename: string | null) => {
    if (!filename) return null;
    return '/screenshots/' + scenarioName + '/' + filename;
  };

  const scenarioStepColumns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 60 },
    { title: 'Remark', dataIndex: 'description', key: 'description', ellipsis: true },
    { title: t('common.type'), dataIndex: 'type', key: 'type', render: (val: string, row: any) => <Tag color={val === 'module_command' ? 'geekblue' : undefined}>{val === 'module_command' ? (row.params?.module || val) : val}</Tag> },
    { title: t('scenario.device'), dataIndex: 'device_id', key: 'device_id', width: 120, render: (v: string) => v ? <Tag color={v.startsWith('Android') ? 'green' : v.startsWith('Serial') ? 'purple' : 'geekblue'}>{v}</Tag> : '-' },
    {
      title: t('scenario.expectedImage'), dataIndex: 'expected_image', key: 'expected_image', width: 90,
      render: (v: string | null) => {
        const url = selectedScenario ? expectedImageUrl(selectedScenario.name, v) : null;
        return url ? <Image src={url} alt="expected" style={{ maxHeight: 60, maxWidth: 60 }} /> : '-';
      },
    },
    { title: t('scenario.parameters'), dataIndex: 'params', key: 'params', render: (p: any) => <code style={{ fontSize: 11 }}>{JSON.stringify(p)}</code> },
    { title: t('scenario.delay'), dataIndex: 'delay_after_ms', key: 'delay', width: 80, render: (v: number) => `${v}ms` },
  ];

  const playbackSteps = playbackScenario?.steps || [];
  const passCount = stepResults.filter((r) => r.status === 'pass').length;
  const failCount = stepResults.filter((r) => r.status === 'fail').length;
  const errorCount = stepResults.filter((r) => r.status === 'error').length;

  const makeStepResultColumns = (totalRepeat: number) => [
    { title: <div>Time Stamp<br /><span style={{ fontSize: 11, color: '#888' }}>{t('scenario.colTimestamp')}</span></div>, dataIndex: 'timestamp', key: 'timestamp', width: 150, render: (v: string | null) => v ? formatTime(v, lang) : '-' },
    { title: <div>Repeat<br /><span style={{ fontSize: 11, color: '#888' }}>{t('scenario.colCurrentTotal')}</span></div>, dataIndex: 'repeat_index', key: 'repeat', width: 75, align: 'center' as const, render: (v: number) => `${v}/${totalRepeat}` },
    { title: <div>Step<br /><span style={{ fontSize: 11, color: '#888' }}>{t('scenario.colOrder')}</span></div>, dataIndex: 'step_id', key: 'step_id', width: 55, align: 'center' as const },
    { title: <div>Device<br /><span style={{ fontSize: 11, color: '#888' }}>{t('scenario.colDevice')}</span></div>, dataIndex: 'device_id', key: 'device_id', width: 120, render: (v: string) => v ? <Tag color={v.startsWith('Android') ? 'green' : v.startsWith('Serial') ? 'purple' : 'geekblue'}>{v}</Tag> : '-' },
    { title: <div>Command<br /><span style={{ fontSize: 11, color: '#888' }}>action</span></div>, dataIndex: 'command', key: 'command', ellipsis: true, render: (v: string, r: StepResultData) => v || r.message || '-' },
    { title: <div>Remark<br /><span style={{ fontSize: 11, color: '#888' }}>{t('common.description')}</span></div>, dataIndex: 'description', key: 'description', width: 150, ellipsis: true, render: (v: string) => v || '-' },
    { title: <div>Status<br /><span style={{ fontSize: 11, color: '#888' }}>{t('common.result')}</span></div>, dataIndex: 'status', key: 'status', width: 90, align: 'center' as const, render: (s: string) => s === 'running' ? <Tag color="processing">RUNNING</Tag> : <Tag color={statusColor(s)}>{s.toUpperCase()}</Tag> },
    { title: <div>Delay<br /><span style={{ fontSize: 11, color: '#888' }}>{t('scenario.colSetting')}</span></div>, dataIndex: 'delay_ms', key: 'delay', width: 80, align: 'center' as const, render: (ms: number) => ms ? formatDuration(ms) : '-' },
    { title: <div>Duration<br /><span style={{ fontSize: 11, color: '#888' }}>{t('scenario.colActual')}</span></div>, dataIndex: 'execution_time_ms', key: 'duration', width: 90, align: 'center' as const, render: (ms: number, r: StepResultData) => r.status === 'running' ? <span style={{ color: '#1677ff' }}>{formatDuration(liveDuration)}</span> : formatDuration(ms) },
    { title: t('scenario.compare'), key: 'compare', width: 70, align: 'center' as const, render: (_: any, r: StepResultData) => {
      if (r.status === 'running') return '-';
      const hasCmdMsg = (r.command?.startsWith('cmd_send:') || r.command?.startsWith('cmd_check:')) && r.message;
      if (r.expected_image || r.actual_image || hasCmdMsg) {
        return <Button size="small" onClick={() => setCompareStep(r)}>{hasCmdMsg && !r.expected_image ? 'CMD' : t('scenario.compare')}</Button>;
      }
      return '-';
    }},
  ];

  const totalTime = (steps: StepResultData[]) => steps.reduce((sum, s) => sum + (s.execution_time_ms || 0), 0);

  const CompareImage = ({ src, roi, alt }: { src: string; roi: ROI | null; alt: string }) => {
    const cRef = useRef<HTMLCanvasElement>(null);
    const [loaded, setLoaded] = useState(false);
    useEffect(() => {
      if (!roi) { setLoaded(false); return; }
      const img = new window.Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { const canvas = cRef.current; if (!canvas) return; canvas.width = roi.width; canvas.height = roi.height; const ctx = canvas.getContext('2d'); if (!ctx) return; ctx.drawImage(img, roi.x, roi.y, roi.width, roi.height, 0, 0, roi.width, roi.height); setLoaded(true); };
      img.onerror = () => setLoaded(false);
      img.src = src;
    }, [src, roi]);
    if (!roi) return <Image src={src} alt={alt} style={{ width: '100%' }} fallback="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iIzMzMyIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmaWxsPSIjOTk5IiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LXNpemU9IjE0Ij5ObyBJbWFnZTwvdGV4dD48L3N2Zz4=" />;
    return <canvas ref={cRef} style={{ width: '100%', borderRadius: 4, display: loaded ? 'block' : 'none' }} />;
  };

  // Group names for the selected scenario
  const scenarioGroups = (name: string) =>
    Object.entries(groups).filter(([, members]) => members.some((m) => m.name === name)).map(([g]) => g);

  return (
    <div style={{ height: 'calc(100vh - 80px)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* 최상단: 도구 버튼 우측 정렬 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, padding: '4px 0', flexShrink: 0 }}>
        <Button icon={<FolderOutlined />} size="small" onClick={() => {
          setGroupModalVisible(true);
          const allNames = Object.values(groups).flatMap((ms) => ms.map((m) => m.name));
          if (allNames.length > 0) fetchScenarioStepsCache(allNames);
        }}>{t('scenario.groupManage')}</Button>
        <Button icon={<MergeCellsOutlined />} size="small" onClick={openMergeModal}>{t('scenario.mergeTitle')}</Button>
        <Button icon={<ExportOutlined />} size="small" onClick={() => { setExportSelectedScenarios([]); setExportSelectedGroups([]); setExportAll(false); setExportModalVisible(true); }}>{t('scenario.exportTitle')}</Button>
        <Button icon={<ImportOutlined />} size="small" onClick={() => { setImportFile(null); setImportPreviewData(null); setImportModalVisible(true); }}>{t('scenario.importTitle')}</Button>
        <Button onClick={() => { fetchScenarios(); fetchGroups(); }} size="small">{t('common.refresh')}</Button>
      </div>
      <Splitter style={{ flex: 1, minHeight: 0 }}>
      <Splitter.Panel defaultSize="40%" min="20%" max="60%" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Card
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        styles={{ body: { flex: 1, overflow: 'auto', padding: '8px 12px' } }}
        title={t('scenario.title')}
      >
        <Tabs
          activeKey={selectedGroup ?? '__all__'}
          onChange={(key) => setSelectedGroup(key === '__all__' ? null : key)}
          size="small"
          tabBarStyle={{ marginBottom: 8 }}
          items={[
            { key: '__all__', label: `${t('scenario.all')} (${scenarios.length})` },
            { key: '__groups__', label: `${t('scenario.groupLabel')} (${Object.keys(groups).length})` },
          ]}
        />

        {selectedGroup === '__groups__' ? (
          /* ===== 그룹 리스트 ===== */
          <List
            size="small"
            dataSource={Object.entries(groups)}
            style={{ overflow: 'auto' }}
            locale={{ emptyText: t('scenario.noGroups') }}
            renderItem={([gName, members]) => {
              const validCount = members.filter((m) => scenarios.includes(m.name)).length;
              return (
                <List.Item
                  onClick={() => { setSelectedGroup(gName); }}
                  style={{
                    cursor: 'pointer',
                    padding: '6px 12px',
                    borderRadius: 4,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                    <FolderOutlined style={{ color: '#1677ff' }} />
                    <span style={{ flex: 1, fontWeight: 500 }}>{gName}</span>
                    <Tag color="blue">{validCount}</Tag>
                    {validCount > 0 && !playing && (
                      <Tooltip title={t('scenario.playGroupAll', { name: gName })}>
                        <PlayCircleOutlined
                          onClick={(e) => { e.stopPropagation(); playGroup(gName); }}
                          style={{ color: '#1677ff' }}
                        />
                      </Tooltip>
                    )}
                  </div>
                </List.Item>
              );
            }}
          />
        ) : selectedGroup && selectedGroup !== '__all__' ? (
          /* ===== 그룹 상세 (멤버 목록 + 재생) ===== */
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Button size="small" onClick={() => setSelectedGroup('__groups__')}>{t('common.back')}</Button>
              <FolderOutlined style={{ color: '#1677ff' }} />
              <span style={{ fontWeight: 600 }}>{selectedGroup}</span>
              <span style={{ color: '#888', fontSize: 12 }}>({(groups[selectedGroup] || []).length})</span>
              <span style={{ flex: 1 }} />
              <InputNumber
                min={1} max={999} size="small"
                value={getRepeatCount(selectedGroup)}
                onChange={(v) => setRepeatCount(selectedGroup, v || 1)}
                style={{ width: 60 }}
                disabled={playing}
              />
              <span style={{ fontSize: 12, color: '#888' }}>{t('scenario.times')}</span>
              {playing && playingGroupName === selectedGroup ? (
                <Button danger size="small" icon={<StopOutlined />} onClick={stopPlayback}>{t('scenario.stop')}</Button>
              ) : (
                <Button type="primary" size="small" icon={<PlayCircleOutlined />}
                  disabled={playing}
                  onClick={() => playGroup(selectedGroup)}
                >
                  {t('scenario.play')}
                </Button>
              )}
            </div>
            <List
              size="small"
              dataSource={(groups[selectedGroup] || []).filter((m) => scenarios.includes(m.name))}
              style={{ overflow: 'auto' }}
              renderItem={(m, idx) => (
                <List.Item
                  onClick={() => {
                    setSelectedName(prev => prev === m.name ? null : m.name);
                    if (!playing) { setStepResults([]); setPlaybackScenario(null); }
                  }}
                  style={{
                    cursor: 'pointer',
                    padding: '6px 12px',
                    background: selectedName === m.name ? 'rgba(22,119,255,0.12)' : undefined,
                    borderRadius: 4,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                    <Tag style={{ margin: 0 }}>{idx + 1}</Tag>
                    <span style={{ flex: 1, fontWeight: selectedName === m.name ? 600 : 400 }}>{m.name}</span>
                  </div>
                </List.Item>
              )}
            />
          </>
        ) : (
          <>
          {/* ===== 트리 형식 시나리오 리스트 ===== */}
          {(() => {
            // 폴더에 속한 시나리오 Set
            const foldered = new Set<string>();
            for (const items of Object.values(folders)) items.forEach(n => foldered.add(n));
            // 트리 데이터 생성
            const treeData: any[] = [];
            // 폴더 노드
            for (const [fname, items] of Object.entries(folders)) {
              treeData.push({
                key: `folder:${fname}`,
                title: fname,
                icon: <FolderOutlined />,
                isLeaf: false,
                children: items.filter(n => filteredScenarios.includes(n)).map(n => ({
                  key: `scenario:${n}`,
                  title: n,
                  icon: <FileOutlined />,
                  isLeaf: true,
                })),
              });
            }
            // 루트 시나리오 (폴더에 속하지 않은 것)
            for (const name of filteredScenarios) {
              if (!foldered.has(name)) {
                treeData.push({ key: `scenario:${name}`, title: name, icon: <FileOutlined />, isLeaf: true });
              }
            }

            const onSelect: TreeProps['onSelect'] = (keys) => {
              if (keys.length === 0) { setSelectedName(null); return; }
              const key = keys[0] as string;
              if (key.startsWith('scenario:')) {
                const name = key.replace('scenario:', '');
                setSelectedName(name);
                if (!playing) { setStepResults([]); setPlaybackScenario(null); }
              }
            };

            const onDrop: TreeProps['onDrop'] = (info) => {
              const dragKey = info.dragNode.key as string;
              if (!dragKey.startsWith('scenario:')) return;
              const scenarioName = dragKey.replace('scenario:', '');
              const dropKey = (info.node.key as string);
              const folderName = dropKey.startsWith('folder:') ? dropKey.replace('folder:', '') : null;
              scenarioApi.moveToFolder(scenarioName, folderName).then(res => setFolders(res.data.folders)).catch(() => {});
            };

            const onRightClick = ({ event, node }: any) => {
              event.preventDefault();
              const key = node.key as string;
              const type = key.startsWith('folder:') ? 'folder' as const : 'scenario' as const;
              const name = key.replace(/^(folder|scenario):/, '');
              setContextMenu({ x: event.clientX, y: event.clientY, type, name });
            };

            const contextMenuItems = contextMenu ? (
              contextMenu.type === 'folder' ? [
                { key: 'rename', label: t('common.rename'), onClick: () => {
                  const newName = prompt(t('scenario.folderName'), contextMenu.name);
                  if (newName && newName !== contextMenu.name) {
                    scenarioApi.renameFolder(contextMenu.name, newName).then(res => setFolders(res.data.folders));
                  }
                  setContextMenu(null);
                }},
                { key: 'delete', label: t('common.delete'), danger: true, onClick: () => {
                  scenarioApi.deleteFolder(contextMenu.name).then(res => setFolders(res.data.folders));
                  setContextMenu(null);
                }},
              ] : [
                { key: 'copy', label: t('common.copy'), onClick: () => {
                  const newName = prompt(t('common.rename'), `${contextMenu.name}_copy`);
                  if (newName) {
                    scenarioApi.copy(contextMenu.name, newName).then(() => { fetchScenarios(); fetchFolders(); });
                  }
                  setContextMenu(null);
                }},
                { key: 'rename', label: t('common.rename'), onClick: () => {
                  const newName = prompt(t('common.rename'), contextMenu.name);
                  if (newName && newName !== contextMenu.name) {
                    scenarioApi.rename(contextMenu.name, newName).then(() => { fetchScenarios(); fetchFolders(); });
                    if (selectedName === contextMenu.name) setSelectedName(newName);
                  }
                  setContextMenu(null);
                }},
                { key: 'moveRoot', label: t('scenario.moveToRoot'), onClick: () => {
                  scenarioApi.moveToFolder(contextMenu.name, null).then(res => setFolders(res.data.folders));
                  setContextMenu(null);
                }},
                ...Object.keys(folders).map(fn => ({
                  key: `move:${fn}`, label: `→ ${fn}`, onClick: () => {
                    scenarioApi.moveToFolder(contextMenu.name, fn).then(res => setFolders(res.data.folders));
                    setContextMenu(null);
                  },
                })),
                { type: 'divider' as const },
                { key: 'delete', label: t('common.delete'), danger: true, onClick: () => {
                  Modal.confirm({
                    title: t('scenario.deleteTitle'), okText: t('common.delete'), okType: 'danger', cancelText: t('common.cancel'),
                    onOk: () => { scenarioApi.delete(contextMenu.name).then(() => { fetchScenarios(); fetchFolders(); }); if (selectedName === contextMenu.name) setSelectedName(null); },
                  });
                  setContextMenu(null);
                }},
              ]
            ) : [];

            return (
              <>
                <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                  <Button size="small" icon={<FolderAddOutlined />} onClick={() => {
                    const name = prompt(t('scenario.folderName'));
                    if (name) scenarioApi.createFolder(name).then(res => setFolders(res.data.folders));
                  }}>{t('scenario.newFolder')}</Button>
                </div>
                <Dropdown
                  menu={{ items: contextMenuItems }}
                  open={!!contextMenu}
                  onOpenChange={(v) => { if (!v) setContextMenu(null); }}
                  trigger={['contextMenu']}
                >
                  <div style={{ flex: 1, overflow: 'auto' }} onContextMenu={(e) => { if (!contextMenu) e.preventDefault(); }}>
                    <Tree
                      treeData={treeData}
                      selectedKeys={selectedName ? [`scenario:${selectedName}`] : []}
                      onSelect={onSelect}
                      draggable
                      onDrop={onDrop}
                      onRightClick={onRightClick}
                      showIcon
                      blockNode
                      defaultExpandAll
                    />
                    {treeData.length === 0 && <div style={{ padding: 16, textAlign: 'center', color: '#888' }}>{t('scenario.noScenarios')}</div>}
                  </div>
                </Dropdown>
              </>
            );
          })()}
          </>
        )}

      </Card>
      </Splitter.Panel>

      <Splitter.Panel style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <style>{`
        .row-pass td { background: rgba(82, 196, 26, 0.06) !important; }
        .row-fail td { background: rgba(255, 77, 79, 0.08) !important; }
        .row-error td { background: rgba(255, 77, 79, 0.06) !important; }
        .row-running td { background: rgba(22, 119, 255, 0.08) !important; }
      `}</style>

      {/* ===== 스텝 패널 (미리보기 + 재생 통합) ===== */}
      {(selectedName && previewSteps.length > 0) || ((playing || stepResults.length > 0) && playbackScenario) ? (
        <Card
          size="small"
          style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          title={
            (playing || stepResults.length > 0) && playbackScenario ? (
              <Space size={4} wrap>
                <span>{t('scenario.play')}: {playingGroupName ? `[${playingGroupName}]` : ''} {currentGroupScenario || playbackScenario.name}</span>
                {playingGroupName && groupScenarioTotal > 0 && <Tag color="cyan">{groupScenarioIndex}/{groupScenarioTotal} {t('scenario.title')}</Tag>}
                {totalIterations > 1 && <Tag color="purple">{currentIteration} / {totalIterations}{t('scenario.times')}</Tag>}
                {playing && !paused && <Tag color="processing">{t('scenario.inProgress')}</Tag>}
                {paused && <Tag color="warning">PAUSED</Tag>}
                {!playing && stepResults.length > 0 && <Tag color={failCount + errorCount > 0 ? 'red' : 'green'}>{t('scenario.complete')}</Tag>}
              </Space>
            ) : (
              <Space size={4} wrap>
                <strong>{selectedName}</strong>
                <span style={{ fontWeight: 400 }}>— {previewSteps.length} {t('scenario.steps')}</span>
                {skipStepIds.size > 0 && <Tag color="orange">{skipStepIds.size} skip</Tag>}
                {playing && playingName === selectedName ? (
                  <Button danger size="small" icon={<StopOutlined />} onClick={stopPlayback}>{t('scenario.stop')}</Button>
                ) : (
                  <>
                    <InputNumber min={1} max={999} size="small" value={getRepeatCount(selectedName!)} onChange={(v) => setRepeatCount(selectedName!, v || 1)} style={{ width: 60 }} disabled={playing} />
                    <span style={{ fontSize: 12, fontWeight: 400 }}>{t('scenario.times')}</span>
                    <Button type="primary" size="small" icon={<PlayCircleOutlined />} loading={playing && playingName === selectedName} disabled={playing} onClick={() => playScenario(selectedName!)}>{t('scenario.play')}</Button>
                  </>
                )}
              </Space>
            )
          }
          styles={{ ...({ body: { flex: 1, overflow: 'auto' } }), header: { flexWrap: 'wrap', height: 'auto', minHeight: 40, padding: '4px 12px' } }}
          extra={
            (playing || stepResults.length > 0) ? (
              <Space>
                {playing && !paused && <Button size="small" icon={<PauseOutlined />} onClick={pausePlayback}>일시정지</Button>}
                {playing && paused && <Button type="primary" size="small" icon={<PlayCircleOutlined />} onClick={resumePlayback}>재개</Button>}
                {playing && <Button danger size="small" icon={<StopOutlined />} onClick={stopPlayback}>{t('scenario.stop')}</Button>}
                <span>Pass: {passCount}</span><span>Fail: {failCount}</span><span>Error: {errorCount}</span><span>/ {playbackSteps.length} {t('scenario.steps')}</span>
              </Space>
            ) : undefined
          }
        >
          {(playing || stepResults.length > 0) ? (
            /* 재생 중 / 완료: 결과 테이블 (스텝만 스크롤, 자동 최하단) */
            <div style={{ flex: 1, overflow: 'auto' }}>
            <Table columns={makeStepResultColumns(totalIterations)} dataSource={playing ? [...stepResults].reverse() : stepResults} rowKey={(_r, idx) => `${idx}`} size="small" pagination={false}
              rowClassName={(r: StepResultData) => r.status === 'running' ? 'row-running' : r.status === 'fail' ? 'row-fail' : r.status === 'error' ? 'row-error' : r.status === 'pass' ? 'row-pass' : ''} />
            </div>
          ) : (
            /* 미리보기: 스텝 편집 테이블 */
            <div style={{ flex: 1, overflow: 'auto' }}>
              <Table
                size="small"
                pagination={false}
                dataSource={previewSteps}
                rowKey="id"
                rowClassName={(r: any) => skipStepIds.has(r.id) ? 'row-skip' : ''}
                columns={[
                  {
                    title: <Checkbox
                      checked={skipStepIds.size === 0}
                      indeterminate={skipStepIds.size > 0 && skipStepIds.size < previewSteps.length}
                      onChange={(e) => {
                        if (e.target.checked) setSkipStepIds(new Set());
                        else setSkipStepIds(new Set(previewSteps.map((s: any) => s.id)));
                      }}
                    />,
                    key: 'check', width: 32, align: 'center' as const,
                    render: (_: any, r: any) => (
                      <Checkbox
                        checked={!skipStepIds.has(r.id)}
                        onChange={(e) => {
                          setSkipStepIds(prev => {
                            const next = new Set(prev);
                            if (e.target.checked) next.delete(r.id);
                            else next.add(r.id);
                            return next;
                          });
                        }}
                      />
                    ),
                  },
                  { title: '#', dataIndex: 'id', key: 'id', width: 32, align: 'center' as const },
                  { title: 'Type', dataIndex: 'type', key: 'type', width: 'auto' as any, ellipsis: true, render: (v: string, row: any) => <Tag color={v === 'module_command' ? 'geekblue' : undefined} style={{ margin: 0 }}>{v === 'module_command' ? (row.params?.module || v) : v}</Tag> },
                  { title: 'Device', dataIndex: 'device_id', key: 'device', ellipsis: true, render: (v: string) => v ? <Tag color="blue" style={{ margin: 0 }}>{v}</Tag> : '-' },
                  { title: t('common.description'), dataIndex: 'description', key: 'desc', ellipsis: true },
                  {
                    title: 'Delay', dataIndex: 'delay_after_ms', key: 'delay', width: 80, align: 'center' as const,
                    render: (v: number, _r: any, idx: number) => {
                      const isWait = _r.type === 'wait';
                      const displayVal = isWait ? (_r.params?.duration_ms ?? v) : v;
                      return (
                        <InputNumber
                          size="small" min={0} step={100} value={displayVal} style={{ width: 70 }}
                          onChange={(val) => {
                            const updated = [...previewSteps];
                            if (isWait) {
                              updated[idx] = { ...updated[idx], params: { ..._r.params, duration_ms: val ?? 0 } };
                              setPreviewSteps(updated);
                              scenarioApi.updateStep(selectedName!, idx, { params: { ..._r.params, duration_ms: val ?? 0 } }).catch(() => {});
                            } else {
                              updated[idx] = { ...updated[idx], delay_after_ms: val ?? 0 };
                              setPreviewSteps(updated);
                              scenarioApi.updateStep(selectedName!, idx, { delay_after_ms: val ?? 0 }).catch(() => {});
                            }
                          }}
                        />
                      );
                    },
                  },
                  { title: t('scenario.compare'), key: 'img', render: (_: any, r: any) => {
                    if (!r.expected_image) return '-';
                    const imgSrc = `/screenshots/${selectedName}/${r.expected_image}?v=${r.id}`;
                    const mode = r.compare_mode;
                    const regions: { x: number; y: number; width: number; height: number }[] = [];
                    let regionColor = '#52c41a';
                    if (mode === 'single_crop' && r.roi) {
                      regions.push(r.roi);
                    } else if (mode === 'multi_crop' && r.expected_images?.length) {
                      r.expected_images.forEach((ci: any) => { if (ci.roi) regions.push(ci.roi); });
                    } else if (mode === 'full_exclude' && r.exclude_rois?.length) {
                      r.exclude_rois.forEach((roi: any) => regions.push(roi));
                      regionColor = '#ff4d4f';
                    }
                    if (regions.length === 0) {
                      return <Image src={imgSrc} alt="expected" style={{ height: 32, maxWidth: 80, objectFit: 'contain', borderRadius: 2 }} preview={{ mask: false }} />;
                    }
                    return (
                      <ExpectedThumbnail src={imgSrc} regions={regions} color={regionColor} height={32} />
                    );
                  }},
                ]}
              />
              <style>{`.row-skip td { opacity: 0.35; }`}</style>
            </div>
          )}
        </Card>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#999' }}>
          {t('scenario.selectToView')}
        </div>
      )}
      </Splitter.Panel>
      </Splitter>

      {/* ===== 그룹 관리 모달 ===== */}
      <Modal title={t('scenario.groupManage')} open={groupModalVisible} onCancel={() => setGroupModalVisible(false)} footer={null} width={960}
        styles={{ body: { maxHeight: '75vh', overflowY: 'auto' } }}
      >
        <Space style={{ marginBottom: 8 }}>
          <Input
            placeholder={t('scenario.newGroupName')}
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onPressEnter={createGroup}
            style={{ width: 200 }}
          />
          <Button icon={<FolderAddOutlined />} type="primary" onClick={createGroup}>{t('scenario.create')}</Button>
        </Space>
        <Collapse
          accordion
          items={Object.entries(groups).map(([gName, members]) => ({
            key: gName,
            label: (
              <Space>
                <FolderOutlined />
                <span>{gName}</span>
                <Tag>{members.length}</Tag>
              </Space>
            ),
            extra: (
              <Button size="small" danger icon={<DeleteOutlined />} onClick={(e) => { e.stopPropagation(); deleteGroup(gName); }}>{t('common.delete')}</Button>
            ),
            children: (
              <>
                <List
                  size="small"
                  dataSource={members}
                  locale={{ emptyText: t('scenario.noScenarios') }}
                  renderItem={(entry, idx) => {
                    const entryKey = `${gName}:${idx}`;
                    const isExpanded = expandedEntries.has(entryKey);
                    const steps = scenarioStepsCache[entry.name] || [];
                    const stepJumps = entry.step_jumps || {};
                    const hasAnyJump = Object.keys(stepJumps).length > 0;

                    // Shared jump selector renderer
                    const renderJumpRow = (
                      jumpLabel: string, jumpColor: string,
                      passGoto: JumpTarget | null, failGoto: JumpTarget | null,
                      onUpdate: (pg: JumpTarget | null, fg: JumpTarget | null) => void,
                      field: 'pass' | 'fail',
                    ) => {
                      const jump = field === 'pass' ? passGoto : failGoto;
                      const targetSteps = jump && jump.scenario >= 0 ? (scenarioStepsCache[members[jump.scenario]?.name] || []) : [];
                      return (
                        <div key={field} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, flexWrap: 'wrap' }}>
                          <span style={{ color: jumpColor, minWidth: 32 }}>{jumpLabel}</span>
                          <Select
                            size="small"
                            style={{ width: 140 }}
                            value={jump ? jump.scenario : undefined}
                            allowClear
                            placeholder={t('scenario.nextTo')}
                            onChange={(v) => {
                              const newJump = v == null ? null : { scenario: v as number, step: 0 };
                              if (field === 'pass') onUpdate(newJump, failGoto);
                              else onUpdate(passGoto, newJump);
                            }}
                          >
                            <Select.Option value={-1}>{t('scenario.end')} (END)</Select.Option>
                            {members.map((m, mi) => (
                              <Select.Option key={mi} value={mi}>#{mi + 1} {m.name}</Select.Option>
                            ))}
                          </Select>
                          {jump && jump.scenario >= 0 && targetSteps.length > 0 && (
                            <Select
                              size="small"
                              style={{ minWidth: 180, flex: 1 }}
                              value={jump.step}
                              onChange={(stepVal) => {
                                const newJump = { scenario: jump.scenario, step: stepVal as number };
                                if (field === 'pass') onUpdate(newJump, failGoto);
                                else onUpdate(passGoto, newJump);
                              }}
                            >
                              {targetSteps.map((s: any, si: number) => (
                                <Select.Option key={si} value={si}>{formatStepLabel(s, si)}</Select.Option>
                              ))}
                            </Select>
                          )}
                        </div>
                      );
                    };

                    return (
                      <List.Item style={{ display: 'block', padding: '6px 0' }}>
                        {/* 시나리오 헤더 */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Tag color="blue" style={{ minWidth: 24, textAlign: 'center' }}>{idx + 1}</Tag>
                          <Button size="small" type="text" style={{ padding: '0 2px', fontSize: 11, color: '#888' }}
                            icon={isExpanded ? <DownOutlined /> : <RightOutlined />}
                            onClick={() => { toggleExpandEntry(entryKey); if (!isExpanded && steps.length === 0) fetchScenarioStepsCache([entry.name]); }}
                          />
                          <span style={{ flex: 1, fontWeight: 500 }}>{entry.name}</span>
                          {!scenarios.includes(entry.name) && <Tag color="red">{t('scenario.missing')}</Tag>}
                          {hasAnyJump && <BranchesOutlined style={{ color: '#722ed1', fontSize: 13 }} />}
                          <span style={{ color: '#888', fontSize: 11 }}>{steps.length} {t('scenario.steps')}</span>
                          <Button size="small" type="text" icon={<ArrowUpOutlined />}
                            disabled={idx === 0}
                            onClick={() => moveInGroup(gName, members, idx, -1)}
                          />
                          <Button size="small" type="text" icon={<ArrowDownOutlined />}
                            disabled={idx === members.length - 1}
                            onClick={() => moveInGroup(gName, members, idx, 1)}
                          />
                          <Button size="small" type="text" danger icon={<DeleteOutlined />}
                            onClick={() => removeFromGroup(gName, entry.name)}
                          />
                        </div>

                        {/* 펼쳐진 스텝 목록 */}
                        {isExpanded && (
                          <div style={{ paddingLeft: 36, marginTop: 6, borderLeft: '2px solid #303030', marginLeft: 18 }}>
                            <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{t('scenario.stepConditionalJump')}:</div>
                            {steps.length === 0 && <div style={{ color: '#666', fontSize: 12, padding: 4 }}>{t('scenario.stepsLoading')}</div>}
                            {steps.map((step: any, si: number) => {
                              const sid = step.id;
                              const sj = stepJumps[String(sid)] || { on_pass_goto: null, on_fail_goto: null };
                              const hasSJ = sj.on_pass_goto != null || sj.on_fail_goto != null;
                              return (
                                <div key={si} style={{ marginBottom: 4, padding: '3px 0', borderBottom: '1px solid #222' }}>
                                  <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <Tag style={{ fontSize: 11, margin: 0, minWidth: 20, textAlign: 'center' }}>{sid}</Tag>
                                    <span style={{ flex: 1, color: hasSJ ? '#d89614' : '#ccc' }}>{formatStepLabel(step, si)}</span>
                                    {hasSJ && <BranchesOutlined style={{ color: '#d89614', fontSize: 11 }} />}
                                  </div>
                                  <div style={{ paddingLeft: 28, display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
                                    {renderJumpRow('P→', '#52c41a', sj.on_pass_goto, sj.on_fail_goto,
                                      (pg, fg) => updateGroupStepJumps(gName, idx, sid, pg, fg), 'pass')}
                                    {renderJumpRow('F→', '#ff4d4f', sj.on_pass_goto, sj.on_fail_goto,
                                      (pg, fg) => updateGroupStepJumps(gName, idx, sid, pg, fg), 'fail')}
                                    {hasSJ && (
                                      <Button size="small" type="link" danger style={{ fontSize: 11, padding: 0, alignSelf: 'flex-start' }}
                                        icon={<ClearOutlined />}
                                        onClick={() => updateGroupStepJumps(gName, idx, sid, null, null)}
                                      >{t('scenario.reset')}</Button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </List.Item>
                    );
                  }}
                />
                <Select
                  placeholder={t('scenario.addScenario')}
                  size="small"
                  style={{ width: '100%', marginTop: 8 }}
                  value={undefined}
                  onChange={(sName: string) => { if (sName) addToGroup(gName, sName); }}
                  options={scenarios.filter((n) => !members.some((m) => m.name === n)).map((n) => ({ label: n, value: n }))}
                />
              </>
            ),
          }))}
        />
        {Object.keys(groups).length === 0 && <div style={{ textAlign: 'center', color: '#888', padding: 20 }}>{t('scenario.noGroups')}</div>}
      </Modal>

      {/* ===== 복사 모달 ===== */}
      <Modal title={t('scenario.renameTitle', { name: selectedName || '' })} open={renameModalVisible} onCancel={() => setRenameModalVisible(false)} onOk={doRename} okText={t('common.change')}>
        <Input value={renameNewName} onChange={(e) => setRenameNewName(e.target.value)} placeholder={t('scenario.newScenarioName')} />
      </Modal>

      <Modal title={t('scenario.copyTitle', { name: selectedName || '' })} open={copyModalVisible} onCancel={() => setCopyModalVisible(false)} onOk={doCopy} okText={t('common.copy')}>
        <Input value={copyName} onChange={(e) => setCopyName(e.target.value)} placeholder={t('scenario.newScenarioName')} />
      </Modal>

      {/* ===== 합치기 모달 ===== */}
      <Modal title={t('scenario.mergeTitle')} open={mergeModalVisible} onCancel={() => setMergeModalVisible(false)} onOk={doMerge} okText={t('scenario.mergeTitle')} width={500}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 8, color: '#888', fontSize: 12 }}>{t('scenario.mergeInstruction')}</div>
          {mergeTargets.map((name, idx) => (
            <Space key={idx} style={{ display: 'flex', marginBottom: 4 }}>
              <Tag color="blue">{idx + 1}</Tag>
              <span>{name}</span>
              <Button size="small" icon={<MinusOutlined />} danger onClick={() => setMergeTargets((prev) => prev.filter((_, i) => i !== idx))} />
            </Space>
          ))}
          <Select
            placeholder={t('scenario.addScenario')}
            style={{ width: '100%', marginTop: 4 }}
            value={undefined}
            onChange={(v: string) => { if (v) setMergeTargets((prev) => [...prev, v]); }}
            options={scenarios.filter((n) => !mergeTargets.includes(n)).map((n) => ({ label: n, value: n }))}
          />
        </div>
        <Divider />
        <Space>
          <span style={{ color: '#888' }}>{t('scenario.nameLabel')}:</span>
          <Input value={mergeName} onChange={(e) => setMergeName(e.target.value)} placeholder={t('scenario.mergedScenarioName')} style={{ width: 300 }} />
        </Space>
      </Modal>

      {/* ===== 시나리오 상세 모달 ===== */}
      <Modal title={selectedScenario?.name || t('scenario.scenarioDetail')} open={detailVisible} onCancel={() => setDetailVisible(false)} width={900} footer={null}>
        {selectedScenario && (
          <>
            <Descriptions column={2} size="small" style={{ marginBottom: 8 }}>
              <Descriptions.Item label={t('common.description')}>{selectedScenario.description || '-'}</Descriptions.Item>
              <Descriptions.Item label={t('scenario.deviceMapping')}>
                {Object.keys(selectedScenario.device_map || {}).length > 0
                  ? Object.entries(selectedScenario.device_map).map(([alias, real]) => (
                    <Tag key={alias} color={alias.startsWith('Android') ? 'green' : alias.startsWith('Serial') ? 'purple' : 'geekblue'}>
                      {alias} → {real}
                    </Tag>
                  ))
                  : selectedScenario.device_serial || '-'}
              </Descriptions.Item>
              <Descriptions.Item label={t('scenario.resolution')}>{selectedScenario.resolution ? `${selectedScenario.resolution.width}×${selectedScenario.resolution.height}` : '-'}</Descriptions.Item>
              <Descriptions.Item label={t('scenario.stepCount')}>{selectedScenario.steps.length}</Descriptions.Item>
            </Descriptions>
            <Table columns={scenarioStepColumns} dataSource={selectedScenario.steps} rowKey="id" size="small" pagination={false} />
          </>
        )}
      </Modal>

      {/* ===== 이미지 비교 / CMD 결과 모달 ===== */}
      <Modal title={t('scenario.stepCompare', { id: String(compareStep?.step_id) })} open={!!compareStep} onCancel={() => setCompareStep(null)} width={1100} footer={null} zIndex={1100}>
        {compareStep && (() => {
          const _isCmdStep = compareStep.command?.startsWith('cmd_send:') || compareStep.command?.startsWith('cmd_check:');
          const _msg = compareStep.message || '';
          const _isCmdCheck = _msg.startsWith('[CMD_CHECK]');

          // CMD 결과 렌더링 함수
          const renderCmdResult = () => {
            if (!_isCmdStep || !_msg) return null;
            if (_isCmdCheck) {
              const simIdx = _msg.indexOf('\n[SIMILARITY]\n');
              const cmdPart = simIdx >= 0 ? _msg.substring(0, simIdx) : _msg;
              const lines = cmdPart.split('\n');
              const expectLine = lines[1] || '';
              const sepIdx = lines.indexOf('---');
              const output = lines.slice(sepIdx + 1).join('\n');
              const em = expectLine.match(/expected\((.*?)\):\s*(.*)/);
              const matchMode = em?.[1] || 'contains';
              const expectedVal = em?.[2] || '';
              const cmdPassed = matchMode === 'exact' ? output.trim() === expectedVal.trim() : output.includes(expectedVal);
              // 하이라이트
              const parts: React.ReactNode[] = [];
              if (expectedVal && output) {
                let rem = output; let k = 0;
                while (rem.length > 0) {
                  const fi = rem.indexOf(expectedVal);
                  if (fi === -1) { parts.push(<span key={k}>{rem}</span>); break; }
                  if (fi > 0) parts.push(<span key={k++}>{rem.substring(0, fi)}</span>);
                  parts.push(<span key={k++} style={{ background: '#faad14', color: '#000', fontWeight: 'bold', padding: '0 2px', borderRadius: 2 }}>{expectedVal}</span>);
                  rem = rem.substring(fi + expectedVal.length);
                }
              } else { parts.push(<span key={0}>{output}</span>); }
              return (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ marginBottom: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Tag color={cmdPassed ? 'green' : 'red'} style={{ margin: 0 }}>CMD {cmdPassed ? 'PASS' : 'FAIL'}</Tag>
                    <span style={{ color: '#888' }}>{matchMode === 'exact' ? 'Exact' : 'Contains'}:</span>
                    <strong style={{ color: cmdPassed ? '#52c41a' : '#ff4d4f' }}>{expectedVal}</strong>
                  </div>
                  <div style={{
                    padding: '8px 10px', borderRadius: 4, fontSize: 12, fontFamily: 'monospace',
                    background: cmdPassed ? '#122010' : '#2a1215',
                    border: `1px solid ${cmdPassed ? '#274916' : '#5c2024'}`,
                    color: '#d9d9d9', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 400, overflow: 'auto',
                  }}>{parts}</div>
                </div>
              );
            }
            // CMD_SEND 결과
            return (
              <div style={{
                marginBottom: 12, padding: '8px 10px', borderRadius: 4, fontSize: 13, fontFamily: 'monospace',
                background: '#122010', border: '1px solid #274916', color: '#95de64',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 400, overflow: 'auto',
              }}>{_msg}</div>
            );
          };

          // CMD 전용 (이미지 없음)
          if (_isCmdStep && _msg && !compareStep.expected_image && !compareStep.actual_image) {
            return (
              <>
                <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Tag color={statusColor(compareStep.status)} style={{ fontSize: 14 }}>{compareStep.status.toUpperCase()}</Tag>
                  <span style={{ color: '#888', marginLeft: 'auto' }}>Duration: {formatDuration(compareStep.execution_time_ms)}</span>
                </div>
                {compareStep.command && (
                  <div style={{ marginBottom: 8, padding: '6px 10px', background: '#1a1a2e', borderRadius: 4, fontFamily: 'monospace', fontSize: 12 }}>
                    <span style={{ color: '#888' }}>$ </span><span style={{ color: '#e0e0e0' }}>{compareStep.command}</span>
                  </div>
                )}
                {renderCmdResult()}
              </>
            );
          }

          // 이미지 비교 (+ CMD 결과 겸용)
          return (
            <>
              <Space style={{ marginBottom: 8 }} wrap>
                <Tag color={statusColor(compareStep.status)}>{compareStep.status.toUpperCase()}</Tag>
                {compareStep.compare_mode && compareStep.compare_mode !== 'full' && (
                  <Tag color="purple">
                    {compareStep.compare_mode === 'single_crop' ? t('scenario.singleCrop') : compareStep.compare_mode === 'full_exclude' ? t('scenario.excludeArea') : compareStep.compare_mode === 'multi_crop' ? t('scenario.multiCrop') : compareStep.compare_mode}
                  </Tag>
                )}
                {compareStep.similarity_score != null && <span>{t('scenario.similarity')}: {(compareStep.similarity_score * 100).toFixed(2)}%</span>}
                {compareStep.match_location && <Tag color="blue">{t('scenario.matchLocation')}: ({compareStep.match_location.x},{compareStep.match_location.y}) {compareStep.match_location.width}x{compareStep.match_location.height}</Tag>}
                <span style={{ color: '#888' }}>Duration: {formatDuration(compareStep.execution_time_ms)}</span>
              </Space>
              {/* CMD 결과 (이미지 비교와 함께 있는 경우) */}
              {_isCmdStep && _msg && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ marginBottom: 4, padding: '6px 10px', background: '#1a1a2e', borderRadius: 4, fontFamily: 'monospace', fontSize: 12 }}>
                    <span style={{ color: '#888' }}>$ </span><span style={{ color: '#e0e0e0' }}>{compareStep.command}</span>
                  </div>
                  {renderCmdResult()}
                </div>
              )}
              <Row gutter={16}>
                <Col span={12}>
                  <Card size="small" title={
                    compareStep.compare_mode === 'full_exclude' ? t('scenario.expectedExclude')
                    : compareStep.compare_mode === 'multi_crop' ? t('scenario.expectedCrop')
                    : t('scenario.expectedImage2')
                  }>
                    {compareStep.expected_image ? (
                      <Image
                        src={`${imageUrl(compareStep.expected_annotated_image || compareStep.expected_image)!}?t=${Date.now()}`}
                        alt="Expected"
                        style={{ width: '100%' }}
                      />
                    ) : <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>{t('scenario.noImage')}</div>}
                  </Card>
                </Col>
                <Col span={12}>
                  <Card size="small" title={t('scenario.actualImage')}>
                    {compareStep.actual_annotated_image ? <Image src={`${imageUrl(compareStep.actual_annotated_image)!}?t=${Date.now()}`} alt="Actual (annotated)" style={{ width: '100%' }} /> : compareStep.actual_image ? <CompareImage src={imageUrl(compareStep.actual_image)!} roi={compareStep.roi} alt="Actual" /> : <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>{t('scenario.noImage')}</div>}
                  </Card>
                </Col>
              </Row>
              {compareStep.compare_mode === 'multi_crop' && compareStep.sub_results?.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <Card size="small" title={t('scenario.cropDetailResult')}>
                    <Table
                      dataSource={compareStep.sub_results}
                      rowKey={(_r, idx) => `sub-${idx}`}
                      size="small"
                      pagination={false}
                      columns={[
                        { title: t('scenario.label'), dataIndex: 'label', key: 'label', render: (v: string) => v || '-' },
                        { title: t('scenario.score'), dataIndex: 'score', key: 'score', width: 100, render: (v: number) => `${(v * 100).toFixed(2)}%` },
                        { title: t('common.status'), dataIndex: 'status', key: 'status', width: 80, render: (s: string) => <Tag color={statusColor(s)}>{s.toUpperCase()}</Tag> },
                        { title: t('scenario.matchLocation'), key: 'loc', width: 200, render: (_: any, r: SubResultData) => r.match_location ? `(${r.match_location.x},${r.match_location.y}) ${r.match_location.width}x${r.match_location.height}` : '-' },
                      ]}
                    />
                  </Card>
                </div>
              )}
              {compareStep.compare_mode === 'full_exclude' && (
                <div style={{ marginTop: 12 }}>
                  <Card size="small"><span style={{ color: '#888' }}>{t('scenario.excludeAreaDescription')}</span></Card>
                </div>
              )}
            </>
          );
        })()}
      </Modal>

      {/* ===== 디바이스 매핑 모달 ===== */}
      <Modal
        title={t('scenario.deviceMappingCheck')}
        open={deviceMapModalVisible}
        onCancel={() => setDeviceMapModalVisible(false)}
        onOk={() => {
          setDeviceMapModalVisible(false);
          const name = deviceMapScenarioName;
          if (name.startsWith('group:')) {
            startGroupPlayback(name.slice(6), deviceMapEditing);
          } else {
            startPlayback(name, deviceMapEditing);
          }
        }}
        okText={t('scenario.play')}
        width={600}
      >
        <p style={{ marginBottom: 12, color: '#888' }}>{t('scenario.deviceMappingDescription')}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Object.entries(deviceMapEditing).map(([alias, realId]) => {
            const connected = connectedDevices.find(d => d.id === realId);
            const isOk = connected && connected.status !== 'offline' && connected.status !== 'disconnected';
            return (
              <div key={alias} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: isOk ? 'rgba(82,196,26,0.06)' : 'rgba(255,77,79,0.06)', borderRadius: 6, border: `1px solid ${isOk ? '#52c41a33' : '#ff4d4f33'}` }}>
                <Tag color="blue" style={{ minWidth: 90, textAlign: 'center' }}>{alias}</Tag>
                <span style={{ color: '#888' }}>→</span>
                <Select
                  value={realId}
                  onChange={(val) => setDeviceMapEditing(prev => ({ ...prev, [alias]: val }))}
                  style={{ flex: 1 }}
                  size="small"
                >
                  {connectedDevices.map(d => (
                    <Select.Option key={d.id} value={d.id}>
                      <Space size={4}>
                        <Tag color={d.status === 'device' || d.status === 'connected' ? 'green' : d.status === 'offline' || d.status === 'disconnected' ? 'red' : 'default'} style={{ marginRight: 0 }}>{d.type}</Tag>
                        {d.name}
                        {d.status === 'offline' || d.status === 'disconnected' ? <span style={{ color: '#ff4d4f' }}>({t('scenario.disconnected')})</span> : null}
                      </Space>
                    </Select.Option>
                  ))}
                </Select>
                {isOk ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : <WarningOutlined style={{ color: '#faad14' }} />}
              </div>
            );
          })}
        </div>
        <Divider style={{ margin: '12px 0' }} />
        <Checkbox checked={webcamAutoRecord} onChange={(e) => setWebcamAutoRecord(e.target.checked)}>
          <VideoCameraOutlined style={{ color: webcamAutoRecord ? '#ff4d4f' : undefined, marginRight: 4 }} />
          {t('webcam.autoRecord')}
        </Checkbox>
      </Modal>

      {/* ===== 내보내기 모달 ===== */}
      <Modal
        title={t('scenario.exportTitle')}
        open={exportModalVisible}
        onCancel={() => setExportModalVisible(false)}
        onOk={doExport}
        okText={t('common.download')}
        confirmLoading={exportLoading}
        okButtonProps={{ disabled: !exportAll && exportSelectedScenarios.length === 0 && exportSelectedGroups.length === 0 }}
        width={500}
      >
        <Checkbox
          checked={exportAll}
          onChange={(e) => {
            setExportAll(e.target.checked);
            if (e.target.checked) {
              setExportSelectedScenarios([...scenarios]);
              setExportSelectedGroups(Object.keys(groups));
            } else {
              setExportSelectedScenarios([]);
              setExportSelectedGroups([]);
            }
          }}
          style={{ marginBottom: 12 }}
        >
          <strong>{t('scenario.selectAll')}</strong>
        </Checkbox>

        {Object.keys(groups).length > 0 && (
          <>
            <Divider style={{ margin: '8px 0' }}>{t('scenario.groupLabel')}</Divider>
            <Checkbox.Group
              value={exportSelectedGroups}
              onChange={(vals) => {
                setExportSelectedGroups(vals as string[]);
                // Auto-select member scenarios
                const memberNames = new Set(exportSelectedScenarios);
                (vals as string[]).forEach((gn) => {
                  (groups[gn] || []).forEach((m) => memberNames.add(m.name));
                });
                setExportSelectedScenarios([...memberNames]);
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
            >
              {Object.entries(groups).map(([gn, members]) => (
                <Checkbox key={gn} value={gn}>
                  <FolderOutlined /> {gn} ({members.length})
                </Checkbox>
              ))}
            </Checkbox.Group>
          </>
        )}

        <Divider style={{ margin: '8px 0' }}>{t('scenario.title')}</Divider>
        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          <Checkbox.Group
            value={exportSelectedScenarios}
            onChange={(vals) => setExportSelectedScenarios(vals as string[])}
            style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            {scenarios.map((sn) => (
              <Checkbox key={sn} value={sn}>{sn}</Checkbox>
            ))}
          </Checkbox.Group>
        </div>
      </Modal>

      {/* ===== 가져오기 모달 ===== */}
      <Modal
        title={t('scenario.importTitle')}
        open={importModalVisible}
        onCancel={() => { setImportModalVisible(false); setImportFile(null); setImportPreviewData(null); }}
        onOk={doImport}
        okText={t('common.import')}
        confirmLoading={importLoading}
        okButtonProps={{ disabled: !importPreviewData }}
        width={650}
      >
        {!importPreviewData ? (
          <Upload.Dragger
            accept=".zip"
            maxCount={1}
            beforeUpload={(file) => { handleImportFile(file); return false; }}
            showUploadList={false}
          >
            <p style={{ fontSize: 40, color: '#999' }}><UploadOutlined /></p>
            <p>{t('scenario.importDragText')}</p>
          </Upload.Dragger>
        ) : (
          <>
            <div style={{ marginBottom: 12 }}>
              <Tag color="blue">{importFile?.name}</Tag>
              <Button size="small" type="link" onClick={() => { setImportFile(null); setImportPreviewData(null); }}>{t('scenario.selectOtherFile')}</Button>
            </div>

            {importPreviewData.scenarios.length > 0 && (
              <>
                <Divider style={{ margin: '8px 0' }}>{t('scenario.title')} ({importPreviewData.scenarios.length})</Divider>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {importPreviewData.scenarios.map((s) => {
                    const key = `s:${s.name}`;
                    const res = importResolutions[key] || { action: 'import' };
                    return (
                      <div key={key} style={{ padding: '6px 8px', background: s.conflict ? 'rgba(255,77,79,0.06)' : 'rgba(82,196,26,0.06)', borderRadius: 6, border: `1px solid ${s.conflict ? '#ff4d4f33' : '#52c41a33'}` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: s.conflict ? 4 : 0 }}>
                          {s.conflict ? <WarningOutlined style={{ color: '#faad14' }} /> : <CheckCircleOutlined style={{ color: '#52c41a' }} />}
                          <strong>{s.name}</strong>
                          {s.conflict && <Tag color="warning" style={{ marginLeft: 'auto' }}>{t('scenario.nameConflict')}</Tag>}
                        </div>
                        {s.conflict && (
                          <div style={{ marginLeft: 22 }}>
                            <Radio.Group
                              value={res.action}
                              onChange={(e) => setImportResolutions((prev) => ({ ...prev, [key]: { ...prev[key], action: e.target.value } }))}
                              size="small"
                            >
                              <Radio value="skip">{t('scenario.skip')}</Radio>
                              <Radio value="overwrite">{t('scenario.overwrite')}</Radio>
                              <Radio value="rename">{t('scenario.rename')}</Radio>
                            </Radio.Group>
                            {res.action === 'rename' && (
                              <Input
                                size="small"
                                placeholder={t('scenario.newNamePlaceholder')}
                                value={res.new_name || ''}
                                onChange={(e) => setImportResolutions((prev) => ({ ...prev, [key]: { ...prev[key], new_name: e.target.value } }))}
                                style={{ width: 200, marginTop: 4 }}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {importPreviewData.groups.length > 0 && (
              <>
                <Divider style={{ margin: '8px 0' }}>{t('scenario.groupLabel')} ({importPreviewData.groups.length})</Divider>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {importPreviewData.groups.map((g) => {
                    const key = `g:${g.name}`;
                    const res = importResolutions[key] || { action: 'import' };
                    return (
                      <div key={key} style={{ padding: '6px 8px', background: g.conflict ? 'rgba(255,77,79,0.06)' : 'rgba(82,196,26,0.06)', borderRadius: 6, border: `1px solid ${g.conflict ? '#ff4d4f33' : '#52c41a33'}` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: g.conflict ? 4 : 0 }}>
                          {g.conflict ? <WarningOutlined style={{ color: '#faad14' }} /> : <CheckCircleOutlined style={{ color: '#52c41a' }} />}
                          <FolderOutlined /> <strong>{g.name}</strong>
                          {g.conflict && <Tag color="warning" style={{ marginLeft: 'auto' }}>{t('scenario.nameConflict')}</Tag>}
                        </div>
                        {g.conflict && (
                          <div style={{ marginLeft: 22 }}>
                            <Radio.Group
                              value={res.action}
                              onChange={(e) => setImportResolutions((prev) => ({ ...prev, [key]: { ...prev[key], action: e.target.value } }))}
                              size="small"
                            >
                              <Radio value="skip">{t('scenario.skip')}</Radio>
                              <Radio value="overwrite">{t('scenario.overwrite')}</Radio>
                              <Radio value="merge">{t('scenario.mergeTitle')}</Radio>
                              <Radio value="rename">{t('scenario.rename')}</Radio>
                            </Radio.Group>
                            {res.action === 'rename' && (
                              <Input
                                size="small"
                                placeholder={t('scenario.newNamePlaceholder')}
                                value={res.new_name || ''}
                                onChange={(e) => setImportResolutions((prev) => ({ ...prev, [key]: { ...prev[key], new_name: e.target.value } }))}
                                style={{ width: 200, marginTop: 4 }}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}
      </Modal>

      <style>{`
        .row-pass td { background: rgba(82, 196, 26, 0.08) !important; }
        .row-fail td { background: rgba(255, 77, 79, 0.12) !important; }
        .row-error td { background: rgba(255, 122, 69, 0.12) !important; }
        .row-warning td { background: rgba(250, 173, 20, 0.08) !important; }
      `}</style>
    </div>
  );
}
