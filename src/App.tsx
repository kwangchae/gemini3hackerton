import { useEffect, useRef, useState } from 'react';
import {
  endLiveSession,
  getDesktopSource,
  onLiveCaption,
  onLiveDebug,
  onLiveError,
  onLiveStatus,
  sendAudioChunk,
  startLiveSession,
} from './lib/electronApi';
import './App.css';

const FALLBACK_KO = '한국어 번역이 여기에 표시됩니다.';
const MAX_DEBUG_LINES = 200;
const AUDIO_PROCESSOR_BUFFER_SIZE = 2048;

type InputMode = 'mic' | 'system';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error occurred.';
}

function getAudioOnlyStreamFromSource(sourceStream: MediaStream): MediaStream {
  const audioTracks = sourceStream.getAudioTracks();
  if (audioTracks.length === 0) {
    for (const track of sourceStream.getTracks()) {
      track.stop();
    }

    throw new Error('No system audio track detected. Enable audio sharing in the screen-share picker.');
  }

  return new MediaStream(audioTracks);
}

function audioBufferToPcm16Chunk(inputBuffer: AudioBuffer): ArrayBuffer {
  const channelCount = inputBuffer.numberOfChannels;
  const sampleCount = inputBuffer.length;
  const output = new Int16Array(sampleCount);

  if (channelCount === 0) return output.buffer;

  if (channelCount === 1) {
    const data = inputBuffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i += 1) {
      const sample = Math.max(-1, Math.min(1, data[i]));
      output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    return output.buffer;
  }

  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c += 1) {
    channels.push(inputBuffer.getChannelData(c));
  }

  for (let i = 0; i < sampleCount; i += 1) {
    let mixed = 0;
    for (let c = 0; c < channelCount; c += 1) {
      mixed += channels[c][i];
    }
    mixed /= channelCount;
    const sample = Math.max(-1, Math.min(1, mixed));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return output.buffer;
}

async function getSystemAudioViaDesktopSource(): Promise<{ sourceStream: MediaStream; audioStream: MediaStream }> {
  const source = await getDesktopSource();
  const desktopConstraints = {
    audio: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: source.id,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: source.id,
      },
    },
  } as unknown as MediaStreamConstraints;

  const sourceStream = await navigator.mediaDevices.getUserMedia(desktopConstraints);
  return {
    sourceStream,
    audioStream: getAudioOnlyStreamFromSource(sourceStream),
  };
}

async function getCaptureStreams(inputMode: InputMode): Promise<{ sourceStream: MediaStream; audioStream: MediaStream }> {
  if (inputMode === 'mic') {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return { sourceStream: stream, audioStream: stream };
  }

  try {
    const sourceStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    return {
      sourceStream,
      audioStream: getAudioOnlyStreamFromSource(sourceStream),
    };
  } catch (error) {
    const message = getErrorMessage(error).toLowerCase();
    const shouldFallback = message.includes('not supported') || message.includes('notsupportederror');
    if (!shouldFallback) {
      throw error;
    }
  }

  return getSystemAudioViaDesktopSource();
}

function App() {
  const [koText, setKoText] = useState('');
  const [status, setStatus] = useState('idle');
  const [inputMode, setInputMode] = useState<InputMode>('mic');
  const [isListening, setIsListening] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [showDebug, setShowDebug] = useState(false);
  const [debugLines, setDebugLines] = useState<string[]>([]);

  const sourceStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const muteGainNodeRef = useRef<GainNode | null>(null);

  useEffect(() => {
    const unsubCaption = onLiveCaption((payload) => {
      setKoText(payload.koText || '');
    });

    const unsubStatus = onLiveStatus((payload) => {
      setStatus(payload.status || 'idle');
    });

    const unsubError = onLiveError((payload) => {
      setErrorMessage(payload.message || 'Live API error');
      setStatus('error');
    });

    const unsubDebug = onLiveDebug((payload) => {
      const detailText = payload.details ? JSON.stringify(payload.details) : '';
      const timeText = payload.timestamp ? payload.timestamp.slice(11, 19) : '';
      const line = `${timeText} ${payload.stage}${detailText ? ` ${detailText}` : ''}`.trim();
      setDebugLines((prev) => {
        const next = [...prev, line];
        return next.slice(-MAX_DEBUG_LINES);
      });
    });

    return () => {
      unsubCaption();
      unsubStatus();
      unsubError();
      unsubDebug();
    };
  }, []);

  const stopAudioPipeline = async () => {
    if (processorNodeRef.current) {
      processorNodeRef.current.onaudioprocess = null;
      try {
        processorNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      processorNodeRef.current = null;
    }

    if (mediaSourceNodeRef.current) {
      try {
        mediaSourceNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      mediaSourceNodeRef.current = null;
    }

    if (muteGainNodeRef.current) {
      try {
        muteGainNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      muteGainNodeRef.current = null;
    }

    if (audioContextRef.current) {
      try {
        await audioContextRef.current.close();
      } catch {
        // ignore
      }
      audioContextRef.current = null;
    }
  };

  const stopSourceStream = () => {
    if (sourceStreamRef.current) {
      for (const track of sourceStreamRef.current.getTracks()) {
        track.stop();
      }
    }
    sourceStreamRef.current = null;
  };

  useEffect(() => {
    return () => {
      void stopAudioPipeline();
      stopSourceStream();
      endLiveSession();
    };
  }, []);

  const handleStop = () => {
    void stopAudioPipeline();
    stopSourceStream();
    endLiveSession();
    setIsListening(false);
    setStatus('idle');
    setDebugLines([]);
  };

  const handleStart = async () => {
    setErrorMessage('');
    setStatus('connecting');

    let localSourceStream: MediaStream | null = null;

    try {
      const { sourceStream, audioStream } = await getCaptureStreams(inputMode);
      localSourceStream = sourceStream;

      const liveSession = await startLiveSession();
      if (!liveSession.ok) {
        for (const track of sourceStream.getTracks()) {
          track.stop();
        }
        throw new Error('Live session did not open. Check API key and model access.');
      }

      const audioContext = new AudioContext({ sampleRate: 16000 });
      await audioContext.resume();

      const mediaSourceNode = audioContext.createMediaStreamSource(audioStream);
      const processorNode = audioContext.createScriptProcessor(
        AUDIO_PROCESSOR_BUFFER_SIZE,
        Math.max(1, mediaSourceNode.channelCount),
        1
      );
      const muteGain = audioContext.createGain();
      muteGain.gain.value = 0;

      const pcmMimeType = `audio/pcm;rate=${audioContext.sampleRate}`;
      processorNode.onaudioprocess = (event) => {
        if (!sourceStreamRef.current) return;

        const pcmChunk = audioBufferToPcm16Chunk(event.inputBuffer);
        sendAudioChunk(pcmChunk, pcmMimeType);
      };

      mediaSourceNode.connect(processorNode);
      processorNode.connect(muteGain);
      muteGain.connect(audioContext.destination);

      sourceStreamRef.current = sourceStream;
      audioContextRef.current = audioContext;
      mediaSourceNodeRef.current = mediaSourceNode;
      processorNodeRef.current = processorNode;
      muteGainNodeRef.current = muteGain;

      setIsListening(true);
    } catch (error) {
      if (localSourceStream) {
        for (const track of localSourceStream.getTracks()) {
          track.stop();
        }
      }
      setErrorMessage(getErrorMessage(error));
      handleStop();
    }
  };

  return (
    <main className="overlay-shell">
      <header className="drag-strip">
        <span className="drag-title">Live Subtitle</span>
      </header>

      <div className="controls-panel no-drag">
        <div className="controls-row">
          <span className={`status-dot status-${status}`} title={status} />
          <button type="button" className="btn btn-start" onClick={handleStart} disabled={isListening}>
            Start
          </button>
          <button type="button" className="btn btn-stop" onClick={handleStop} disabled={!isListening}>
            Stop
          </button>
          <div className="input-toggle" role="group" aria-label="Audio input mode">
            <button
              type="button"
              className={`mode-btn${inputMode === 'mic' ? ' active' : ''}`}
              onClick={() => setInputMode('mic')}
              disabled={isListening}
            >
              Mic
            </button>
            <button
              type="button"
              className={`mode-btn${inputMode === 'system' ? ' active' : ''}`}
              onClick={() => setInputMode('system')}
              disabled={isListening}
            >
              Sys
            </button>
          </div>
          <button
            type="button"
            className={`mode-btn${showDebug ? ' active' : ''}`}
            onClick={() => setShowDebug((prev) => !prev)}
          >
            Debug
          </button>
        </div>
      </div>

      <section className="caption-box">
        <p className="caption-line caption-ko">{koText || FALLBACK_KO}</p>
      </section>

      {errorMessage ? <p className="error-banner no-drag">{errorMessage}</p> : null}

      {showDebug ? (
        <section className="debug-box no-drag">
          {debugLines.length === 0 ? (
            <div className="debug-line">No debug events yet.</div>
          ) : (
            debugLines.map((line, index) => (
              <div key={`${index}-${line}`} className="debug-line">
                {line}
              </div>
            ))
          )}
        </section>
      ) : null}
    </main>
  );
}

export default App;
