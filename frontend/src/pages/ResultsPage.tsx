import React, { useEffect, useRef, useState } from 'react';
import { Button, Card, Col, Descriptions, Image, Modal, Row, Space, Table, Tag, Tooltip, message } from 'antd';
import { DeleteOutlined, DownloadOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import { resultsApi } from '../services/api';
import { useSettings } from '../context/SettingsContext';

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
  const [results, setResults] = useState<ResultSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<ResultDetail | null>(null);
  const [detailFilename, setDetailFilename] = useState('');
  const [detailVisible, setDetailVisible] = useState(false);
  const [compareStep, setCompareStep] = useState<StepResultDetail | null>(null);

  const fetchResults = async () => {
    setLoading(true);
    try {
      const res = await resultsApi.list();
      setResults(res.data.results);
    } catch {
      message.error('결과 목록 불러오기 실패');
    }
    setLoading(false);
  };

  const viewDetail = async (filename: string) => {
    try {
      const res = await resultsApi.get(filename);
      setDetail(res.data);
      setDetailFilename(filename);
      setDetailVisible(true);
    } catch {
      message.error('결과 상세 불러오기 실패');
    }
  };

  const deleteResult = (filename: string) => {
    Modal.confirm({
      title: '결과 삭제',
      content: `"${filename}" 결과를 삭제하시겠습니까?`,
      okText: '삭제',
      okType: 'danger',
      cancelText: '취소',
      onOk: async () => {
        try {
          await resultsApi.delete(filename);
          message.success('삭제 완료');
          fetchResults();
          if (detailFilename === filename) {
            setDetailVisible(false);
            setDetail(null);
          }
        } catch {
          message.error('삭제 실패');
        }
      },
    });
  };

  const exportExcel = async (filename: string) => {
    try {
      if (settings.excel_export_dir) {
        const path = await saveExcelToDir(filename);
        message.success(`Excel 저장 완료: ${path}`);
      } else {
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
      }
    } catch (e: any) {
      message.error(e.response?.data?.detail || 'Excel 내보내기 실패');
    }
  };

  useEffect(() => {
    fetchResults();
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
      return new Date(iso).toLocaleString('ko-KR');
    } catch {
      return iso;
    }
  };

  const columns = [
    {
      title: '시나리오',
      dataIndex: 'scenario_name',
      key: 'name',
      sorter: (a: ResultSummary, b: ResultSummary) => a.scenario_name.localeCompare(b.scenario_name),
    },
    {
      title: '상태',
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
      title: '결과',
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
      title: '실행 시간',
      key: 'time',
      width: 160,
      render: (_: any, r: ResultSummary) => formatTime(r.started_at),
      sorter: (a: ResultSummary, b: ResultSummary) => (a.started_at || '').localeCompare(b.started_at || ''),
      defaultSortOrder: 'descend' as const,
    },
    {
      title: '작업',
      key: 'actions',
      width: 200,
      render: (_: any, record: ResultSummary) => (
        <Space size={4}>
          <Tooltip title="상세보기">
            <Button size="small" icon={<EyeOutlined />} onClick={() => viewDetail(record.filename)}>
              상세
            </Button>
          </Tooltip>
          <Tooltip title="Excel 내보내기">
            <Button size="small" icon={<DownloadOutlined />} onClick={() => exportExcel(record.filename)} />
          </Tooltip>
          <Tooltip title="삭제">
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => deleteResult(record.filename)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  const stepColumns = [
    {
      title: <div>Time Stamp<br /><span style={{ fontSize: 11, color: '#888' }}>실행 시각</span></div>,
      dataIndex: 'timestamp',
      key: 'timestamp',
      width: 160,
      render: (v: string | null) => v ? formatTime(v) : '-',
    },
    {
      title: <div>Repeat<br /><span style={{ fontSize: 11, color: '#888' }}>현재/총</span></div>,
      key: 'repeat',
      width: 80,
      render: (_: any, r: StepResultDetail) => detail ? `${r.repeat_index ?? 1}/${detail.total_repeat}` : '-',
    },
    {
      title: <div>Step<br /><span style={{ fontSize: 11, color: '#888' }}>순서</span></div>,
      dataIndex: 'step_id',
      key: 'step_id',
      width: 60,
      align: 'center' as const,
    },
    {
      title: <div>Device<br /><span style={{ fontSize: 11, color: '#888' }}>장치</span></div>,
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
      title: <div>Status<br /><span style={{ fontSize: 11, color: '#888' }}>결과</span></div>,
      dataIndex: 'status',
      key: 'status',
      width: 90,
      align: 'center' as const,
      render: (s: string) => <Tag color={statusColor(s)}>{s.toUpperCase()}</Tag>,
    },
    {
      title: <div>Delay<br /><span style={{ fontSize: 11, color: '#888' }}>설정 딜레이</span></div>,
      dataIndex: 'delay_ms',
      key: 'delay',
      width: 90,
      align: 'center' as const,
      render: (v: number) => v ? formatDuration(v) : '-',
    },
    {
      title: <div>Duration<br /><span style={{ fontSize: 11, color: '#888' }}>실제 시간</span></div>,
      dataIndex: 'execution_time_ms',
      key: 'duration',
      width: 100,
      align: 'center' as const,
      render: (v: number) => formatDuration(v),
    },
    {
      title: '비교',
      key: 'compare',
      width: 70,
      align: 'center' as const,
      render: (_: any, r: StepResultDetail) => {
        if (r.expected_image || r.actual_image) {
          return (
            <Button size="small" onClick={() => setCompareStep(r)}>
              비교
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
        title="테스트 실행 결과"
        extra={
          <Button icon={<ReloadOutlined />} onClick={fetchResults} loading={loading}>
            새로고침
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
            <span>{detail?.scenario_name || '결과 상세'}</span>
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
              Excel 내보내기
            </Button>
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={() => detailFilename && deleteResult(detailFilename)}
            >
              삭제
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
              <Descriptions.Item label="시나리오">{detail.scenario_name}</Descriptions.Item>
              <Descriptions.Item label="디바이스">{detail.device_serial || '-'}</Descriptions.Item>
              <Descriptions.Item label="시작">{formatTime(detail.started_at)}</Descriptions.Item>
              <Descriptions.Item label="종료">{formatTime(detail.finished_at)}</Descriptions.Item>
              <Descriptions.Item label="총 실행시간">
                <strong>{formatDuration(totalTime(detail.step_results))}</strong>
              </Descriptions.Item>
              <Descriptions.Item label="Repeat">{detail.total_repeat}회</Descriptions.Item>
              <Descriptions.Item label="결과">
                <Space size={4}>
                  <Tag color="green">{detail.passed_steps} Pass</Tag>
                  <Tag color="red">{detail.failed_steps} Fail</Tag>
                  {detail.warning_steps > 0 && <Tag color="orange">{detail.warning_steps} Warning</Tag>}
                  {detail.error_steps > 0 && <Tag color="volcano">{detail.error_steps} Error</Tag>}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="상태">
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
          </>
        )}
      </Modal>

      {/* Image comparison modal */}
      <Modal
        title={`스텝 ${compareStep?.step_id} 비교`}
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
                  {compareStep.compare_mode === 'single_crop' ? '단일크롭'
                    : compareStep.compare_mode === 'full_exclude' ? '영역제외'
                    : compareStep.compare_mode === 'multi_crop' ? '멀티크롭'
                    : compareStep.compare_mode}
                </Tag>
              )}
              {compareStep.similarity_score != null && (
                <span>
                  유사도: {(compareStep.similarity_score * 100).toFixed(2)}%
                </span>
              )}
              {compareStep.match_location && (
                <Tag color="blue">
                  매칭 위치: ({compareStep.match_location.x},{compareStep.match_location.y})
                  {' '}{compareStep.match_location.width}x{compareStep.match_location.height}
                </Tag>
              )}
              <span style={{ color: '#888' }}>Duration: {formatDuration(compareStep.execution_time_ms)}</span>
            </Space>
            <Row gutter={16}>
              <Col span={12}>
                <Card size="small" title={
                  compareStep.compare_mode === 'full_exclude' ? '기대 이미지 (제외 영역 표시 → Actual)'
                  : compareStep.compare_mode === 'multi_crop' ? '기대 이미지 (크롭 영역 → Actual)'
                  : '기대 이미지 (Expected)'
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
                    <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>이미지 없음</div>
                  )}
                </Card>
              </Col>
              <Col span={12}>
                <Card size="small" title="실제 이미지 (Actual)">
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
                    <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>이미지 없음</div>
                  )}
                </Card>
              </Col>
            </Row>
            {compareStep.diff_image && (
              <div style={{ marginTop: 12 }}>
                <Card size="small" title="차이 히트맵 (Diff)">
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
                <Card size="small" title="영역 제외 비교">
                  <Space wrap>
                    <Tag color="red">제외 영역 적용</Tag>
                    <span style={{ fontSize: 13, color: '#ccc' }}>{compareStep.message}</span>
                  </Space>
                  <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>
                    실제 이미지에서 회색 반투명 영역이 제외된 부분입니다. Diff 히트맵에서도 해당 영역은 제외됩니다.
                  </div>
                </Card>
              </div>
            )}
            {compareStep.compare_mode === 'multi_crop' && compareStep.sub_results?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <Card size="small" title={`개별 크롭 비교 결과 (${compareStep.sub_results.length}개)`}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #303030' }}>
                        <th style={{ padding: '4px 8px', textAlign: 'left' }}>#</th>
                        <th style={{ padding: '4px 8px', textAlign: 'left' }}>라벨</th>
                        <th style={{ padding: '4px 8px', textAlign: 'center' }}>상태</th>
                        <th style={{ padding: '4px 8px', textAlign: 'right' }}>유사도</th>
                        <th style={{ padding: '4px 8px', textAlign: 'right' }}>매칭 위치</th>
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
