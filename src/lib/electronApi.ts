import type {
  DesktopSourceInfo,
  ElectronAPI,
  LiveCaptionPayload,
  LiveDebugPayload,
  LiveErrorPayload,
  LiveSessionResult,
  LiveStatusPayload,
} from '../types/electron';

function getApi(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error('Electron bridge is unavailable. Run this app in Electron.');
  }

  return window.electronAPI;
}

export function startLiveSession(): Promise<LiveSessionResult> {
  return getApi().startLiveSession();
}

export function getDesktopSource(): Promise<DesktopSourceInfo> {
  return getApi().getDesktopSource();
}

export function sendAudioChunk(chunk: ArrayBuffer, mimeType?: string): void {
  getApi().sendAudioChunk(chunk, mimeType);
}

export function endLiveSession(): void {
  getApi().endLiveSession();
}

export function onLiveCaption(callback: (payload: LiveCaptionPayload) => void): () => void {
  return getApi().onLiveCaption(callback);
}

export function onLiveError(callback: (payload: LiveErrorPayload) => void): () => void {
  return getApi().onLiveError(callback);
}

export function onLiveStatus(callback: (payload: LiveStatusPayload) => void): () => void {
  return getApi().onLiveStatus(callback);
}

export function onLiveDebug(callback: (payload: LiveDebugPayload) => void): () => void {
  return getApi().onLiveDebug(callback);
}
