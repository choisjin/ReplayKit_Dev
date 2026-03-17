import { useEffect, useState } from 'react';
import { App as AntdApp, Button, ConfigProvider, Layout, Menu, Tooltip, theme } from 'antd';
import {
  BarChartOutlined,
  DesktopOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
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
  const { settings, uploadWebcamRecording } = useSettings();
  const { t } = useTranslation();

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
        <Sider collapsible>
          <div style={{ height: 40, margin: 16, color: '#fff', fontSize: 14, fontWeight: 'bold', textAlign: 'center', lineHeight: '40px' }}>
            Menu
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[activeKey]}
            items={menuItems}
            onClick={({ key }) => { setActiveKey(key); window.dispatchEvent(new CustomEvent('tab-change', { detail: key })); }}
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
            {pages.map(({ key, component }) => (
              <div key={key} style={{ display: activeKey === key ? 'block' : 'none' }}>
                {component}
              </div>
            ))}
          </Content>
        </Layout>
      </Layout>

      {webcamVisible && (
        <WebcamPip webcam={webcam} onClose={toggleWebcam} />
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
