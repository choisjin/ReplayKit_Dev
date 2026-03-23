import React, { useEffect, useRef, useState } from 'react';
import { Button, Card, Collapse, Col, Descriptions, Image, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Tooltip, message } from 'antd';
import { DeleteOutlined, DownloadOutlined, EyeOutlined, PlayCircleOutlined, ReloadOutlined, ScissorOutlined, SearchOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { resultsApi, scenarioApi } from '../services/api';
import { useSettings } from '../context/SettingsContext';
import { useTranslation } from '../i18n';

interface ResultSummary {
  filename: string;
  scenario_name: string;
  status: string;
  total_steps: number;
  passed_steps: number;
  failed_steps: number;
  warning_steps: number;
  error_steps: number;
  started_at: string;
  finished_at: string;
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
  const [compareStep, setCompareStep] = useState<StepResultDetail | null>(null);

  // 백그라운드 CMD 폴링
  const bgPollTimers = useRef<ReturnType<typeof setInterval>[]>([]);

  // 선택 삭제 + 필터
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [scenarioFilter, setScenarioFilter] = useState('');

  // Webcam recordings
  const [recordings, setRecordings] = useState<{ filename: string; size: number; url: string }[]>([]);
  const [webcamPanelOpen, setWebcamPanelOpen] = useState(false);
  const [activeRecUrl, setActiveRecUrl] = useState('');
  const [activeRecRepeat, setActiveRecRepeat] = useState(1);
  const detailVideoRef = useRef<HTMLVideoElement>(null);
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
        const m = recs[0].filename.match(/_webcam_r(\d+)\.webm$/);
        setActiveRecRepeat(m ? parseInt(m[1]) : 1);
      } else {
        setActiveRecUrl('');
      }
    } catch { setRecordings([]); }
  };

  const seekToStep = (step: StepResultDetail) => {
    if (!detail || recordings.length === 0) return;
    // 패널 열기
    if (!webcamPanelOpen) setWebcamPanelOpen(true);
    // 해당 회차 녹화 선택
    const targetRepeat = step.repeat_index || 1;
    const rec = recordings.find(r => r.filename.includes(`_webcam_r${targetRepeat}.webm`));
    if (!rec) return;

    // 같은 회차의 첫 스텝 타임스탬프 기준으로 오프셋 계산
    const sameRepeatSteps = detail.step_results.filter(s => (s.repeat_index || 1) === targetRepeat);
    const firstStep = sameRepeatSteps[0];
    if (!firstStep?.timestamp || !step.timestamp) return;
    const firstTime = new Date(firstStep.timestamp).getTime();
    const stepTime = new Date(step.timestamp).getTime();
    const offsetSec = Math.max(0, (stepTime - firstTime) / 1000 - 2);

    const doSeek = () => {
      const video = detailVideoRef.current;
      if (!video) return;
      const applySeek = () => {
        video.currentTime = offsetSec;
      };
      // 비디오가 로드되어 있으면 즉시, 아니면 로드 후 seek
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
      // 소스 변경 → React 렌더링 후 seek
      setTimeout(doSeek, 100);
    } else {
      doSeek();
    }
  };

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

  const viewDetail = async (filename: string) => {
    try {
      const res = await resultsApi.get(filename);
      setDetail(res.data);
      setDetailFilename(filename);
      setDetailVisible(true);
      fetchRecordings(filename);
    } catch {
      message.error(t('results.detailFailed'));
    }
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
      const { path, files } = res.data;
      message.success(t('results.exportBundleComplete', { path, count: String(files.length) }));
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('results.exportBundleFailed'));
    }
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
    // 이전 폴링 정리
    bgPollTimers.current.forEach(t => clearInterval(t));
    bgPollTimers.current = [];

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
          if (r.data.status === 'running') return;
          clearInterval(poll);

          const stdout = r.data.stdout || '';
          setDetail(prev => {
            if (!prev) return prev;
            const updated = { ...prev, step_results: [...prev.step_results] };
            const step = updated.step_results[idx];
            const cmd = step.command || '';
            const isCmdCheck = cmd.startsWith('cmd_check:');

            if (isCmdCheck) {
              // command에서 expected와 match_mode 추출: "cmd_check: ... (expect[mode]: ...)"
              const expectMatch = cmd.match(/\(expect(?:\[(\w+)\])?:\s*(.*)\)$/);
              const matchMode = expectMatch?.[1] || 'contains';
              const expected = expectMatch?.[2] || '';
              const passed = matchMode === 'exact'
                ? stdout.trim() === expected.trim()
                : stdout.includes(expected);
              const newMsg = `[CMD_CHECK]\nexpected(${matchMode}): ${expected}\n---\n${stdout}`;
              const newStatus = passed ? step.status : 'fail';
              updated.step_results[idx] = { ...step, message: newMsg, status: newStatus };

              // 카운트 재계산
              if (!passed && step.status !== 'fail') {
                updated.failed_steps += 1;
                if (step.status === 'pass') updated.passed_steps = Math.max(0, updated.passed_steps - 1);
                else if (step.status === 'warning') updated.warning_steps = Math.max(0, updated.warning_steps - 1);
                if (updated.failed_steps > 0 || updated.error_steps > 0) updated.status = 'fail';
              }

              // 백엔드에 영구 저장
              resultsApi.updateStepResult(detailFilename, idx, newMsg, newStatus).catch(() => {});
            } else {
              const newMsg = stdout || `완료 (rc: ${r.data.rc})`;
              updated.step_results[idx] = { ...step, message: newMsg };
              resultsApi.updateStepResult(detailFilename, idx, newMsg).catch(() => {});
            }
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
    });

    return () => {
      bgPollTimers.current.forEach(t => clearInterval(t));
      bgPollTimers.current = [];
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

  const formatTime = (iso: string) => {
    if (!iso) return '-';
    try {
      return new Date(iso).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US');
    } catch {
      return iso;
    }
  };

  const deleteSelected = () => {
    if (selectedRowKeys.length === 0) return;
    Modal.confirm({
      title: t('results.deleteTitle'),
      content: `${selectedRowKeys.length}${t('results.deleteSelectedConfirm')}`,
      okText: t('common.delete'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        for (const key of selectedRowKeys) {
          try { await resultsApi.delete(key as string); } catch { /* skip */ }
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

  const columns = [
    {
      title: t('results.execTime'),
      key: 'time',
      width: 200,
      render: (_: any, r: ResultSummary) => <span style={{ whiteSpace: 'nowrap' }}>{formatTime(r.started_at)}</span>,
      sorter: (a: ResultSummary, b: ResultSummary) => (a.started_at || '').localeCompare(b.started_at || ''),
      defaultSortOrder: 'descend' as const,
    },
    {
      title: t('results.scenario'),
      dataIndex: 'scenario_name',
      key: 'name',
      sorter: (a: ResultSummary, b: ResultSummary) => a.scenario_name.localeCompare(b.scenario_name),
      filters: scenarioNames.map(n => ({ text: n, value: n })),
      onFilter: (value: any, record: ResultSummary) => record.scenario_name === value,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      key: 'status',
      width: 90,
      filters: [
        { text: 'PASS', value: 'pass' },
        { text: 'FAIL', value: 'fail' },
        { text: 'WARNING', value: 'warning' },
        { text: 'ERROR', value: 'error' },
      ],
      onFilter: (value: any, record: ResultSummary) => record.status === value,
      render: (s: string) => <Tag color={statusColor(s)}>{s.toUpperCase()}</Tag>,
    },
    {
      title: t('common.result'),
      key: 'counts',
      width: 180,
      render: (_: any, r: ResultSummary) => (
        <Space size={4}>
          <Tag color="green">{r.passed_steps}P</Tag>
          <Tag color="red">{r.failed_steps}F</Tag>
          {r.warning_steps > 0 && <Tag color="orange">{r.warning_steps}W</Tag>}
          {r.error_steps > 0 && <Tag color="volcano">{r.error_steps}E</Tag>}
          <span style={{ color: '#888' }}>/ {r.total_steps}</span>
        </Space>
      ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 200,
      render: (_: any, record: ResultSummary) => (
        <Space size={4}>
          <Tooltip title={t('results.viewDetail')}>
            <Button size="small" icon={<EyeOutlined />} onClick={() => viewDetail(record.filename)}>
              {t('common.details')}
            </Button>
          </Tooltip>
          <Tooltip title={t('results.exportBundle')}>
            <Button size="small" icon={<DownloadOutlined />} onClick={() => exportBundle(record.filename)} />
          </Tooltip>
          <Tooltip title={t('common.delete')}>
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => deleteResult(record.filename)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  const stepColumns = [
    {
      title: <div>Time Stamp<br /><span style={{ fontSize: 11, color: '#888' }}>{t('results.timestamp')}</span></div>,
      dataIndex: 'timestamp',
      key: 'timestamp',
      width: 160,
      render: (v: string | null) => v ? formatTime(v) : '-',
    },
    {
      title: <div>Repeat<br /><span style={{ fontSize: 11, color: '#888' }}>{t('results.repeat')}</span></div>,
      key: 'repeat',
      width: 80,
      render: (_: any, r: StepResultDetail) => detail ? `${r.repeat_index ?? 1}/${detail.total_repeat}` : '-',
    },
    {
      title: <div>Step<br /><span style={{ fontSize: 11, color: '#888' }}>{t('results.step')}</span></div>,
      dataIndex: 'step_id',
      key: 'step_id',
      width: 60,
      align: 'center' as const,
    },
    {
      title: <div>Device<br /><span style={{ fontSize: 11, color: '#888' }}>{t('results.deviceCol')}</span></div>,
      dataIndex: 'device_id',
      key: 'device_id',
      width: 120,
      ellipsis: true,
      render: (v: string) => v || '-',
    },
    {
      title: <div>Command<br /><span style={{ fontSize: 11, color: '#888' }}>action</span></div>,
      dataIndex: 'command',
      key: 'command',
      ellipsis: true,
      render: (v: string, r: StepResultDetail) => {
        const isCmdStep = v?.startsWith('cmd_send:') || v?.startsWith('cmd_check:');
        if (isCmdStep && r.message) {
          // BG_TASK 마커가 아직 남아있으면 실행 중 표시
          if (r.message.match(/\[BG_TASK:/)) {
            return <span>{v} <Tag color="processing">BG</Tag></span>;
          }
          // 실행 중 표시
          if (r.message.startsWith('⏳')) {
            return <span>{v} <Tag color="processing">⏳</Tag></span>;
          }
          // CMD_CHECK 결과가 있으면 간략 표시
          if (r.message.startsWith('[CMD_CHECK]')) {
            return <Tooltip title={<pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap' }}>{r.message}</pre>}><span>{v}</span></Tooltip>;
          }
          // CMD_SEND 결과
          return <Tooltip title={<pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{r.message}</pre>}><span>{v}</span></Tooltip>;
        }
        return v || r.message || '-';
      },
    },
    {
      title: <div>Status<br /><span style={{ fontSize: 11, color: '#888' }}>{t('results.resultCol')}</span></div>,
      dataIndex: 'status',
      key: 'status',
      width: 90,
      align: 'center' as const,
      render: (s: string) => <Tag color={statusColor(s)}>{s.toUpperCase()}</Tag>,
    },
    {
      title: <div>Delay<br /><span style={{ fontSize: 11, color: '#888' }}>{t('results.delaySet')}</span></div>,
      dataIndex: 'delay_ms',
      key: 'delay',
      width: 90,
      align: 'center' as const,
      render: (v: number) => v ? formatDuration(v) : '-',
    },
    {
      title: <div>Duration<br /><span style={{ fontSize: 11, color: '#888' }}>{t('results.duration')}</span></div>,
      dataIndex: 'execution_time_ms',
      key: 'duration',
      width: 100,
      align: 'center' as const,
      render: (v: number) => formatDuration(v),
    },
    {
      title: t('scenario.compare'),
      key: 'compare',
      width: 70,
      align: 'center' as const,
      render: (_: any, r: StepResultDetail) => {
        if (r.expected_image || r.actual_image) {
          return (
            <Button size="small" onClick={() => setCompareStep(r)}>
              {t('scenario.compare')}
            </Button>
          );
        }
        return '-';
      },
    },
  ];

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
            <Button icon={<ReloadOutlined />} onClick={fetchResults} loading={loading} size="small">
              {t('common.refresh')}
            </Button>
          </Space>
        }
      >
        <Table
          columns={columns}
          dataSource={filteredResults}
          rowKey="filename"
          size="small"
          pagination={{ pageSize: 15, showSizeChanger: true }}
          rowSelection={{
            selectedRowKeys,
            onChange: (keys) => setSelectedRowKeys(keys),
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
        onCancel={() => setDetailVisible(false)}
        width={1200}
        footer={
          <Space>
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
        {detail && (
          <>
            <Descriptions
              bordered
              size="small"
              column={4}
              style={{ marginBottom: 16 }}
            >
              <Descriptions.Item label={t('results.scenario')}>{detail.scenario_name}</Descriptions.Item>
              <Descriptions.Item label={t('scenario.device')}>{detail.device_serial || '-'}</Descriptions.Item>
              <Descriptions.Item label={t('scenario.startTime')}>{formatTime(detail.started_at)}</Descriptions.Item>
              <Descriptions.Item label={t('scenario.endTime')}>{formatTime(detail.finished_at)}</Descriptions.Item>
              <Descriptions.Item label={t('results.totalExecTime')}>
                <strong>{formatDuration(totalTime(detail.step_results))}</strong>
              </Descriptions.Item>
              <Descriptions.Item label="Repeat">{detail.total_repeat}{t('results.times')}</Descriptions.Item>
              <Descriptions.Item label={t('common.result')}>
                <Space size={4}>
                  <Tag color="green">{detail.passed_steps} Pass</Tag>
                  <Tag color="red">{detail.failed_steps} Fail</Tag>
                  {detail.warning_steps > 0 && <Tag color="orange">{detail.warning_steps} Warning</Tag>}
                  {detail.error_steps > 0 && <Tag color="volcano">{detail.error_steps} Error</Tag>}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('common.status')}>
                <Tag color={statusColor(detail.status)} style={{ fontSize: 14 }}>
                  {detail.status.toUpperCase()}
                </Tag>
              </Descriptions.Item>
            </Descriptions>

            <div style={{ display: 'flex', gap: 8 }}>
              {/* 좌측: 웹캠 녹화 패널 (접힘/펼침) */}
              {recordings.length > 0 && (
                <div style={{ width: webcamPanelOpen ? 300 : 36, flexShrink: 0, transition: 'width 0.2s' }}>
                  {webcamPanelOpen ? (
                    <Card
                      size="small"
                      title={<Space size={4}><VideoCameraOutlined />{t('webcam.recordings')}</Space>}
                      extra={<Button type="text" size="small" onClick={() => setWebcamPanelOpen(false)} style={{ fontSize: 11 }}>✕</Button>}
                      bodyStyle={{ padding: 6 }}
                    >
                      <video
                        ref={detailVideoRef}
                        src={activeRecUrl}
                        controls
                        style={{ width: '100%', borderRadius: 4, background: '#000', display: 'block', marginBottom: 6 }}
                      />
                      {recordings.length > 1 && (
                        <Select
                          size="small"
                          value={activeRecRepeat}
                          onChange={(v) => {
                            const rec = recordings.find(r => r.filename.includes(`_webcam_r${v}.webm`));
                            if (rec) { setActiveRecUrl(rec.url); setActiveRecRepeat(v); }
                          }}
                          style={{ width: '100%', marginBottom: 6 }}
                          options={recordings.map(r => {
                            const m = r.filename.match(/_webcam_r(\d+)\.webm$/);
                            const ri = m ? parseInt(m[1]) : 1;
                            return { value: ri, label: `${t('webcam.repeat')} ${ri}  (${(r.size / 1024 / 1024).toFixed(1)} MB)` };
                          })}
                        />
                      )}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {recordings.map((rec) => {
                          const m = rec.filename.match(/_webcam_r(\d+)\.webm$/);
                          const ri = m ? m[1] : '?';
                          return (
                            <div key={rec.filename} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                              <Tag color="blue" style={{ margin: 0, fontSize: 10 }}>R{ri}</Tag>
                              <span style={{ flex: 1, color: '#888' }}>{(rec.size / 1024 / 1024).toFixed(1)}MB</span>
                              <Tooltip title={t('webcam.trimSave')}>
                                <Button size="small" type="text" icon={<ScissorOutlined />} style={{ padding: '0 4px', height: 20 }}
                                  onClick={() => { setTrimFile(rec.filename); setTrimStart(0); setTrimEnd(0); }} />
                              </Tooltip>
                              <Tooltip title={t('common.delete')}>
                                <Button size="small" type="text" danger icon={<DeleteOutlined />} style={{ padding: '0 4px', height: 20 }}
                                  onClick={() => Modal.confirm({
                                    title: t('webcam.deleteConfirm'), okType: 'danger',
                                    onOk: async () => { await resultsApi.deleteRecording(rec.filename); message.success(t('webcam.deleteSuccess')); fetchRecordings(detailFilename); },
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

              {/* 우측: 스텝 결과 테이블 */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <Table
                  columns={stepColumns}
                  dataSource={detail.step_results}
                  rowKey="step_id"
                  size="small"
                  pagination={false}
                  rowClassName={(r: StepResultDetail) =>
                    r.status === 'fail' ? 'result-row-fail' :
                    r.status === 'error' ? 'result-row-error' :
                    r.status === 'warning' ? 'result-row-warning' : ''
                  }
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
      `}</style>
    </div>
  );
}
