import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Progress, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { serverApi } from '../services/api';

interface ProcessInfo {
  pid: number;
  name: string;
  role: string;
  cmdline: string;
  rss_mb: number;
  peak_mb: number;
  os_peak_mb: number | null;
}

interface MemoryUsage {
  processes: ProcessInfo[];
  total: { rss_mb: number; peak_mb: number };
  system: { total_mb: number; available_mb: number; used_percent: number };
}

const ROLE_COLORS: Record<string, string> = {
  backend: 'blue',
  launcher: 'purple',
  frontend: 'green',
  node: 'cyan',
  adb: 'orange',
  python: 'geekblue',
};

const MAX_SAMPLES = 120;

/**
 * 실시간 메모리 모니터링 — 1초 주기 폴링.
 * 백엔드 + 자식 프로세스(프론트 dev, ADB 등) 합계와 Peak를 보여준다.
 */
export default function MemoryMonitor({ active }: { active: boolean }) {
  const [data, setData] = useState<MemoryUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [history, setHistory] = useState<number[]>([]); // 총 RSS MB 최근 N개
  const [sessionPeak, setSessionPeak] = useState(0);
  const timerRef = useRef<number | null>(null);

  const fetchOnce = async () => {
    try {
      const res = await serverApi.memoryUsage();
      const d = res.data as MemoryUsage;
      setData(d);
      setError('');
      setHistory(prev => {
        const next = [...prev, d.total.rss_mb];
        return next.length > MAX_SAMPLES ? next.slice(-MAX_SAMPLES) : next;
      });
      setSessionPeak(prev => Math.max(prev, d.total.peak_mb));
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message || 'fetch failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!active) {
      if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    fetchOnce();
    timerRef.current = window.setInterval(fetchOnce, 1000);
    return () => {
      if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
    };
  }, [active]);

  const handleReset = async () => {
    try {
      await serverApi.resetMemoryPeak();
      setSessionPeak(0);
      setHistory([]);
      message.success('Peak 값 초기화됨');
      fetchOnce();
    } catch (e: any) {
      message.error('리셋 실패: ' + (e.response?.data?.detail || e.message));
    }
  };

  // SVG sparkline
  const renderSparkline = () => {
    if (history.length < 2) return <div style={{ color: '#888', fontSize: 11 }}>데이터 수집 중...</div>;
    const w = 600;
    const h = 80;
    const max = Math.max(...history, 1);
    const min = Math.min(...history);
    const range = max - min || 1;
    const pts = history.map((v, i) => {
      const x = (i / (MAX_SAMPLES - 1)) * w;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return (
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
        <polyline points={pts} fill="none" stroke="#1677ff" strokeWidth="1.5" />
        <text x={4} y={12} fontSize="10" fill="#888">max {max.toFixed(0)} MB</text>
        <text x={4} y={h - 4} fontSize="10" fill="#888">min {min.toFixed(0)} MB</text>
      </svg>
    );
  };

  const columns = [
    { title: 'Role', dataIndex: 'role', width: 100, render: (r: string) => <Tag color={ROLE_COLORS[r] || 'default'}>{r}</Tag> },
    { title: 'Name', dataIndex: 'name', width: 130 },
    { title: 'PID', dataIndex: 'pid', width: 70 },
    {
      title: 'Current (MB)', dataIndex: 'rss_mb', width: 110, align: 'right' as const,
      sorter: (a: ProcessInfo, b: ProcessInfo) => a.rss_mb - b.rss_mb,
      render: (v: number) => <Typography.Text strong>{v.toFixed(1)}</Typography.Text>,
    },
    {
      title: 'Session Peak (MB)', dataIndex: 'peak_mb', width: 140, align: 'right' as const,
      sorter: (a: ProcessInfo, b: ProcessInfo) => a.peak_mb - b.peak_mb,
      render: (v: number) => <span style={{ color: '#d46b08' }}>{v.toFixed(1)}</span>,
    },
    {
      title: 'OS Peak (MB)', dataIndex: 'os_peak_mb', width: 120, align: 'right' as const,
      render: (v: number | null) => v == null ? <span style={{ color: '#bbb' }}>—</span> : <span style={{ color: '#888' }}>{v.toFixed(1)}</span>,
    },
    {
      title: 'Cmdline', dataIndex: 'cmdline',
      render: (c: string) => (
        <Tooltip title={c}>
          <Typography.Text type="secondary" style={{ fontSize: 10, fontFamily: 'monospace' }} ellipsis>{c}</Typography.Text>
        </Tooltip>
      ),
    },
  ];

  return (
    <Card
      size="small"
      title={<Space><Typography.Text strong>메모리 사용량 (실시간)</Typography.Text><Tag color="blue">1s 폴링</Tag></Space>}
      extra={
        <Space>
          <Button size="small" icon={<ReloadOutlined />} onClick={handleReset}>Peak 리셋</Button>
        </Space>
      }
      loading={loading && !data}
    >
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 8 }} />}

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>Total Current</Typography.Text>
              <div style={{ fontSize: 22, fontWeight: 600, color: '#1677ff' }}>
                {data.total.rss_mb.toFixed(1)} <span style={{ fontSize: 13, color: '#888' }}>MB</span>
              </div>
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>Session Peak</Typography.Text>
              <div style={{ fontSize: 22, fontWeight: 600, color: '#d46b08' }}>
                {sessionPeak.toFixed(1)} <span style={{ fontSize: 13, color: '#888' }}>MB</span>
              </div>
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>System</Typography.Text>
              <div style={{ marginTop: 4 }}>
                <Progress
                  percent={data.system.used_percent}
                  size="small"
                  status={data.system.used_percent > 90 ? 'exception' : 'normal'}
                  format={(p) => `${p}%`}
                />
                <Typography.Text type="secondary" style={{ fontSize: 10 }}>
                  {(data.system.available_mb / 1024).toFixed(1)} GB free / {(data.system.total_mb / 1024).toFixed(1)} GB
                </Typography.Text>
              </div>
            </div>
          </div>

          <div style={{ background: 'rgba(22,119,255,0.05)', borderRadius: 4, padding: 4, marginBottom: 12 }}>
            {renderSparkline()}
          </div>

          <Table
            size="small"
            rowKey="pid"
            dataSource={data.processes}
            columns={columns}
            pagination={false}
            scroll={{ y: 300 }}
          />

          <Typography.Paragraph type="secondary" style={{ fontSize: 10, marginTop: 8, marginBottom: 0 }}>
            <b>Session Peak</b>: 본 백엔드 세션 동안 관측된 최대값 (리셋 가능). <b>OS Peak</b>: Windows가 추적하는 프로세스 수명 최대 Working Set (백엔드 재시작 전엔 리셋 불가).
          </Typography.Paragraph>
        </>
      )}
    </Card>
  );
}
