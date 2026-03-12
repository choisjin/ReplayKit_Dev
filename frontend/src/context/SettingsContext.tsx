import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

export interface AppSettings {
  theme: 'light' | 'dark';
  webcam_save_dir: string;
  excel_export_dir: string;
}

interface SettingsContextType {
  settings: AppSettings;
  loading: boolean;
  updateSettings: (partial: Partial<AppSettings>) => Promise<void>;
  uploadWebcamRecording: (blob: Blob, filename: string) => Promise<string>;
  saveExcelToDir: (resultFilename: string) => Promise<string>;
  browseFolder: (initialDir?: string) => Promise<string>;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  webcam_save_dir: '',
  excel_export_dir: '',
};

const SettingsContext = createContext<SettingsContextType | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/settings').then(res => {
      setSettings({ ...DEFAULT_SETTINGS, ...res.data });
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const updateSettings = useCallback(async (partial: Partial<AppSettings>) => {
    const res = await api.post('/settings', partial);
    setSettings({ ...DEFAULT_SETTINGS, ...res.data });
  }, []);

  const uploadWebcamRecording = useCallback(async (blob: Blob, filename: string): Promise<string> => {
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('filename', filename);
    const res = await api.post('/settings/upload-webcam', form);
    return res.data.path;
  }, []);

  const saveExcelToDir = useCallback(async (resultFilename: string): Promise<string> => {
    const res = await api.post(`/settings/save-excel/${resultFilename}`);
    return res.data.path;
  }, []);

  const browseFolder = useCallback(async (initialDir?: string): Promise<string> => {
    const res = await api.post('/settings/browse-folder', { initial_dir: initialDir || '' });
    return res.data.path || '';
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, loading, updateSettings, uploadWebcamRecording, saveExcelToDir, browseFolder }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
