import { useEffect, useRef, useState } from 'react';
import { App as AntdApp, Button, ConfigProvider, Layout, Menu, Spin, Tooltip, theme } from 'antd';
import {
  BarChartOutlined,
  DesktopOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import axios from 'axios';
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

  const pages = pageKeys.map(p => ({ ...p, label: t(p.labelKey) }));
  const menuItems = pages.map(({ key, icon, label }) => ({ key, icon, label }));

  const isDark = settings.theme === 'dark';
  const themeAlgorithm = isDark ? theme.darkAlgorithm : theme.defaultAlgorithm;
  const contentBg = isDark ? '#1f1f1f' : '#e8e8e8';
  const layoutBg = isDark ? undefined : '#d0d0d0';

  return (
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
        <Sider collapsible style={isDark ? undefined : { background: '#f0f0f0' }}>
          <div style={{ height: 40, margin: 16, color: isDark ? '#fff' : '#222', fontSize: 14, fontWeight: 'bold', textAlign: 'center', lineHeight: '40px' }}>
            Menu
          </div>
          <Menu
            theme={isDark ? 'dark' : 'light'}
            mode="inline"
            selectedKeys={[activeKey]}
            items={menuItems}
            onClick={({ key }) => { setActiveKey(key); window.dispatchEvent(new CustomEvent('tab-change', { detail: key })); }}
            style={isDark ? undefined : { background: '#f0f0f0' }}
          />
          <div style={{ padding: '12px 16px' }}>
            <Tooltip title={t('webcam.title')} placement="right">
              <Button
                block
                type={webcamVisible ? 'primary' : 'default'}
                icon={<VideoCameraOutlined />}
                onClick={toggleWebcam}
                style={webcamVisible && webcam.webcamRecording ? { animation: 'blink 1s infinite' } : undefined}
              >
                {t('webcam.title')}
              </Button>
            </Tooltip>
          </div>
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
