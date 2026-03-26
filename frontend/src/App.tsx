import { useEffect, useRef, useState } from 'react';
import { App as AntdApp, Button, ConfigProvider, Layout, Menu, Modal, Spin, Tooltip, message, theme } from 'antd';
import {
  BarChartOutlined,
  BookOutlined,
  CloudSyncOutlined,
  DatabaseOutlined,
  DesktopOutlined,
  FolderOpenOutlined,
  FundProjectionScreenOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  VideoCameraOutlined,
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
import WebcamPip from './components/WebcamPip';
import { WebcamProvider } from './context/WebcamContext';

const { Sider, Content } = Layout;

const pageKeys = [
  { key: '/', icon: <DesktopOutlined />, labelKey: 'nav.device' as const, component: <DevicePage /> },
  { key: '/record', icon: <VideoCameraOutlined />, labelKey: 'nav.record' as const, component: <RecordPage /> },
  { key: '/scenarios', icon: <PlayCircleOutlined />, labelKey: 'nav.scenario' as const, component: <ScenarioPage /> },
  { key: '/results', icon: <BarChartOutlined />, labelKey: 'nav.results' as const, component: <ResultsPage /> },
  { key: '/settings', icon: <SettingOutlined />, labelKey: 'nav.settings' as const, component: <SettingsPage /> },
];

function AppContent() {
  const [activeKey, setActiveKey] = useState('/');
  const [siderCollapsed, setSiderCollapsed] = useState(false);
  const [diskInfoList, setDiskInfoList] = useState<{ drive: string; free_gb: number; total_gb: number; used_percent: number }[]>([]);
  const { settings, uploadWebcamRecording, fetchSettings } = useSettings();
  const { t } = useTranslation();

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
        await axios.get('/api/health', { timeout: 3000 });
        if (!readyRef.current) {
          readyRef.current = true;
          // 백엔드 연결 시 설정 다시 불러오기 (테마 등)
          await fetchSettings();
          setBackendReady(true);
          if (everReadyRef.current) {
            // 재연결 시 현재 탭 데이터 새로고침
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent('tab-change', { detail: activeKeyRef.current }));
            }, 200);
          }
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
          <div style={{ height: 40, margin: siderCollapsed ? '16px 8px' : 16, color: isDark ? '#fff' : '#222', fontSize: siderCollapsed ? 11 : 14, fontWeight: 'bold', textAlign: 'center', lineHeight: '40px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {siderCollapsed ? 'RK' : 'ReplayKit'}
          </div>
          <Menu
            theme={isDark ? 'dark' : 'light'}
            mode="inline"
            selectedKeys={[activeKey]}
            items={menuItems}
            onClick={({ key }) => { setActiveKey(key); window.dispatchEvent(new CustomEvent('tab-change', { detail: key })); }}
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
                        message.success({ content: t('server.updateSuccess'), key: 'update' });
                        setTimeout(() => window.location.reload(), 5000);
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
          </div>
          {diskInfoList.length > 0 && (
            <div style={{ padding: siderCollapsed ? '8px 4px' : '8px 16px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
              {diskInfoList.map((di) => (
              <Tooltip key={di.drive} title={`${di.drive} — ${di.free_gb} GB 사용가능 / ${di.total_gb} GB`} placement="right">
                <div style={{ fontSize: 11, color: '#888', marginBottom: diskInfoList.length > 1 ? 6 : 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {!siderCollapsed && <span style={{ whiteSpace: 'nowrap', minWidth: 24 }}>{di.drive}</span>}
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
