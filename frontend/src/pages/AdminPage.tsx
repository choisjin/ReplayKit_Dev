import { useEffect, useState } from 'react';
import { Button, Card, Checkbox, Collapse, Divider, Empty, Input, message, Modal, Space, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { deviceApi } from '../services/api';

interface Model {
  value: string;   // 표시 텍스트이자 Device ID prefix로 사용
  enabled: boolean;
}

interface Project {
  name: string;
  enabled: boolean;
  models: Model[];
}

interface Catalog {
  projects: Project[];
  module_visibility: Record<string, boolean>;
}

interface ModuleInfo {
  name: string;
  label: string;
}

/**
 * 관리자 전용 카탈로그 편집 페이지.
 *  - 프로젝트 / 모델명 콤보 편집 (DevicePage에서 사용)
 *  - 모듈 표시여부 (체크박스로 숨김 처리 가능)
 *  - 스캔 설정은 DevicePage의 "스캔 설정" 모달을 계속 사용 (중복 UI 안 만듦)
 * 접근 경로: URL hash `#admin` (메뉴에 노출되지 않음).
 */
export default function AdminPage() {
  const [catalog, setCatalog] = useState<Catalog>({ projects: [], module_visibility: {} });
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [catRes, modRes] = await Promise.all([
        deviceApi.getCatalog(),
        deviceApi.listModules(),
      ]);
      const cat = catRes.data || {};
      setCatalog({
        projects: Array.isArray(cat.projects) ? cat.projects : [],
        module_visibility: cat.module_visibility || {},
      });
      setModules((modRes.data.modules || []).sort((a: ModuleInfo, b: ModuleInfo) => (a.label || a.name || '').localeCompare(b.label || b.name || '')));
      setDirty(false);
    } catch (e: any) {
      message.error('카탈로그 로드 실패: ' + (e.response?.data?.detail || e.message));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const markDirty = () => setDirty(true);

  const save = async () => {
    setSaving(true);
    try {
      await deviceApi.saveCatalog(catalog);
      message.success('저장 완료');
      setDirty(false);
    } catch (e: any) {
      message.error('저장 실패: ' + (e.response?.data?.detail || e.message));
    } finally {
      setSaving(false);
    }
  };

  // --- Project / Model helpers ---
  const updateProject = (idx: number, patch: Partial<Project>) => {
    setCatalog(c => ({ ...c, projects: c.projects.map((p, i) => i === idx ? { ...p, ...patch } : p) }));
    markDirty();
  };
  const removeProject = (idx: number) => {
    Modal.confirm({
      title: `'${catalog.projects[idx].name}' 프로젝트 삭제`,
      content: '되돌릴 수 없습니다.',
      okText: '삭제', okType: 'danger', cancelText: '취소',
      onOk: () => {
        setCatalog(c => ({ ...c, projects: c.projects.filter((_, i) => i !== idx) }));
        markDirty();
      },
    });
  };
  const addProject = () => {
    const name = prompt('새 프로젝트 이름');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (catalog.projects.some(p => p.name === trimmed)) {
      message.warning('이미 존재하는 프로젝트 이름');
      return;
    }
    setCatalog(c => ({ ...c, projects: [...c.projects, { name: trimmed, enabled: true, models: [] }] }));
    markDirty();
  };
  const updateModel = (projIdx: number, modelIdx: number, patch: Partial<Model>) => {
    setCatalog(c => ({
      ...c,
      projects: c.projects.map((p, i) => i === projIdx ? {
        ...p,
        models: p.models.map((m, mi) => mi === modelIdx ? { ...m, ...patch } : m),
      } : p),
    }));
    markDirty();
  };
  const removeModel = (projIdx: number, modelIdx: number) => {
    setCatalog(c => ({
      ...c,
      projects: c.projects.map((p, i) => i === projIdx ? {
        ...p,
        models: p.models.filter((_, mi) => mi !== modelIdx),
      } : p),
    }));
    markDirty();
  };
  const addModel = (projIdx: number) => {
    const value = prompt('모델 이름 (Device ID prefix, 예: ccRC / Gen6 Premium / GVM)');
    if (!value || !value.trim()) return;
    const trimmed = value.trim();
    const p = catalog.projects[projIdx];
    if (p.models.some(m => m.value === trimmed)) {
      message.warning('이미 존재하는 이름');
      return;
    }
    setCatalog(c => ({
      ...c,
      projects: c.projects.map((pp, i) => i === projIdx ? {
        ...pp,
        models: [...pp.models, { value: trimmed, enabled: true }],
      } : pp),
    }));
    markDirty();
  };

  // --- Module visibility ---
  const setModuleVisible = (name: string, visible: boolean) => {
    setCatalog(c => ({ ...c, module_visibility: { ...c.module_visibility, [name]: visible } }));
    markDirty();
  };
  const isModuleVisible = (name: string) => catalog.module_visibility[name] !== false; // 기본값 true

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        size="small"
        title={<Space><Typography.Text strong>디바이스 카탈로그 관리</Typography.Text><Tag color="orange">Admin</Tag></Space>}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load} disabled={loading}>새로고침</Button>
            <Button type="primary" icon={<SaveOutlined />} onClick={save} loading={saving} disabled={!dirty}>저장</Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          DevicePage의 프로젝트·모델 콤보와 모듈 목록에 반영됩니다. 체크 해제된 항목은 사용자에게 노출되지 않습니다.
          접근 경로: URL hash <code>#admin</code>. 메뉴에는 표시되지 않습니다.
        </Typography.Paragraph>
      </Card>

      {/* 프로젝트 / 모델 관리 */}
      <Card size="small" title="프로젝트 · 모델 콤보"
        extra={<Button size="small" icon={<PlusOutlined />} onClick={addProject}>프로젝트 추가</Button>}>
        {catalog.projects.length === 0 ? (
          <Empty description="프로젝트 없음" />
        ) : (
          <Collapse
            defaultActiveKey={catalog.projects.map((_, i) => String(i))}
            items={catalog.projects.map((p, idx) => ({
              key: String(idx),
              label: (
                <Space>
                  <Checkbox
                    checked={p.enabled}
                    onChange={(e) => { updateProject(idx, { enabled: e.target.checked }); }}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <Input
                    size="small"
                    value={p.name}
                    onChange={(e) => updateProject(idx, { name: e.target.value })}
                    onClick={(e) => e.stopPropagation()}
                    style={{ width: 160 }}
                  />
                  <Tag>{p.models.length} models</Tag>
                </Space>
              ),
              extra: (
                <Space onClick={(e) => e.stopPropagation()}>
                  <Button size="small" icon={<PlusOutlined />} onClick={() => addModel(idx)}>모델 추가</Button>
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeProject(idx)} />
                </Space>
              ),
              children: (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {p.models.length === 0 && <Typography.Text type="secondary">모델이 없습니다.</Typography.Text>}
                  {p.models.map((m, mi) => (
                    <div key={mi} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Checkbox
                        checked={m.enabled}
                        onChange={(e) => updateModel(idx, mi, { enabled: e.target.checked })}
                      />
                      <Input
                        size="small"
                        value={m.value}
                        placeholder="모델 이름 (Device ID prefix)"
                        style={{ width: 260 }}
                        onChange={(e) => updateModel(idx, mi, { value: e.target.value })}
                      />
                      <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeModel(idx, mi)} />
                    </div>
                  ))}
                </div>
              ),
            }))}
          />
        )}
      </Card>

      {/* 모듈 표시 여부 */}
      <Card size="small" title="모듈 표시 여부"
        extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>체크 해제하면 DevicePage 스캔/등록 UI에서 숨김</Typography.Text>}>
        {modules.length === 0 ? (
          <Empty description="등록된 모듈 없음" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 6 }}>
            {modules.map(m => (
              <Checkbox
                key={m.name}
                checked={isModuleVisible(m.name)}
                onChange={(e) => setModuleVisible(m.name, e.target.checked)}
              >
                <Space>
                  <Typography.Text strong style={{ fontSize: 12 }}>{m.label || m.name}</Typography.Text>
                  {m.label && m.label !== m.name && (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>({m.name})</Typography.Text>
                  )}
                </Space>
              </Checkbox>
            ))}
          </div>
        )}
      </Card>

      <Divider style={{ margin: '4px 0' }} />

      <Card size="small" title="스캔 설정">
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          <Typography.Text type="secondary">
            스캔 설정은 DevicePage 상단 "스캔 설정" 버튼에서 편집하세요. 해당 설정은 <code>backend/scan_settings.json</code>에 저장됩니다.
          </Typography.Text>
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
