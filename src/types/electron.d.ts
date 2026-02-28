export type LiveSource = 'input' | 'model';

export interface LiveCaptionPayload {
  enText: string;
  koText: string;
  isFinal: boolean;
  source: LiveSource;
  timestamp: string;
}

export interface LiveErrorPayload {
  message: string;
  timestamp: string;
}

export interface LiveStatusPayload {
  status: string;
  message: string;
  timestamp: string;
}

export interface LiveDebugPayload {
  stage: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export interface LiveSessionResult {
  ok: boolean;
}

export interface DesktopSourceInfo {
  id: string;
  name: string;
}

export interface ElectronAPI {
  startLiveSession: () => Promise<LiveSessionResult>;
  getDesktopSource: () => Promise<DesktopSourceInfo>;
  sendAudioChunk: (chunk: ArrayBuffer, mimeType?: string) => void;
  endLiveSession: () => void;
  onLiveCaption: (callback: (payload: LiveCaptionPayload) => void) => () => void;
  onLiveError: (callback: (payload: LiveErrorPayload) => void) => () => void;
  onLiveStatus: (callback: (payload: LiveStatusPayload) => void) => () => void;
  onLiveDebug: (callback: (payload: LiveDebugPayload) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
