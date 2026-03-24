import { useState } from 'react';
import { Button, Card, Col, Input, InputNumber, List, Modal, Row, Select, Space, Table, Tabs, Tag, message } from 'antd';
import { ReloadOutlined, MobileOutlined, PlusOutlined, DisconnectOutlined, UsbOutlined, WifiOutlined, SearchOutlined, EditOutlined, SyncOutlined } from '@ant-design/icons';
import { useDevice, ManagedDevice } from '../context/DeviceContext';
import { deviceApi } from '../services/api';
import { useTranslation } from '../i18n';

const { Option } = Select;

interface ConnectField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'select';
  default?: string;
  options?: string[];
}

interface ModuleInfo {
  name: string;
  label: string;
  connect_type?: string;
  connect_fields?: ConnectField[];
}

interface SerialPort {
  port: string;
  description: string;
  hwid: string;
  manufacturer: string;
  vid: string;
  pid: string;
}

export default function DevicePage() {
  const { t } = useTranslation();
  const { primaryDevices, auxiliaryDevices, loading, fetchDevices, connectDevice, disconnectDevice } = useDevice();

  // ADB reconnect state
  const [reconnecting, setReconnecting] = useState(false);

  const handleAdbReconnect = async () => {
    setReconnecting(true);
    try {
      await deviceApi.adbRestart();
      message.success(t('device.adbRestart'));
      await fetchDevices();
    } catch {
      message.error(t('device.adbRestartFailed'));
    }
    setReconnecting(false);
  };

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalCategory, setModalCategory] = useState<'primary' | 'auxiliary'>('primary');
  const [scanning, setScanning] = useState(false);
  const [scannedAdb, setScannedAdb] = useState<any[]>([]);
  const [scannedSerial, setScannedSerial] = useState<SerialPort[]>([]);
  const [scannedHkmc, setScannedHkmc] = useState<{ ip: string; port: number; raw: string }[]>([]);
  const [scannedBench, setScannedBench] = useState<{ ip: string; port: number; verified?: boolean }[]>([]);
  const [scannedVision, setScannedVision] = useState<{ id: string; mac: string; model: string; serial: string; vendor: string; tl_type: string; ip: string; subnet?: string; gateway?: string }[]>([]);
  const [scannedDlt, setScannedDlt] = useState<{ ip: string; port: number }[]>([]);
  const [pcInterfaces, setPcInterfaces] = useState<{ name: string; ip: string; prefix: number }[]>([]);
  const [forceIpModal, setForceIpModal] = useState<{ mac: string; currentIp: string } | null>(null);
  const [forceIpAddr, setForceIpAddr] = useState('');
  const [forceIpSubnet, setForceIpSubnet] = useState('255.255.255.0');
  const [forceIpGateway, setForceIpGateway] = useState('0.0.0.0');
  const [forceIpLoading, setForceIpLoading] = useState(false);
  const [connectType, setConnectType] = useState<'adb' | 'serial' | 'module' | 'hkmc6th' | 'vision_camera'>('adb');
  const [connectAddress, setConnectAddress] = useState('');
  const [baudrate, setBaudrate] = useState(115200);
  const [connecting, setConnecting] = useState(false);
  const [hkmcPort, setHkmcPort] = useState(5000);
  const [modalTabKey, setModalTabKey] = useState('scan');

  // VisionCamera
  const [vcMac, setVcMac] = useState('');
  const [vcModel, setVcModel] = useState('exo264CGE');
  const [vcSerial, setVcSerial] = useState('');
  const [vcSubnet, setVcSubnet] = useState('255.255.0.0');

  // Module
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [selectedModule, setSelectedModule] = useState<string | undefined>(undefined);
  const [scanSelectedModule, setScanSelectedModule] = useState<string | undefined>(undefined);
  const [extraFieldValues, setExtraFieldValues] = useState<Record<string, any>>({});

  // Edit device modal
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editDevice, setEditDevice] = useState<ManagedDevice | null>(null);
  const [editName, setEditName] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editBaudrate, setEditBaudrate] = useState(115200);
  const [editModule, setEditModule] = useState<string | undefined>(undefined);
  const [editExtraFields, setEditExtraFields] = useState<Record<string, any>>({});
  const [editSaving, setEditSaving] = useState(false);

  const getModuleInfo = (moduleName?: string): ModuleInfo | undefined => {
    if (!moduleName) return undefined;
    return modules.find(m => m.name === moduleName);
  };

  const getModuleConnectType = (moduleName?: string) => {
    return getModuleInfo(moduleName)?.connect_type;
  };

  const getModuleConnectFields = (moduleName?: string): ConnectField[] => {
    return getModuleInfo(moduleName)?.connect_fields || [];
  };

  const handleDisconnect = async (deviceId: string) => {
    try {
      const result = await disconnectDevice(deviceId);
      message.info(result);
    } catch {
      message.error(t('device.disconnectFailed'));
    }
  };

  const openAddModal = (category: 'primary' | 'auxiliary') => {
    setModalCategory(category);
    setConnectType(category === 'primary' ? 'adb' : 'serial');
    setSelectedModule(undefined);
    setScanSelectedModule(undefined);
    setExtraFieldValues({});
    setModalTabKey('scan');
    setModalOpen(true);
    handleScan();
    if (category === 'auxiliary') {
      deviceApi.listModules().then(res => setModules((res.data.modules || []).sort((a: ModuleInfo, b: ModuleInfo) => a.label.localeCompare(b.label)))).catch(() => {});
    }
  };

  const handleScan = async () => {
    setScanning(true);
    try {
      const [res, ifRes] = await Promise.all([deviceApi.scan(), deviceApi.localInterfaces()]);
      setScannedAdb(res.data.adb_devices || []);
      setScannedSerial(res.data.serial_ports || []);
      setScannedHkmc(res.data.hkmc_devices || []);
      setScannedBench(res.data.bench_devices || []);
      setScannedVision(res.data.vision_cameras || []);
      setScannedDlt(res.data.dlt_devices || []);
      setPcInterfaces(ifRes.data.interfaces || []);
    } catch {
      message.error(t('device.scanFailed'));
    }
    setScanning(false);
  };

  const handleConnect = async () => {
    const moduleConnType = getModuleConnectType(selectedModule);
    const fields = getModuleConnectFields(selectedModule);

    // VisionCamera 전용 처리
    if (connectType === 'vision_camera') {
      if (!vcMac.trim()) {
        message.warning('MAC Address is required');
        return;
      }
      setConnecting(true);
      try {
        const extra = {
          mac: vcMac.trim(),
          model: vcModel.trim(),
          serial: vcSerial.trim(),
          subnetmask: vcSubnet.trim(),
        };
        const result = await connectDevice('vision_camera', connectAddress.trim(), undefined, '', 'primary', undefined, 'vision_camera', extra);
        message.success(result);
        setConnectAddress('');
        setVcMac('');
        setModalOpen(false);
      } catch (e: any) {
        message.error(e.response?.data?.detail || t('device.connectFailed'));
      }
      setConnecting(false);
      return;
    }

    if (moduleConnType !== 'none' && moduleConnType !== 'can' && !connectAddress.trim()) {
      message.warning(t('device.addressPlaceholder'));
      return;
    }
    setConnecting(true);
    try {
      let devType: string = connectType;
      if (selectedModule && (moduleConnType === 'socket' || moduleConnType === 'none' || moduleConnType === 'can')) {
        devType = 'module';
      }
      // Build extra_fields from connect_fields
      let extra: Record<string, any> | undefined = undefined;
      if (fields.length > 0) {
        extra = {};
        for (const f of fields) {
          extra[f.name] = extraFieldValues[f.name] ?? f.default ?? '';
        }
      }
      const tcpPort = devType === 'hkmc6th' ? hkmcPort : undefined;
      const result = await connectDevice(devType, connectAddress.trim(), baudrate, '', modalCategory, selectedModule, moduleConnType, extra, '', tcpPort);
      message.success(result);
      setConnectAddress('');
      setExtraFieldValues({});
      setModalOpen(false);
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('device.connectFailed'));
    }
    setConnecting(false);
  };

  const handleAddSerial = async (port: string, description: string) => {
    setConnecting(true);
    try {
      const scanModuleConnType = getModuleConnectType(scanSelectedModule);
      const result = await connectDevice('serial', port, baudrate, description, modalCategory, scanSelectedModule, scanModuleConnType);
      message.success(result);
      setModalOpen(false);
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('device.connectFailed'));
    }
    setConnecting(false);
  };

  const handleAddAdb = async (serial: string) => {
    setConnecting(true);
    try {
      const result = await connectDevice('adb', serial);
      message.success(result);
      setModalOpen(false);
    } catch (e: any) {
      await fetchDevices();
      setModalOpen(false);
    }
    setConnecting(false);
  };

  const handleAddHkmc = async (ip: string, port: number) => {
    setConnecting(true);
    try {
      const result = await connectDevice('hkmc6th', ip, undefined, '', 'primary', undefined, undefined, undefined, '', port);
      message.success(result);
      setModalOpen(false);
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('device.connectFailed'));
    }
    setConnecting(false);
  };

  const handleAddBench = async (ip: string, port: number) => {
    const moduleName = scanSelectedModule || 'CCIC_BENCH';
    setConnecting(true);
    try {
      const extra = { udp_port: port };
      const result = await connectDevice('module', ip, undefined, '', 'auxiliary', moduleName, 'socket', extra);
      message.success(result);
      setModalOpen(false);
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('device.connectFailed'));
    }
    setConnecting(false);
  };

  // --- Edit device ---
  const openEditModal = (dev: ManagedDevice) => {
    setEditDevice(dev);
    setEditName(dev.name);
    setEditAddress(dev.address);
    setEditBaudrate(dev.info?.baudrate || 115200);
    setEditModule(dev.info?.module);
    // Collect extra fields from device info
    const extras: Record<string, any> = {};
    for (const [k, v] of Object.entries(dev.info || {})) {
      if (!['baudrate', 'module', 'connect_type', 'connect_result'].includes(k)) {
        extras[k] = v;
      }
    }
    setEditExtraFields(extras);
    setEditModalOpen(true);
    // Ensure modules are loaded
    if (modules.length === 0) {
      deviceApi.listModules().then(res => setModules((res.data.modules || []).sort((a: ModuleInfo, b: ModuleInfo) => a.label.localeCompare(b.label)))).catch(() => {});
    }
  };

  const handleSaveEdit = async () => {
    if (!editDevice) return;
    setEditSaving(true);
    try {
      const updates: Record<string, any> = {};
      if (editName !== editDevice.name) updates.name = editName;
      if (editAddress !== editDevice.address) updates.address = editAddress;
      if (editBaudrate !== (editDevice.info?.baudrate || 115200)) updates.baudrate = editBaudrate;
      if (editModule !== editDevice.info?.module) {
        updates.module = editModule;
        const ct = getModuleConnectType(editModule);
        if (ct) updates.connect_type = ct;
      }
      // Extra fields
      if (Object.keys(editExtraFields).length > 0) {
        updates.extra_fields = editExtraFields;
      }
      await deviceApi.updateDevice(editDevice.id, updates);
      message.success(t('device.editSuccess'));
      setEditModalOpen(false);
      await fetchDevices();
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('device.editFailed'));
    }
    setEditSaving(false);
  };

  const getDeviceIcon = (type: string) => {
    if (type === 'serial' || type === 'module') return <UsbOutlined style={{ fontSize: 24 }} />;
    return <MobileOutlined style={{ fontSize: 24 }} />;
  };

  const getTypeTag = (dev: ManagedDevice) => {
    if (dev.type === 'hkmc6th') return <Tag color="volcano">HKMC</Tag>;
    if (dev.type === 'vision_camera') return <Tag color="magenta">VisionCam</Tag>;
    if (dev.type === 'module') return <Tag color="geekblue">Module</Tag>;
    if (dev.type === 'serial') return <Tag color="purple">Serial</Tag>;
    if (dev.type === 'adb' && dev.address?.includes(':')) return <Tag color="blue">WiFi</Tag>;
    if (dev.type === 'adb') return <Tag color="green">ADB</Tag>;
    return <Tag>USB</Tag>;
  };

  const allDevices = [...primaryDevices, ...auxiliaryDevices];

  const getCategoryTag = (category: string) => {
    if (category === 'primary') return <Tag color="blue">{t('device.primary')}</Tag>;
    return <Tag color="orange">{t('device.auxiliary')}</Tag>;
  };

  const renderDeviceList = () => (
    <List
      dataSource={allDevices}
      renderItem={(d) => (
        <List.Item
          actions={[
            ...(d.type === 'adb' ? [
              <Button
                size="small"
                icon={<SyncOutlined spin={reconnecting} />}
                onClick={handleAdbReconnect}
                loading={reconnecting}
              >
                {t('device.reconnect')}
              </Button>,
            ] : []),
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEditModal(d)}
            >
              {t('common.edit')}
            </Button>,
            <Button
              danger
              size="small"
              icon={<DisconnectOutlined />}
              onClick={() => handleDisconnect(d.id)}
            >
              {t('common.disconnect')}
            </Button>,
          ]}
        >
          <List.Item.Meta
            avatar={getDeviceIcon(d.type)}
            title={<>{d.info?.module || d.name || d.id} <Tag color="default" style={{ fontSize: 11, fontWeight: 'normal' }}>{d.id}</Tag></>}
            description={
              <>
                <Tag color={d.status === 'device' || d.status === 'connected' ? 'green' : d.status === 'offline' ? 'red' : 'orange'}>
                  {d.status}
                </Tag>
                {getCategoryTag(d.category)}
                {getTypeTag(d)}
                <span style={{ color: '#888' }}>{d.address}</span>
                {d.info?.baudrate && (
                  <Tag style={{ marginLeft: 4 }}>{d.info.baudrate} baud</Tag>
                )}
                {d.info?.module && (
                  <Tag color="cyan" style={{ marginLeft: 4 }}>{d.info.module}</Tag>
                )}
                {d.info?.bitrate && (
                  <Tag color="orange" style={{ marginLeft: 4 }}>{d.info.bitrate} bps</Tag>
                )}
                {d.info?.interface && (
                  <Tag style={{ marginLeft: 4 }}>{d.info.interface}</Tag>
                )}
                {d.info?.channel && (
                  <Tag style={{ marginLeft: 4 }}>{d.info.channel}</Tag>
                )}
                {d.info?.resolution && (
                  <Tag style={{ marginLeft: 4 }}>{d.info.resolution.width}x{d.info.resolution.height}</Tag>
                )}
              </>
            }
          />
        </List.Item>
      )}
      locale={{ emptyText: t('device.noDevicesRegistered') }}
    />
  );

  // Render dynamic connect_fields inputs
  const renderConnectFields = (fields: ConnectField[], values: Record<string, any>, onChange: (vals: Record<string, any>) => void) => {
    return fields.map(f => (
      <div key={f.name} style={{ marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: '#888', marginRight: 8 }}>{f.label}:</span>
        {f.type === 'select' && f.options ? (
          <Select
            style={{ width: '100%' }}
            value={values[f.name] ?? f.default}
            onChange={(v) => onChange({ ...values, [f.name]: v })}
          >
            {f.options.map(o => <Option key={o} value={o}>{o}</Option>)}
          </Select>
        ) : f.type === 'number' ? (
          <InputNumber
            style={{ width: '100%' }}
            value={values[f.name] ?? (f.default ? Number(f.default) : undefined)}
            onChange={(v) => onChange({ ...values, [f.name]: v })}
          />
        ) : (
          <Input
            value={values[f.name] ?? f.default ?? ''}
            onChange={(e) => onChange({ ...values, [f.name]: e.target.value })}
          />
        )}
      </div>
    ));
  };

  const serialColumns = [
    { title: t('device.port'), dataIndex: 'port', key: 'port', render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: t('common.description'), dataIndex: 'description', key: 'description' },
    { title: t('device.manufacturer'), dataIndex: 'manufacturer', key: 'manufacturer' },
    { title: 'VID:PID', key: 'vidpid', render: (_: any, r: SerialPort) => r.vid ? `${r.vid}:${r.pid}` : '-' },
    {
      title: '',
      key: 'action',
      width: 100,
      render: (_: any, r: SerialPort) => (
        <Button size="small" type="primary" loading={connecting} onClick={() => handleAddSerial(r.port, r.description)}>
          {t('common.add')}
        </Button>
      ),
    },
  ];

  const baudrateOptions = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Button icon={<ReloadOutlined />} onClick={fetchDevices} loading={loading}>{t('common.refresh')}</Button>
      </Space>

      <Card
        title={`${t('device.title')} (${allDevices.length})`}
        extra={
          <Space>
            <Button icon={<PlusOutlined />} type="primary" size="small" onClick={() => openAddModal('primary')}>{t('device.addPrimary')}</Button>
            <Button icon={<PlusOutlined />} size="small" onClick={() => openAddModal('auxiliary')}>{t('device.addAuxiliary')}</Button>
          </Space>
        }
      >
        {renderDeviceList()}
      </Card>

      {/* 장치 추가 모달 */}
      <Modal
        title={t('device.addModalTitle', { category: modalCategory === 'primary' ? t('device.primary') : t('device.auxiliary') })}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        width={700}
        footer={null}
      >
        <Tabs
          activeKey={modalTabKey}
          onChange={setModalTabKey}
          items={[
            {
              key: 'scan',
              label: <span><SearchOutlined /> {t('device.scan')}</span>,
              children: (
                <div>
                  <Button icon={<ReloadOutlined />} onClick={handleScan} loading={scanning} style={{ marginBottom: 8 }}>
                    {t('device.rescan')}
                  </Button>

                  {modalCategory === 'primary' && scannedAdb.length > 0 && (
                    <>
                      <div style={{ fontWeight: 'bold', marginBottom: 8 }}>{t('device.detectedAdb')}</div>
                      <List
                        size="small"
                        dataSource={scannedAdb}
                        renderItem={(d) => (
                          <List.Item actions={[
                            <Button size="small" type="primary" loading={connecting} onClick={() => handleAddAdb(d.serial)}>{t('common.add')}</Button>
                          ]}>
                            <Tag color="green">{d.serial}</Tag> {d.model} <Tag>{d.status}</Tag>
                          </List.Item>
                        )}
                      />
                    </>
                  )}

                  {scannedSerial.length > 0 && (
                    <>
                      <div style={{ fontWeight: 'bold', marginBottom: 8, marginTop: 8 }}>{t('device.detectedSerial')}</div>
                      {modalCategory === 'auxiliary' && (
                        <Space style={{ marginBottom: 8, width: '100%' }} direction="vertical">
                          {modules.length > 0 && (
                            <div>
                              <span style={{ marginRight: 8, color: '#888', fontSize: 12 }}>{`${t('device.module')}:`}</span>
                              <Select
                                allowClear
                                placeholder={t('device.moduleSelect')}
                                value={scanSelectedModule}
                                onChange={setScanSelectedModule}
                                style={{ width: 280 }}
                                options={modules.map(m => ({ label: m.label, value: m.name }))}
                              />
                            </div>
                          )}
                          <div>
                            <span style={{ marginRight: 8, color: '#888', fontSize: 12 }}>Baudrate:</span>
                            <Select
                              value={baudrate}
                              onChange={setBaudrate}
                              style={{ width: 150 }}
                              options={baudrateOptions.map(b => ({ label: `${b}`, value: b }))}
                            />
                          </div>
                        </Space>
                      )}
                      <Table
                        columns={serialColumns}
                        dataSource={scannedSerial}
                        rowKey="port"
                        size="small"
                        pagination={false}
                      />
                    </>
                  )}

                  {modalCategory === 'primary' && scannedHkmc.length > 0 && (
                    <>
                      <div style={{ fontWeight: 'bold', marginBottom: 8, marginTop: 8 }}>{t('device.detectedHkmc')}</div>
                      <List
                        size="small"
                        dataSource={scannedHkmc}
                        renderItem={(d) => (
                          <List.Item actions={[
                            <Button size="small" type="primary" loading={connecting} onClick={() => handleAddHkmc(d.ip, d.port)}>{t('common.add')}</Button>
                          ]}>
                            <Tag color="volcano">HKMC</Tag> <Tag color="blue">{d.ip}</Tag> <span style={{ color: '#888' }}>TCP: {d.port}</span>
                          </List.Item>
                        )}
                      />
                    </>
                  )}

                  {modalCategory === 'auxiliary' && scannedBench.length > 0 && (
                    <>
                      <div style={{ fontWeight: 'bold', marginBottom: 8, marginTop: 8 }}>{t('device.detectedBench')}</div>
                      {modules.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <span style={{ marginRight: 8, color: '#888', fontSize: 12 }}>{`${t('device.module')}:`}</span>
                          <Select
                            placeholder={t('device.moduleSelect')}
                            value={scanSelectedModule}
                            onChange={setScanSelectedModule}
                            style={{ width: 280 }}
                            defaultValue="CCIC_BENCH"
                            options={modules.filter(m => m.connect_type === 'socket').map(m => ({ label: m.label, value: m.name }))}
                          />
                        </div>
                      )}
                      <List
                        size="small"
                        dataSource={scannedBench}
                        renderItem={(d) => (
                          <List.Item actions={[
                            <Button size="small" type="primary" loading={connecting} onClick={() => handleAddBench(d.ip, d.port)}>{t('common.add')}</Button>
                          ]}>
                            {d.verified
                              ? <Tag color="green">Bench</Tag>
                              : <Tag color="default">Host</Tag>
                            }
                            <Tag color="blue">{d.ip}</Tag>
                            <span style={{ color: '#888' }}>UDP: {d.port}</span>
                            {d.verified && <Tag color="green" style={{ marginLeft: 4 }}>응답확인</Tag>}
                          </List.Item>
                        )}
                      />
                    </>
                  )}

                  {modalCategory === 'primary' && scannedVision.length > 0 && (
                    <>
                      <div style={{ fontWeight: 'bold', marginBottom: 8, marginTop: 8 }}>{t('device.detectedVision')}</div>
                      {pcInterfaces.length > 0 && (
                        <div style={{ marginBottom: 8, fontSize: 12, color: '#888' }}>
                          {t('device.pcInterfaces')}: {pcInterfaces.map(i => `${i.ip}/${i.prefix} (${i.name})`).join(' | ')}
                        </div>
                      )}
                      <List
                        size="small"
                        dataSource={scannedVision}
                        renderItem={(cam) => (
                          <List.Item actions={[
                            <Space size={4}>
                              {cam.mac && (
                                <Button size="small" onClick={() => {
                                  setForceIpModal({ mac: cam.mac, currentIp: cam.ip || '' });
                                  // PC 인터페이스 서브넷에 맞는 IP 자동 추천
                                  const iface = pcInterfaces[0];
                                  if (iface) {
                                    const parts = iface.ip.split('.');
                                    const camParts = (cam.ip || '').split('.');
                                    // 같은 서브넷인지 확인 (prefix 기준)
                                    const prefixLen = iface.prefix || 24;
                                    const sameSubnet = prefixLen >= 24
                                      && parts[0] === camParts[0]
                                      && parts[1] === camParts[1]
                                      && parts[2] === camParts[2];
                                    if (sameSubnet) {
                                      // 이미 같은 서브넷 — 현재 값 유지
                                      setForceIpAddr(cam.ip || '');
                                      setForceIpSubnet(cam.subnet || '255.255.255.0');
                                    } else {
                                      // 다른 서브넷 — PC와 같은 서브넷의 IP 추천
                                      const lastOctet = parseInt(parts[3]) < 200 ? parseInt(parts[3]) + 100 : parseInt(parts[3]) - 100;
                                      setForceIpAddr(`${parts[0]}.${parts[1]}.${parts[2]}.${Math.min(Math.max(lastOctet, 2), 254)}`);
                                      const masks: Record<number, string> = { 8: '255.0.0.0', 16: '255.255.0.0', 24: '255.255.255.0' };
                                      setForceIpSubnet(masks[prefixLen] || '255.255.255.0');
                                    }
                                  } else {
                                    setForceIpAddr(cam.ip || '');
                                    setForceIpSubnet(cam.subnet || '255.255.255.0');
                                  }
                                  setForceIpGateway(cam.gateway || '0.0.0.0');
                                }}>{t('device.visionForceIp')}</Button>
                              )}
                              <Button size="small" type="primary" loading={connecting} onClick={() => {
                                setConnectType('vision_camera');
                                setVcMac(cam.mac);
                                setVcModel(cam.model || '');
                                setVcSerial(cam.serial || '');
                                setConnectAddress(cam.ip || '');
                                setModalTabKey('manual');
                              }}>{t('common.connect')}</Button>
                            </Space>
                          ]}>
                            <div>
                              <Tag color="magenta">VisionCam</Tag>
                              {cam.model && <span style={{ marginRight: 8, fontWeight: 500 }}>{cam.model}</span>}
                              {cam.vendor && <span style={{ color: '#888', marginRight: 8 }}>{cam.vendor}</span>}
                              <br />
                              {cam.mac && <Tag color="blue">MAC: {cam.mac}</Tag>}
                              {cam.ip ? <Tag color="cyan">IP: {cam.ip}</Tag> : <Tag color="orange">IP: unknown</Tag>}
                              {cam.subnet && <Tag>/{cam.subnet}</Tag>}
                            </div>
                          </List.Item>
                        )}
                      />
                    </>
                  )}

                  {scannedDlt.length > 0 && (
                    <>
                      <div style={{ fontWeight: 'bold', marginBottom: 8, marginTop: 8 }}>{t('dlt.detectedDlt')}</div>
                      <List
                        size="small"
                        bordered
                        dataSource={scannedDlt}
                        renderItem={(d) => (
                          <List.Item
                            actions={[
                              <Button
                                size="small"
                                type="primary"
                                onClick={async () => {
                                  try {
                                    await connectDevice('module', d.ip, undefined, `DLT_${d.ip}`, 'auxiliary', 'DLTViewer', 'socket', { port: String(d.port) });
                                    message.success(`DLT ${d.ip}:${d.port} ${t('common.connect')}`);
                                    setModalOpen(false);
                                  } catch (e: any) {
                                    message.error(e.response?.data?.detail || 'Connect failed');
                                  }
                                }}
                              >{t('common.connect')}</Button>,
                            ]}
                          >
                            <div>
                              <Tag color="geekblue">DLT</Tag>
                              <strong>{d.ip}</strong>:{d.port}
                            </div>
                          </List.Item>
                        )}
                      />
                    </>
                  )}

                  {scannedSerial.length === 0 && scannedAdb.length === 0 && scannedHkmc.length === 0 && scannedBench.length === 0 && scannedVision.length === 0 && scannedDlt.length === 0 && !scanning && (
                    <div style={{ color: '#666', textAlign: 'center', padding: 24 }}>
                      {t('device.noDevicesFound')}
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: 'manual',
              label: <span><WifiOutlined /> {t('device.manualConnect')}</span>,
              children: (() => {
                const moduleConnType = getModuleConnectType(selectedModule);
                const connectFields = getModuleConnectFields(selectedModule);
                return (
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {modalCategory === 'auxiliary' && modules.length > 0 && (
                      <Select
                        allowClear
                        placeholder={t('device.moduleSelect')}
                        value={selectedModule}
                        onChange={(v) => {
                          setSelectedModule(v);
                          setExtraFieldValues({});
                          const ct = getModuleConnectType(v);
                          if (ct === 'serial') setConnectType('serial');
                          else if (ct === 'socket' || ct === 'none' || ct === 'can') setConnectType('module');
                          else setConnectType('serial');
                        }}
                        style={{ width: '100%' }}
                        options={modules.map(m => ({ label: `${m.label} [${m.connect_type}]`, value: m.name }))}
                      />
                    )}

                    {(!selectedModule || moduleConnType === undefined) && (
                      <Select value={connectType} onChange={setConnectType} style={{ width: '100%' }}>
                        <Option value="adb">ADB (WiFi / TCP)</Option>
                        {modalCategory === 'primary' && <Option value="hkmc6th">HKMC 6th (TCP)</Option>}
                        {modalCategory === 'primary' && <Option value="vision_camera">Vision Camera</Option>}
                        <Option value="serial">{t('device.serialPort')}</Option>
                      </Select>
                    )}

                    {moduleConnType === 'serial' && (
                      <>
                        <Input
                          placeholder={t('device.comPlaceholder')}
                          value={connectAddress}
                          onChange={(e) => setConnectAddress(e.target.value)}
                          onPressEnter={handleConnect}
                        />
                        <div>
                          <span style={{ fontSize: 12, color: '#888', marginRight: 8 }}>Baudrate:</span>
                          <Select
                            value={baudrate}
                            onChange={setBaudrate}
                            style={{ width: 150 }}
                            options={baudrateOptions.map(b => ({ label: `${b}`, value: b }))}
                          />
                        </div>
                      </>
                    )}

                    {moduleConnType === 'socket' && (
                      <Input
                        placeholder={t('device.ipPlaceholder')}
                        value={connectAddress}
                        onChange={(e) => setConnectAddress(e.target.value)}
                        onPressEnter={handleConnect}
                      />
                    )}

                    {moduleConnType === 'can' && (
                      <>
                        {renderConnectFields(connectFields, extraFieldValues, setExtraFieldValues)}
                      </>
                    )}

                    {moduleConnType === 'none' && (
                      <div style={{ color: '#888', fontSize: 12, padding: '8px 0' }}>
                        {t('device.noConnectionRequired')}
                      </div>
                    )}

                    {!selectedModule && connectType === 'hkmc6th' && (
                      <>
                        <Input
                          placeholder={t('device.hkmcIpPlaceholder')}
                          value={connectAddress}
                          onChange={(e) => setConnectAddress(e.target.value)}
                          onPressEnter={handleConnect}
                        />
                        <div>
                          <span style={{ fontSize: 12, color: '#888', marginRight: 8 }}>TCP Port:</span>
                          <InputNumber
                            value={hkmcPort}
                            onChange={(v) => setHkmcPort(v || 5000)}
                            min={1} max={65535}
                            style={{ width: 150 }}
                          />
                        </div>
                      </>
                    )}

                    {!selectedModule && connectType === 'vision_camera' && (
                      <>
                        <Input
                          placeholder="MAC Address (예: AC4FFC011D82)"
                          value={vcMac}
                          onChange={(e) => setVcMac(e.target.value)}
                        />
                        <Input
                          placeholder="IP Address (예: 169.254.4.191)"
                          value={connectAddress}
                          onChange={(e) => setConnectAddress(e.target.value)}
                        />
                        <Input
                          placeholder="Model (예: exo264CGE)"
                          value={vcModel}
                          onChange={(e) => setVcModel(e.target.value)}
                        />
                        <Input
                          placeholder="Serial Number"
                          value={vcSerial}
                          onChange={(e) => setVcSerial(e.target.value)}
                        />
                        <Input
                          placeholder="Subnet Mask (예: 255.255.0.0)"
                          value={vcSubnet}
                          onChange={(e) => setVcSubnet(e.target.value)}
                        />
                      </>
                    )}

                    {!selectedModule && connectType !== 'hkmc6th' && connectType !== 'vision_camera' && (
                      <>
                        <Input
                          placeholder={connectType === 'adb' ? t('device.adbPlaceholder') : t('device.comPlaceholder')}
                          value={connectAddress}
                          onChange={(e) => setConnectAddress(e.target.value)}
                          onPressEnter={handleConnect}
                        />
                        {connectType === 'serial' && (
                          <div>
                            <span style={{ fontSize: 12, color: '#888', marginRight: 8 }}>Baudrate:</span>
                            <Select
                              value={baudrate}
                              onChange={setBaudrate}
                              style={{ width: 150 }}
                              options={baudrateOptions.map(b => ({ label: `${b}`, value: b }))}
                            />
                          </div>
                        )}
                      </>
                    )}

                    {/* Show extra connect_fields for serial modules too */}
                    {moduleConnType === 'serial' && connectFields.length > 0 && (
                      renderConnectFields(connectFields, extraFieldValues, setExtraFieldValues)
                    )}

                    <Button
                      type="primary"
                      icon={<PlusOutlined />}
                      onClick={handleConnect}
                      loading={connecting}
                      block
                    >
                      {t('common.connect')}
                    </Button>
                  </Space>
                );
              })(),
            },
          ]}
        />
      </Modal>

      {/* 디바이스 수정 모달 */}
      <Modal
        title={t('device.editTitle')}
        open={editModalOpen}
        onCancel={() => setEditModalOpen(false)}
        onOk={handleSaveEdit}
        confirmLoading={editSaving}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        {editDevice && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <span style={{ fontSize: 12, color: '#888' }}>{`${t('common.name')}:`}</span>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div>
              <span style={{ fontSize: 12, color: '#888' }}>{`${t('common.address')}:`}</span>
              <Input value={editAddress} onChange={(e) => setEditAddress(e.target.value)} />
            </div>
            {(editDevice.type === 'serial' || editDevice.info?.baudrate) && (
              <div>
                <span style={{ fontSize: 12, color: '#888' }}>Baudrate:</span>
                <Select
                  value={editBaudrate}
                  onChange={setEditBaudrate}
                  style={{ width: '100%' }}
                  options={baudrateOptions.map(b => ({ label: `${b}`, value: b }))}
                />
              </div>
            )}
            {editDevice.category === 'auxiliary' && (
              <div>
                <span style={{ fontSize: 12, color: '#888' }}>{`${t('device.module')}:`}</span>
                <Select
                  allowClear
                  placeholder={t('device.moduleSelectPlaceholder')}
                  value={editModule}
                  onChange={setEditModule}
                  style={{ width: '100%' }}
                  options={modules.map(m => ({ label: m.label, value: m.name }))}
                />
              </div>
            )}
            {/* Show extra fields from module connect_fields or existing device info */}
            {(() => {
              const fields = getModuleConnectFields(editModule);
              if (fields.length > 0) {
                return renderConnectFields(fields, editExtraFields, setEditExtraFields);
              }
              // Show existing extra info fields as editable
              const extraKeys = Object.keys(editExtraFields).filter(
                k => !['baudrate', 'module', 'connect_type', 'connect_result', 'resolution'].includes(k)
              );
              if (extraKeys.length > 0) {
                return extraKeys.map(k => (
                  <div key={k}>
                    <span style={{ fontSize: 12, color: '#888' }}>{k}:</span>
                    <Input
                      value={editExtraFields[k] ?? ''}
                      onChange={(e) => setEditExtraFields({ ...editExtraFields, [k]: e.target.value })}
                    />
                  </div>
                ));
              }
              return null;
            })()}
          </Space>
        )}
      </Modal>

      {/* ForceIP Modal */}
      <Modal
        title={t('device.visionForceIpTitle')}
        open={!!forceIpModal}
        onCancel={() => setForceIpModal(null)}
        onOk={async () => {
          if (!forceIpModal) return;
          setForceIpLoading(true);
          try {
            await deviceApi.visionForceIp(forceIpModal.mac, forceIpAddr, forceIpSubnet, forceIpGateway);
            message.success(t('device.visionForceIpSuccess'));
            setForceIpModal(null);
            handleScan();
          } catch (e: any) {
            message.error(`${t('device.visionForceIpFailed')}: ${e.response?.data?.detail || e.message}`);
          }
          setForceIpLoading(false);
        }}
        confirmLoading={forceIpLoading}
        width={480}
      >
        {forceIpModal && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div><strong>MAC:</strong> {forceIpModal.mac}</div>
            {forceIpModal.currentIp && <div><strong>{t('device.visionCurrentIp')}:</strong> {forceIpModal.currentIp}</div>}
            {pcInterfaces.length > 0 && (
              <div style={{ fontSize: 12, color: '#888' }}>
                {t('device.pcInterfaces')}: {pcInterfaces.map(i => `${i.ip}/${i.prefix}`).join(', ')}
              </div>
            )}
            <Input addonBefore={t('device.visionNewIp')} value={forceIpAddr} onChange={e => setForceIpAddr(e.target.value)} placeholder="192.168.20.10" />
            <Input addonBefore={t('device.visionSubnet')} value={forceIpSubnet} onChange={e => setForceIpSubnet(e.target.value)} />
            <Input addonBefore={t('device.visionGateway')} value={forceIpGateway} onChange={e => setForceIpGateway(e.target.value)} />
          </Space>
        )}
      </Modal>
    </div>
  );
}
