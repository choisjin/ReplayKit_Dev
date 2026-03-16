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
  const [scannedTcp, setScannedTcp] = useState<{ ip: string; port: number }[]>([]);
  const [connectType, setConnectType] = useState<'adb' | 'serial' | 'module' | 'hkmc6th'>('adb');
  const [connectAddress, setConnectAddress] = useState('');
  const [baudrate, setBaudrate] = useState(115200);
  const [connecting, setConnecting] = useState(false);
  const [hkmcPort, setHkmcPort] = useState(5000);

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
    setModalOpen(true);
    handleScan();
    if (category === 'auxiliary') {
      deviceApi.listModules().then(res => setModules((res.data.modules || []).sort((a: ModuleInfo, b: ModuleInfo) => a.label.localeCompare(b.label)))).catch(() => {});
    }
  };

  const handleScan = async () => {
    setScanning(true);
    try {
      const res = await deviceApi.scan();
      setScannedAdb(res.data.adb_devices || []);
      setScannedSerial(res.data.serial_ports || []);
      setScannedHkmc(res.data.hkmc_devices || []);
      setScannedTcp(res.data.tcp_devices || []);
    } catch {
      message.error(t('device.scanFailed'));
    }
    setScanning(false);
  };

  const handleConnect = async () => {
    const moduleConnType = getModuleConnectType(selectedModule);
    const fields = getModuleConnectFields(selectedModule);
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

  const handleAddTcp = async (ip: string, port: number) => {
    const moduleName = scanSelectedModule;
    const moduleConnType = getModuleConnectType(moduleName);
    setConnecting(true);
    try {
      let result: string;
      if (moduleName && (moduleConnType === 'socket' || moduleConnType === 'none')) {
        result = await connectDevice('module', ip, undefined, '', 'auxiliary', moduleName, moduleConnType);
      } else {
        // 모듈 미선택 시 module 타입으로 추가 (address = ip)
        result = await connectDevice('module', ip, undefined, `TCP ${ip}:${port}`, 'auxiliary', moduleName, 'socket');
      }
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

                  {modalCategory === 'auxiliary' && scannedTcp.length > 0 && (
                    <>
                      <div style={{ fontWeight: 'bold', marginBottom: 8, marginTop: 8 }}>{t('device.detectedTcp')}</div>
                      {modules.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <span style={{ marginRight: 8, color: '#888', fontSize: 12 }}>{`${t('device.module')}:`}</span>
                          <Select
                            allowClear
                            placeholder={t('device.moduleSelect')}
                            value={scanSelectedModule}
                            onChange={setScanSelectedModule}
                            style={{ width: 280 }}
                            options={modules.filter(m => m.connect_type === 'socket').map(m => ({ label: m.label, value: m.name }))}
                          />
                        </div>
                      )}
                      <List
                        size="small"
                        dataSource={scannedTcp}
                        renderItem={(d) => (
                          <List.Item actions={[
                            <Button size="small" type="primary" loading={connecting} onClick={() => handleAddTcp(d.ip, d.port)}>{t('common.add')}</Button>
                          ]}>
                            <Tag color="geekblue">TCP</Tag> <Tag color="blue">{d.ip}</Tag> <span style={{ color: '#888' }}>Port: {d.port}</span>
                          </List.Item>
                        )}
                      />
                    </>
                  )}

                  {scannedSerial.length === 0 && scannedAdb.length === 0 && scannedHkmc.length === 0 && scannedTcp.length === 0 && !scanning && (
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

                    {!selectedModule && connectType !== 'hkmc6th' && (
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
    </div>
  );
}
