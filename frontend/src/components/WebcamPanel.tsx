import { Button, Collapse, Select, Slider, Space } from 'antd';
import { PlayCircleOutlined, PauseOutlined, VideoCameraOutlined, SettingOutlined } from '@ant-design/icons';
import { useWebcam } from '../hooks/useWebcam';
import { useTranslation } from '../i18n';

const { Option } = Select;

interface WebcamPanelProps {
  webcam: ReturnType<typeof useWebcam>;
}

const RESOLUTION_LABELS: Record<string, string> = {
  '3840x2160': '4K', '2560x1440': 'QHD', '1920x1080': 'FHD',
  '1280x720': 'HD', '960x540': 'qHD', '640x480': 'VGA', '320x240': 'QVGA',
};

export default function WebcamPanel({ webcam }: WebcamPanelProps) {
  const { t } = useTranslation();
  const {
    webcamOpen, webcamIndex, webcamDevices, webcamVideoRef, webcamRecording,
    webcamSettingsOpen, setWebcamSettingsOpen, webcamCapabilities, webcamSettings,
    webcamResolution, webcamResolutions,
    handleWebcamToggle, handleWebcamChange, handleWebcamResolutionChange,
    startWebcamRecording, stopWebcamRecording, loadWebcamCapabilities, applyWebcamSetting,
  } = webcam;

  return (
    <Collapse
      size="small"
      style={{ flexShrink: 0 }}
      activeKey={webcamOpen ? ['webcam'] : []}
      onChange={handleWebcamToggle}
      items={[{
        key: 'webcam',
        label: (
          <Space>
            <VideoCameraOutlined />
            <span>{t('webcam.title')}</span>
          </Space>
        ),
        extra: webcamOpen ? (
          <Space size={4} onClick={(e) => e.stopPropagation()}>
            <Select
              size="small"
              value={webcamIndex}
              onChange={(v) => { handleWebcamChange(v); }}
              style={{ width: 180 }}
              placeholder={t('webcam.select')}
            >
              {webcamDevices.map((d, i) => (
                <Option key={d.deviceId} value={i}>
                  {d.label || t('webcam.camera', { index: i })}
                </Option>
              ))}
            </Select>
            {!webcamRecording ? (
              <Button
                size="small"
                type="primary"
                danger
                icon={<PlayCircleOutlined />}
                onClick={startWebcamRecording}
              >
                {t('webcam.record')}
              </Button>
            ) : (
              <Button
                size="small"
                danger
                icon={<PauseOutlined />}
                onClick={stopWebcamRecording}
                style={{ animation: 'blink 1s infinite' }}
              >
                {t('webcam.recordStop')}
              </Button>
            )}
            <Button
              size="small"
              icon={<SettingOutlined />}
              onClick={() => { loadWebcamCapabilities(); setWebcamSettingsOpen(v => !v); }}
              type={webcamSettingsOpen ? 'primary' : 'default'}
            />
          </Space>
        ) : null,
        children: (
          <div>
            {webcamResolutions.length > 0 && (
              <div style={{ marginBottom: 4 }}>
                <Select
                  size="small"
                  value={webcamResolution || undefined}
                  onChange={handleWebcamResolutionChange}
                  style={{ width: '100%' }}
                  placeholder={t('webcam.resolutionSelect')}
                >
                  {webcamResolutions.map(r => {
                    const [w, h] = r.split('x');
                    return (
                      <Option key={r} value={r}>
                        {RESOLUTION_LABELS[r] ? `${RESOLUTION_LABELS[r]} (${w}×${h})` : `${w}×${h}`}
                      </Option>
                    );
                  })}
                </Select>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <div style={{ width: '66.6%', position: 'relative' }}>
                <video
                  ref={webcamVideoRef}
                  autoPlay
                  playsInline
                  muted
                  style={{
                    width: '100%',
                    borderRadius: 4,
                    background: '#000',
                    display: 'block',
                  }}
                />
                {webcamRecording && (
                  <div style={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    background: 'rgba(255, 0, 0, 0.8)',
                    color: '#fff',
                    padding: '2px 8px',
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: 'bold',
                    animation: 'blink 1s infinite',
                  }}>
                    ● REC
                  </div>
                )}
              </div>
            </div>
            {webcamSettingsOpen && (
              <div style={{
                marginTop: 8,
                padding: '8px 12px',
                background: 'rgba(0,0,0,0.15)',
                borderRadius: 6,
              }}>
                {Object.keys(webcamCapabilities).length === 0 ? (
                  <div style={{ color: '#888', fontSize: 12, textAlign: 'center' }}>
                    {t('webcam.noSettings')}
                  </div>
                ) : (
                  Object.entries(webcamCapabilities).map(([key, cap]) => (
                    <div key={key} style={{ marginBottom: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                        <span>{t((`webcam.${key}`) as any) !== `webcam.${key}` ? t((`webcam.${key}`) as any) : key}</span>
                        <span style={{ color: '#888' }}>{webcamSettings[key] ?? '-'}</span>
                      </div>
                      <Slider
                        min={cap.min}
                        max={cap.max}
                        step={cap.step || 1}
                        value={webcamSettings[key] ?? cap.min}
                        onChange={(v: number) => applyWebcamSetting(key, v)}
                        style={{ margin: '0 0 4px 0' }}
                      />
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ),
      }]}
    />
  );
}
