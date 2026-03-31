import { useEffect, useState } from 'react';
import { Card, Input, Space, Spin, Table, Tag, Typography, message } from 'antd';
import { BranchesOutlined, TagOutlined } from '@ant-design/icons';
import { serverApi } from '../services/api';
import { useSettings } from '../context/SettingsContext';
import { useTranslation } from '../i18n';

interface Commit {
  hash: string;
  short_hash: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

export default function ChangelogPage() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const isDark = settings.theme === 'dark';

  const [loading, setLoading] = useState(true);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [branch, setBranch] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res = await serverApi.gitLog(200);
        setCommits(res.data.commits || []);
        setBranch(res.data.branch || '');
        setTags(res.data.tags || []);
      } catch {
        message.error(t('changelog.loadFailed'));
      } finally {
        setLoading(false);
      }
    };
    load();

    const handler = (e: Event) => {
      if ((e as CustomEvent).detail === '/changelog') load();
    };
    window.addEventListener('tab-change', handler);
    return () => window.removeEventListener('tab-change', handler);
  }, []);

  const filtered = search
    ? commits.filter(c =>
        c.message.toLowerCase().includes(search.toLowerCase()) ||
        c.short_hash.toLowerCase().includes(search.toLowerCase()) ||
        c.author.toLowerCase().includes(search.toLowerCase())
      )
    : commits;

  // 커밋 메시지 prefix로 타입 태그 표시
  const typeTag = (msg: string) => {
    const m = msg.match(/^(feat|fix|refactor|docs|style|test|chore|perf|ci|build)[:(]/i);
    if (!m) return null;
    const type = m[1].toLowerCase();
    const colors: Record<string, string> = {
      feat: 'blue', fix: 'red', refactor: 'orange', docs: 'green',
      style: 'purple', test: 'cyan', chore: 'default', perf: 'gold',
      ci: 'geekblue', build: 'lime',
    };
    return <Tag color={colors[type] || 'default'} style={{ marginRight: 6 }}>{type}</Tag>;
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return '오늘';
    if (days === 1) return '어제';
    if (days < 7) return `${days}일 전`;
    return d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
  };

  const columns = [
    {
      title: t('changelog.hash'),
      dataIndex: 'short_hash',
      key: 'hash',
      width: 90,
      render: (v: string) => (
        <Typography.Text code copyable={{ text: v }} style={{ fontSize: 12 }}>{v}</Typography.Text>
      ),
    },
    {
      title: t('changelog.message'),
      dataIndex: 'message',
      key: 'message',
      render: (v: string) => (
        <span>
          {typeTag(v)}
          <span>{v.replace(/^(feat|fix|refactor|docs|style|test|chore|perf|ci|build)[:(]\s*/i, '')}</span>
        </span>
      ),
    },
    {
      title: t('changelog.author'),
      dataIndex: 'author',
      key: 'author',
      width: 120,
      render: (v: string) => <span style={{ color: isDark ? '#91caff' : '#1677ff' }}>{v}</span>,
    },
    {
      title: t('changelog.date'),
      dataIndex: 'date',
      key: 'date',
      width: 110,
      render: (v: string) => <span style={{ color: '#888', fontSize: 12 }}>{formatDate(v)}</span>,
    },
  ];

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>{t('changelog.title')}</Typography.Title>

      <Space style={{ marginBottom: 16 }} wrap>
        <Tag icon={<BranchesOutlined />} color="processing">{branch}</Tag>
        <span style={{ color: '#888', fontSize: 12 }}>{t('changelog.totalCommits')}: {commits.length}</span>
        {tags.length > 0 && (
          <>
            <TagOutlined style={{ color: '#888', marginLeft: 8 }} />
            {tags.slice(0, 5).map(tag => (
              <Tag key={tag} color="gold">{tag}</Tag>
            ))}
            {tags.length > 5 && <span style={{ color: '#888', fontSize: 12 }}>+{tags.length - 5}</span>}
          </>
        )}
      </Space>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Input.Search
          placeholder={t('changelog.search')}
          allowClear
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </Card>

      <Spin spinning={loading}>
        <Table
          dataSource={filtered}
          columns={columns}
          rowKey="hash"
          size="small"
          pagination={{ pageSize: 30, showSizeChanger: true, pageSizeOptions: ['20', '30', '50', '100'] }}
          locale={{ emptyText: t('changelog.noCommits') }}
        />
      </Spin>
    </div>
  );
}
