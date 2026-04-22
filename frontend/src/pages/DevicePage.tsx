import { useState, useMemo, useEffect, useCallback } from 'react';
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
  iSAP: 'iSAP Agent',
  Serial: 'Serial',
  VisionCam: 'Vision Camera',
  Webcam: 'Webcam',
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
        if (d.protected) continue;
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
  const [scannedIsap, setScannedIsap] = useState<{ ip: string; port: number }[]>([]);
  const [scannedBench, setScannedBench] = useState<{ ip: string; port: number; verified?: boolean }[]>([]);
  const [scannedVision, setScannedVision] = useState<{ id: string; mac: string; model: string; serial: string; vendor: string; tl_type: string; ip: string; subnet?: string; gateway?: string }[]>([]);
  const [scannedWebcams, setScannedWebcams] = useState<{ index: number; label: string; width: number; height: number; already_registered?: boolean; in_use_by_recording?: boolean }[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [scannedDlt, setScannedDlt] = useState<{ ip: string; port: number }[]>([]);
  const [scannedSmartbench, setScannedSmartbench] = useState<{ ip: string; port: number; label: string; module: string }[]>([]);
  const [scannedSsh, setScannedSsh] = useState<{ ip: string; port: number }[]>([]);
  const [scannedCustom, setScannedCustom] = useState<{ label: string; hosts: { ip: string; port: number }[] }[]>([]);
  const [pcInterfaces, setPcInterfaces] = useState<{ name: string; ip: string; prefix: number }[]>([]);
  const [forceIpModal, setForceIpModal] = useState<{ mac: string; currentIp: string } | null>(null);
  const [forceIpAddr, setForceIpAddr] = useState('');
  const [forceIpSubnet, setForceIpSubnet] = useState('255.255.255.0');
  const [forceIpGateway, setForceIpGateway] = useState('0.0.0.0');
  const [forceIpLoading, setForceIpLoading] = useState(false);
  const [connectType, setConnectType] = useState<'adb' | 'serial' | 'module' | 'hkmc6th' | 'isap_agent' | 'vision_camera' | 'webcam' | 'ssh'>('adb');
  const [connectAddress, setConnectAddress] = useState('');
  const [baudrate, setBaudrate] = useState(115200);
  const [connecting, setConnecting] = useState(false);
  const [hkmcPort, setHkmcPort] = useState(5000);
  const [sshPort, setSshPort] = useState(22);
  const [sshUser, setSshUser] = useState('');
  const [sshPass, setSshPass] = useState('');
  const [sshKeyFile, setSshKeyFile] = useState('');
  const [modalTabKey, setModalTabKey] = useState('scan');
  const [deviceProject, setDeviceProject] = useState('');
  const [deviceModel, setDeviceModel] = useState('');

  // 프로젝트/모델 콤보는 backend/device_catalog.json 에서 로드 (AdminPage에서 편집)
  interface CatalogModel { value: string; enabled: boolean }   // label 없음 — value가 표시·ID prefix 겸용
  interface CatalogProject { name: string; enabled: boolean; models: CatalogModel[] }
  const [catalogProjects, setCatalogProjects] = useState<CatalogProject[]>([]);
  const [moduleVisibility, setModuleVisibility] = useState<Record<string, boolean>>({});

  useEffect(() => {
    deviceApi.getCatalog().then(res => {
      const data = res.data || {};
      setCatalogProjects(Array.isArray(data.projects) ? data.projects : []);
      setModuleVisibility(data.module_visibility || {});
    }).catch(() => {
      setCatalogProjects([]);
      setModuleVisibility({});
    });
  }, []);

  const PROJECT_OPTIONS = useMemo(() => [
    { label: '전체', value: '' },
    ...catalogProjects
      .filter(p => p.enabled !== false && typeof p.name === 'string' && p.name.length > 0)
      .map(p => ({ label: p.name, value: p.name }))
      .sort((a, b) => (a.label || '').localeCompare(b.label || '')),
  ], [catalogProjects]);

  const DEVICE_MODELS = useMemo(() => {
    const enabledProjects = catalogProjects.filter(p => p.enabled !== false);
    const src = deviceProject
      ? enabledProjects.filter(p => p.name === deviceProject)
      : enabledProjects;
    const flat: { label: string; value: string }[] = [];
    for (const p of src) {
      for (const m of (p.models || [])) {
        if (m.enabled === false) continue;
        const v = typeof m.value === 'string' ? m.value : '';
        if (!v) continue; // value 누락 항목 스킵
        flat.push({ label: v, value: v });
      }
    }
    return flat.sort((a, b) => (a.label || '').localeCompare(b.label || ''));
  }, [deviceProject, catalogProjects]);

  const isModuleVisible = useCallback((name?: string) => {
    if (!name) return true;
    return moduleVisibility[name] !== false;
  }, [moduleVisibility]);

  // VisionCamera
  const [vcMac, setVcMac] = useState('');
  const [vcModel, setVcModel] = useState('exo264CGE');
  const [vcSerial, setVcSerial] = useState('');
  const [vcSubnet, setVcSubnet] = useState('255.255.0.0');

  // Webcam
  const [webcamIndex, setWebcamIndex] = useState<number>(0);
  const [webcamWidth, setWebcamWidth] = useState<number>(0);
  const [webcamHeight, setWebcamHeight] = useState<number>(0);

  // Module
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  // 표시 가능한 모듈 목록 (사용자 선택 UI에서 참조 — AdminPage에서 체크 해제 시 숨김)
  const visibleModules = useMemo(() => modules.filter(m => isModuleVisible(m.name)), [modules, isModuleVisible]);
  const [selectedModule, setSelectedModule] = useState<string | undefined>(undefined);
  const [scanSelectedModule, setScanSelectedModule] = useState<string | undefined>(undefined);
  const [extraFieldValues, setExtraFieldValues] = useState<Record<string, any>>({});

  // Edit device modal
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editDevice, setEditDevice] = useState<ManagedDevice | null>(null);
  const [editName, setEditName] = useState('');
  const [editDeviceId, setEditDeviceId] = useState('');
  const [editBaudrate, setEditBaudrate] = useState(115200);
  const [editModule, setEditModule] = useState<string | undefined>(undefined);
  const [editExtraFields, setEditExtraFields] = useState<Record<string, any>>({});
  const [editSaving, setEditSaving] = useState(false);

  // Scan settings modal
  const [scanSettingsOpen, setScanSettingsOpen] = useState(false);
  const [scanBuiltin, setScanBuiltin] = useState<Record<string, { enabled: boolean; module: string; port?: number; ports?: number[]; host?: string }>>({
    adb: { enabled: true, module: '' },
    serial: { enabled: true, module: 'SerialLogging' },
    hkmc: { enabled: true, module: '', ports: [6655, 5000] },
    isap: { enabled: false, module: '', ports: [20000] },
    dlt: { enabled: true, module: 'DLTLogging', ports: [3490] },
    bench: { enabled: true, module: 'CCIC_BENCH', ports: [25000] },
    vision_camera: { enabled: false, module: 'VisionCamera' },
    webcam: { enabled: true, module: 'WebcamDevice' },
    ssh: { enabled: true, module: 'SSHManager', port: 22 },
    smartbench: { enabled: true, module: 'SmartBench', host: '192.167.0.5', port: 8000 },
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
      const prefix = getDevicePrefix(deviceId);
      const result = await disconnectDevice(deviceId);
      message.info(result);
      // 삭제 후 같은 그룹 디바이스 번호 재정렬
      await fetchDevices();
      // fetchDevices 후 최신 목록에서 같은 prefix 디바이스 추출
      const remaining = [...primaryDevices, ...auxiliaryDevices]
        .filter(d => d.id !== deviceId && getDevicePrefix(d.id) === prefix)
        .sort((a, b) => {
          const na = parseInt(a.id.match(/_(\d+)$/)?.[1] || '0');
          const nb = parseInt(b.id.match(/_(\d+)$/)?.[1] || '0');
          return na - nb;
        });
      if (remaining.length > 0) {
        try {
          const res = await deviceApi.reorderDevices(prefix, remaining.map(d => d.id));
          updateDeviceLists(res.data);
        } catch { /* 재정렬 실패해도 삭제는 완료 */ }
      }
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
      setModules((modRes.data.modules || []).sort((a: ModuleInfo, b: ModuleInfo) => (a.label || a.name || '').localeCompare(b.label || b.name || '')));
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
    setDeviceProject('');
    setDeviceModel('');
    setModalTabKey('scan');
    setModalOpen(true);
    // 네트워크 스캔은 사용자가 명시적으로 버튼을 눌렀을 때만 수행 (IDS 오탐 방지)
    // 이전 스캔 결과를 초기화해서 stale 결과가 보이지 않도록 함
    setScannedAdb([]);
    setScannedSerial([]);
    setScannedHkmc([]);
    setScannedIsap([]);
    setScannedBench([]);
    setScannedVision([]);
    setScannedWebcams([]);
    setScannedDlt([]);
    setScannedSmartbench([]);
    setScannedSsh([]);
    setScannedCustom([]);
    setHasScanned(false);
    if (category === 'auxiliary') {
      deviceApi.listModules().then(res => setModules((res.data.modules || []).sort((a: ModuleInfo, b: ModuleInfo) => (a.label || a.name || '').localeCompare(b.label || b.name || '')))).catch(() => {});
    }
  };

  const handleScan = async () => {
    setScanning(true);
    try {
      const [res, ifRes] = await Promise.all([deviceApi.scan(), deviceApi.localInterfaces()]);
      setScannedAdb(res.data.adb_devices || []);
      setScannedSerial(res.data.serial_ports || []);
      setScannedHkmc(res.data.hkmc_devices || []);
      setScannedIsap(res.data.isap_hosts || []);
      setScannedBench(res.data.bench_devices || []);
      setScannedVision(res.data.vision_cameras || []);
      setScannedWebcams(res.data.webcams || []);
      setScannedDlt(res.data.dlt_devices || []);
      setScannedSmartbench(res.data.smartbench_devices || []);
      setScannedSsh(res.data.ssh_hosts || []);
      setScannedCustom(res.data.custom_results || []);
      setPcInterfaces(ifRes.data.interfaces || []);
      setHasScanned(true);
    } catch {
      message.error(t('device.scanFailed'));
    }
    setScanning(false);
  };

  const handleConnect = async () => {
    // 주 디바이스는 프로젝트·모델 필수
    if (!ensurePrimaryProjectModel()) return;
    const moduleConnType = getModuleConnectType(selectedModule);
    const fields = getModuleConnectFields(selectedModule);

    // SSH 전용 처리
    if (connectType === 'ssh') {
      if (!connectAddress.trim()) { message.warning(t('device.sshHostPlaceholder')); return; }
      if (!sshUser.trim()) { message.warning(t('device.sshUserPlaceholder')); return; }
      if (!sshPass.trim() && !sshKeyFile.trim()) { message.warning(t('device.sshPassPlaceholder')); return; }
      setConnecting(true);
      try {
        const extra = {
          username: sshUser.trim(),
          password: sshPass,
          key_file_path: sshKeyFile.trim(),
        };
        const result = await connectDevice(
          'ssh', connectAddress.trim(), undefined, '', modalCategory,
          undefined, 'ssh', extra, '', sshPort,
        );
        message.success(result);
        setConnectAddress('');
        setSshUser('');
        setSshPass('');
        setSshKeyFile('');
        closeAddModal();
      } catch (e: any) {
        message.error(e.response?.data?.detail || t('device.connectFailed'));
      }
      setConnecting(false);
      return;
    }

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

    // Webcam 전용 처리
    if (connectType === 'webcam') {
      setConnecting(true);
      try {
        const extra = {
          device_index: webcamIndex,
          width: webcamWidth,
          height: webcamHeight,
        };
        const result = await connectDevice('webcam', String(webcamIndex), undefined, '', 'primary', undefined, 'webcam', extra);
        message.success(result);
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
      const tcpPort = (devType === 'hkmc6th' || devType === 'isap_agent') ? hkmcPort : undefined;
      const model = (devType === 'adb' || devType === 'hkmc6th' || devType === 'isap_agent') ? (deviceModel || undefined) : undefined;
      const result = await connectDevice(devType, connectAddress.trim(), baudrate, '', modalCategory, selectedModule, moduleConnType, extra, '', tcpPort, model);
      message.success(result);
      setConnectAddress('');
      setExtraFieldValues({});
      closeAddModal();
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('device.connectFailed'));
    }
    setConnecting(false);
  };

  // 주 디바이스 등록 시 프로젝트·모델 필수 선택 여부 확인
  const primaryProjectModelMissing = modalCategory === 'primary' && (!deviceProject || !deviceModel);
  const ensurePrimaryProjectModel = (): boolean => {
    if (primaryProjectModelMissing) {
      message.warning('주 디바이스 추가 시 프로젝트와 장비 모델을 먼저 선택하세요.');
      return false;
    }
    return true;
  };

  const handleAddSerial = async (port: string, description: string) => {
    if (!ensurePrimaryProjectModel()) return;
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
    if (!ensurePrimaryProjectModel()) return;
    setConnecting(true);
    try {
      const result = await connectDevice('adb', serial, undefined, '', 'primary', undefined, undefined, undefined, '', undefined, deviceModel || undefined);
      message.success(result);
      closeAddModal();
    } catch (e: any) {
      await fetchDevices();
      closeAddModal();
    }
    setConnecting(false);
  };

  const handleAddHkmc = async (ip: string, port: number) => {
    if (!ensurePrimaryProjectModel()) return;
    setConnecting(true);
    try {
      const result = await connectDevice('hkmc6th', ip, undefined, '', 'primary', undefined, undefined, undefined, '', port, deviceModel || undefined);
      message.success(result);
      closeAddModal();
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('device.connectFailed'));
    }
    setConnecting(false);
  };

  const handleAddIsap = async (ip: string, port: number) => {
    if (!ensurePrimaryProjectModel()) return;
    setConnecting(true);
    try {
      const result = await connectDevice('isap_agent', ip, undefined, '', 'primary', undefined, undefined, undefined, '', port, deviceModel || undefined);
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
    let mods = modules;
    if (mods.length === 0) {
      try {
        const res = await deviceApi.listModules();
        mods = (res.data.modules || []).sort((a: ModuleInfo, b: ModuleInfo) => (a.label || a.name || '').localeCompare(b.label || b.name || ''));
        setModules(mods);
      } catch { /* ignore */ }
    }
    setEditDevice(dev);
    setEditDeviceId(dev.id);
    setEditName(dev.name);
    setEditBaudrate(dev.info?.baudrate || 115200);
    setEditModule(dev.info?.module);
    const extras: Record<string, any> = {};
    const modInfo = mods.find(m => m.name === dev.info?.module);
    if (modInfo?.connect_fields) {
      for (const f of modInfo.connect_fields) {
        extras[f.name] = dev.info?.[f.name] ?? f.default ?? '';
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
      // Device ID (prefix) 변경
      const oldPrefix = getDevicePrefix(editDevice.id);
      const newPrefix = getDevicePrefix(editDeviceId);
      if (editDeviceId !== editDevice.id && newPrefix !== oldPrefix) {
        // 새 그룹의 마지막 번호 + 1
        const samePrefix = allDevices.filter(d => getDevicePrefix(d.id) === newPrefix && d.id !== editDevice.id);
        const maxNum = samePrefix.reduce((max, d) => {
          const n = parseInt(d.id.match(/_(\d+)$/)?.[1] || '0');
          return Math.max(max, n);
        }, 0);
        updates.new_device_id = `${newPrefix}_${maxNum + 1}`;
      } else if (editDeviceId !== editDevice.id) {
        updates.new_device_id = editDeviceId;
      }
      if (editName !== editDevice.name) updates.name = editName;
      if (editBaudrate !== (editDevice.info?.baudrate || 115200)) updates.baudrate = editBaudrate;
      if (editModule !== editDevice.info?.module) {
        updates.module = editModule;
        const ct = getModuleConnectType(editModule);
        if (ct) updates.connect_type = ct;
      }
      if (Object.keys(editExtraFields).length > 0) {
        updates.extra_fields = editExtraFields;
      }
      await deviceApi.updateDevice(editDevice.id, updates);
      message.success(t('device.editSuccess'));
      setEditModalOpen(false);
      await fetchDevices();
      // 기존 그룹 번호 재정렬
      if (updates.new_device_id && newPrefix !== oldPrefix) {
        const oldGroup = [...primaryDevices, ...auxiliaryDevices]
          .filter(d => d.id !== editDevice.id && getDevicePrefix(d.id) === oldPrefix)
          .sort((a, b) => parseInt(a.id.match(/_(\d+)$/)?.[1] || '0') - parseInt(b.id.match(/_(\d+)$/)?.[1] || '0'));
        if (oldGroup.length > 0) {
          try {
            const res = await deviceApi.reorderDevices(oldPrefix, oldGroup.map(d => d.id));
            updateDeviceLists(res.data);
          } catch { /* ignore */ }
        }
      }
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
    const primary = ['Android', 'HKMC', 'iSAP', 'VisionCam', 'Webcam'];
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
        disabled={d.protected}
        style={{ flexShrink: 0, visibility: d.protected ? 'hidden' : 'visible' }}
      />
      <Tag color={getStatusColor(d.status)} style={{ flexShrink: 0 }}>
        {getStatusLabel(d.status)}
      </Tag>
      <span style={{ fontWeight: 500, flexShrink: 0 }}>{d.id}</span>
      {d.protected && <Tag color="gold" style={{ flexShrink: 0 }}>SYSTEM</Tag>}
      <span style={{ color: '#aaa', fontSize: 12, flexShrink: 0 }}>{d.address}</span>
      {d.info?.module && <Tag color="cyan" style={{ flexShrink: 0 }}>{d.info.module}</Tag>}
      {d.info?.baudrate && <Tag style={{ flexShrink: 0 }}>{d.info.baudrate}</Tag>}
      {d.info?.resolution && <Tag style={{ flexShrink: 0 }}>{d.info.resolution.width}x{d.info.resolution.height}</Tag>}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, flexShrink: 0 }}>
        {d.protected ? null : (
          <>
            {isDeviceConnected(d) ? (
              <Button size="small" icon={<DisconnectOutlined />} loading={disconnectingIds.has(d.id)}
                onClick={() => handleDisconnectOne(d.id)}>{t('device.disconnectOne')}</Button>
            ) : (
              <Button size="small" type="primary" icon={<LinkOutlined />} loading={connectingIds.has(d.id)}
                onClick={() => handleConnectOne(d.id)}>{t('device.connectOne')}</Button>
            )}
            <Button size="small" icon={<EditOutlined />} onClick={() => openEditModal(d)} />
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDisconnect(d.id)} />
          </>
        )}
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
        <Button size="small" type="primary" loading={connecting} disabled={primaryProjectModelMissing} title={primaryProjectModelMissing ? '프로젝트·모델을 먼저 선택하세요' : undefined} onClick={() => handleAddSerial(r.port, r.description)}>
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
                  <Space style={{ marginBottom: 8 }} wrap>
                    <Button
                      type={hasScanned ? 'default' : 'primary'}
                      icon={hasScanned ? <ReloadOutlined /> : <SearchOutlined />}
                      onClick={handleScan}
                      loading={scanning}
                    >
                      {hasScanned ? t('device.rescan') : t('device.scan')}
                    </Button>
                    {modalCategory === 'primary' && (
                      <>
                        <Select
                          value={deviceProject}
                          onChange={(v) => { setDeviceProject(v); setDeviceModel(''); }}
                          style={{ minWidth: 120 }}
                          options={PROJECT_OPTIONS}
                        />
                        <Select
                          allowClear
                          value={deviceModel || undefined}
                          onChange={(v) => {
                            const nextModel = v || '';
                            setDeviceModel(nextModel);
                            // SSH는 스캔 대상이 아니므로 수동 연결 탭으로 자동 전환
                            if (nextModel === 'SSH') {
                              setConnectType('ssh');
                              setModalTabKey('manual');
                            }
                          }}
                          style={{ minWidth: 200 }}
                          placeholder="장비 모델 선택"
                          options={DEVICE_MODELS}
                        />
                      </>
                    )}
                  </Space>

                  {(() => {
                    // 카테고리별 tab 구성 — 결과 있는 것만 표시
                    const PAGE_SIZE = 5;
                    const scanTabs: { key: string; label: React.ReactNode; children: React.ReactNode }[] = [];

                    if (modalCategory === 'primary' && scannedAdb.length > 0) {
                      scanTabs.push({
                        key: 'adb',
                        label: <span>{t('device.detectedAdb')} <Tag style={{ marginLeft: 4 }}>{scannedAdb.length}</Tag></span>,
                        children: (
                          <List
                            size="small"
                            dataSource={scannedAdb}
                            pagination={scannedAdb.length > PAGE_SIZE ? { pageSize: PAGE_SIZE, size: 'small' } : false}
                            renderItem={(d) => (
                              <List.Item actions={[
                                <Button size="small" type="primary" loading={connecting} disabled={primaryProjectModelMissing} title={primaryProjectModelMissing ? '프로젝트·모델을 먼저 선택하세요' : undefined} onClick={() => handleAddAdb(d.serial)}>{t('common.add')}</Button>
                              ]}>
                                <Tag color="green">{d.serial}</Tag> {d.model} <Tag>{d.status}</Tag>
                              </List.Item>
                            )}
                          />
                        ),
                      });
                    }

                    if (scannedSerial.length > 0) {
                      scanTabs.push({
                        key: 'serial',
                        label: <span>{t('device.detectedSerial')} <Tag style={{ marginLeft: 4 }}>{scannedSerial.length}</Tag></span>,
                        children: (
                          <>
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
                                      options={visibleModules.map(m => ({ label: m.label, value: m.name }))}
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
                              pagination={scannedSerial.length > PAGE_SIZE ? { pageSize: PAGE_SIZE, size: 'small' } : false}
                            />
                          </>
                        ),
                      });
                    }

                    if (modalCategory === 'primary' && scannedHkmc.length > 0) {
                      scanTabs.push({
                        key: 'hkmc',
                        label: <span>{t('device.detectedHkmc')} <Tag style={{ marginLeft: 4 }}>{scannedHkmc.length}</Tag></span>,
                        children: (
                          <List
                            size="small"
                            dataSource={scannedHkmc}
                            pagination={scannedHkmc.length > PAGE_SIZE ? { pageSize: PAGE_SIZE, size: 'small' } : false}
                            renderItem={(d) => (
                              <List.Item actions={[
                                <Button size="small" type="primary" loading={connecting} disabled={primaryProjectModelMissing} title={primaryProjectModelMissing ? '프로젝트·모델을 먼저 선택하세요' : undefined} onClick={() => handleAddHkmc(d.ip, d.port)}>{t('common.add')}</Button>
                              ]}>
                                <Tag color="volcano">HKMC</Tag> <Tag color="blue">{d.ip}</Tag> <span style={{ color: '#888' }}>TCP: {d.port}</span>
                              </List.Item>
                            )}
                          />
                        ),
                      });
                    }

                    if (modalCategory === 'primary' && scannedIsap.length > 0) {
                      scanTabs.push({
                        key: 'isap',
                        label: <span>{t('device.detectedIsap')} <Tag style={{ marginLeft: 4 }}>{scannedIsap.length}</Tag></span>,
                        children: (
                          <List
                            size="small"
                            dataSource={scannedIsap}
                            pagination={scannedIsap.length > PAGE_SIZE ? { pageSize: PAGE_SIZE, size: 'small' } : false}
                            renderItem={(d) => (
                              <List.Item actions={[
                                <Button size="small" type="primary" loading={connecting} disabled={primaryProjectModelMissing} title={primaryProjectModelMissing ? '프로젝트·모델을 먼저 선택하세요' : undefined} onClick={() => handleAddIsap(d.ip, d.port)}>{t('common.add')}</Button>
                              ]}>
                                <Tag color="geekblue">iSAP</Tag> <Tag color="blue">{d.ip}</Tag> <span style={{ color: '#888' }}>TCP: {d.port}</span>
                              </List.Item>
                            )}
                          />
                        ),
                      });
                    }

                    if (modalCategory === 'auxiliary' && scannedBench.length > 0) {
                      scanTabs.push({
                        key: 'bench',
                        label: <span>{t('device.detectedBench')} <Tag style={{ marginLeft: 4 }}>{scannedBench.length}</Tag></span>,
                        children: (
                          <>
                            {modules.length > 0 && (
                              <div style={{ marginBottom: 8 }}>
                                <span style={{ marginRight: 8, color: '#888', fontSize: 12 }}>{`${t('device.module')}:`}</span>
                                <Select
                                  placeholder={t('device.moduleSelect')}
                                  value={scanSelectedModule}
                                  onChange={setScanSelectedModule}
                                  style={{ width: 280 }}
                                  defaultValue="CCIC_BENCH"
                                  options={visibleModules.filter(m => m.connect_type === 'socket').map(m => ({ label: m.label, value: m.name }))}
                                />
                              </div>
                            )}
                            <List
                              size="small"
                              dataSource={scannedBench}
                              pagination={scannedBench.length > PAGE_SIZE ? { pageSize: PAGE_SIZE, size: 'small' } : false}
                              renderItem={(d) => (
                                <List.Item actions={[
                                  <Button size="small" type="primary" loading={connecting} onClick={() => handleAddBench(d.ip, d.port)}>{t('common.add')}</Button>
                                ]}>
                                  {d.verified ? <Tag color="green">Bench</Tag> : <Tag color="default">Host</Tag>}
                                  <Tag color="blue">{d.ip}</Tag>
                                  <span style={{ color: '#888' }}>UDP: {d.port}</span>
                                  {d.verified && <Tag color="green" style={{ marginLeft: 4 }}>응답확인</Tag>}
                                </List.Item>
                              )}
                            />
                          </>
                        ),
                      });
                    }

                    if (modalCategory === 'primary' && scannedVision.length > 0) {
                      scanTabs.push({
                        key: 'vision',
                        label: <span>{t('device.detectedVision')} <Tag style={{ marginLeft: 4 }}>{scannedVision.length}</Tag></span>,
                        children: (
                          <>
                            {pcInterfaces.length > 0 && (
                              <div style={{ marginBottom: 8, fontSize: 12, color: '#888' }}>
                                {t('device.pcInterfaces')}: {pcInterfaces.map(i => `${i.ip}/${i.prefix} (${i.name})`).join(' | ')}
                              </div>
                            )}
                            <List
                              size="small"
                              dataSource={scannedVision}
                              pagination={scannedVision.length > PAGE_SIZE ? { pageSize: PAGE_SIZE, size: 'small' } : false}
                              renderItem={(cam) => (
                                <List.Item actions={[
                                  <Space size={4}>
                                    {cam.mac && (
                                      <Button size="small" onClick={() => {
                                        setForceIpModal({ mac: cam.mac, currentIp: cam.ip || '' });
                                        const iface = pcInterfaces[0];
                                        if (iface) {
                                          const parts = iface.ip.split('.');
                                          const camParts = (cam.ip || '').split('.');
                                          const prefixLen = iface.prefix || 24;
                                          const sameSubnet = prefixLen >= 24
                                            && parts[0] === camParts[0]
                                            && parts[1] === camParts[1]
                                            && parts[2] === camParts[2];
                                          if (sameSubnet) {
                                            setForceIpAddr(cam.ip || '');
                                            setForceIpSubnet(cam.subnet || '255.255.255.0');
                                          } else {
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
                        ),
                      });
                    }

                    if (modalCategory === 'primary' && scannedWebcams.length > 0) {
                      scanTabs.push({
                        key: 'webcam',
                        label: <span>{t('device.detectedWebcam')} <Tag style={{ marginLeft: 4 }}>{scannedWebcams.length}</Tag></span>,
                        children: (
                          <List
                            size="small"
                            dataSource={scannedWebcams}
                            pagination={scannedWebcams.length > PAGE_SIZE ? { pageSize: PAGE_SIZE, size: 'small' } : false}
                            renderItem={(w) => {
                              const busy = !!w.in_use_by_recording;
                              const dup = !!w.already_registered;
                              const handleQuickAdd = async () => {
                                if (!ensurePrimaryProjectModel()) return;
                                setConnecting(true);
                                try {
                                  const extra = { device_index: w.index, width: w.width || 0, height: w.height || 0 };
                                  const result = await connectDevice('webcam', String(w.index), undefined, '', 'primary', undefined, 'webcam', extra);
                                  message.success(result);
                                  closeAddModal();
                                } catch (e: any) {
                                  message.error(e.response?.data?.detail || t('device.connectFailed'));
                                }
                                setConnecting(false);
                              };
                              return (
                                <List.Item actions={[
                                  <Button size="small" type="primary" loading={connecting}
                                          disabled={dup || busy || primaryProjectModelMissing}
                                          title={primaryProjectModelMissing ? '프로젝트·모델을 먼저 선택하세요' : undefined}
                                          onClick={handleQuickAdd}>
                                    {t('common.add')}
                                  </Button>
                                ]}>
                                  <div>
                                    <Tag color="purple">{t('device.webcam')}</Tag>
                                    <strong>{w.label}</strong>
                                    {w.width > 0 && <Tag style={{ marginLeft: 8 }}>{w.width}×{w.height}</Tag>}
                                    {dup && <Tag color="default" style={{ marginLeft: 8 }}>{t('device.alreadyRegistered')}</Tag>}
                                    {busy && <Tag color="orange" style={{ marginLeft: 8 }}>{t('device.webcamInUseByRecording')}</Tag>}
                                  </div>
                                </List.Item>
                              );
                            }}
                          />
                        ),
                      });
                    }

                    if (scannedDlt.length > 0) {
                      const dltModule = (scanBuiltin.dlt as any)?.module || 'DLTLogging';
                      scanTabs.push({
                        key: 'dlt',
                        label: <span>{t('dlt.detectedDlt')} <Tag style={{ marginLeft: 4 }}>{scannedDlt.length}</Tag></span>,
                        children: (
                          <List
                            size="small"
                            bordered
                            dataSource={scannedDlt}
                            pagination={scannedDlt.length > PAGE_SIZE ? { pageSize: PAGE_SIZE, size: 'small' } : false}
                            renderItem={(d) => (
                              <List.Item actions={[
                                <Button size="small" type="primary" onClick={async () => {
                                  try {
                                    await connectDevice('module', d.ip, undefined, `${dltModule}_${d.ip}`, 'auxiliary', dltModule, 'socket', { port: d.port });
                                    message.success(`DLT ${d.ip}:${d.port} ${t('common.connect')}`);
                                    closeAddModal();
                                  } catch (e: any) {
                                    message.error(e.response?.data?.detail || 'Connect failed');
                                  }
                                }}>{t('common.connect')}</Button>,
                              ]}>
                                <div>
                                  <Tag color="geekblue">DLT</Tag>
                                  <strong>{d.ip}</strong>:{d.port}
                                  <Tag style={{ marginLeft: 8 }}>{dltModule}</Tag>
                                </div>
                              </List.Item>
                            )}
                          />
                        ),
                      });
                    }

                    if (scannedSmartbench.length > 0) {
                      scanTabs.push({
                        key: 'smartbench',
                        label: <span>SmartBench <Tag style={{ marginLeft: 4 }}>{scannedSmartbench.length}</Tag></span>,
                        children: (
                          <List
                            size="small"
                            bordered
                            dataSource={scannedSmartbench}
                            pagination={scannedSmartbench.length > PAGE_SIZE ? { pageSize: PAGE_SIZE, size: 'small' } : false}
                            renderItem={(h) => (
                              <List.Item actions={[
                                <Button size="small" type="primary" onClick={async () => {
                                  try {
                                    const devId = `SmartBench_${h.ip}`;
                                    await connectDevice('module', h.ip, undefined, devId, 'auxiliary', 'SmartBench', 'socket', { port: h.port });
                                    message.success(`SmartBench ${h.ip}:${h.port} ${t('common.connect')}`);
                                    closeAddModal();
                                  } catch (e: any) {
                                    message.error(e.response?.data?.detail || 'Connect failed');
                                  }
                                }}>{t('common.connect')}</Button>,
                              ]}>
                                <div>
                                  <Tag color="orange">SmartBench</Tag>
                                  <strong>{h.ip}</strong>:{h.port}
                                </div>
                              </List.Item>
                            )}
                          />
                        ),
                      });
                    }

                    if (scannedSsh.length > 0) {
                      scanTabs.push({
                        key: 'ssh',
                        label: <span>{t('device.detectedSsh')} <Tag style={{ marginLeft: 4 }}>{scannedSsh.length}</Tag></span>,
                        children: (
                          <List
                            size="small"
                            bordered
                            dataSource={scannedSsh}
                            pagination={scannedSsh.length > PAGE_SIZE ? { pageSize: PAGE_SIZE, size: 'small' } : false}
                            renderItem={(h) => (
                              <List.Item actions={[
                                <Button size="small" type="primary" onClick={() => {
                                  setConnectType('ssh');
                                  setConnectAddress(h.ip);
                                  setSshPort(h.port);
                                  if (modalCategory === 'primary') {
                                    setDeviceProject('General');
                                    setDeviceModel('SSH');
                                  }
                                  setModalTabKey('manual');
                                }}>{t('common.connect')}</Button>,
                              ]}>
                                <div>
                                  <Tag color="magenta">SSH</Tag>
                                  <strong>{h.ip}</strong>:{h.port}
                                </div>
                              </List.Item>
                            )}
                          />
                        ),
                      });
                    }

                    // 커스텀 스캔 결과
                    scannedCustom.forEach((group, gi) => {
                      if (group.hosts.length === 0) return;
                      const customEntry = scanCustom.find(c => c.label === group.label);
                      const moduleName = customEntry?.module || '';
                      scanTabs.push({
                        key: `custom_${gi}`,
                        label: <span>{group.label} <Tag style={{ marginLeft: 4 }}>{group.hosts.length}</Tag></span>,
                        children: (
                          <List
                            size="small"
                            bordered
                            dataSource={group.hosts}
                            pagination={group.hosts.length > PAGE_SIZE ? { pageSize: PAGE_SIZE, size: 'small' } : false}
                            renderItem={(h) => (
                              <List.Item actions={[
                                <Button size="small" type="primary" onClick={async () => {
                                  try {
                                    const devId = moduleName ? `${moduleName}_${h.ip}` : `tcp_${h.ip}_${h.port}`;
                                    await connectDevice('module', h.ip, undefined, devId, 'auxiliary', moduleName || undefined, 'socket', { port: h.port });
                                    message.success(`${group.label} ${h.ip}:${h.port} ${t('common.connect')}`);
                                    closeAddModal();
                                  } catch (e: any) {
                                    message.error(e.response?.data?.detail || 'Connect failed');
                                  }
                                }}>{t('common.connect')}</Button>,
                              ]}>
                                <div>
                                  <Tag color="cyan">{group.label}</Tag>
                                  <strong>{h.ip}</strong>:{h.port}
                                  {moduleName && <Tag style={{ marginLeft: 8 }}>{moduleName}</Tag>}
                                </div>
                              </List.Item>
                            )}
                          />
                        ),
                      });
                    });

                    if (scanTabs.length === 0 && !scanning) {
                      if (!hasScanned) {
                        return (
                          <div style={{ color: '#888', textAlign: 'center', padding: 32 }}>
                            <SearchOutlined style={{ fontSize: 28, marginBottom: 8 }} />
                            <div style={{ fontSize: 14 }}>{t('device.clickToScan')}</div>
                          </div>
                        );
                      }
                      return (
                        <div style={{ color: '#666', textAlign: 'center', padding: 24 }}>
                          {t('device.noDevicesFound')}
                        </div>
                      );
                    }

                    return <Tabs size="small" items={scanTabs} />;
                  })()}
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
                    {modalCategory === 'primary' && (
                      <Space style={{ width: '100%' }} wrap>
                        <Select
                          value={deviceProject}
                          onChange={(v) => { setDeviceProject(v); setDeviceModel(''); }}
                          style={{ minWidth: 120 }}
                          options={PROJECT_OPTIONS}
                        />
                        <Select
                          allowClear
                          value={deviceModel || undefined}
                          onChange={(v) => {
                            const nextModel = v || '';
                            setDeviceModel(nextModel);
                            // SSH 모델 선택 시 연결 타입도 자동으로 SSH로 전환
                            if (nextModel === 'SSH') {
                              setConnectType('ssh');
                            } else if (connectType === 'ssh') {
                              // SSH 아닌 모델로 바꾸면 ADB로 되돌림
                              setConnectType('adb');
                            }
                          }}
                          style={{ minWidth: 200, flex: 1 }}
                          placeholder="장비 모델 선택"
                          options={DEVICE_MODELS}
                        />
                      </Space>
                    )}
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
                        options={visibleModules.map(m => ({ label: `${m.label} [${m.connect_type}]`, value: m.name }))}
                      />
                    )}

                    {(!selectedModule || moduleConnType === undefined) && (
                      <Select value={connectType} onChange={setConnectType} style={{ width: '100%' }}>
                        <Option value="adb">ADB (WiFi / TCP)</Option>
                        {modalCategory === 'primary' && <Option value="hkmc6th">HKMC 6th (TCP)</Option>}
                        {modalCategory === 'primary' && <Option value="isap_agent">iSAP Agent (TCP)</Option>}
                        {modalCategory === 'primary' && <Option value="vision_camera">Vision Camera</Option>}
                        {modalCategory === 'primary' && <Option value="webcam">{t('device.webcam')}</Option>}
                        <Option value="serial">{t('device.serialPort')}</Option>
                        <Option value="ssh">{t('device.ssh')}</Option>
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

                    {!selectedModule && connectType === 'isap_agent' && (
                      <>
                        <Input
                          placeholder="iSAP Agent IP (예: 192.168.105.1)"
                          value={connectAddress}
                          onChange={(e) => setConnectAddress(e.target.value)}
                          onPressEnter={handleConnect}
                        />
                        <div>
                          <span style={{ fontSize: 12, color: '#888', marginRight: 8 }}>TCP Port:</span>
                          <InputNumber
                            value={hkmcPort}
                            onChange={(v) => setHkmcPort(v || 20000)}
                            min={1} max={65535}
                            style={{ width: 150 }}
                          />
                          <span style={{ fontSize: 11, color: '#888', marginLeft: 8 }}>
                            20000=전석, 20003=클러스터, 20004=HUD
                          </span>
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

                    {!selectedModule && connectType === 'webcam' && (
                      <>
                        <div>
                          <span style={{ fontSize: 12, color: '#888', marginRight: 8 }}>{t('device.webcamIndex')}:</span>
                          <InputNumber
                            value={webcamIndex}
                            onChange={(v) => setWebcamIndex(v || 0)}
                            min={0} max={15}
                            style={{ width: 150 }}
                          />
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <div style={{ flex: 1 }}>
                            <span style={{ fontSize: 12, color: '#888', marginRight: 8 }}>{t('device.webcamWidth')}:</span>
                            <InputNumber
                              value={webcamWidth}
                              onChange={(v) => setWebcamWidth(v || 0)}
                              min={0} max={7680}
                              placeholder="auto"
                              style={{ width: 110 }}
                            />
                          </div>
                          <div style={{ flex: 1 }}>
                            <span style={{ fontSize: 12, color: '#888', marginRight: 8 }}>{t('device.webcamHeight')}:</span>
                            <InputNumber
                              value={webcamHeight}
                              onChange={(v) => setWebcamHeight(v || 0)}
                              min={0} max={4320}
                              placeholder="auto"
                              style={{ width: 110 }}
                            />
                          </div>
                        </div>
                        <div style={{ fontSize: 11, color: '#888' }}>
                          {t('device.webcamHint')}
                        </div>
                      </>
                    )}

                    {!selectedModule && connectType === 'ssh' && (
                      <>
                        <Input
                          placeholder={t('device.sshHostPlaceholder')}
                          value={connectAddress}
                          onChange={(e) => setConnectAddress(e.target.value)}
                          onPressEnter={handleConnect}
                        />
                        <div>
                          <span style={{ fontSize: 12, color: '#888', marginRight: 8 }}>{t('device.sshPort')}:</span>
                          <InputNumber
                            value={sshPort}
                            onChange={(v) => setSshPort(v || 22)}
                            min={1} max={65535}
                            style={{ width: 150 }}
                          />
                        </div>
                        <Input
                          placeholder={t('device.sshUserPlaceholder')}
                          value={sshUser}
                          onChange={(e) => setSshUser(e.target.value)}
                        />
                        <Input.Password
                          placeholder={t('device.sshPassPlaceholder')}
                          value={sshPass}
                          onChange={(e) => setSshPass(e.target.value)}
                          onPressEnter={handleConnect}
                        />
                        <Input
                          placeholder={t('device.sshKeyFilePlaceholder')}
                          value={sshKeyFile}
                          onChange={(e) => setSshKeyFile(e.target.value)}
                        />
                      </>
                    )}

                    {!selectedModule && connectType !== 'hkmc6th' && connectType !== 'isap_agent' && connectType !== 'vision_camera' && connectType !== 'ssh' && (
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
                      disabled={primaryProjectModelMissing}
                      title={primaryProjectModelMissing ? '프로젝트·모델을 먼저 선택하세요' : undefined}
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
            {/* 디바이스 정보 */}
            <div style={{ background: '#fafafa', borderRadius: 6, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'center' }}>
                <span style={{ color: '#888', minWidth: 80 }}>Device ID:</span>
                <Select
                  size="small"
                  value={getDevicePrefix(editDeviceId)}
                  onChange={(prefix) => {
                    // 새 prefix 그룹의 다음 번호로 임시 ID 생성
                    const samePrefix = allDevices.filter(d => getDevicePrefix(d.id) === prefix && d.id !== editDevice.id);
                    const maxNum = samePrefix.reduce((max, d) => {
                      const n = parseInt(d.id.match(/_(\d+)$/)?.[1] || '0');
                      return Math.max(max, n);
                    }, 0);
                    setEditDeviceId(`${prefix}_${maxNum + 1}`);
                  }}
                  style={{ flex: 1 }}
                  showSearch
                  options={(() => {
                    if (editDevice.category === 'primary') {
                      // 주 디바이스: 프로젝트별 모델 목록 + 기존 primary prefix
                      const opts = new Map<string, string>(); // value → label
                      catalogProjects.filter(p => p.enabled !== false).forEach(proj => {
                        proj.models.filter(m => m.enabled !== false).forEach(m => {
                          if (m.value) opts.set(m.value, `${m.value} [${proj.name}]`);
                        });
                      });
                      // 기존 primary prefix 추가 (모델 목록에 없고, 모듈명이 아닌 것만)
                      const moduleNames = new Set(modules.map(m => m.name));
                      primaryDevices.forEach(d => {
                        const p = getDevicePrefix(d.id);
                        if (!opts.has(p) && !moduleNames.has(p)) opts.set(p, p);
                      });
                      return Array.from(opts.entries())
                        .sort((a, b) => a[1].localeCompare(b[1]))
                        .map(([value, label]) => ({ label, value }));
                    } else {
                      // 보조 디바이스: 모듈 목록 + 기존 auxiliary prefix
                      const opts = new Map<string, string>();
                      modules.forEach(m => opts.set(m.name, m.label));
                      auxiliaryDevices.forEach(d => {
                        const p = getDevicePrefix(d.id);
                        if (!opts.has(p)) opts.set(p, p);
                      });
                      return Array.from(opts.entries())
                        .sort((a, b) => a[1].localeCompare(b[1]))
                        .map(([value, label]) => ({ label, value }));
                    }
                  })()}
                />
                <span style={{ color: '#aaa', fontSize: 11, flexShrink: 0 }}>
                  {editDeviceId !== editDevice.id ? `${editDevice.id} → ${editDeviceId}` : editDeviceId}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, fontSize: 13 }}>
                <span style={{ color: '#888', minWidth: 80 }}>Type:</span>
                <span>{editDevice.type}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, fontSize: 13 }}>
                <span style={{ color: '#888', minWidth: 80 }}>{`${t('common.address')}:`}</span>
                <span>{editDevice.address || '-'}</span>
              </div>
              {editDevice.info?.resolution && (
                <div style={{ display: 'flex', gap: 8, fontSize: 13 }}>
                  <span style={{ color: '#888', minWidth: 80 }}>Resolution:</span>
                  <span>{editDevice.info.resolution.width}x{editDevice.info.resolution.height}</span>
                </div>
              )}
            </div>
            {/* 수정 가능한 필드 */}
            <div>
              <span style={{ fontSize: 12, color: '#888' }}>{`${t('common.name')}:`}</span>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
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
                  options={modules
                    .filter(m => isModuleVisible(m.name) || m.name === editModule)
                    .map(m => ({ label: m.label, value: m.name }))}
                />
              </div>
            )}
            {(() => {
              const fields = getModuleConnectFields(editModule);
              if (fields.length > 0) {
                return renderConnectFields(fields, editExtraFields, setEditExtraFields);
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
              { key: 'adb', label: 'ADB', proto: 'USB/WiFi', editablePorts: false },
              { key: 'serial', label: 'Serial', proto: 'COM', editablePorts: false },
              { key: 'hkmc', label: 'HKMC', proto: 'TCP', editablePorts: true },
              { key: 'isap', label: 'iSAP Agent', proto: 'TCP', editablePorts: true },
              { key: 'dlt', label: 'DLT', proto: 'TCP', editablePorts: true },
              { key: 'bench', label: 'Bench', proto: 'UDP', editablePorts: true },
              { key: 'vision_camera', label: 'Vision Camera', proto: 'GigE', editablePorts: false },
              { key: 'webcam', label: 'Webcam', proto: 'USB', editablePorts: false },
              { key: 'ssh', label: 'SSH', proto: 'TCP', editablePorts: false },
              { key: 'smartbench', label: 'SmartBench', proto: 'TCP', editablePorts: false },
            ].map(item => {
              const v = scanBuiltin[item.key] || { enabled: true, module: '' };
              const portsStr = v.ports && v.ports.length > 0 ? v.ports.join(',') : '';
              const portLabel = item.key === 'ssh'
                ? String(v.port ?? 22)
                : (item.editablePorts ? portsStr : '-');
              return (
                <tr key={item.key} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '4px' }}>
                    <Checkbox checked={v.enabled !== false}
                      onChange={e => setScanBuiltin({ ...scanBuiltin, [item.key]: { ...v, enabled: e.target.checked } })} />
                  </td>
                  <td style={{ padding: '4px' }}>{item.label}</td>
                  <td style={{ padding: '4px' }}><Tag>{item.proto}</Tag></td>
                  <td style={{ padding: '4px' }}>
                    {item.editablePorts ? (
                      <Input
                        size="small"
                        value={portsStr}
                        placeholder={t('device.portsPlaceholder')}
                        onChange={e => {
                          const ports = e.target.value
                            .split(/[,\s]+/)
                            .map(p => parseInt(p.trim(), 10))
                            .filter(p => !isNaN(p) && p > 0 && p < 65536);
                          setScanBuiltin({ ...scanBuiltin, [item.key]: { ...v, ports } });
                        }}
                      />
                    ) : item.key === 'smartbench' ? (
                      <Space.Compact size="small" style={{ width: '100%' }}>
                        <Input
                          size="small"
                          value={v.host ?? '192.167.0.5'}
                          placeholder="host"
                          style={{ flex: 1 }}
                          onChange={e => setScanBuiltin({ ...scanBuiltin, [item.key]: { ...v, host: e.target.value } })}
                        />
                        <InputNumber
                          size="small"
                          min={1} max={65535}
                          value={v.port ?? 8000}
                          placeholder="port"
                          style={{ width: 80 }}
                          onChange={p => setScanBuiltin({ ...scanBuiltin, [item.key]: { ...v, port: p ?? 8000 } })}
                        />
                      </Space.Compact>
                    ) : portLabel}
                  </td>
                  <td style={{ padding: '4px' }}>
                    <Select size="small" allowClear placeholder="-" value={v.module || undefined}
                      onChange={val => setScanBuiltin({ ...scanBuiltin, [item.key]: { ...v, module: val || '' } })}
                      style={{ width: '100%' }} options={visibleModules.map(m => ({ label: m.label, value: m.name }))} />
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
                    style={{ width: '100%' }} options={visibleModules.map(m => ({ label: m.label, value: m.name }))} />
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
                  options={visibleModules.map(m => ({ label: m.label, value: m.name }))} />
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
