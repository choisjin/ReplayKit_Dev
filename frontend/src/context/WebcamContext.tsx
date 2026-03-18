import { createContext, useContext, ReactNode } from 'react';
import { useWebcam } from '../hooks/useWebcam';

type WebcamInstance = ReturnType<typeof useWebcam>;

interface WebcamContextType {
  webcam: WebcamInstance;
  webcamVisible: boolean;
  /** 웹캠 PiP를 열고 스트림이 준비될 때까지 대기. 실패 시 false 반환 */
  ensureWebcamOpen: () => Promise<boolean>;
}

const WebcamContext = createContext<WebcamContextType | null>(null);

export function WebcamProvider({ webcam, webcamVisible, ensureWebcamOpen, children }: {
  webcam: WebcamInstance;
  webcamVisible: boolean;
  ensureWebcamOpen: () => Promise<boolean>;
  children: ReactNode;
}) {
  return (
    <WebcamContext.Provider value={{ webcam, webcamVisible, ensureWebcamOpen }}>
      {children}
    </WebcamContext.Provider>
  );
}

export function useWebcamContext() {
  const ctx = useContext(WebcamContext);
  if (!ctx) throw new Error('useWebcamContext must be used within WebcamProvider');
  return ctx;
}
