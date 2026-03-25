import { useEffect, useState } from 'react';
import { Badge, Button, Card, Input, Select, Space, Switch, message, Typography } from 'antd';
import { ApiOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { useSettings } from '../context/SettingsContext';
import { useTranslation } from '../i18n';

const { Text } = Typography;

export default function SettingsPage() {
  const { settings, updateSettings, browseFolder } = useSettings();
  const { t } = useTranslation();
  const [excelDir, setExcelDir] = useState(settings.excel_export_dir);
  const [exportDir, setExportDir] = useState(settings.scenario_export_dir);
  const [monitorUrl, setMonitorUrl] = useState(settings.monitor_server_url);

  // Sync local state when settings load
  useEffect(() => {
    setExcelDir(settings.excel_export_dir);
    setExportDir(settings.scenario_export_dir);
    setMonitorUrl(settings.monitor_server_url);
  }, [settings.excel_export_dir, settings.scenario_export_dir, settings.monitor_server_url]);

  const handleThemeToggle = async (checked: boolean) => {
    try {
      await updateSettings({ theme: checked ? 'dark' : 'light' });
    } catch {
      message.error(t('settings.themeChanged'));
    }
  };

  const handleExcelDirSave = async () => {
    try {
      await updateSettings({ excel_export_dir: excelDir.trim() });
      message.success(t('settings.excelDirSuccess'));
    } catch {
      message.error(t('common.saveFailed'));
    }
  };

  const handleExportDirSave = async () => {
    try {
      await updateSettings({ scenario_export_dir: exportDir.trim() });
      message.success(t('settings.exportDirSuccess'));
    } catch {
      message.error(t('common.saveFailed'));
    }
  };

  const handleLanguageChange = async (lang: 'ko' | 'en') => {
    try {
      await updateSettings({ language: lang });
    } catch {
      message.error(t('common.saveFailed'));
    }
  };

  return (
    <div>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Card title={t('settings.language')} size="small">
          <Space>
            <Select
              value={settings.language || 'ko'}
              onChange={handleLanguageChange}
              style={{ width: 200 }}
              options={[
                { label: '한국어 (Korean)', value: 'ko' },
                { label: 'English', value: 'en' },
              ]}
            />
          </Space>
          <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
            {t('settings.languageDesc')}
          </Text>
        </Card>

        <Card title={t('settings.theme')} size="small">
          <Space>
            <Text>Light</Text>
            <Switch
              checked={settings.theme === 'dark'}
              onChange={handleThemeToggle}
              checkedChildren="Dark"
              unCheckedChildren="Light"
            />
            <Text>Dark</Text>
          </Space>
        </Card>

        <Card title={t('settings.excelDir')} size="small">
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder={t('settings.excelDirPlaceholder')}
              value={excelDir}
              onChange={(e) => setExcelDir(e.target.value)}
              onPressEnter={handleExcelDirSave}
              style={{ flex: 1 }}
            />
            <Button
              icon={<FolderOpenOutlined />}
              onClick={async () => {
                try {
                  const path = await browseFolder(excelDir);
                  if (path) { setExcelDir(path); await updateSettings({ excel_export_dir: path }); message.success(t('settings.excelDirSuccess')); }
                } catch { message.error(t('settings.folderSelectFailed')); }
              }}
            />
            <Button type="primary" onClick={handleExcelDirSave}>{t('common.save')}</Button>
          </Space.Compact>
          <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
            {t('settings.excelDirDesc')}
          </Text>
        </Card>

        <Card title={t('settings.exportDir')} size="small">
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder={t('settings.exportDirPlaceholder')}
              value={exportDir}
              onChange={(e) => setExportDir(e.target.value)}
              onPressEnter={handleExportDirSave}
              style={{ flex: 1 }}
            />
            <Button
              icon={<FolderOpenOutlined />}
              onClick={async () => {
                try {
                  const path = await browseFolder(exportDir);
                  if (path) { setExportDir(path); await updateSettings({ scenario_export_dir: path }); message.success(t('settings.exportDirSuccess')); }
                } catch { message.error(t('settings.folderSelectFailed')); }
              }}
            />
            <Button type="primary" onClick={handleExportDirSave}>{t('common.save')}</Button>
          </Space.Compact>
          <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
            {t('settings.exportDirDesc')}
          </Text>
        </Card>

        <Card
          title={
            <Space>
              <ApiOutlined />
              {t('settings.monitorServer')}
              {monitorUrl ? <Badge status="processing" text="" /> : null}
            </Space>
          }
          size="small"
        >
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder={t('settings.monitorServerPlaceholder')}
              value={monitorUrl}
              onChange={(e) => setMonitorUrl(e.target.value)}
              onPressEnter={async () => {
                try {
                  await updateSettings({ monitor_server_url: monitorUrl.trim() });
                  message.success(t('settings.monitorServerSuccess'));
                } catch { message.error(t('common.saveFailed')); }
              }}
              style={{ flex: 1 }}
            />
            <Button
              type="primary"
              onClick={async () => {
                try {
                  await updateSettings({ monitor_server_url: monitorUrl.trim() });
                  message.success(t('settings.monitorServerSuccess'));
                } catch { message.error(t('common.saveFailed')); }
              }}
            >
              {t('common.save')}
            </Button>
          </Space.Compact>
          <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
            {t('settings.monitorServerDesc')}
          </Text>
        </Card>
      </Space>
    </div>
  );
}
