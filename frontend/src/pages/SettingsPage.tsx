import { useEffect, useState } from 'react';
import { Button, Card, Input, Space, Switch, message, Typography } from 'antd';
import { FolderOpenOutlined } from '@ant-design/icons';
import { useSettings } from '../context/SettingsContext';

const { Text } = Typography;

export default function SettingsPage() {
  const { settings, updateSettings, browseFolder } = useSettings();
  const [webcamDir, setWebcamDir] = useState(settings.webcam_save_dir);
  const [excelDir, setExcelDir] = useState(settings.excel_export_dir);
  const [exportDir, setExportDir] = useState(settings.scenario_export_dir);

  // Sync local state when settings load
  useEffect(() => {
    setWebcamDir(settings.webcam_save_dir);
    setExcelDir(settings.excel_export_dir);
    setExportDir(settings.scenario_export_dir);
  }, [settings.webcam_save_dir, settings.excel_export_dir, settings.scenario_export_dir]);

  const handleThemeToggle = async (checked: boolean) => {
    try {
      await updateSettings({ theme: checked ? 'dark' : 'light' });
    } catch {
      message.error('테마 변경 실패');
    }
  };

  const handleWebcamDirSave = async () => {
    try {
      await updateSettings({ webcam_save_dir: webcamDir.trim() });
      message.success('웹캠 저장 경로 설정됨');
    } catch {
      message.error('저장 실패');
    }
  };

  const handleExcelDirSave = async () => {
    try {
      await updateSettings({ excel_export_dir: excelDir.trim() });
      message.success('Excel 저장 경로 설정됨');
    } catch {
      message.error('저장 실패');
    }
  };

  const handleExportDirSave = async () => {
    try {
      await updateSettings({ scenario_export_dir: exportDir.trim() });
      message.success('내보내기 저장 경로 설정됨');
    } catch {
      message.error('저장 실패');
    }
  };

  return (
    <div>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Card title="UI 테마" size="small">
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

        <Card title="웹캠 녹화 저장 경로" size="small">
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="예: C:\Users\user\Videos\webcam 또는 /home/user/videos"
              value={webcamDir}
              onChange={(e) => setWebcamDir(e.target.value)}
              onPressEnter={handleWebcamDirSave}
              style={{ flex: 1 }}
            />
            <Button
              icon={<FolderOpenOutlined />}
              onClick={async () => {
                try {
                  const path = await browseFolder(webcamDir);
                  if (path) { setWebcamDir(path); await updateSettings({ webcam_save_dir: path }); message.success('웹캠 저장 경로 설정됨'); }
                } catch { message.error('폴더 선택 실패'); }
              }}
            />
            <Button type="primary" onClick={handleWebcamDirSave}>저장</Button>
          </Space.Compact>
          <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
            웹캠 녹화 파일이 자동으로 이 경로에 저장됩니다. 비어있으면 브라우저 다운로드를 사용합니다.
          </Text>
        </Card>

        <Card title="Excel 내보내기 저장 경로" size="small">
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="예: C:\Users\user\Documents\results 또는 /home/user/results"
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
                  if (path) { setExcelDir(path); await updateSettings({ excel_export_dir: path }); message.success('Excel 저장 경로 설정됨'); }
                } catch { message.error('폴더 선택 실패'); }
              }}
            />
            <Button type="primary" onClick={handleExcelDirSave}>저장</Button>
          </Space.Compact>
          <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
            Excel 내보내기 시 이 경로에 자동으로 저장됩니다. 비어있으면 브라우저 다운로드를 사용합니다.
          </Text>
        </Card>

        <Card title="시나리오/그룹 내보내기 저장 경로" size="small">
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="예: C:\Users\user\Documents\export 또는 /home/user/export"
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
                  if (path) { setExportDir(path); await updateSettings({ scenario_export_dir: path }); message.success('내보내기 저장 경로 설정됨'); }
                } catch { message.error('폴더 선택 실패'); }
              }}
            />
            <Button type="primary" onClick={handleExportDirSave}>저장</Button>
          </Space.Compact>
          <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
            시나리오/그룹 내보내기 시 이 경로에 ZIP 파일로 저장됩니다. 비어있으면 브라우저 다운로드를 사용합니다.
          </Text>
        </Card>
      </Space>
    </div>
  );
}
