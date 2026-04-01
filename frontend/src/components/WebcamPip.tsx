import { useState, useRef, useCallback, useEffect } from 'react';
import { Button, ConfigProvider, Select, Slider, theme } from 'antd';
import {
  PlayCircleOutlined, PauseOutlined, VideoCameraOutlined,
  SettingOutlined, CloseOutlined, MinusOutlined,
} from '@ant-design/icons';
import { useWebcam } from '../hooks/useWebcam';
import { useTranslation } from '../i18n';

interface WebcamPipProps {
  webcam: ReturnType<typeof useWebcam>;
  onClose: () => void;
  isDark: boolean;
}

const RESOLUTION_LABELS: Record<string, string> = {
  '3840x2160': '4K', '2560x1440': 'QHD', '1920x1080': 'FHD',
  '1280x720': 'HD', '960x540': 'qHD', '640x480': 'VGA', '320x240': 'QVGA',
};

export default function WebcamPip({ webcam, onClose, isDark }: WebcamPipProps) {
  const { t } = useTranslation();
  const {
    webcamIndex, webcamDevices, webcamVideoRef, webcamRecording,
    webcamSettingsOpen, setWebcamSettingsOpen, webcamCapabilities, webcamSettings,
    webcamResolution, webcamResolutions,
    handleWebcamChange, handleWebcamResolutionChange,
    startWebcamRecording, stopWebcamRecording, loadWebcamCapabilities, applyWebcamSetting,
    timestampPosition, setTimestampPosition,
    timestampColor, setTimestampColor,
    timestampFontSize, setTimestampFontSize,
  } = webcam;

  const [minimized, setMinimized] = useState(false);
  const [now, setNow] = useState('');

  // 프리뷰용 1초 타이머
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNow(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const getContainer = useCallback(() => containerRef.current || document.body, []);

  // Theme colors
  const bg = isDark ? '#1f1f1f' : '#fff';
  const headerBg = isDark ? '#141414' : '#f0f0f0';
  const border = isDark ? '#404040' : '#d0d0d0';
  const titleColor = isDark ? '#d9d9d9' : '#333';
  const btnColor = isDark ? '#aaa' : '#666';
  const settingsBg = isDark ? '#141414' : '#f5f5f5';
  const labelColor = isDark ? '#ccc' : '#555';
  const subColor = isDark ? '#888' : '#999';

  return (
    <ConfigProvider theme={{ algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
      <div
        ref={containerRef}
        style={{
          position: 'fixed',
          left: position.x,
          top: position.y,
          width: 360,
          zIndex: 9999,
          borderRadius: 8,
          boxShadow: isDark ? '0 8px 32px rgba(0,0,0,0.6)' : '0 8px 32px rgba(0,0,0,0.18)',
          background: bg,
          border: `1px solid ${border}`,
        }}
      >
        {/* Header */}
        <div
          onMouseDown={onMouseDown}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 10px',
            background: headerBg,
            borderRadius: '8px 8px 0 0',
            cursor: 'grab',
            userSelect: 'none',
          }}
        >
          <VideoCameraOutlined style={{ color: '#1677ff' }} />
          <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: titleColor }}>{t('webcam.title')}</span>
          {webcamRecording && (
            <span style={{
              background: '#ff4d4f', color: '#fff', padding: '0 6px',
              borderRadius: 3, fontSize: 11, fontWeight: 'bold', lineHeight: '18px',
              animation: 'blink 1s infinite',
            }}>● REC</span>
          )}
          <Button type="text" size="small" icon={<MinusOutlined />} onClick={() => setMinimized(!minimized)}
            style={{ color: btnColor, width: 24, height: 24, padding: 0 }} />
          <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose}
            style={{ color: btnColor, width: 24, height: 24, padding: 0 }} />
        </div>

        <div style={{ padding: 8, display: minimized ? 'none' : undefined }}>
          {/* Video */}
          <div style={{ position: 'relative', marginBottom: 8 }}>
            <video
              ref={webcamVideoRef}
              autoPlay playsInline muted
              style={{ width: '100%', borderRadius: 4, background: '#000', display: 'block' }}
            />
            {webcamRecording && (
              <span style={{
                position: 'absolute', top: 6, right: 6,
                background: 'rgba(255,0,0,0.85)', color: '#fff',
                padding: '1px 6px', borderRadius: 4, fontSize: 11, fontWeight: 'bold',
                animation: 'blink 1s infinite',
              }}>● REC</span>
            )}
            {timestampPosition !== 'off' && now && (
              <span style={{
                position: 'absolute',
                ...(timestampPosition.includes('top') ? { top: 4 } : { bottom: 4 }),
                ...(timestampPosition.includes('left') ? { left: 4 } : { right: 4 }),
                background: 'rgba(0,0,0,0.5)',
                color: timestampColor || '#fff',
                padding: '1px 5px',
                borderRadius: 3,
                fontSize: timestampFontSize || 11,
                fontFamily: 'monospace',
                fontWeight: 'bold',
                pointerEvents: 'none',
              }}>{now}</span>
            )}
          </div>

          {/* Controls */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 6 }}>
            <Select
              size="small"
              value={webcamIndex}
              onChange={handleWebcamChange}
              style={{ flex: 1 }}
              placeholder={t('webcam.select')}
              getPopupContainer={getContainer}
              options={webcamDevices.map((d, i) => ({
                value: i,
                label: d.label || t('webcam.camera', { index: String(i) }),
              }))}
            />
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
          </div>

          {/* Settings */}
          {webcamSettingsOpen && (
            <div style={{ padding: '6px 8px', background: settingsBg, borderRadius: 6 }}>
              {webcamResolutions.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 11, marginBottom: 2, color: subColor }}>{t('webcam.resolutionSelect')}</div>
                  <Select
                    size="small"
                    value={webcamResolution || undefined}
                    onChange={handleWebcamResolutionChange}
                    style={{ width: '100%' }}
                    placeholder={t('webcam.resolutionSelect')}
                    getPopupContainer={getContainer}
                    options={webcamResolutions.map(r => {
                      const [w, h] = r.split('x');
                      return { value: r, label: RESOLUTION_LABELS[r] ? `${RESOLUTION_LABELS[r]} (${w}×${h})` : `${w}×${h}` };
                    })}
                  />
                </div>
              )}
              {/* 타임스탬프 위치 */}
              <div style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 11, marginBottom: 2, color: subColor }}>{t('webcam.timestampPosition')}</div>
                <Select
                  size="small"
                  value={timestampPosition}
                  onChange={setTimestampPosition}
                  style={{ width: '100%' }}
                  getPopupContainer={getContainer}
                  options={[
                    { value: 'top-left', label: '↖ Top Left' },
                    { value: 'top-right', label: '↗ Top Right' },
                    { value: 'bottom-left', label: '↙ Bottom Left' },
                    { value: 'bottom-right', label: '↘ Bottom Right' },
                    { value: 'off', label: t('webcam.timestampOff') },
                  ]}
                />
              </div>
              {Object.keys(webcamCapabilities).length === 0 && webcamResolutions.length === 0 ? (
                <div style={{ color: subColor, fontSize: 11, textAlign: 'center', padding: 4 }}>{t('webcam.noSettings')}</div>
              ) : (
                Object.entries(webcamCapabilities).map(([key, cap]) => (
                  <div key={key} style={{ marginBottom: 4 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 1 }}>
                      <span style={{ color: labelColor }}>{t((`webcam.${key}`) as any) !== `webcam.${key}` ? t((`webcam.${key}`) as any) : key}</span>
                      <span style={{ color: subColor }}>{webcamSettings[key] ?? '-'}</span>
                    </div>
                    <Slider min={cap.min} max={cap.max} step={cap.step || 1} value={webcamSettings[key] ?? cap.min}
                      onChange={(v: number) => applyWebcamSetting(key, v)} style={{ margin: '0 0 2px 0' }} />
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
    </ConfigProvider>
  );
}
