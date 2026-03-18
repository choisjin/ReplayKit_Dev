import React, { useEffect, useRef, useState } from 'react';
import { Button, Card, Col, Descriptions, Image, InputNumber, Modal, Row, Space, Table, Tag, Tooltip, message } from 'antd';
import { DeleteOutlined, DownloadOutlined, EyeOutlined, PlayCircleOutlined, ReloadOutlined, ScissorOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { resultsApi } from '../services/api';
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
  const { settings, saveExcelToDir } = useSettings();
  const { t, lang } = useTranslation();
  const [results, setResults] = useState<ResultSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<ResultDetail | null>(null);
  const [detailFilename, setDetailFilename] = useState('');
  const [detailVisible, setDetailVisible] = useState(false);
  const [compareStep, setCompareStep] = useState<StepResultDetail | null>(null);

  // Webcam recordings
  const [recordings, setRecordings] = useState<{ filename: string; size: number; url: string }[]>([]);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [trimFile, setTrimFile] = useState<string | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  const fetchRecordings = async (resultFilename: string) => {
    try {
      const res = await resultsApi.listRecordings(resultFilename);
      setRecordings(res.data.recordings || []);
    } catch { setRecordings([]); }
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

  const exportExcel = async (filename: string) => {
    // Always try server-side save first
    try {
      const path = await saveExcelToDir(filename);
      message.success(t('results.excelSaveComplete', { path }));
      return;
    } catch (serverErr: any) {
      const status = serverErr.response?.status;
      const detail = serverErr.response?.data?.detail || '';
      if (status !== 400 || !detail.includes('경로가 설정되지')) {
        if (status) {
          message.error(t('results.excelSaveFailed', { status, detail }));
          return;
        }
      }
    }
    // Fallback: browser download
    try {
      const res = await resultsApi.exportExcel(filename);
      const blob = new Blob([res.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename.replace('.json', '.xlsx');
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('results.excelExportFailed'));
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
          <Tooltip title={t('results.excelExport')}>
            <Button size="small" icon={<DownloadOutlined />} onClick={() => exportExcel(record.filename)} />
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
      render: (v: string, r: StepResultDetail) => v || r.message || '-',
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
          <Button icon={<ReloadOutlined />} onClick={fetchResults} loading={loading}>
            {t('common.refresh')}
          </Button>
        }
      >
        <Table
          columns={columns}
          dataSource={results}
          rowKey="filename"
          size="small"
          pagination={{ pageSize: 15, showSizeChanger: true }}
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
              onClick={() => detailFilename && exportExcel(detailFilename)}
            >
              {t('results.excelExport')}
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
            />

            {/* Webcam recordings */}
            {recordings.length > 0 && (
              <Card
                size="small"
                title={<Space><VideoCameraOutlined />{t('webcam.recordings')} ({recordings.length})</Space>}
                style={{ marginTop: 12 }}
              >
                {recordings.map((rec) => {
                  const match = rec.filename.match(/_webcam_r(\d+)\.webm$/);
                  const repeatIdx = match ? match[1] : '?';
                  const sizeMB = (rec.size / 1024 / 1024).toFixed(1);
                  return (
                    <div key={rec.filename} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
                      <Tag color="blue">{t('webcam.repeat')} {repeatIdx}</Tag>
                      <span style={{ flex: 1, fontSize: 12, color: '#888' }}>{sizeMB} MB</span>
                      <Button size="small" icon={<PlayCircleOutlined />} onClick={() => setVideoUrl(rec.url)}>
                        {t('webcam.play')}
                      </Button>
                      <Button size="small" icon={<ScissorOutlined />} onClick={() => { setTrimFile(rec.filename); setTrimStart(0); setTrimEnd(0); }}>
                        {t('webcam.trimSave')}
                      </Button>
                      <Button size="small" danger icon={<DeleteOutlined />} onClick={() => {
                        Modal.confirm({
                          title: t('webcam.deleteConfirm'),
                          okType: 'danger',
                          onOk: async () => {
                            await resultsApi.deleteRecording(rec.filename);
                            message.success(t('webcam.deleteSuccess'));
                            fetchRecordings(detailFilename);
                          },
                        });
                      }} />
                    </div>
                  );
                })}
              </Card>
            )}
          </>
        )}
      </Modal>

      {/* Video player modal */}
      <Modal
        title={t('webcam.recordings')}
        open={!!videoUrl}
        onCancel={() => setVideoUrl(null)}
        footer={null}
        width={720}
      >
        {videoUrl && (
          <video ref={videoRef} src={videoUrl} controls autoPlay style={{ width: '100%', borderRadius: 4 }} />
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
            {compareStep.diff_image && (
              <div style={{ marginTop: 12 }}>
                <Card size="small" title={t('results.diffHeatmap')}>
                  <Image
                    src={`${imageUrl(compareStep.diff_image)!}?t=${Date.now()}`}
                    alt="Diff"
                    style={{ width: '100%' }}
                  />
                </Card>
              </div>
            )}
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
