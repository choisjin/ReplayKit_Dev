import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Collapse, Col, Descriptions, Image, Input, InputNumber, Modal, Row, Select, Space, Spin, Table, Tag, Tooltip, message } from 'antd';
import { DeleteOutlined, DownloadOutlined, ExpandOutlined, EyeOutlined, FolderOpenOutlined, PlayCircleOutlined, ReloadOutlined, ScissorOutlined, SearchOutlined, ShrinkOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { resultsApi, scenarioApi } from '../services/api';
import { useSettings } from '../context/SettingsContext';
import { useTranslation } from '../i18n';

interface ResultSummary {
  filename: string;
  scenario_name: string;
  status: string;
  total_steps: number;
  total_repeat: number;
  passed_steps: number;
  failed_steps: number;
  warning_steps: number;
  error_steps: number;
  started_at: string;
  finished_at: string;
}

// 같은 타임스탬프를 공유하는 결과 묶음 (그룹 재생 또는 반복 실행)
interface ResultGroup {
  key: string; // 타임스탬프
  timestamp: string;
  items: ResultSummary[];
  status: string; // 전체 상태 (하나라도 fail이면 fail)
  scenario_names: string;
  total_repeat: number;
}

interface MatchLocation {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SubResultDetail {
  label: string;
  expected_image: string;
  score: number;
  status: string;
  match_location: MatchLocation | null;
}

interface StepResultDetail {
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
  roi: { x: number; y: number; width: number; height: number } | null;
  match_location: MatchLocation | null;
  message: string;
  delay_ms: number;
  execution_time_ms: number;
  compare_mode: string | null;
  sub_results: SubResultDetail[];
}

interface ResultDetail {
  scenario_name: string;
  device_serial: string;
  status: string;
  total_steps: number;
  total_repeat: number;
  passed_steps: number;
  failed_steps: number;
  warning_steps: number;
  error_steps: number;
  step_results: StepResultDetail[];
  started_at: string;
  finished_at: string;
}

const statusColor = (s: string) =>
  s === 'pass' ? 'green' : s === 'warning' ? 'orange' : s === 'error' ? 'volcano' : 'red';

const imageUrl = (path: string | null) => {
  if (!path) return null;
  let rel = path.replace(/\\/g, '/');
  const resultsIdx = rel.indexOf('/results/');
  if (resultsIdx >= 0) return '/results-files/' + rel.substring(resultsIdx + '/results/'.length);
  if (/^\d{8}_\d{6}_/.test(rel)) return '/results-files/' + rel;
  const idx = rel.indexOf('/screenshots/');
  if (idx >= 0) {
    rel = rel.substring(idx + '/screenshots/'.length);
  }
  return '/screenshots/' + rel;
};

// Draws match-location boxes on the expected image for multi_crop results
const AnnotatedOverlay = React.memo(({ subResults, expectedImage }: {
  subResults: SubResultDetail[];
  expectedImage: string;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const img = new window.Image();
    img.onload = () => {
      setSize({ w: img.width, h: img.height });
      const canvas = canvasRef.current;
      if (!canvas) return;
      // canvas overlays on the image; match its display size via parent
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      subResults.forEach((sr, i) => {
        const loc = sr.match_location;
        if (!loc) return;
        const color = sr.status === 'pass' ? '#52c41a' : sr.status === 'warning' ? '#faad14' : '#ff4d4f';
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(loc.x, loc.y, loc.width, loc.height);
        ctx.fillStyle = color.replace(')', ',0.15)').replace('rgb', 'rgba').replace('#', '');
        // Use simpler fill
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = color;
        ctx.fillRect(loc.x, loc.y, loc.width, loc.height);
        ctx.globalAlpha = 1;
        // Label
        ctx.fillStyle = color;
        ctx.font = 'bold 24px sans-serif';
        ctx.fillText(`${sr.label || `#${i + 1}`} ${(sr.score * 100).toFixed(0)}%`, loc.x + 4, loc.y + 28);
      });
    };
    img.src = expectedImage + `?t=${Date.now()}`;
  }, [subResults, expectedImage]);

  if (!size) return null;
  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
        pointerEvents: 'none',
      }}
    />
  );
});

export default function ResultsPage() {
  const { settings } = useSettings();
  const { t, lang } = useTranslation();
  const [results, setResults] = useState<ResultSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<ResultDetail | null>(null);
  const [detailFilename, setDetailFilename] = useState('');
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [compareStep, setCompareStep] = useState<StepResultDetail | null>(null);

  // 그룹 상세 뷰 (사이클별 통합)
  const [groupDetail, setGroupDetail] = useState<ResultDetail[] | null>(null);
  const [groupDetailCycle, setGroupDetailCycle] = useState(1);

  // 백그라운드 CMD/SSH 폴링 (task_id도 함께 추적해서 취소 가능)
  const bgPollTimers = useRef<ReturnType<typeof setInterval>[]>([]);
  const bgPollTaskIds = useRef<string[]>([]);
  const stopAllResultBgPolls = (cancelBackend: boolean = true) => {
    bgPollTimers.current.forEach(t => clearInterval(t));
    bgPollTimers.current = [];
    if (cancelBackend) {
      bgPollTaskIds.current.forEach(tid => {
        scenarioApi.cancelCmdTask(tid).catch(() => {});
      });
    }
    bgPollTaskIds.current = [];
  };

  // 선택 삭제 + 필터
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [scenarioFilter, setScenarioFilter] = useState('');

  // Webcam recordings
  const [recordings, setRecordings] = useState<{ filename: string; size: number; url: string }[]>([]);
  const [webcamPanelOpen, setWebcamPanelOpen] = useState(false);
  const [webcamExpanded, setWebcamExpanded] = useState(false);
  const [activeRecUrl, setActiveRecUrl] = useState('');
  const [activeRecRepeat, setActiveRecRepeat] = useState(1);
  const detailVideoRef = useRef<HTMLVideoElement>(null);
  const [currentPlayingStepId, setCurrentPlayingStepId] = useState<number | null>(null);
  const [trimFile, setTrimFile] = useState<string | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);

  const fetchRecordings = async (resultFilename: string) => {
    try {
      const res = await resultsApi.listRecordings(resultFilename);
      const recs = res.data.recordings || [];
      setRecordings(recs);
      if (recs.length > 0) {
        setActiveRecUrl(recs[0].url);
        const m = recs[0].filename.match(/webcam_r(\d+)\.(?:webm|mp4)$/);
        setActiveRecRepeat(m ? parseInt(m[1]) : 1);
      } else {
        setActiveRecUrl('');
      }
    } catch { setRecordings([]); }
  };

  // 그룹/단일 공통: 현재 사이클의 전체 스텝 목록 반환
  const getAllStepsForRepeat = useCallback((repeatIdx: number): StepResultDetail[] => {
    if (groupDetail && groupDetail.length > 0) {
      const allSteps: StepResultDetail[] = [];
      for (const d of groupDetail) {
        allSteps.push(...d.step_results.filter(s => (s.repeat_index || 1) === repeatIdx));
      }
      return allSteps;
    }
    if (detail) {
      return detail.step_results.filter(s => (s.repeat_index || 1) === repeatIdx);
    }
    return [];
  }, [detail, groupDetail]);

  const seekToStep = (step: StepResultDetail) => {
    if ((!detail && !groupDetail) || recordings.length === 0) return;
    // 패널 열기
    if (!webcamPanelOpen) setWebcamPanelOpen(true);
    // 해당 회차 녹화 선택
    const targetRepeat = step.repeat_index || 1;
    const rec = recordings.find(r => (r.filename.includes(`webcam_r${targetRepeat}.webm`) || r.filename.includes(`webcam_r${targetRepeat}.mp4`)));
    if (!rec) return;

    // 같은 회차의 첫/마지막 스텝 타임스탬프 기준으로 오프셋 계산
    const sameRepeatSteps = getAllStepsForRepeat(targetRepeat);
    const firstStep = sameRepeatSteps[0];
    const lastStep = sameRepeatSteps[sameRepeatSteps.length - 1];
    if (!firstStep?.timestamp || !step.timestamp) return;
    const firstTime = new Date(firstStep.timestamp).getTime();
    const stepTime = new Date(step.timestamp).getTime();
    const rawOffsetSec = (stepTime - firstTime) / 1000;

    const doSeek = () => {
      const video = detailVideoRef.current;
      if (!video) return;
      const applySeek = () => {
        // 비디오 duration과 스텝 시간 범위의 비율로 보정 (Infinity면 스케일링 생략)
        const videoDuration = video.duration;
        const hasDuration = Number.isFinite(videoDuration) && videoDuration > 0;
        const lastTime = lastStep?.timestamp ? new Date(lastStep.timestamp).getTime() : stepTime;
        const lastExec = lastStep?.execution_time_ms || 0;
        const totalStepSpanSec = (lastTime - firstTime) / 1000 + lastExec / 1000;
        const scale = (hasDuration && totalStepSpanSec > 0) ? videoDuration / totalStepSpanSec : 1;
        const correctedOffset = Math.max(0, rawOffsetSec * scale - 1);
        const seekTime = hasDuration ? Math.min(correctedOffset, videoDuration) : correctedOffset;
        if (Number.isFinite(seekTime)) video.currentTime = seekTime;
      };
      if (video.readyState >= 2) {
        applySeek();
      } else {
        video.addEventListener('loadeddata', applySeek, { once: true });
      }
    };

    const urlChanged = rec.url !== activeRecUrl;
    setActiveRecUrl(rec.url);
    setActiveRecRepeat(targetRepeat);

    if (urlChanged) {
      requestAnimationFrame(() => requestAnimationFrame(doSeek));
    } else {
      doSeek();
    }
  };

  // 비디오 재생 시 현재 스텝 실시간 하이라이트
  const handleVideoTimeUpdate = useCallback(() => {
    const video = detailVideoRef.current;
    if (!video || (!detail && !groupDetail)) return;
    const currentTime = video.currentTime;
    const sameRepeatSteps = getAllStepsForRepeat(activeRecRepeat);
    if (sameRepeatSteps.length === 0) return;
    const firstStep = sameRepeatSteps[0];
    const lastStep = sameRepeatSteps[sameRepeatSteps.length - 1];
    if (!firstStep?.timestamp) return;
    const firstTime = new Date(firstStep.timestamp).getTime();

    // 비디오 duration ↔ 스텝 시간 범위 비율로 역보정 (Infinity면 스케일링 생략)
    const videoDuration = video.duration;
    const hasDuration = Number.isFinite(videoDuration) && videoDuration > 0;
    const lastTime = lastStep?.timestamp ? new Date(lastStep.timestamp).getTime() : firstTime;
    const lastExec = lastStep?.execution_time_ms || 0;
    const totalStepSpanSec = (lastTime - firstTime) / 1000 + lastExec / 1000;
    const scale = (hasDuration && totalStepSpanSec > 0) ? totalStepSpanSec / videoDuration : 1;
    // 비디오 시간 → 스텝 시간으로 변환
    const mappedTime = currentTime * scale;

    let matchedStep: StepResultDetail | null = null;
    for (let i = sameRepeatSteps.length - 1; i >= 0; i--) {
      const s = sameRepeatSteps[i];
      if (!s.timestamp) continue;
      const stepOffset = (new Date(s.timestamp).getTime() - firstTime) / 1000;
      if (mappedTime >= stepOffset - 1) {
        matchedStep = s;
        break;
      }
    }
    setCurrentPlayingStepId(matchedStep?.step_id ?? null);
  }, [detail, groupDetail, activeRecRepeat, getAllStepsForRepeat]);

  const handleVideoPauseOrEnd = useCallback(() => {
    setCurrentPlayingStepId(null);
  }, []);

  const fetchResults = async () => {
    setLoading(true);
    try {
      const res = await resultsApi.list();
      setResults(res.data.results);
    } catch {
      message.error(t('results.listFailed'));
    }
    setLoading(false);
  };

  const viewGroupDetail = async (group: ResultGroup) => {
    setDetailLoading(true);
    setDetailVisible(true);
    setDetail(null);
    setGroupDetail(null);
    setGroupDetailCycle(1);
    setDetailFilename(group.items[0].filename);
    try {
      const details: ResultDetail[] = [];
      for (const item of group.items) {
        const res = await resultsApi.get(item.filename);
        details.push(res.data);
      }
      setGroupDetail(details);
      // 모든 시나리오의 녹화 파일을 합쳐서 로드
      const allRecs: any[] = [];
      for (const item of group.items) {
        try {
          const recRes = await resultsApi.listRecordings(item.filename);
          allRecs.push(...(recRes.data.recordings || []));
        } catch { /* ignore */ }
      }
      // 중복 제거 (같은 파일명)
      const seen = new Set<string>();
      const uniqueRecs = allRecs.filter(r => { if (seen.has(r.filename)) return false; seen.add(r.filename); return true; });
      setRecordings(uniqueRecs);
      if (uniqueRecs.length > 0) {
        setActiveRecUrl(uniqueRecs[0].url);
        const m = uniqueRecs[0].filename.match(/webcam_r(\d+)\.(?:webm|mp4)$/);
        setActiveRecRepeat(m ? parseInt(m[1]) : 1);
      } else {
        setActiveRecUrl('');
      }
    } catch {
      message.error(t('results.detailFailed'));
    }
    setDetailLoading(false);
  };

  const viewDetail = async (filename: string) => {
    setDetailLoading(true);
    setDetailFilename(filename);
    setDetailVisible(true);
    setDetail(null);
    try {
      const res = await resultsApi.get(filename);
      setDetail(res.data);
      fetchRecordings(filename);
    } catch {
      message.error(t('results.detailFailed'));
    }
    setDetailLoading(false);
  };

  const deleteResult = (filename: string) => {
    Modal.confirm({
      title: t('results.deleteTitle'),
      content: t('results.deleteConfirm', { name: filename }),
      okText: t('common.delete'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          await resultsApi.delete(filename);
          message.success(t('common.deleteComplete'));
          fetchResults();
          if (detailFilename === filename) {
            setDetailVisible(false);
            setDetail(null);
          }
        } catch {
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const exportBundle = async (filename: string) => {
    try {
      const res = await resultsApi.exportBundle(filename);
      // ZIP blob 다운로드
      const blob = new Blob([res.data], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const baseName = filename.replace('/result.json', '').replace('.json', '');
      a.href = url;
      a.download = `${baseName}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      message.success(t('results.exportBundleComplete', { path: `${baseName}.zip`, count: '1' }));
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('results.exportBundleFailed'));
    }
  };

  const openFolder = async (filename: string) => {
    try {
      await resultsApi.openFolder(filename);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    fetchResults();
    const onTabChange = (e: Event) => {
      if ((e as CustomEvent).detail === '/results') {
        fetchResults();
      }
    };
    window.addEventListener('tab-change', onTabChange);
    return () => window.removeEventListener('tab-change', onTabChange);
  }, []);

  // 결과 상세 열릴 때 BG_TASK 마커 감지 → 폴링
  useEffect(() => {
    // 이전 폴링 정리 (detail 변경이므로 backend cancel은 안 함 — 이전 detail의 태스크는 그대로 둠)
    stopAllResultBgPolls(false);

    if (!detail || !detailFilename) return;

    detail.step_results.forEach((sr, idx) => {
      const bgMatch = sr.message?.match?.(/\[BG_TASK:(bg_\d+)\]/);
      if (!bgMatch) return;

      const taskId = bgMatch[1];
      // 즉시 "실행 중" 표시
      setDetail(prev => {
        if (!prev) return prev;
        const updated = { ...prev, step_results: [...prev.step_results] };
        updated.step_results[idx] = { ...updated.step_results[idx], message: `⏳ ${t('record.cmdRunning')}...` };
        return updated;
      });

      const poll = setInterval(async () => {
        try {
          const r = await scenarioApi.getCmdResult(taskId);
          if (r.data.status === 'running') {
            // 라이브 업데이트: 누적 stdout을 계속 반영 (send_command_stream)
            const liveStdout = r.data.stdout ?? '';
            if (liveStdout) {
              setDetail(prev => {
                if (!prev) return prev;
                const updated = { ...prev, step_results: [...prev.step_results] };
                updated.step_results[idx] = { ...updated.step_results[idx], message: liveStdout };
                return updated;
              });
            }
            return;
          }
          clearInterval(poll);

          // 서버가 계산한 final_message/final_status 사용
          const finalMsg = r.data.final_message ?? r.data.stdout ?? '';
          const finalStatus = r.data.final_status as 'pass' | 'fail' | null | undefined;

          setDetail(prev => {
            if (!prev) return prev;
            const updated = { ...prev, step_results: [...prev.step_results] };
            const step = updated.step_results[idx];
            const newStatus = finalStatus ?? step.status;
            updated.step_results[idx] = { ...step, message: finalMsg, status: newStatus };

            // status가 fail로 바뀐 경우 카운트 재계산
            if (finalStatus === 'fail' && step.status !== 'fail') {
              updated.failed_steps += 1;
              if (step.status === 'pass') updated.passed_steps = Math.max(0, updated.passed_steps - 1);
              else if (step.status === 'warning') updated.warning_steps = Math.max(0, updated.warning_steps - 1);
              if (updated.failed_steps > 0 || updated.error_steps > 0) updated.status = 'fail';
            }

            // 백엔드에 영구 저장
            resultsApi.updateStepResult(detailFilename, idx, finalMsg, newStatus).catch(() => {});
            return updated;
          });
        } catch (err: any) {
          clearInterval(poll);
          // 404 = 태스크가 서버 메모리에 없음 (서버 재시작 등)
          if (err?.response?.status === 404) {
            const lostMsg = `[BG_TASK:${taskId}] 결과 소실 (서버 재시작)`;
            setDetail(prev => {
              if (!prev) return prev;
              const updated = { ...prev, step_results: [...prev.step_results] };
              updated.step_results[idx] = { ...updated.step_results[idx], message: lostMsg };
              return updated;
            });
            resultsApi.updateStepResult(detailFilename, idx, lostMsg).catch(() => {});
          }
        }
      }, 1000);
      bgPollTimers.current.push(poll);
      bgPollTaskIds.current.push(taskId);
    });

    return () => {
      stopAllResultBgPolls();
    };
  }, [detail?.scenario_name, detailFilename, detailVisible]);

  const totalTime = (stepResults: StepResultDetail[]) =>
    stepResults.reduce((sum, s) => sum + (s.execution_time_ms || 0), 0);

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    const sec = Math.floor(ms / 1000);
    const remain = ms % 1000;
    if (sec < 60) return `${sec}.${String(remain).padStart(3, '0').slice(0, 1)}s`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    return `${min}m ${remSec}s`;
  };

  const formatTime = (iso: string, inline = false) => {
    if (!iso) return '-';
    try {
      const d = new Date(iso);
      const date = d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
      const time = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      if (inline) return `${date} ${time}`;
      return <>{date}<br />{time}</>;
    } catch {
      return iso;
    }
  };

  const deleteSelected = () => {
    if (selectedRowKeys.length === 0) return;
    // 선택된 그룹의 모든 파일명 수집
    const filesToDelete: string[] = [];
    for (const key of selectedRowKeys) {
      const group = groupedResults.find(g => g.key === key);
      if (group) {
        filesToDelete.push(...group.items.map(i => i.filename));
      }
    }
    Modal.confirm({
      title: t('results.deleteTitle'),
      content: `${selectedRowKeys.length}${t('results.deleteSelectedConfirm')} (${filesToDelete.length} files)`,
      okText: t('common.delete'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        for (const fn of filesToDelete) {
          try { await resultsApi.delete(fn); } catch { /* skip */ }
        }
        message.success(t('common.deleteComplete'));
        setSelectedRowKeys([]);
        fetchResults();
      },
    });
  };

  // 시나리오 이름 필터링 + 검색
  const filteredResults = scenarioFilter
    ? results.filter(r => r.scenario_name.toLowerCase().includes(scenarioFilter.toLowerCase()))
    : results;

  // 시나리오 이름 목록 (필터 드롭다운용)
  const scenarioNames = [...new Set(results.map(r => r.scenario_name))].sort();

  // 파일명에서 타임스탬프 추출: ScenarioName_YYYYMMDD_HHMMSS.json → YYYYMMDD_HHMMSS
  const extractTimestamp = (filename: string): string => {
    const m = filename.match(/(\d{8}_\d{6})\.json$/);
    return m ? m[1] : filename;
  };

  // 같은 타임스탬프의 결과를 묶음으로 그룹화
  const groupedResults: ResultGroup[] = React.useMemo(() => {
    const map = new Map<string, ResultSummary[]>();
    for (const r of filteredResults) {
      const ts = extractTimestamp(r.filename);
      if (!map.has(ts)) map.set(ts, []);
      map.get(ts)!.push(r);
    }
    return Array.from(map.entries()).map(([ts, items]) => {
      const hasAnyFail = items.some(i => i.status === 'fail' || i.status === 'error');
      const hasWarning = items.some(i => i.status === 'warning');
      const names = [...new Set(items.map(i => i.scenario_name))];
      return {
        key: ts,
        timestamp: items[0].started_at,
        items,
        status: hasAnyFail ? 'fail' : hasWarning ? 'warning' : 'pass',
        scenario_names: names.join(', '),
        total_repeat: Math.max(...items.map(i => i.total_repeat || 1)),
      };
    });
  }, [filteredResults]);

  const groupColumns = [
    {
      title: t('results.execTime'),
      key: 'time',
      width: 200,
      render: (_: any, g: ResultGroup) => <span style={{ fontSize: 12, lineHeight: 1.4 }}>{formatTime(g.timestamp)}</span>,
      sorter: (a: ResultGroup, b: ResultGroup) => (a.timestamp || '').localeCompare(b.timestamp || ''),
      defaultSortOrder: 'descend' as const,
    },
    {
      title: t('results.scenario'),
      key: 'name',
      render: (_: any, g: ResultGroup) => (
        <Space size={4} wrap>
          <span>{g.scenario_names}</span>
          {g.items.length > 1 && <Tag color="blue">{g.items.length} {t('results.scenarios')}</Tag>}
          {g.total_repeat > 1 && <Tag color="purple">{g.total_repeat}x</Tag>}
        </Space>
      ),
      sorter: (a: ResultGroup, b: ResultGroup) => a.scenario_names.localeCompare(b.scenario_names),
    },
    {
      title: t('common.status'),
      key: 'status',
      width: 90,
      render: (_: any, g: ResultGroup) => <Tag color={statusColor(g.status)}>{g.status.toUpperCase()}</Tag>,
      filters: [
        { text: 'PASS', value: 'pass' },
        { text: 'FAIL', value: 'fail' },
        { text: 'WARNING', value: 'warning' },
      ],
      onFilter: (value: any, g: ResultGroup) => g.status === value,
    },
    {
      title: t('common.result'),
      key: 'counts',
      width: 180,
      render: (_: any, g: ResultGroup) => {
        const p = g.items.reduce((s, i) => s + i.passed_steps, 0);
        const f = g.items.reduce((s, i) => s + i.failed_steps, 0);
        const w = g.items.reduce((s, i) => s + i.warning_steps, 0);
        const e = g.items.reduce((s, i) => s + i.error_steps, 0);
        const total = g.items.reduce((s, i) => s + i.total_steps, 0);
        return (
          <Space size={4}>
            <Tag color="green">{p}P</Tag>
            <Tag color="red">{f}F</Tag>
            {w > 0 && <Tag color="orange">{w}W</Tag>}
            {e > 0 && <Tag color="volcano">{e}E</Tag>}
            <span style={{ color: '#888' }}>/ {total}</span>
          </Space>
        );
      },
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 160,
      render: (_: any, g: ResultGroup) => {
        if (g.items.length === 1) {
          const r = g.items[0];
          return (
            <Space size={4}>
              <Button size="small" icon={<FolderOpenOutlined />} onClick={() => openFolder(r.filename)} />
              <Button size="small" icon={<EyeOutlined />} onClick={() => viewDetail(r.filename)}>{t('common.details')}</Button>
              <Button size="small" icon={<DownloadOutlined />} onClick={() => exportBundle(r.filename)} />
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => deleteResult(r.filename)} />
            </Space>
          );
        }
        return (
          <Space size={4}>
            <Button size="small" icon={<EyeOutlined />} onClick={() => viewGroupDetail(g)}>{t('common.details')}</Button>
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => {
              Modal.confirm({
                title: t('results.deleteTitle'),
                onOk: async () => {
                  for (const item of g.items) {
                    try { await resultsApi.delete(item.filename); } catch { /* ignore */ }
                  }
                  fetchResults();
                },
              });
            }} />
          </Space>
        );
      },
    },
  ];

  const _colTitle = (en: string, ko: string) => <div style={{ textAlign: 'center' }}>{en}<br /><span style={{ fontSize: 11, color: '#888' }}>{ko}</span></div>;
  // 필터용: 현재 표시 데이터에서 고유값 추출
  const _allSteps: StepResultDetail[] = detail?.step_results || (groupDetail ? groupDetail.flatMap(d => d.step_results || []) : []);
  const _uniqueStatuses = [...new Set(_allSteps.map(s => s.status).filter(Boolean))].sort();
  const _uniqueDevices = [...new Set(_allSteps.map(s => s.device_id).filter(Boolean))].sort();
  const _uniqueRepeats = [...new Set(_allSteps.map(s => s.repeat_index ?? 1))].sort((a, b) => a - b);

  const stepColumns = ([
    {
      title: _colTitle('Time Stamp', t('results.timestamp')),
      dataIndex: 'timestamp',
      key: 'timestamp',
      align: 'center' as const,
      render: (v: string | null) => <span style={{ fontSize: 12, lineHeight: 1.4 }}>{v ? formatTime(v) : '-'}</span>,
      _hide: false,
    },
    {
      title: _colTitle('Repeat', t('results.repeat')),
      key: 'repeat',
      align: 'center' as const,
      filters: _uniqueRepeats.map(r => ({ text: `#${r}`, value: r })),
      onFilter: (value: any, record: any) => (record.repeat_index ?? 1) === value,
      render: (_: any, r: StepResultDetail) => {
        const total = detail?.total_repeat || (groupDetail ? Math.max(...groupDetail.map(d => d.total_repeat || 1)) : 1);
        return `${r.repeat_index ?? 1}/${total}`;
      },
      _hide: false,
    },
    {
      title: _colTitle('Step', t('results.step')),
      dataIndex: 'step_id',
      key: 'step_id',
      align: 'center' as const,
      render: (_: any, r: any) => r._seq || r.step_id,
      _hide: false,
    },
    {
      title: _colTitle('Device', t('results.deviceCol')),
      dataIndex: 'device_id',
      key: 'device_id',
      align: 'center' as const,
      filters: _uniqueDevices.map(d => ({ text: d, value: d })),
      onFilter: (value: any, record: any) => (record.device_id || '') === value,
      render: (v: string) => v || '-',
      _hide: false,
    },
    {
      title: _colTitle('Command', 'action'),
      dataIndex: 'command',
      key: 'command',
      width: 200,
      ellipsis: true,
      align: 'center' as const,
      render: (v: string, r: StepResultDetail) => {
        // module_command 결과에 message가 있으면 툴팁으로 표시
        const isModuleStep = v?.includes('::');
        if (isModuleStep && r.message) {
          if (r.message.match(/\[BG_TASK:/)) return <span>{v} <Tag color="processing">BG</Tag></span>;
          if (r.message.startsWith('⏳')) return <span>{v} <Tag color="processing">⏳</Tag></span>;
          return <Tooltip title={<pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{r.message}</pre>}><span>{v}</span></Tooltip>;
        }
        return <span style={{ textAlign: 'left', display: 'block' }}>{v || r.message || '-'}</span>;
      },
      _hide: false,
    },
    {
      title: _colTitle('Remark', t('results.remark')),
      dataIndex: 'description',
      key: 'description',
      width: 200,
      ellipsis: true,
      align: 'center' as const,
      render: (v: string) => <span style={{ textAlign: 'left', display: 'block' }}>{v || '-'}</span>,
      _hide: webcamExpanded,
    },
    {
      title: _colTitle('Status', t('results.resultCol')),
      dataIndex: 'status',
      key: 'status',
      align: 'center' as const,
      filters: _uniqueStatuses.map(s => ({ text: s.toUpperCase(), value: s })),
      onFilter: (value: any, record: any) => record.status === value,
      defaultFilteredValue: null,
      render: (s: string) => <Tag color={statusColor(s)} style={{ margin: 0 }}>{s.toUpperCase()}</Tag>,
      _hide: false,
    },
    {
      title: _colTitle('Delay', t('results.delaySet')),
      dataIndex: 'delay_ms',
      key: 'delay',
      align: 'center' as const,
      render: (v: number) => v ? formatDuration(v) : '-',
      _hide: webcamExpanded,
    },
    {
      title: _colTitle('Duration', t('results.duration')),
      dataIndex: 'execution_time_ms',
      key: 'duration',
      align: 'center' as const,
      render: (v: number) => formatDuration(v),
      _hide: webcamExpanded,
    },
    {
      title: _colTitle('', t('scenario.compare')),
      key: 'compare',
      align: 'center' as const,
      render: (_: any, r: StepResultDetail) => {
        if (r.expected_image || r.actual_image) {
          return <Button size="small" onClick={() => setCompareStep(r)}>{t('scenario.compare')}</Button>;
        }
        return '-';
      },
      _hide: false,
    },
  ] as any[]).filter((c: any) => !c._hide);

  return (
    <div>
      <Card
        title={t('results.title')}
        extra={
          <Space>
            <Input
              placeholder={t('common.search')}
              prefix={<SearchOutlined />}
              value={scenarioFilter}
              onChange={(e) => setScenarioFilter(e.target.value)}
              allowClear
              style={{ width: 200 }}
              size="small"
            />
            {selectedRowKeys.length > 0 && (
              <Button danger size="small" icon={<DeleteOutlined />} onClick={deleteSelected}>
                {t('common.delete')} ({selectedRowKeys.length})
              </Button>
            )}
            <Button
              size="small"
              onClick={async () => {
                Modal.confirm({
                  title: t('results.migrateLegacyTitle'),
                  content: t('results.migrateLegacyDesc'),
                  okText: t('results.migrateLegacyOk'),
                  onOk: async () => {
                    const hide = message.loading(t('results.migrating'), 0);
                    try {
                      const res = await resultsApi.migrateLegacy();
                      hide();
                      message.success(t('results.migrateComplete', { count: String(res.data.migrated) }));
                      if (res.data.errors?.length) {
                        Modal.warning({ title: t('results.migrateErrors'), content: res.data.errors.join('\n') });
                      }
                      fetchResults();
                    } catch {
                      hide();
                      message.error(t('results.migrateFailed'));
                    }
                  },
                });
              }}
            >
              {t('results.migrateLegacy')}
            </Button>
            <Button icon={<ReloadOutlined />} onClick={fetchResults} loading={loading} size="small">
              {t('common.refresh')}
            </Button>
          </Space>
        }
      >
        <Table
          columns={groupColumns as any}
          dataSource={groupedResults}
          rowKey="key"
          size="small"
          pagination={{ pageSize: 15, showSizeChanger: true }}
          rowSelection={{
            selectedRowKeys,
            onChange: (keys) => setSelectedRowKeys(keys),
          }}
          expandable={{
            expandedRowRender: (g: ResultGroup) => g.items.length > 1 ? (
              <div style={{ padding: '4px 0' }}>
                {g.items.map((r, idx) => (
                  <div key={r.filename} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderBottom: idx < g.items.length - 1 ? '1px solid #f0f0f0' : undefined }}>
                    <Tag style={{ margin: 0 }}>{idx + 1}</Tag>
                    <span style={{ flex: 1 }}>{r.scenario_name}</span>
                    <Tag color={statusColor(r.status)}>{r.status.toUpperCase()}</Tag>
                    <Space size={4}>
                      <Tag color="green">{r.passed_steps}P</Tag>
                      <Tag color="red">{r.failed_steps}F</Tag>
                      {r.total_repeat > 1 && <Tag color="purple">{r.total_repeat}x</Tag>}
                    </Space>
                    <Button size="small" icon={<FolderOpenOutlined />} onClick={() => openFolder(r.filename)} />
                    <Button size="small" icon={<EyeOutlined />} onClick={() => viewDetail(r.filename)}>{t('common.details')}</Button>
                    <Button size="small" icon={<DownloadOutlined />} onClick={() => exportBundle(r.filename)} />
                  </div>
                ))}
              </div>
            ) : null,
            rowExpandable: (g: ResultGroup) => g.items.length > 1,
          }}
        />
      </Card>

      {/* Detail report modal */}
      <Modal
        title={
          <Space>
            <span>{detail?.scenario_name || t('scenario.resultDetail')}</span>
            {detail && <Tag color={statusColor(detail.status)}>{detail.status.toUpperCase()}</Tag>}
          </Space>
        }
        open={detailVisible}
        onCancel={() => { setDetailVisible(false); setWebcamPanelOpen(false); setWebcamExpanded(false); setCurrentPlayingStepId(null); setGroupDetail(null); }}
        width="90vw"
        style={{ top: 20 }}
        footer={
          <Space>
            <Button
              icon={<FolderOpenOutlined />}
              onClick={() => detailFilename && openFolder(detailFilename)}
            >
              {t('results.openFolder')}
            </Button>
            <Button
              icon={<DownloadOutlined />}
              onClick={() => detailFilename && exportBundle(detailFilename)}
            >
              {t('results.exportBundle')}
            </Button>
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={() => detailFilename && deleteResult(detailFilename)}
            >
              {t('common.delete')}
            </Button>
          </Space>
        }
      >
        {detailLoading && !detail && !groupDetail && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" tip={t('results.loading')} />
          </div>
        )}
        {groupDetail && groupDetail.length > 0 && (() => {
          const totalRepeat = Math.max(...groupDetail.map(d => d.total_repeat || 1));
          // 현재 사이클의 스텝들을 시나리오 순서대로 합침 (연번 부여)
          const cycleSteps: (StepResultDetail & { _seq?: number; _scenarioName?: string })[] = [];
          let seq = 0;
          for (const d of groupDetail) {
            const stepsForCycle = d.step_results.filter(sr => sr.repeat_index === groupDetailCycle);
            for (const s of stepsForCycle) {
              seq++;
              cycleSteps.push({ ...s, _seq: seq, _scenarioName: d.scenario_name });
            }
          }
          const cyclePass = cycleSteps.filter(s => s.status === 'pass').length;
          const cycleFail = cycleSteps.filter(s => s.status === 'fail').length;
          const cycleWarn = cycleSteps.filter(s => s.status === 'warning').length;
          const cycleErr = cycleSteps.filter(s => s.status !== 'pass' && s.status !== 'fail' && s.status !== 'warning').length;
          return (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{ fontWeight: 600 }}>Cycle:</span>
                {Array.from({ length: totalRepeat }, (_, i) => i + 1).map(c => (
                  <Button key={c} size="small" type={groupDetailCycle === c ? 'primary' : 'default'} onClick={() => setGroupDetailCycle(c)}>
                    {c}
                  </Button>
                ))}
                <span style={{ marginLeft: 'auto', color: '#888' }}>
                  {groupDetail.map(d => d.scenario_name).join(' → ')}
                </span>
              </div>
              <Space size={8} style={{ marginBottom: 12 }}>
                <Tag color="green">{cyclePass} Pass</Tag>
                <Tag color="red">{cycleFail} Fail</Tag>
                {cycleWarn > 0 && <Tag color="orange">{cycleWarn} Warning</Tag>}
                {cycleErr > 0 && <Tag color="volcano">{cycleErr} Error</Tag>}
                <span style={{ color: '#888' }}>/ {cycleSteps.length} steps</span>
              </Space>
              {/* 웹캠 패널 */}
              {recordings.length > 0 && (
                <Collapse
                  activeKey={webcamPanelOpen ? ['webcam'] : []}
                  onChange={(keys) => setWebcamPanelOpen(keys.includes('webcam'))}
                  style={{ marginBottom: 12 }}
                  items={[{
                    key: 'webcam',
                    label: <Space><VideoCameraOutlined /> {t('webcam.recordings')} ({recordings.length})</Space>,
                    children: (
                      <div>
                        <Space style={{ marginBottom: 8 }}>
                          {recordings.map((rec, i) => {
                            const m = rec.filename.match(/webcam_r(\d+)\.(?:webm|mp4)$/);
                            const recCycle = m ? parseInt(m[1]) : i + 1;
                            return (
                              <Button key={rec.filename} size="small"
                                type={activeRecUrl === rec.url ? 'primary' : 'default'}
                                onClick={() => { setActiveRecUrl(rec.url); setActiveRecRepeat(recCycle); setGroupDetailCycle(recCycle); }}
                              >
                                Cycle {recCycle}
                              </Button>
                            );
                          })}
                        </Space>
                        {activeRecUrl && <video ref={detailVideoRef} src={activeRecUrl} controls style={{ width: '100%', maxHeight: 400 }} />}
                      </div>
                    ),
                  }]}
                />
              )}
              <Table
                columns={stepColumns as any}
                dataSource={cycleSteps}
                rowKey={(r: any) => `${r._seq || r.step_id}_${r.repeat_index}_${r.device_id}`}
                size="small"
                pagination={false}
                scroll={{ y: 500 }}
                rowClassName={(r: any, idx: number) => {
                  const statusCls = r.status === 'pass' ? 'row-pass' : r.status === 'fail' ? 'row-fail' : r.status === 'error' ? 'row-error' : '';
                  // 시나리오 경계 (이전 스텝과 시나리오명 다르면)
                  const prevScenario = idx > 0 ? (cycleSteps[idx - 1] as any)?._scenarioName : null;
                  const boundary = prevScenario && prevScenario !== r._scenarioName ? 'scenario-boundary' : '';
                  return `${statusCls} ${boundary}`.trim();
                }}
              />
            </>
          );
        })()}
        {!groupDetail && detail && (
          <>
            <Descriptions
              bordered
              size="small"
              column={4}
              style={{ marginBottom: 16 }}
            >
              <Descriptions.Item label={t('results.scenario')}>{detail.scenario_name}</Descriptions.Item>
              <Descriptions.Item label={t('scenario.device')}>{detail.device_serial || '-'}</Descriptions.Item>
              <Descriptions.Item label={t('scenario.startTime')}>{formatTime(detail.started_at, true)}</Descriptions.Item>
              <Descriptions.Item label={t('scenario.endTime')}>{formatTime(detail.finished_at, true)}</Descriptions.Item>
              <Descriptions.Item label={t('results.totalExecTime')}>
                <strong>{formatDuration(totalTime(detail.step_results))}</strong>
              </Descriptions.Item>
              <Descriptions.Item label="Repeat">{detail.total_repeat}{t('results.times')}</Descriptions.Item>
              <Descriptions.Item label={t('common.result')}>
                <Space size={4}>
                  <Tag color="green">{detail.passed_steps} Pass</Tag>
                  <Tag color="red">{detail.failed_steps} Fail</Tag>
                  {detail.error_steps > 0 && <Tag color="volcano">{detail.error_steps} Error</Tag>}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('common.status')}>
                <Tag color={statusColor(detail.status)} style={{ fontSize: 14 }}>
                  {detail.status.toUpperCase()}
                </Tag>
              </Descriptions.Item>
            </Descriptions>

            <div style={{ display: 'flex', gap: 8, maxHeight: 'calc(90vh - 200px)', overflow: 'hidden' }}>
              {/* 좌측: 웹캠 녹화 패널 (접힘/펼침) */}
              {recordings.length > 0 && (
                <div style={{ width: webcamPanelOpen ? (webcamExpanded ? '60%' : 300) : 36, flexShrink: 0, transition: 'width 0.2s' }}>
                  {webcamPanelOpen ? (
                    <Card
                      size="small"
                      title={<Space size={4}><VideoCameraOutlined />{t('webcam.recordings')}</Space>}
                      extra={
                        <Space size={0}>
                          <Button type="text" size="small" icon={webcamExpanded ? <ShrinkOutlined /> : <ExpandOutlined />}
                            onClick={() => setWebcamExpanded(!webcamExpanded)} style={{ fontSize: 11 }} />
                          <Button type="text" size="small" onClick={() => { setWebcamPanelOpen(false); setWebcamExpanded(false); }} style={{ fontSize: 11 }}>✕</Button>
                        </Space>
                      }
                      bodyStyle={{ padding: 6 }}
                    >
                      <video
                        ref={detailVideoRef}
                        src={activeRecUrl}
                        controls
                        onTimeUpdate={handleVideoTimeUpdate}
                        onPause={handleVideoPauseOrEnd}
                        onEnded={handleVideoPauseOrEnd}
                        style={{ width: '100%', borderRadius: 4, background: '#000', display: 'block', marginBottom: 6 }}
                      />
                      {recordings.length > 1 && (
                        <Select
                          size="small"
                          value={activeRecRepeat}
                          onChange={(v) => {
                            const rec = recordings.find(r => (r.filename.includes(`webcam_r${v}.webm`) || r.filename.includes(`webcam_r${v}.mp4`)));
                            if (rec) { setActiveRecUrl(rec.url); setActiveRecRepeat(v); }
                          }}
                          style={{ width: '100%', marginBottom: 6 }}
                          options={recordings.map(r => {
                            const m = r.filename.match(/webcam_r(\d+)\.(?:webm|mp4)$/);
                            const ri = m ? parseInt(m[1]) : 1;
                            return { value: ri, label: `${t('webcam.repeat')} ${ri}  (${(r.size / 1024 / 1024).toFixed(1)} MB)` };
                          })}
                        />
                      )}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {recordings.map((rec) => {
                          const m = rec.filename.match(/webcam_r(\d+)\.(?:webm|mp4)$/);
                          const ri = m ? m[1] : '?';
                          const isActive = rec.url === activeRecUrl;
                          return (
                            <div key={rec.filename} style={{
                              display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
                              padding: '2px 4px', borderRadius: 4,
                              background: isActive ? 'var(--accent-light, #e6f4ff)' : 'transparent',
                              border: isActive ? '1px solid var(--accent, #1677ff)' : '1px solid transparent',
                              cursor: 'pointer',
                            }}
                              onClick={() => { setActiveRecUrl(rec.url); const recCycle = m ? parseInt(m[1]) : 1; setActiveRecRepeat(recCycle); }}
                            >
                              <Tag color={isActive ? 'processing' : 'blue'} style={{ margin: 0, fontSize: 10 }}>R{ri}</Tag>
                              <span style={{ flex: 1, color: isActive ? 'var(--accent, #1677ff)' : '#888', fontWeight: isActive ? 600 : 400 }}>{(rec.size / 1024 / 1024).toFixed(1)}MB</span>
                              <Tooltip title={t('webcam.trimSave')}>
                                <Button size="small" type="text" icon={<ScissorOutlined />} style={{ padding: '0 4px', height: 20 }}
                                  onClick={() => {
                                    setTrimFile(rec.filename);
                                    setTrimStart(0);
                                    // 비디오 길이를 임시 video 요소로 가져와 trimEnd 초기화
                                    const tmpVideo = document.createElement('video');
                                    tmpVideo.src = `/recordings/${rec.filename}`;
                                    tmpVideo.onloadedmetadata = () => { setTrimEnd(Math.round(tmpVideo.duration * 10) / 10); tmpVideo.src = ''; };
                                    tmpVideo.onerror = () => setTrimEnd(0);
                                  }} />
                              </Tooltip>
                              <Tooltip title={t('common.delete')}>
                                <Button size="small" type="text" danger icon={<DeleteOutlined />} style={{ padding: '0 4px', height: 20 }}
                                  onClick={() => Modal.confirm({
                                    title: t('webcam.deleteConfirm'), okType: 'danger',
                                    onOk: async () => {
                                      await resultsApi.deleteRecording(rec.filename);
                                      message.success(t('webcam.deleteSuccess'));
                                      // 삭제된 녹화가 현재 재생 중이면 URL 초기화
                                      if (rec.url === activeRecUrl) setActiveRecUrl('');
                                      fetchRecordings(detailFilename);
                                    },
                                  })} />
                              </Tooltip>
                            </div>
                          );
                        })}
                      </div>
                    </Card>
                  ) : (
                    <Tooltip title={t('webcam.recordings')} placement="right">
                      <Button
                        type="text"
                        icon={<VideoCameraOutlined />}
                        onClick={() => setWebcamPanelOpen(true)}
                        style={{ writingMode: 'vertical-rl', height: 'auto', padding: '8px 4px', fontSize: 12 }}
                      >
                        {t('webcam.recordings')} ({recordings.length})
                      </Button>
                    </Tooltip>
                  )}
                </div>
              )}

              {/* 우측: 스텝 결과 테이블 (스크롤) */}
              <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
                <Table
                  columns={stepColumns}
                  dataSource={detail.step_results}
                  rowKey={(r: StepResultDetail) => `${r.step_id}_${r.repeat_index}`}
                  size="small"
                  pagination={false}
                  rowClassName={(r: StepResultDetail) => {
                    const statusCls = r.status === 'fail' ? 'result-row-fail' :
                      r.status === 'error' ? 'result-row-error' :
                      r.status === 'warning' ? 'result-row-warning' : '';
                    const playingCls = currentPlayingStepId === r.step_id && (r.repeat_index || 1) === activeRecRepeat ? 'result-row-playing' : '';
                    return [statusCls, playingCls].filter(Boolean).join(' ');
                  }}
                  onRow={(r) => ({
                    onClick: () => { if (recordings.length > 0) seekToStep(r); },
                    style: recordings.length > 0 ? { cursor: 'pointer' } : undefined,
                  })}
                />
              </div>
            </div>
          </>
        )}
      </Modal>

      {/* Trim modal */}
      <Modal
        title={t('webcam.trimSave')}
        open={!!trimFile}
        onCancel={() => setTrimFile(null)}
        onOk={async () => {
          if (!trimFile || trimEnd <= trimStart) return;
          try {
            const res = await resultsApi.trimRecording(trimFile, trimStart, trimEnd);
            message.success(t('webcam.trimSuccess'));
            setTrimFile(null);
            fetchRecordings(detailFilename);
          } catch (e: any) {
            message.error(e.response?.data?.detail || t('webcam.trimFailed'));
          }
        }}
        okText={t('webcam.trimSave')}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <video src={trimFile ? `/recordings/${trimFile}` : undefined} controls style={{ width: '100%', borderRadius: 4 }} />
          </div>
          <Space>
            <span>{t('webcam.trimStart')}:</span>
            <InputNumber min={0} step={0.1} value={trimStart} onChange={(v) => setTrimStart(v || 0)} style={{ width: 100 }} />
            <span>{t('webcam.trimEnd')}:</span>
            <InputNumber min={0} step={0.1} value={trimEnd} onChange={(v) => setTrimEnd(v || 0)} style={{ width: 100 }} />
          </Space>
        </Space>
      </Modal>

      {/* Image comparison modal */}
      <Modal
        title={t('results.stepCompare', { id: String(compareStep?.step_id || '') })}
        open={!!compareStep}
        onCancel={() => setCompareStep(null)}
        width={1100}
        footer={null}
      >
        {compareStep && (
          <>
            <Space style={{ marginBottom: 16 }} wrap>
              <Tag color={statusColor(compareStep.status)}>{compareStep.status.toUpperCase()}</Tag>
              {compareStep.compare_mode && compareStep.compare_mode !== 'full' && (
                <Tag color="purple">
                  {compareStep.compare_mode === 'single_crop' ? t('results.singleCrop')
                    : compareStep.compare_mode === 'full_exclude' ? t('results.excludeArea')
                    : compareStep.compare_mode === 'multi_crop' ? t('results.multiCrop')
                    : compareStep.compare_mode}
                </Tag>
              )}
              {compareStep.similarity_score != null && (
                <span>
                  {t('results.similarity')}: {(compareStep.similarity_score * 100).toFixed(2)}%
                </span>
              )}
              {compareStep.match_location && (
                <Tag color="blue">
                  {t('results.matchLocation')}: ({compareStep.match_location.x},{compareStep.match_location.y})
                  {' '}{compareStep.match_location.width}x{compareStep.match_location.height}
                </Tag>
              )}
              <span style={{ color: '#888' }}>Duration: {formatDuration(compareStep.execution_time_ms)}</span>
            </Space>
            <Row gutter={16}>
              <Col span={12}>
                <Card size="small" title={
                  compareStep.compare_mode === 'full_exclude' ? t('results.expectedExclude')
                  : compareStep.compare_mode === 'multi_crop' ? t('results.expectedCrop')
                  : t('results.expectedImage')
                }>
                  {compareStep.expected_image ? (
                    <div style={{ position: 'relative' }}>
                      <Image
                        src={`${imageUrl(compareStep.expected_annotated_image || compareStep.expected_image)!}?t=${Date.now()}`}
                        alt="Expected"
                        style={{ width: '100%' }}
                      />
                      {/* Overlay annotations for multi_crop when no pre-rendered annotated image */}
                      {!compareStep.expected_annotated_image && compareStep.compare_mode === 'multi_crop' && compareStep.sub_results?.length > 0 && (
                        <AnnotatedOverlay subResults={compareStep.sub_results} expectedImage={imageUrl(compareStep.expected_image)!} />
                      )}
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>{t('common.noImage')}</div>
                  )}
                </Card>
              </Col>
              <Col span={12}>
                <Card size="small" title={t('results.actualImage')}>
                  {compareStep.actual_annotated_image ? (
                    <Image
                      src={`${imageUrl(compareStep.actual_annotated_image)!}?t=${Date.now()}`}
                      alt="Actual (annotated)"
                      style={{ width: '100%' }}
                    />
                  ) : compareStep.actual_image ? (
                    <Image
                      src={`${imageUrl(compareStep.actual_image)!}?t=${Date.now()}`}
                      alt="Actual"
                      style={{ width: '100%' }}
                    />
                  ) : (
                    <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>{t('common.noImage')}</div>
                  )}
                </Card>
              </Col>
            </Row>
            {compareStep.compare_mode === 'full_exclude' && (
              <div style={{ marginTop: 12 }}>
                <Card size="small" title={t('results.excludeAreaCompare')}>
                  <Space wrap>
                    <Tag color="red">{t('results.excludeAreaApplied')}</Tag>
                    <span style={{ fontSize: 13, color: '#ccc' }}>{compareStep.message}</span>
                  </Space>
                  <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>
                    {t('results.excludeAreaDesc')}
                  </div>
                </Card>
              </div>
            )}
            {compareStep.compare_mode === 'multi_crop' && compareStep.sub_results?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <Card size="small" title={t('results.cropResults', { count: String(compareStep.sub_results.length) })}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #303030' }}>
                        <th style={{ padding: '4px 8px', textAlign: 'left' }}>#</th>
                        <th style={{ padding: '4px 8px', textAlign: 'left' }}>{t('results.label')}</th>
                        <th style={{ padding: '4px 8px', textAlign: 'center' }}>{t('common.status')}</th>
                        <th style={{ padding: '4px 8px', textAlign: 'right' }}>{t('results.similarity')}</th>
                        <th style={{ padding: '4px 8px', textAlign: 'right' }}>{t('results.matchLocation')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compareStep.sub_results.map((sr, si) => (
                        <tr key={si} style={{ borderBottom: '1px solid #222' }}>
                          <td style={{ padding: '4px 8px' }}>{si + 1}</td>
                          <td style={{ padding: '4px 8px' }}>{sr.label || '-'}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                            <Tag color={statusColor(sr.status)}>{sr.status.toUpperCase()}</Tag>
                          </td>
                          <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                            {(sr.score * 100).toFixed(2)}%
                          </td>
                          <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                            {sr.match_location
                              ? `(${sr.match_location.x},${sr.match_location.y}) ${sr.match_location.width}x${sr.match_location.height}`
                              : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </div>
            )}
          </>
        )}
      </Modal>

      <style>{`
        .result-row-fail td { background: rgba(255, 77, 79, 0.08) !important; }
        .result-row-error td { background: rgba(255, 122, 69, 0.08) !important; }
        .result-row-warning td { background: rgba(250, 173, 20, 0.08) !important; }
        .result-row-playing td { background: rgba(22, 119, 255, 0.18) !important; box-shadow: inset 3px 0 0 #1677ff; }
        @keyframes playingPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
        .result-row-playing td:first-child { animation: playingPulse 1.5s infinite; }
        .scenario-boundary td { border-top: 2px solid #1677ff !important; }
      `}</style>
    </div>
  );
}
