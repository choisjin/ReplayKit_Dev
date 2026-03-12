import { useState } from 'react';
import { ConfigProvider, Layout, Menu, theme } from 'antd';
import {
  DesktopOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { DeviceProvider } from './context/DeviceContext';
import { SettingsProvider, useSettings } from './context/SettingsContext';
import DevicePage from './pages/DevicePage';
import RecordPage from './pages/RecordPage';
import ScenarioPage from './pages/ScenarioPage';
import SettingsPage from './pages/SettingsPage';

const { Sider, Content } = Layout;

const pages = [
  { key: '/', icon: <DesktopOutlined />, label: '디바이스', component: <DevicePage /> },
  { key: '/record', icon: <VideoCameraOutlined />, label: '녹화', component: <RecordPage /> },
  { key: '/scenarios', icon: <PlayCircleOutlined />, label: '시나리오', component: <ScenarioPage /> },
  { key: '/settings', icon: <SettingOutlined />, label: '설정', component: <SettingsPage /> },
];

function AppContent() {
  const [activeKey, setActiveKey] = useState('/');
  const { settings } = useSettings();

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
    </ConfigProvider>
  );
}

function App() {
  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <SettingsProvider>
        <DeviceProvider>
          <AppContent />
        </DeviceProvider>
      </SettingsProvider>
    </ConfigProvider>
  );
}

export default App;
