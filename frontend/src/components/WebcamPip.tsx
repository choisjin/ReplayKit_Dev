import { useState, useRef, useCallback } from 'react';
import { Button, Select, Slider, Space, Tag } from 'antd';
import {
  PlayCircleOutlined, PauseOutlined, VideoCameraOutlined,
  SettingOutlined, CloseOutlined, MinusOutlined,
} from '@ant-design/icons';
import { useWebcam } from '../hooks/useWebcam';
import { useTranslation } from '../i18n';

const { Option } = Select;

interface WebcamPipProps {
  webcam: ReturnType<typeof useWebcam>;
  onClose: () => void;
}

const RESOLUTION_LABELS: Record<string, string> = {
  '3840x2160': '4K', '2560x1440': 'QHD', '1920x1080': 'FHD',
  '1280x720': 'HD', '960x540': 'qHD', '640x480': 'VGA', '320x240': 'QVGA',
};

export default function WebcamPip({ webcam, onClose }: WebcamPipProps) {
  const { t } = useTranslation();
  const {
    webcamIndex, webcamDevices, webcamVideoRef, webcamRecording,
    webcamSettingsOpen, setWebcamSettingsOpen, webcamCapabilities, webcamSettings,
    webcamResolution, webcamResolutions,
    handleWebcamChange, handleWebcamResolutionChange,
    startWebcamRecording, stopWebcamRecording, loadWebcamCapabilities, applyWebcamSetting,
  } = webcam;

  const [minimized, setMinimized] = useState(false);

  // Dragging
  const [position, setPosition] = useState({ x: window.innerWidth - 380, y: window.innerHeight - 460 });
  const dragRef = useRef<{ startX: number; startY: number; posX: number; posY: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, posX: position.x, posY: position.y };
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setPosition({
        x: dragRef.current.posX + (ev.clientX - dragRef.current.startX),
        y: dragRef.current.posY + (ev.clientY - dragRef.current.startY),
      });
    };
    const onMouseUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [position]);

  return (
    <div
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        width: 360,
        zIndex: 9999,
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        background: '#1f1f1f',
        border: '1px solid #303030',
      }}
    >
      {/* Header - draggable */}
      <div
        onMouseDown={onMouseDown}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 10px',
          background: '#141414',
          cursor: 'grab',
          userSelect: 'none',
        }}
      >
        <VideoCameraOutlined style={{ color: '#1677ff' }} />
        <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: '#d9d9d9' }}>{t('webcam.title')}</span>
        {webcamRecording && (
          <Tag color="red" style={{ margin: 0, fontSize: 11, lineHeight: '18px', animation: 'blink 1s infinite' }}>● REC</Tag>
        )}
        <Button type="text" size="small" icon={<MinusOutlined />} onClick={() => setMinimized(!minimized)} style={{ color: '#888' }} />
        <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} style={{ color: '#888' }} />
      </div>

      {!minimized && (
        <div style={{ padding: 8 }}>
          {/* Video */}
          <div style={{ position: 'relative', marginBottom: 8 }}>
            <video
              ref={webcamVideoRef}
              autoPlay
              playsInline
              muted
              style={{ width: '100%', borderRadius: 4, background: '#000', display: 'block' }}
            />
            {webcamRecording && (
              <div style={{
                position: 'absolute', top: 6, right: 6,
                background: 'rgba(255,0,0,0.8)', color: '#fff',
                padding: '1px 6px', borderRadius: 4, fontSize: 11, fontWeight: 'bold',
                animation: 'blink 1s infinite',
              }}>● REC</div>
            )}
          </div>

          {/* Controls */}
          <Space size={4} wrap style={{ width: '100%', marginBottom: 6 }}>
            <Select
              size="small"
              value={webcamIndex}
              onChange={handleWebcamChange}
              style={{ width: 200 }}
              placeholder={t('webcam.select')}
            >
              {webcamDevices.map((d, i) => (
                <Option key={d.deviceId} value={i}>
                  {d.label || t('webcam.camera', { index: String(i) })}
                </Option>
              ))}
            </Select>
            {!webcamRecording ? (
              <Button size="small" type="primary" danger icon={<PlayCircleOutlined />} onClick={startWebcamRecording}>
                {t('webcam.record')}
              </Button>
            ) : (
              <Button size="small" danger icon={<PauseOutlined />} onClick={stopWebcamRecording}
                style={{ animation: 'blink 1s infinite' }}>
                {t('webcam.recordStop')}
              </Button>
            )}
            <Button
              size="small"
              icon={<SettingOutlined />}
              onClick={() => { loadWebcamCapabilities(); setWebcamSettingsOpen((v: boolean) => !v); }}
              type={webcamSettingsOpen ? 'primary' : 'default'}
            />
          </Space>

          {/* Settings */}
          {webcamSettingsOpen && (
            <div style={{ padding: '6px 8px', background: 'rgba(0,0,0,0.2)', borderRadius: 6 }}>
              {webcamResolutions.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 11, marginBottom: 2, color: '#aaa' }}>{t('webcam.resolutionSelect')}</div>
                  <Select size="small" value={webcamResolution || undefined} onChange={handleWebcamResolutionChange}
                    style={{ width: '100%' }} placeholder={t('webcam.resolutionSelect')}>
                    {webcamResolutions.map(r => {
                      const [w, h] = r.split('x');
                      return <Option key={r} value={r}>{RESOLUTION_LABELS[r] ? `${RESOLUTION_LABELS[r]} (${w}×${h})` : `${w}×${h}`}</Option>;
                    })}
                  </Select>
                </div>
              )}
              {Object.keys(webcamCapabilities).length === 0 && webcamResolutions.length === 0 ? (
                <div style={{ color: '#888', fontSize: 11, textAlign: 'center' }}>{t('webcam.noSettings')}</div>
              ) : (
                Object.entries(webcamCapabilities).map(([key, cap]) => (
                  <div key={key} style={{ marginBottom: 4 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 1 }}>
                      <span>{t((`webcam.${key}`) as any) !== `webcam.${key}` ? t((`webcam.${key}`) as any) : key}</span>
                      <span style={{ color: '#888' }}>{webcamSettings[key] ?? '-'}</span>
                    </div>
                    <Slider min={cap.min} max={cap.max} step={cap.step || 1} value={webcamSettings[key] ?? cap.min}
                      onChange={(v: number) => applyWebcamSetting(key, v)} style={{ margin: '0 0 2px 0' }} />
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      <style>{`@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
    </div>
  );
}
