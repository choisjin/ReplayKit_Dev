import { useEffect, useRef, useState } from 'react';
import { App as AntdApp, Button, ConfigProvider, Layout, Menu, Modal, Spin, Tooltip, message, theme } from 'antd';
import {
  BarChartOutlined,
  AppstoreOutlined,
  BookOutlined,
  CloudSyncOutlined,
  DatabaseOutlined,
  DesktopOutlined,
  FolderOpenOutlined,
  FundProjectionScreenOutlined,
  HistoryOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  VideoCameraOutlined,
  MessageOutlined,
} from '@ant-design/icons';
import axios from 'axios';
import { deviceApi, serverApi } from './services/api';
import { DeviceProvider } from './context/DeviceContext';
import { SettingsProvider, useSettings } from './context/SettingsContext';
import { useTranslation } from './i18n';
import { useWebcam } from './hooks/useWebcam';
import DevicePage from './pages/DevicePage';
import RecordPage from './pages/RecordPage';
import ScenarioPage from './pages/ScenarioPage';
import ResultsPage from './pages/ResultsPage';
import SettingsPage from './pages/SettingsPage';
import ChangelogPage from './pages/ChangelogPage';
import WebcamPip from './components/WebcamPip';
import AnnouncementBanner from './components/AnnouncementBanner';
import ChatWidget from './components/ChatWidget';
import { WebcamProvider } from './context/WebcamContext';

const { Sider, Content } = Layout;

const pageKeys = [
  { key: '/', icon: <DesktopOutlined />, labelKey: 'nav.device' as const, component: <DevicePage /> },
  { key: '/record', icon: <VideoCameraOutlined />, labelKey: 'nav.record' as const, component: <RecordPage /> },
  { key: '/scenarios', icon: <PlayCircleOutlined />, labelKey: 'nav.scenario' as const, component: <ScenarioPage /> },
  { key: '/results', icon: <BarChartOutlined />, labelKey: 'nav.results' as const, component: <ResultsPage /> },
  { key: '/settings', icon: <SettingOutlined />, labelKey: 'nav.settings' as const, component: <SettingsPage /> },
  { key: '/changelog', icon: <HistoryOutlined />, labelKey: 'nav.changelog' as const, component: <ChangelogPage /> },
];

function AppContent() {
  const [activeKey, setActiveKey] = useState('/');
  const [siderCollapsed, setSiderCollapsed] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [diskInfoList, setDiskInfoList] = useState<{ drive: string; free_gb: number; total_gb: number; used_percent: number }[]>([]);
  const { settings, uploadWebcamRecording, fetchSettings } = useSettings();
  const { t } = useTranslation();

  // ── 로고 5연타 → 런처 로그 ──
  const logoClickRef = useRef<number[]>([]);
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [launcherLog, setLauncherLog] = useState<string[]>([]);
  const [logDates, setLogDates] = useState<string[]>([]);
  const [logSelectedDate, setLogSelectedDate] = useState('');
  const [logSource, setLogSource] = useState<'launcher' | 'backend'>('backend');

  const loadLog = (date?: string, source?: string) => {
    const src = source ?? logSource;
    serverApi.launcherLog(1000, date, src).then(res => {
      setLauncherLog(res.data.lines || []);
      setLogDates(res.data.dates || []);
      if (!date && res.data.dates?.length > 0) setLogSelectedDate(res.data.dates[0]);
    }).catch(() => {});
  };

  const handleLogoClick = () => {
    const now = Date.now();
    const clicks = logoClickRef.current;
    clicks.push(now);
    while (clicks.length > 0 && now - clicks[0] > 2000) clicks.shift();
    if (clicks.length >= 5) {
      clicks.length = 0;
      loadLog();
      setLogModalOpen(true);
    }
  };

  // --- Backend health polling ---
  const [backendReady, setBackendReady] = useState(false);
  const readyRef = useRef(false);
  const everReadyRef = useRef(false);
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;

  useEffect(() => {
    let mounted = true;

    const poll = async () => {
      if (!mounted) return;
      try {
        await axios.get('/api/health', { timeout: 5000 });
        if (!readyRef.current) {
          readyRef.current = true;
          await fetchSettings();
          setBackendReady(true);
          everReadyRef.current = true;
          // 디스크 용량 조회
          serverApi.diskUsage().then(res => {
            const data = res.data;
            // 배열이면 그대로, 단일 객체면 배열로 래핑 (하위호환)
            setDiskInfoList(Array.isArray(data) ? data : [data]);
          }).catch(() => {});
        }
      } catch {
        if (readyRef.current) {
          readyRef.current = false;
          setBackendReady(false);
        }
      }
      if (mounted) {
        setTimeout(poll, readyRef.current ? 10000 : 2000);
      }
    };

    poll();
    return () => { mounted = false; };
  }, []);

  // Global webcam
  const webcam = useWebcam();
  const [webcamVisible, setWebcamVisible] = useState(false);

  // Wire up webcam upload when save dir is configured
  useEffect(() => {
    if (settings.webcam_save_dir) {
      webcam.setUploadFn(uploadWebcamRecording);
    } else {
      webcam.setUploadFn(null);
    }
  }, [settings.webcam_save_dir, webcam.setUploadFn, uploadWebcamRecording]);

  const toggleWebcam = () => {
    if (webcamVisible) {
      webcam.stopWebcam();
      setWebcamVisible(false);
    } else {
      webcam.handleWebcamToggle(['webcam']);
      setWebcamVisible(true);
    }
  };

  /** 웹캠 PiP 열기 + 실제 비디오 스트림 준비 대기. 이미 스트림 활성이면 즉시 true */
  const ensureWebcamOpen = async (): Promise<boolean> => {
    // 이미 스트림이 준비되어 있으면 즉시 성공
    if (webcamVisible && webcam.isStreamReady()) return true;
    // PiP 닫혀있으면 열기
    if (!webcamVisible) {
      webcam.handleWebcamToggle(['webcam']);
      setWebcamVisible(true);
    }
    // 실제 비디오 스트림이 live 상태가 될 때까지 대기 (최대 15초)
    for (let i = 0; i < 75; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (webcam.isStreamReady()) return true;
    }
    return false;
  };

  const pages = pageKeys.map(p => ({ ...p, label: t(p.labelKey) }));
  const menuItems = pages.map(({ key, icon, label }) => ({ key, icon, label }));

  const isDark = settings.theme === 'dark';
  const themeAlgorithm = isDark ? theme.darkAlgorithm : theme.defaultAlgorithm;
  const contentBg = isDark ? '#1f1f1f' : '#e8e8e8';
  const layoutBg = isDark ? undefined : '#d0d0d0';

  return (
    <WebcamProvider webcam={webcam} webcamVisible={webcamVisible} ensureWebcamOpen={ensureWebcamOpen}>
    <ConfigProvider theme={{
      algorithm: themeAlgorithm,
      ...(!isDark ? {
        token: {
          colorBgContainer: '#e8e8e8',
          colorBgElevated: '#e0e0e0',
          colorBgLayout: '#d0d0d0',
          colorBgBase: '#dcdcdc',
        },
      } : {}),
    }}>
      <Layout style={{ minHeight: '100vh' }}>
        <Sider collapsible collapsed={siderCollapsed} onCollapse={setSiderCollapsed} style={isDark ? undefined : { background: '#f0f0f0' }}>
          <div
            onClick={handleLogoClick}
            style={{ height: 40, margin: siderCollapsed ? '16px 8px' : 16, color: isDark ? '#fff' : '#222', fontSize: siderCollapsed ? 11 : 14, fontWeight: 'bold', textAlign: 'center', lineHeight: '40px', overflow: 'hidden', whiteSpace: 'nowrap', cursor: 'default', userSelect: 'none' }}
          >
            {siderCollapsed ? 'RK' : 'ReplayKit'}
          </div>
          <Menu
            theme={isDark ? 'dark' : 'light'}
            mode="inline"
            selectedKeys={[activeKey]}
            items={menuItems}
            onClick={async ({ key }) => {
              if (activeKey === '/record' && key !== '/record') {
                const check = (window as any).__recordPageDirtyCheck;
                if (check) { const ok = await check(); if (!ok) return; }
              }
              setActiveKey(key);
              window.dispatchEvent(new CustomEvent('tab-change', { detail: key }));
            }}
            style={isDark ? undefined : { background: '#f0f0f0' }}
          />
          <div style={{ padding: siderCollapsed ? '12px 8px' : '12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Tooltip title={t('webcam.title')} placement="right">
              <Button
                block
                type={webcamVisible ? 'primary' : 'default'}
                icon={<VideoCameraOutlined />}
                onClick={toggleWebcam}
                style={webcamVisible && webcam.webcamRecording ? { animation: 'blink 1s infinite' } : undefined}
              >
                {!siderCollapsed && t('webcam.title')}
              </Button>
            </Tooltip>
            <Tooltip title={t('dlt.launchViewer')} placement="right">
              <Button
                block
                icon={<FundProjectionScreenOutlined />}
                onClick={async () => {
                  try {
                    await deviceApi.dltViewerLaunch();
                    message.success(t('dlt.launchViewer'));
                  } catch (e: any) {
                    message.error(e.response?.data?.detail || 'DLT Viewer launch failed');
                  }
                }}
              >
                {!siderCollapsed && t('dlt.launchViewer')}
              </Button>
            </Tooltip>
            <Tooltip title={t('server.update')} placement="right">
              <Button
                block
                icon={<CloudSyncOutlined />}
                onClick={() => {
                  Modal.confirm({
                    title: t('server.updateConfirm'),
                    content: t('server.updateDesc'),
                    okText: t('server.update'),
                    onOk: async () => {
                      message.loading({ content: t('server.updating'), key: 'update', duration: 0 });
                      try {
                        await serverApi.updateAndRestart();
                        message.destroy('update');
                        // 업데이트 대기 화면 표시
                        const wrap = document.createElement('div');
                        wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px;font-family:sans-serif';
                        const title = document.createElement('div');
                        title.style.cssText = 'font-size:20px;font-weight:600';
                        title.textContent = '서버 업데이트 중...';
                        const status = document.createElement('div');
                        status.style.color = '#888';
                        status.textContent = '서버 종료 대기 중';
                        wrap.appendChild(title);
                        wrap.appendChild(status);
                        document.body.innerHTML = '';
                        document.body.appendChild(wrap);
                        // 서버가 다시 응답할 때까지 폴링
                        const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
                        await delay(3000);
                        status.textContent = 'git pull + 서버 재시작 대기 중...';
                        for (let waited = 0; waited < 120; waited += 2) {
                          try {
                            const r = await fetch('/api/health', { signal: AbortSignal.timeout(2000) });
                            if (r.ok) {
                              status.textContent = '서버 준비 완료! 새로고침 중...';
                              await delay(1000);
                              window.location.reload();
                              return;
                            }
                          } catch { /* 서버 아직 안 뜸 */ }
                          await delay(2000);
                          status.textContent = '서버 재시작 대기 중... (' + (waited + 2) + 's)';
                        }
                        status.textContent = '서버 응답 없음 — 수동으로 새로고침 해주세요.';
                      } catch {
                        message.error({ content: t('server.updateFailed'), key: 'update' });
                      }
                    },
                  });
                }}
              >
                {!siderCollapsed && t('server.update')}
              </Button>
            </Tooltip>
            <Tooltip title={t('server.guide')} placement="right">
              <Button
                block
                icon={<BookOutlined />}
                onClick={() => window.open(settings.language === 'en' ? '/docs/user-guide-en.html' : '/docs/user-guide.html', '_blank')}
              >
                {!siderCollapsed && t('server.guide')}
              </Button>
            </Tooltip>
            <Tooltip title={t('server.moduleGuide')} placement="right">
              <Button
                block
                icon={<AppstoreOutlined />}
                onClick={() => window.open(settings.language === 'en' ? '/docs/module-guide-en.html' : '/docs/module-guide.html', '_blank')}
              >
                {!siderCollapsed && t('server.moduleGuide')}
              </Button>
            </Tooltip>
            <Tooltip title="Results 폴더 열기" placement="right">
              <Button
                block
                icon={<FolderOpenOutlined />}
                onClick={async () => {
                  try {
                    await serverApi.openResultsFolder();
                  } catch (e: any) {
                    message.error(e.response?.data?.detail || 'Failed to open folder');
                  }
                }}
              >
                {!siderCollapsed && 'Results 폴더'}
              </Button>
            </Tooltip>
            <Tooltip title={t('chat.title')} placement="right">
              <Button
                block
                icon={<MessageOutlined />}
                onClick={() => setChatOpen(true)}
              >
                {!siderCollapsed && t('chat.title')}
              </Button>
            </Tooltip>
          </div>
          {diskInfoList.length > 0 && (
            <div style={{ padding: siderCollapsed ? '8px 4px' : '8px 16px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
              {diskInfoList.map((di) => (
              <Tooltip key={di.drive} title={`${di.drive} — ${di.free_gb} GB 사용가능 / ${di.total_gb} GB`} placement="right">
                <div style={{ fontSize: 11, color: '#888', marginBottom: diskInfoList.length > 1 ? 6 : 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {!siderCollapsed && <span style={{ whiteSpace: 'nowrap', minWidth: 24 }}><DatabaseOutlined /> {di.drive.replace(':', '')}</span>}
                    <div style={{ flex: 1, background: '#333', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                      <div style={{ background: di.used_percent > 90 ? '#ff4d4f' : di.used_percent > 70 ? '#faad14' : '#52c41a', width: `${di.used_percent}%`, height: '100%' }} />
                    </div>
                  </div>
                  <div style={{ marginTop: 2, fontSize: 10, textAlign: 'center' }}>
                    {siderCollapsed ? `${di.free_gb}G` : `${di.free_gb} GB 사용가능`}
                  </div>
                </div>
              </Tooltip>
              ))}
            </div>
          )}
        </Sider>
        <Layout style={layoutBg ? { background: layoutBg } : undefined}>
          <Content style={{ margin: 8, padding: 12, background: contentBg, borderRadius: 8 }}>
            <AnnouncementBanner />
            {backendReady ? (
              pages.map(({ key, component }) => (
                <div key={key} style={{ display: activeKey === key ? 'block' : 'none' }}>
                  {component}
                </div>
              ))
            ) : (
              <div style={{
                display: 'flex', flexDirection: 'column',
                justifyContent: 'center', alignItems: 'center',
                height: 'calc(100vh - 48px)', gap: 24,
              }}>
                <Spin indicator={<LoadingOutlined style={{ fontSize: 48 }} spin />} />
                <div style={{ color: '#888', fontSize: 16 }}>
                  {t('common.backendConnecting')}
                </div>
              </div>
            )}
          </Content>
        </Layout>
      </Layout>

      {webcamVisible && (
        <WebcamPip webcam={webcam} onClose={toggleWebcam} isDark={isDark} />
      )}

      <ChatWidget open={chatOpen} onClose={() => setChatOpen(false)} />

      <Modal
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>Log</span>
            <select
              value={logSource}
              onChange={(e) => { const s = e.target.value as 'launcher' | 'backend'; setLogSource(s); setLogSelectedDate(''); loadLog('', s); }}
              style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, border: '1px solid #d9d9d9' }}
            >
              <option value="backend">Backend</option>
              <option value="launcher">Launcher</option>
            </select>
            {logDates.length > 0 && (
              <select
                value={logSelectedDate}
                onChange={(e) => { setLogSelectedDate(e.target.value); loadLog(e.target.value); }}
                style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, border: '1px solid #d9d9d9' }}
              >
                {logDates.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
          </div>
        }
        open={logModalOpen}
        onCancel={() => setLogModalOpen(false)}
        footer={null}
        width={800}
      >
        <div style={{ maxHeight: 500, overflow: 'auto', background: isDark ? '#1e1e2e' : '#f5f5f5', borderRadius: 6, padding: 12 }}>
          <pre style={{ margin: 0, fontSize: 11, fontFamily: 'Consolas, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: isDark ? '#cdd6f4' : '#333' }}>
            {launcherLog.length > 0 ? launcherLog.join('\n') : 'No logs'}
          </pre>
        </div>
      </Modal>

      <style>{`@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
    </ConfigProvider>
    </WebcamProvider>
  );
}

function App() {
  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <AntdApp>
        <SettingsProvider>
          <DeviceProvider>
            <AppContent />
          </DeviceProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  );
}

export default App;
