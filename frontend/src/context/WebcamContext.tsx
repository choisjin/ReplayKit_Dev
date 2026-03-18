import { createContext, useContext, ReactNode } from 'react';
import { useWebcam } from '../hooks/useWebcam';

type WebcamInstance = ReturnType<typeof useWebcam>;

const WebcamContext = createContext<WebcamInstance | null>(null);

export function WebcamProvider({ webcam, children }: { webcam: WebcamInstance; children: ReactNode }) {
  return <WebcamContext.Provider value={webcam}>{children}</WebcamContext.Provider>;
}

export function useWebcamContext() {
  const ctx = useContext(WebcamContext);
  if (!ctx) throw new Error('useWebcamContext must be used within WebcamProvider');
  return ctx;
}
