import { useState, useMemo } from 'react';
import { Button, Card, Checkbox, Input, InputNumber, List, Modal, Select, Space, Table, Tabs, Tag, message } from 'antd';
import { ReloadOutlined, PlusOutlined, DisconnectOutlined, DeleteOutlined, WifiOutlined, SearchOutlined, EditOutlined, ApiOutlined, LinkOutlined, SettingOutlined, HolderOutlined } from '@ant-design/icons';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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

// 디바이스 ID에서 prefix 추출 (Android_1 → Android, POWER_2 → POWER)
function getDevicePrefix(id: string): string {
  const m = id.match(/^(.+?)_\d+$/);
  return m ? m[1] : id;
}

// 그룹 표시 이름
const GROUP_LABELS: Record<string, string> = {
  Android: 'Android (ADB)',
  HKMC: 'HKMC 6th',
  Serial: 'Serial',
  VisionCam: 'Vision Camera',
  Device: 'Device',
};

function SortableDeviceRow({ device, children }: { device: ManagedDevice; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: device.id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '6px 8px',
        borderBottom: '1px solid #f0f0f0',
        background: isDragging ? '#fafafa' : undefined,
      }}
    >
      <HolderOutlined
        {...attributes}
        {...listeners}
        style={{ cursor: 'grab', color: '#bbb', flexShrink: 0, fontSize: 14 }}
      />
      {children}
    </div>
  );
}

export default function DevicePage() {
  const { t } = useTranslation();
  const { primaryDevices, auxiliaryDevices, loading, fetchDevices, connectDevice, disconnectDevice, updateDeviceLists, pauseDevicePolling, resumeDevicePolling } = useDevice();

  // ADB reconnect state
  const [reconnecting, setReconnecting] = useState(false);

  // 체크박스 선택 & 연결 상태
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<string>>(new Set());
  const [connectingAll, setConnectingAll] = useState(false);
  const [connectingIds, setConnectingIds] = useState<Set<string>>(new Set());

  const allDevices = [...primaryDevices, ...auxiliaryDevices];

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

  // 전체 연결
  const handleConnectAll = async () => {
    setConnectingAll(true);
    try {
      const res = await deviceApi.connectRegistered();
      updateDeviceLists(res.data);
      message.success(t('device.connectAllSuccess'));
    } catch {
      message.error(t('device.connectFailed'));
    }
    setConnectingAll(false);
  };

  // 선택 연결
  const handleConnectSelected = async () => {
    if (selectedDeviceIds.size === 0) {
      message.warning(t('device.noSelection'));
      return;
    }
    setConnectingAll(true);
    try {
      const res = await deviceApi.connectRegistered(Array.from(selectedDeviceIds));
      updateDeviceLists(res.data);
      message.success(t('device.connectSelectedSuccess'));
    } catch {
      message.error(t('device.connectFailed'));
    }
    setConnectingAll(false);
  };

  // 전체 연결 끊기
  const [disconnectingAll, setDisconnectingAll] = useState(false);
  const handleDisconnectAll = async () => {
    setDisconnectingAll(true);
    try {
      for (const d of allDevices) {
        if (d.status === 'device' || d.status === 'connected') {
          await deviceApi.disconnectOne(d.id);
        }
      }
      await fetchDevices();
      message.success(t('device.disconnectAllSuccess'));
    } catch {
      message.error(t('device.disconnectFailed'));
    }
    setDisconnectingAll(false);
  };

  // 선택 연결 끊기
  const handleDisconnectSelected = async () => {
    if (selectedDeviceIds.size === 0) { message.warning(t('device.noSelection')); return; }
    setDisconnectingAll(true);
    try {
      for (const id of selectedDeviceIds) {
        const d = allDevices.find(dd => dd.id === id);
        if (d && (d.status === 'device' || d.status === 'connected')) {
          await deviceApi.disconnectOne(id);
        }
      }
      await fetchDevices();
      message.success(t('device.disconnectSelectedSuccess'));
    } catch {
      message.error(t('device.disconnectFailed'));
    }
    setDisconnectingAll(false);
  };

  // 개별 연결
  const handleConnectOne = async (deviceId: string) => {
    setConnectingIds(prev => new Set(prev).add(deviceId));
    try {
      const res = await deviceApi.connectRegistered([deviceId]);
      updateDeviceLists(res.data);
      const result = res.data.results?.find((r: any) => r.device_id === deviceId);
      message.success(result?.message || t('device.connectOneSuccess'));
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('device.connectFailed'));
    }
    setConnectingIds(prev => {
      const next = new Set(prev);
      next.delete(deviceId);
      return next;
    });
  };

  // 체크박스 토글
  const toggleDeviceSelection = (deviceId: string, checked: boolean) => {
    setSelectedDeviceIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(deviceId);
      else next.delete(deviceId);
      return next;
    });
  };

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedDeviceIds(new Set(allDevices.map(d => d.id)));
    } else {
      setSelectedDeviceIds(new Set());
    }
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
  const [scannedSmartbench, setScannedSmartbench] = useState<{ ip: string; port: number; label: string; module: string }[]>([]);
  const [scannedCustom, setScannedCustom] = useState<{ label: string; hosts: { ip: string; port: number }[] }[]>([]);
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
  const [editDeviceId, setEditDeviceId] = useState('');
  const [editName, setEditName] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editBaudrate, setEditBaudrate] = useState(115200);
  const [editModule, setEditModule] = useState<string | undefined>(undefined);
  const [editExtraFields, setEditExtraFields] = useState<Record<string, any>>({});
  const [editSaving, setEditSaving] = useState(false);

  // Scan settings modal
  const [scanSettingsOpen, setScanSettingsOpen] = useState(false);
  const [scanBuiltin, setScanBuiltin] = useState<Record<string, { enabled: boolean; module: string }>>({
    adb: { enabled: true, module: '' },
    serial: { enabled: true, module: 'SerialLogging' },
    hkmc: { enabled: true, module: '' },
    dlt: { enabled: true, module: 'DLTLogging' },
    bench: { enabled: true, module: 'CCIC_BENCH' },
    vision_camera: { enabled: false, module: 'VisionCamera' },
  });
  const [scanCustom, setScanCustom] = useState<{ label: string; type: string; port: number; module: string; enabled: boolean }[]>([]);
  const [newCustomLabel, setNewCustomLabel] = useState('');
  const [newCustomPort, setNewCustomPort] = useState<number | null>(null);
  const [newCustomType, setNewCustomType] = useState<string>('tcp');
  const [newCustomModule, setNewCustomModule] = useState<string>('');

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

  const closeAddModal = () => {
    setModalOpen(false);
    resumeDevicePolling();
  };

  const openScanSettings = async () => {
    // 모듈 목록 로드 (커스텀 스캔에서 모듈 선택용)
    try {
      const modRes = await deviceApi.listModules();
      setModules((modRes.data.modules || []).sort((a: ModuleInfo, b: ModuleInfo) => a.label.localeCompare(b.label)));
    } catch { /* ignore */ }
    try {
      const res = await deviceApi.getScanSettings();
      setScanBuiltin(res.data.builtin || {});
      setScanCustom(res.data.custom || []);
    } catch { /* use defaults */ }
    setScanSettingsOpen(true);
  };

  const saveScanSettings = async () => {
    const settings = { builtin: scanBuiltin, custom: scanCustom };
    try {
      await deviceApi.saveScanSettings(settings);
      message.success(t('common.saved'));
    } catch { message.error(t('common.saveFailed')); }
    setScanSettingsOpen(false);
  };

  const addCustomScan = () => {
    if (!newCustomPort) return;
    setScanCustom([...scanCustom, {
      label: newCustomLabel || `${newCustomType.toUpperCase()}:${newCustomPort}`,
      type: newCustomType,
      port: newCustomPort,
      module: newCustomModule,
      enabled: true,
    }]);
    setNewCustomLabel('');
    setNewCustomPort(null);
    setNewCustomModule('');
  };

  const openAddModal = (category: 'primary' | 'auxiliary') => {
    pauseDevicePolling();
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
      setScannedSmartbench(res.data.smartbench_devices || []);
      setScannedCustom(res.data.custom_results || []);
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
        closeAddModal();
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
      closeAddModal();
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
      closeAddModal();
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
      closeAddModal();
    } catch (e: any) {
      await fetchDevices();
      closeAddModal();
    }
    setConnecting(false);
  };

  const handleAddHkmc = async (ip: string, port: number) => {
    setConnecting(true);
    try {
      const result = await connectDevice('hkmc6th', ip, undefined, '', 'primary', undefined, undefined, undefined, '', port);
      message.success(result);
      closeAddModal();
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
      closeAddModal();
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('device.connectFailed'));
    }
    setConnecting(false);
  };

  // --- Edit device ---
  const openEditModal = async (dev: ManagedDevice) => {
    // 모듈 목록 먼저 로드 (connect_fields 표시에 필요)
    let mods = modules;
    if (mods.length === 0) {
      try {
        const res = await deviceApi.listModules();
        mods = (res.data.modules || []).sort((a: ModuleInfo, b: ModuleInfo) => a.label.localeCompare(b.label));
        setModules(mods);
      } catch { /* ignore */ }
    }
    setEditDevice(dev);
    setEditDeviceId(dev.id);
    setEditName(dev.name);
    setEditAddress(dev.address);
    setEditBaudrate(dev.info?.baudrate || 115200);
    setEditModule(dev.info?.module);
    // Collect extra fields from device info + module connect_fields 기본값
    const extras: Record<string, any> = {};
    for (const [k, v] of Object.entries(dev.info || {})) {
      if (!['baudrate', 'module', 'connect_type', 'connect_result'].includes(k)) {
        extras[k] = v;
      }
    }
    // 모듈의 connect_fields 기본값 주입 (저장된 값이 없는 필드)
    const modInfo = mods.find(m => m.name === dev.info?.module);
    if (modInfo?.connect_fields) {
      for (const f of modInfo.connect_fields) {
        if (!(f.name in extras)) {
          extras[f.name] = dev.info?.[f.name] ?? f.default ?? '';
        }
      }
    }
    setEditExtraFields(extras);
    setEditModalOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editDevice) return;
    setEditSaving(true);
    try {
      const updates: Record<string, any> = {};
      if (editDeviceId.trim() && editDeviceId.trim() !== editDevice.id) updates.new_device_id = editDeviceId.trim();
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


  const isDeviceConnected = (d: ManagedDevice) => d.status === 'device' || d.status === 'connected';

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'device': case 'connected': return t('device.statusConnected');
      case 'reconnecting': return t('device.statusConnecting');
      case 'disconnected': case 'unknown': return t('device.statusDisconnected');
      case 'offline': return t('device.statusOffline');
      case 'error': return t('device.statusError');
      default: return status;
    }
  };
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'device': case 'connected': return 'green';
      case 'reconnecting': return 'processing';
      case 'disconnected': case 'unknown': return 'default';
      case 'offline': case 'error': return 'red';
      default: return 'orange';
    }
  };

  const [disconnectingIds, setDisconnectingIds] = useState<Set<string>>(new Set());

  const handleDisconnectOne = async (deviceId: string) => {
    setDisconnectingIds(prev => new Set(prev).add(deviceId));
    try {
      const res = await deviceApi.disconnectOne(deviceId);
      updateDeviceLists(res.data);
      message.info(res.data.result || t('device.disconnectOneSuccess'));
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('device.disconnectFailed'));
    }
    setDisconnectingIds(prev => { const next = new Set(prev); next.delete(deviceId); return next; });
  };

  // ── 그룹화 + DnD ──
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // 디바이스를 prefix 기준으로 그룹화, 번호순 정렬
  const deviceGroups = useMemo(() => {
    const groups: Record<string, ManagedDevice[]> = {};
    for (const d of allDevices) {
      const prefix = getDevicePrefix(d.id);
      if (!groups[prefix]) groups[prefix] = [];
      groups[prefix].push(d);
    }
    // 각 그룹 내 번호순 정렬
    for (const arr of Object.values(groups)) {
      arr.sort((a, b) => {
        const na = parseInt(a.id.match(/_(\d+)$/)?.[1] || '0');
        const nb = parseInt(b.id.match(/_(\d+)$/)?.[1] || '0');
        return na - nb;
      });
    }
    return groups;
  }, [allDevices]);

  const groupOrder = useMemo(() => {
    // primary 그룹(Android, HKMC, VisionCam) 우선, 나머지는 알파벳
    const primary = ['Android', 'HKMC', 'VisionCam'];
    const keys = Object.keys(deviceGroups);
    const first = primary.filter(k => keys.includes(k));
    const rest = keys.filter(k => !primary.includes(k)).sort();
    return [...first, ...rest];
  }, [deviceGroups]);

  const handleGroupDragEnd = async (prefix: string, event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const group = deviceGroups[prefix];
    if (!group) return;
    const oldIdx = group.findIndex(d => d.id === active.id);
    const newIdx = group.findIndex(d => d.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    // 순서 변경 후 API 호출
    const reordered = [...group];
    const [moved] = reordered.splice(oldIdx, 1);
    reordered.splice(newIdx, 0, moved);
    try {
      const res = await deviceApi.reorderDevices(prefix, reordered.map(d => d.id));
      updateDeviceLists(res.data);
    } catch (e: any) {
      message.error(e.response?.data?.detail || 'Reorder failed');
    }
  };

  const renderDeviceRow = (d: ManagedDevice) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
      <Checkbox
        checked={selectedDeviceIds.has(d.id)}
        onChange={(e) => toggleDeviceSelection(d.id, e.target.checked)}
        style={{ flexShrink: 0 }}
      />
      <Tag color={getStatusColor(d.status)} style={{ flexShrink: 0 }}>
        {getStatusLabel(d.status)}
      </Tag>
      <span style={{ fontWeight: 500, flexShrink: 0 }}>{d.id}</span>
      {d.name && d.name !== d.id && (
        <span style={{ color: '#888', flexShrink: 0 }}>{d.name}</span>
      )}
      <span style={{ color: '#aaa', fontSize: 12, flexShrink: 0 }}>{d.address}</span>
      {d.info?.module && <Tag color="cyan" style={{ flexShrink: 0 }}>{d.info.module}</Tag>}
      {d.info?.baudrate && <Tag style={{ flexShrink: 0 }}>{d.info.baudrate}</Tag>}
      {d.info?.resolution && <Tag style={{ flexShrink: 0 }}>{d.info.resolution.width}x{d.info.resolution.height}</Tag>}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, flexShrink: 0 }}>
        {isDeviceConnected(d) ? (
          <Button size="small" icon={<DisconnectOutlined />} loading={disconnectingIds.has(d.id)}
            onClick={() => handleDisconnectOne(d.id)}>{t('device.disconnectOne')}</Button>
        ) : (
          <Button size="small" type="primary" icon={<LinkOutlined />} loading={connectingIds.has(d.id)}
            onClick={() => handleConnectOne(d.id)}>{t('device.connectOne')}</Button>
        )}
        <Button size="small" icon={<EditOutlined />} onClick={() => openEditModal(d)} />
        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDisconnect(d.id)} />
      </div>
    </div>
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
      <Space style={{ marginBottom: 8 }} wrap>
        <Button icon={<ReloadOutlined />} onClick={fetchDevices} loading={loading}>{t('common.refresh')}</Button>
        <Button icon={<ApiOutlined />} type="primary" onClick={handleConnectAll} loading={connectingAll}>{t('device.connectAll')}</Button>
        <Button icon={<LinkOutlined />} onClick={handleConnectSelected} loading={connectingAll} disabled={selectedDeviceIds.size === 0}>{t('device.connectSelected')} ({selectedDeviceIds.size})</Button>
        <Button icon={<DisconnectOutlined />} danger onClick={handleDisconnectAll} loading={disconnectingAll}>{t('device.disconnectAll')}</Button>
        <Button icon={<DisconnectOutlined />} onClick={handleDisconnectSelected} loading={disconnectingAll} disabled={selectedDeviceIds.size === 0}>{t('device.disconnectSelected')} ({selectedDeviceIds.size})</Button>
      </Space>

      <Card
        size="small"
        title={
          <Space>
            <Checkbox
              indeterminate={selectedDeviceIds.size > 0 && selectedDeviceIds.size < allDevices.length}
              checked={allDevices.length > 0 && selectedDeviceIds.size === allDevices.length}
              onChange={(e) => toggleSelectAll(e.target.checked)}
            />
            {`${t('device.title')} (${allDevices.length})`}
          </Space>
        }
        extra={
          <Space>
            <Button icon={<PlusOutlined />} type="primary" size="small" onClick={() => openAddModal('primary')}>{t('device.addPrimary')}</Button>
            <Button icon={<PlusOutlined />} size="small" onClick={() => openAddModal('auxiliary')}>{t('device.addAuxiliary')}</Button>
            <Button icon={<SettingOutlined />} size="small" onClick={openScanSettings}>{t('device.scanSettings')}</Button>
          </Space>
        }
      >
        {groupOrder.length === 0 ? (
          <div style={{ color: '#999', textAlign: 'center', padding: 32 }}>{t('device.noDevicesRegistered')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {groupOrder.map(prefix => {
              const group = deviceGroups[prefix];
              if (!group || group.length === 0) return null;
              const label = GROUP_LABELS[prefix] || prefix;
              const connectedCount = group.filter(isDeviceConnected).length;
              return (
                <Card
                  key={prefix}
                  size="small"
                  type="inner"
                  title={
                    <Space>
                      <span style={{ fontWeight: 600 }}>{label}</span>
                      <Tag>{group.length}</Tag>
                      {connectedCount > 0 && <Tag color="green">{connectedCount} {t('device.statusConnected')}</Tag>}
                    </Space>
                  }
                  styles={{ body: { padding: 0 } }}
                >
                  <DndContext sensors={dndSensors} collisionDetection={closestCenter}
                    onDragEnd={(e) => handleGroupDragEnd(prefix, e)}>
                    <SortableContext items={group.map(d => d.id)} strategy={verticalListSortingStrategy}>
                      {group.map(d => (
                        <SortableDeviceRow key={d.id} device={d}>
                          {renderDeviceRow(d)}
                        </SortableDeviceRow>
                      ))}
                    </SortableContext>
                  </DndContext>
                </Card>
              );
            })}
          </div>
        )}
      </Card>

      {/* 장치 추가 모달 */}
      <Modal
        title={t('device.addModalTitle', { category: modalCategory === 'primary' ? t('device.primary') : t('device.auxiliary') })}
        open={modalOpen}
        onCancel={() => closeAddModal()}
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

                  {scannedDlt.length > 0 && (() => {
                    const dltModule = (scanBuiltin.dlt as any)?.module || 'DLTLogging';
                    return (
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
                                    await connectDevice('module', d.ip, undefined, `${dltModule}_${d.ip}`, 'auxiliary', dltModule, 'socket', { port: d.port });
                                    message.success(`DLT ${d.ip}:${d.port} ${t('common.connect')}`);
                                    closeAddModal();
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
                              <Tag style={{ marginLeft: 8 }}>{dltModule}</Tag>
                            </div>
                          </List.Item>
                        )}
                      />
                    </>
                    );
                  })()}

                  {/* SmartBench 스캔 결과 */}
                  {scannedSmartbench.length > 0 && (
                    <div>
                      <div style={{ fontWeight: 'bold', marginBottom: 8, marginTop: 8 }}>SmartBench ({scannedSmartbench.length})</div>
                      <List
                        size="small"
                        bordered
                        dataSource={scannedSmartbench}
                        renderItem={(h) => (
                          <List.Item
                            actions={[
                              <Button
                                size="small"
                                type="primary"
                                onClick={async () => {
                                  try {
                                    const devId = `SmartBench_${h.ip}`;
                                    await connectDevice('module', h.ip, undefined, devId, 'auxiliary', 'SmartBench', 'socket', { port: h.port });
                                    message.success(`SmartBench ${h.ip}:${h.port} ${t('common.connect')}`);
                                    closeAddModal();
                                  } catch (e: any) {
                                    message.error(e.response?.data?.detail || 'Connect failed');
                                  }
                                }}
                              >{t('common.connect')}</Button>,
                            ]}
                          >
                            <div>
                              <Tag color="orange">SmartBench</Tag>
                              <strong>{h.ip}</strong>:{h.port}
                            </div>
                          </List.Item>
                        )}
                      />
                    </div>
                  )}

                  {/* 커스텀 스캔 결과 */}
                  {scannedCustom.map((group, gi) => {
                    if (group.hosts.length === 0) return null;
                    // 스캔 설정에서 모듈명 찾기
                    const customEntry = scanCustom.find(c => c.label === group.label);
                    const moduleName = customEntry?.module || '';
                    return (
                      <div key={gi}>
                        <div style={{ fontWeight: 'bold', marginBottom: 8, marginTop: 8 }}>{group.label} ({group.hosts.length})</div>
                        <List
                          size="small"
                          bordered
                          dataSource={group.hosts}
                          renderItem={(h) => (
                            <List.Item
                              actions={[
                                <Button
                                  size="small"
                                  type="primary"
                                  onClick={async () => {
                                    try {
                                      const devId = moduleName ? `${moduleName}_${h.ip}` : `tcp_${h.ip}_${h.port}`;
                                      await connectDevice('module', h.ip, undefined, devId, 'auxiliary', moduleName || undefined, 'socket', { port: h.port });
                                      message.success(`${group.label} ${h.ip}:${h.port} ${t('common.connect')}`);
                                      closeAddModal();
                                    } catch (e: any) {
                                      message.error(e.response?.data?.detail || 'Connect failed');
                                    }
                                  }}
                                >{t('common.connect')}</Button>,
                              ]}
                            >
                              <div>
                                <Tag color="cyan">{group.label}</Tag>
                                <strong>{h.ip}</strong>:{h.port}
                                {moduleName && <Tag style={{ marginLeft: 8 }}>{moduleName}</Tag>}
                              </div>
                            </List.Item>
                          )}
                        />
                      </div>
                    );
                  })}

                  {scannedSerial.length === 0 && scannedAdb.length === 0 && scannedHkmc.length === 0 && scannedBench.length === 0 && scannedVision.length === 0 && scannedDlt.length === 0 && scannedSmartbench.length === 0 && scannedCustom.every(g => g.hosts.length === 0) && !scanning && (
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
              <span style={{ fontSize: 12, color: '#888' }}>Device ID:</span>
              <Select
                showSearch
                value={editDeviceId}
                onChange={(v) => setEditDeviceId(v)}
                style={{ width: '100%' }}
                options={(() => {
                  const prefix = editDeviceId.replace(/_\d+$/, '');
                  const ids = Array.from({ length: 10 }, (_, i) => `${prefix}_${i + 1}`);
                  if (!ids.includes(editDeviceId)) ids.unshift(editDeviceId);
                  return ids.map(id => ({ label: id, value: id }));
                })()}
              />
            </div>
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
                  onChange={(val) => {
                    setEditModule(val);
                    // 모듈 변경 시 Device ID prefix도 갱신
                    if (val) {
                      const num = editDeviceId.match(/_(\d+)$/)?.[1] || '1';
                      setEditDeviceId(`${val}_${num}`);
                    }
                  }}
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
      {/* 스캔 설정 모달 */}
      <Modal
        title={t('device.scanSettings')}
        open={scanSettingsOpen}
        onCancel={() => setScanSettingsOpen(false)}
        onOk={saveScanSettings}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        width={620}
      >
        {/* 기본 + 커스텀 통합 테이블 */}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #d9d9d9', textAlign: 'left' }}>
              <th style={{ padding: '6px 4px', width: 40 }}></th>
              <th style={{ padding: '6px 4px' }}>{t('common.name')}</th>
              <th style={{ padding: '6px 4px', width: 80 }}>Protocol</th>
              <th style={{ padding: '6px 4px', width: 90 }}>Port</th>
              <th style={{ padding: '6px 4px', width: 140 }}>Module</th>
              <th style={{ padding: '6px 4px', width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {/* 기본 스캔 항목 */}
            {[
              { key: 'adb', label: 'ADB', proto: 'USB/WiFi', port: '-' },
              { key: 'serial', label: 'Serial', proto: 'COM', port: '-' },
              { key: 'hkmc', label: 'HKMC', proto: 'TCP', port: '6655/5000' },
              { key: 'dlt', label: 'DLT', proto: 'TCP', port: '3490' },
              { key: 'bench', label: 'Bench', proto: 'UDP', port: '25000' },
              { key: 'vision_camera', label: 'Vision Camera', proto: 'GigE', port: '-' },
            ].map(item => {
              const v = scanBuiltin[item.key] || { enabled: true, module: '' };
              return (
                <tr key={item.key} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '4px' }}>
                    <Checkbox checked={v.enabled !== false}
                      onChange={e => setScanBuiltin({ ...scanBuiltin, [item.key]: { ...v, enabled: e.target.checked } })} />
                  </td>
                  <td style={{ padding: '4px' }}>{item.label}</td>
                  <td style={{ padding: '4px' }}><Tag>{item.proto}</Tag></td>
                  <td style={{ padding: '4px' }}>{item.port}</td>
                  <td style={{ padding: '4px' }}>
                    <Select size="small" allowClear placeholder="-" value={v.module || undefined}
                      onChange={val => setScanBuiltin({ ...scanBuiltin, [item.key]: { ...v, module: val || '' } })}
                      style={{ width: '100%' }} options={modules.map(m => ({ label: m.label, value: m.name }))} />
                  </td>
                  <td></td>
                </tr>
              );
            })}
            {/* 커스텀 스캔 항목 */}
            {scanCustom.map((entry, idx) => (
              <tr key={`c_${idx}`} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '4px' }}>
                  <Checkbox checked={entry.enabled}
                    onChange={e => { const n = [...scanCustom]; n[idx] = { ...entry, enabled: e.target.checked }; setScanCustom(n); }} />
                </td>
                <td style={{ padding: '4px' }}>{entry.label}</td>
                <td style={{ padding: '4px' }}><Tag color={entry.type === 'udp' ? 'orange' : 'blue'}>{entry.type.toUpperCase()}</Tag></td>
                <td style={{ padding: '4px' }}>{entry.port}</td>
                <td style={{ padding: '4px' }}>
                  <Select size="small" allowClear placeholder="-" value={entry.module || undefined}
                    onChange={val => { const n = [...scanCustom]; n[idx] = { ...entry, module: val || '' }; setScanCustom(n); }}
                    style={{ width: '100%' }} options={modules.map(m => ({ label: m.label, value: m.name }))} />
                </td>
                <td style={{ padding: '4px' }}>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />}
                    onClick={() => setScanCustom(scanCustom.filter((_, i) => i !== idx))} />
                </td>
              </tr>
            ))}
            {/* 추가 행 */}
            <tr style={{ borderTop: '1px solid #d9d9d9' }}>
              <td></td>
              <td style={{ padding: '4px' }}>
                <Input size="small" placeholder={t('device.customLabel')} value={newCustomLabel}
                  onChange={e => setNewCustomLabel(e.target.value)} />
              </td>
              <td style={{ padding: '4px' }}>
                <Select size="small" value={newCustomType} onChange={setNewCustomType} style={{ width: '100%' }}
                  options={[{ label: 'TCP', value: 'tcp' }, { label: 'UDP', value: 'udp' }]} />
              </td>
              <td style={{ padding: '4px' }}>
                <InputNumber size="small" placeholder="Port" value={newCustomPort}
                  onChange={v => setNewCustomPort(v)} min={1} max={65535} style={{ width: '100%' }} />
              </td>
              <td style={{ padding: '4px' }}>
                <Select size="small" allowClear placeholder="Module" value={newCustomModule || undefined}
                  onChange={v => setNewCustomModule(v || '')} style={{ width: '100%' }}
                  options={modules.map(m => ({ label: m.label, value: m.name }))} />
              </td>
              <td style={{ padding: '4px' }}>
                <Button size="small" type="primary" icon={<PlusOutlined />}
                  onClick={addCustomScan} disabled={!newCustomPort} />
              </td>
            </tr>
          </tbody>
        </table>
      </Modal>
    </div>
  );
}
