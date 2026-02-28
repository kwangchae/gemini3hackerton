const { app, BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { GoogleGenAI, Modality } = require('@google/genai');

dotenv.config();

function isTruthy(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

const USE_VERTEX_AI =
  isTruthy(process.env.GOOGLE_GENAI_USE_VERTEXAI) ||
  isTruthy(process.env.USE_VERTEXAI) ||
  Boolean(process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.VERTEX_PROJECT_ID);

const VERTEX_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  process.env.VERTEX_PROJECT_ID;

const VERTEX_LOCATION =
  process.env.GOOGLE_CLOUD_LOCATION ||
  process.env.VERTEX_LOCATION ||
  'us-central1';

const GENAI_API_VERSION =
  process.env.GOOGLE_GENAI_API_VERSION ||
  process.env.GENAI_API_VERSION ||
  (USE_VERTEX_AI ? 'v1' : 'v1beta');

const PRIMARY_LIVE_MODEL = (process.env.GEMINI_LIVE_MODEL || (USE_VERTEX_AI ? 'gemini-2.0-flash-live-preview-04-09' : 'gemini-2.0-flash-live-001')).trim();
const FALLBACK_LIVE_MODEL = USE_VERTEX_AI
  ? 'gemini-live-2.5-flash-preview-native-audio-09-2025'
  : 'gemini-2.0-flash-live-001';
const TRANSLATION_MODEL = (process.env.GEMINI_TRANSLATION_MODEL || 'gemini-2.0-flash').trim();
const DEFAULT_AUDIO_MIME = 'audio/pcm;rate=16000';
const DEBUG_AUDIO_LOG_EVERY = Math.max(1, Number(process.env.DEBUG_AUDIO_LOG_EVERY || 5) || 5);
const DEBUG_SERVER_LOG_EVERY = Math.max(1, Number(process.env.DEBUG_SERVER_LOG_EVERY || 5) || 5);
const DEBUG_CAPTION_LOG_EVERY = Math.max(1, Number(process.env.DEBUG_CAPTION_LOG_EVERY || 3) || 3);
const PARTIAL_TRANSLATION_DEBOUNCE_MS = Math.max(60, Number(process.env.PARTIAL_TRANSLATION_DEBOUNCE_MS || 120) || 120);
const FINAL_TRANSLATION_DEBOUNCE_MS = Math.max(60, Number(process.env.FINAL_TRANSLATION_DEBOUNCE_MS || 90) || 90);
const PARTIAL_TRANSLATION_MIN_CHARS = Math.max(1, Number(process.env.PARTIAL_TRANSLATION_MIN_CHARS || 5) || 5);
const OUTPUT_STREAM_FALLBACK_DELAY_MS = Math.max(100, Number(process.env.OUTPUT_STREAM_FALLBACK_DELAY_MS || 700) || 700);
const MAX_TRANSLATION_CHARS = Math.max(80, Number(process.env.MAX_TRANSLATION_CHARS || 180) || 180);
const RUNTIME_MARKER = 'rt-fix-2026-02-28-1';
const SYSTEM_PROMPT = [
  'You are a live subtitle translator.',
  'The speaker language is English.',
  'Translate speech to natural Korean subtitles.',
  'Return only Korean translation text.',
  'Do not add labels, explanations, markdown, or extra commentary.'
].join(' ');

let mainWindow = null;
let ai = null;
let liveSession = null;
let sessionStarting = false;
let intentionalClose = false;
let activeLiveModel = PRIMARY_LIVE_MODEL;
let fallbackTried = false;
let queuedAudio = [];
let captionState = createCaptionState();
let fallbackTranslateTimer = null;
let translationJobSeq = 0;
let latestRequestedTranslationSeq = 0;
let latestAppliedTranslationSeq = 0;
let lastRequestedInputText = '';
let lastRequestedInputIsFinal = false;
let lastInputTranscriptionAtMs = 0;
let streamingKoText = '';
let receivedChunkCount = 0;
let sentChunkCount = 0;
let liveMessageCount = 0;
let captionEmitCount = 0;

function createCaptionState() {
  return {
    enText: '',
    koText: '',
    enFinal: false,
    koFinal: false
  };
}

function resetCaptionState() {
  captionState = createCaptionState();
  translationJobSeq = 0;
  latestRequestedTranslationSeq = 0;
  latestAppliedTranslationSeq = 0;
  lastRequestedInputText = '';
  lastRequestedInputIsFinal = false;
  lastInputTranscriptionAtMs = 0;
  streamingKoText = '';
}

function normalizeError(error) {
  if (!error) return 'Unknown Live API error.';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string') return error.message;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isModelSupportClose(event) {
  const reason = event && typeof event.reason === 'string' ? event.reason.toLowerCase() : '';
  if (!reason) return false;

  return (
    reason.includes('not found') ||
    reason.includes('not supported for bidigenera') ||
    reason.includes('not supported for bidigeneratecontent')
  );
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function emitStatus(status, message = '') {
  emit('live-status', {
    status,
    message,
    timestamp: new Date().toISOString()
  });
}

function emitError(message) {
  emit('live-error', {
    message,
    timestamp: new Date().toISOString()
  });
}

function emitDebug(stage, details = {}) {
  emit('live-debug', {
    stage,
    details,
    timestamp: new Date().toISOString()
  });
}

function shouldEmitDebugSample(count, interval) {
  return count === 1 || count % interval === 0;
}

function emitCaption(source, isFinal = false) {
  emit('live-caption', {
    enText: captionState.enText,
    koText: captionState.koText,
    isFinal,
    source,
    timestamp: new Date().toISOString()
  });

  captionEmitCount += 1;
  if (shouldEmitDebugSample(captionEmitCount, DEBUG_CAPTION_LOG_EVERY)) {
    emitDebug('caption-updated', {
      source,
      isFinal,
      enLength: (captionState.enText || '').length,
      koLength: (captionState.koText || '').length,
      enPreview: (captionState.enText || '').slice(0, 60),
      koPreview: (captionState.koText || '').slice(0, 60)
    });
  }
}

function getAiClient() {
  if (ai) return ai;

  if (USE_VERTEX_AI) {
    if (!VERTEX_PROJECT) {
      throw new Error(
        'Vertex mode requires GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT). ' +
        'Also run: gcloud auth application-default login'
      );
    }

    ai = new GoogleGenAI({
      vertexai: true,
      project: VERTEX_PROJECT,
      location: VERTEX_LOCATION,
      apiVersion: GENAI_API_VERSION
    });
    return ai;
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    const hasVertexApiKey =
      Boolean(process.env.VERTEX_API_KEY) ||
      Boolean(process.env.vertex_api_key);

    if (hasVertexApiKey) {
      throw new Error(
        'VERTEX_API_KEY is not valid for Live API auth. ' +
        'Use Gemini API key (GEMINI_API_KEY) or Vertex OAuth ' +
        '(GOOGLE_GENAI_USE_VERTEXAI=true, GOOGLE_CLOUD_PROJECT, ADC login).'
      );
    }

    throw new Error(
      'Missing API key in .env. Set GEMINI_API_KEY (or GOOGLE_API_KEY), ' +
      'or enable Vertex OAuth with GOOGLE_GENAI_USE_VERTEXAI=true and GOOGLE_CLOUD_PROJECT.'
    );
  }

  ai = new GoogleGenAI({ apiKey, apiVersion: GENAI_API_VERSION });
  return ai;
}

function isNativeAudioModel(modelName) {
  return typeof modelName === 'string' && modelName.toLowerCase().includes('native-audio');
}

function buildLiveConnectConfig(modelName) {
  const config = {
    inputAudioTranscription: {},
    systemInstruction: SYSTEM_PROMPT
  };

  if (isNativeAudioModel(modelName)) {
    return {
      ...config,
      responseModalities: [Modality.AUDIO],
      outputAudioTranscription: {}
    };
  }

  return {
    ...config,
    responseModalities: [Modality.TEXT]
  };
}

async function translateEnglishToKorean(text) {
  const sourceText = typeof text === 'string' ? text.trim() : '';
  if (!sourceText) return '';

  const client = getAiClient();
  const response = await client.models.generateContent({
    model: TRANSLATION_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              'Translate this English speech transcript into natural Korean subtitle text. ' +
              'Return Korean text only, no labels.\n\n' +
              sourceText
          }
        ]
      }
    ]
  });

  return extractTextFromGenerateContentResponse(response);
}

function extractTextFromGenerateContentResponse(response) {
  if (!response || !Array.isArray(response.candidates)) return '';

  for (const candidate of response.candidates) {
    const content = candidate && candidate.content;
    if (!content || !Array.isArray(content.parts)) continue;

    const text = content.parts
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();

    if (text) return text;
  }

  return '';
}

function getTextTailForTranslation(text, maxChars) {
  const normalized = typeof text === 'string' ? text.trim() : '';
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;

  const tail = normalized.slice(-maxChars * 2);
  const splitIndex = Math.max(
    tail.lastIndexOf('. '),
    tail.lastIndexOf('? '),
    tail.lastIndexOf('! '),
    tail.lastIndexOf('\n')
  );
  if (splitIndex >= 0 && tail.length - splitIndex <= maxChars + 32) {
    return tail.slice(splitIndex + 1).trim();
  }

  return normalized.slice(-maxChars).trim();
}

function appendKoreanStreamChunk(currentText, chunk) {
  const normalizedChunk = typeof chunk === 'string' ? chunk.replace(/\s+/g, ' ').trim() : '';
  if (!normalizedChunk) return currentText;

  // Ignore non-Korean chunks from synthesized audio transcripts.
  if (!/[가-힣]/.test(normalizedChunk)) return currentText;

  if (!currentText) return normalizedChunk;
  if (normalizedChunk.startsWith(currentText)) return normalizedChunk;
  if (currentText.endsWith(normalizedChunk)) return currentText;
  return `${currentText} ${normalizedChunk}`.replace(/\s+/g, ' ').trim();
}

async function runTranslationJob(job) {
  emitDebug('fallback-started', {
    seq: job.seq,
    enLength: job.text.length,
    isFinal: job.isFinal
  });

  try {
    const translated = await translateEnglishToKorean(job.text);
    if (!translated) {
      emitDebug('fallback-skipped', {
        reason: 'empty-translation',
        seq: job.seq
      });
      return;
    }

    if (job.seq < latestRequestedTranslationSeq) {
      emitDebug('fallback-skipped', {
        reason: 'outdated-seq',
        seq: job.seq,
        latestRequestedSeq: latestRequestedTranslationSeq
      });
      return;
    }

    if (job.seq < latestAppliedTranslationSeq) {
      emitDebug('fallback-skipped', {
        reason: 'older-than-applied',
        seq: job.seq,
        latestAppliedSeq: latestAppliedTranslationSeq
      });
      return;
    }

    if (captionState.koFinal) {
      emitDebug('fallback-skipped', {
        reason: 'live-api-already-final',
        seq: job.seq
      });
      return;
    }

    captionState.koText = translated;
    captionState.koFinal = Boolean(job.isFinal && captionState.enFinal);
    latestAppliedTranslationSeq = job.seq;
    emitCaption('model', captionState.enFinal && captionState.koFinal);
    emitDebug('fallback-success', {
      koLength: translated.length,
      enLength: job.text.length,
      seq: job.seq,
      isFinal: job.isFinal
    });
  } catch (error) {
    emitError(`Fallback translation failed: ${normalizeError(error)}`);
    emitDebug('fallback-failed', {
      error: normalizeError(error),
      seq: job.seq,
      isFinal: job.isFinal
    });
  }
}

function scheduleFallbackTranslation(englishText, options = {}) {
  const normalizedEn = typeof englishText === 'string' ? englishText.trim() : '';
  if (!normalizedEn) return;

  const isFinal = Boolean(options.isFinal);
  const sourceForTranslation = getTextTailForTranslation(normalizedEn, MAX_TRANSLATION_CHARS);
  if (!sourceForTranslation) return;

  if (!isFinal && normalizedEn.length < PARTIAL_TRANSLATION_MIN_CHARS) {
    emitDebug('fallback-skipped', {
      reason: 'too-short-partial',
      enLength: normalizedEn.length
    });
    return;
  }

  const isDuplicateInput = (
    sourceForTranslation === lastRequestedInputText &&
    (lastRequestedInputIsFinal || !isFinal)
  );
  if (isDuplicateInput) {
    emitDebug('fallback-skipped', {
      reason: 'duplicate-input',
      enLength: sourceForTranslation.length,
      isFinal
    });
    return;
  }

  if (normalizedEn.length > sourceForTranslation.length) {
    emitDebug('fallback-trimmed-input', {
      originalLength: normalizedEn.length,
      usedLength: sourceForTranslation.length
    });
  }

  lastRequestedInputText = sourceForTranslation;
  lastRequestedInputIsFinal = isFinal;

  const seq = ++translationJobSeq;
  latestRequestedTranslationSeq = seq;
  const debounceMs = isFinal ? FINAL_TRANSLATION_DEBOUNCE_MS : PARTIAL_TRANSLATION_DEBOUNCE_MS;

  if (fallbackTranslateTimer) {
    clearTimeout(fallbackTranslateTimer);
  }

  emitDebug('fallback-scheduled', {
    enLength: sourceForTranslation.length,
    seq,
    isFinal,
    debounceMs
  });

  fallbackTranslateTimer = setTimeout(() => {
    fallbackTranslateTimer = null;
    void runTranslationJob({
      seq,
      text: sourceForTranslation,
      isFinal
    });
  }, debounceMs);
}

function sendAudioToSession(chunk, mimeType) {
  if (!liveSession) return;

  try {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const normalizedMime = (typeof mimeType === 'string' && mimeType.startsWith('audio/'))
      ? mimeType
      : DEFAULT_AUDIO_MIME;

    liveSession.sendRealtimeInput({
      audio: {
        data: buffer.toString('base64'),
        mimeType: normalizedMime
      }
    });
    sentChunkCount += 1;
    if (shouldEmitDebugSample(sentChunkCount, DEBUG_AUDIO_LOG_EVERY)) {
      emitDebug('audio-sent', {
        sentChunkCount,
        mimeType: normalizedMime,
        bytes: buffer.length
      });
    }
  } catch (error) {
    emitError(normalizeError(error));
    emitDebug('audio-send-failed', { error: normalizeError(error) });
  }
}

function flushQueuedAudio() {
  if (!liveSession || queuedAudio.length === 0) return;

  const pending = queuedAudio;
  queuedAudio = [];

  for (const item of pending) {
    sendAudioToSession(item.chunk, item.mimeType);
  }
}

function handleLiveServerMessage(message) {
  liveMessageCount += 1;
  const serverContent = message && message.serverContent ? message.serverContent : null;
  if (!serverContent) return;

  if (shouldEmitDebugSample(liveMessageCount, DEBUG_SERVER_LOG_EVERY)) {
    const inputText = serverContent.inputTranscription && typeof serverContent.inputTranscription.text === 'string'
      ? serverContent.inputTranscription.text : '';
    const outputText = serverContent.outputTranscription && typeof serverContent.outputTranscription.text === 'string'
      ? serverContent.outputTranscription.text : '';
    const modelTurnText = serverContent.modelTurn && Array.isArray(serverContent.modelTurn.parts)
      ? serverContent.modelTurn.parts.filter(p => p && typeof p.text === 'string').map(p => p.text).join('') : '';
    emitDebug('server-message', {
      liveMessageCount,
      hasInputTranscription: Boolean(inputText),
      hasOutputTranscription: Boolean(outputText),
      hasModelTurn: Boolean(modelTurnText),
      inputPreview: inputText ? inputText.replace(/\s+/g, ' ').slice(0, 80) : '',
      outputPreview: outputText ? outputText.replace(/\s+/g, ' ').slice(0, 80) : '',
      modelTurnPreview: modelTurnText ? modelTurnText.replace(/\s+/g, ' ').slice(0, 80) : '',
      turnComplete: Boolean(serverContent.turnComplete),
      generationComplete: Boolean(serverContent.generationComplete)
    });
  }

  const transcription = serverContent.inputTranscription;
  if (transcription && typeof transcription.text === 'string') {
    if (captionState.enFinal && captionState.koFinal) {
      resetCaptionState();
    }

    lastInputTranscriptionAtMs = Date.now();
    streamingKoText = '';
    captionState.enText = transcription.text;
    captionState.enFinal = Boolean(transcription.finished);
    emitCaption('input', captionState.enFinal && captionState.koFinal);
    scheduleFallbackTranslation(transcription.text, { isFinal: Boolean(transcription.finished) });
  }

  const modelTurn = serverContent.modelTurn;
  if (modelTurn && Array.isArray(modelTurn.parts)) {
    for (const part of modelTurn.parts) {
      if (part && typeof part.text === 'string' && part.text) {
        streamingKoText = streamingKoText ? streamingKoText + part.text : part.text.trim();
        captionState.koText = streamingKoText;
        captionState.koFinal = false;
        emitCaption('model', false);
      }
    }
  }

  const outputTranscription = serverContent.outputTranscription;
  if (outputTranscription && typeof outputTranscription.text === 'string') {
    const sinceInputMs = Date.now() - lastInputTranscriptionAtMs;
    if (sinceInputMs >= OUTPUT_STREAM_FALLBACK_DELAY_MS && !captionState.koFinal) {
      const nextStreamText = appendKoreanStreamChunk(streamingKoText, outputTranscription.text);
      if (nextStreamText && nextStreamText !== streamingKoText) {
        streamingKoText = nextStreamText;
        captionState.koText = nextStreamText;
        captionState.koFinal = false;
        emitCaption('model', false);
        emitDebug('output-stream-applied', {
          koLength: nextStreamText.length,
          sinceInputMs
        });
      }
    }
  }

  if (serverContent.turnComplete || serverContent.generationComplete) {
    const koTrimmed = (captionState.koText || '').trim();
    const enLen = (captionState.enText || '').trim().length;
    const koIsPlausible = koTrimmed.length >= 2 && (enLen === 0 || koTrimmed.length >= Math.min(enLen * 0.3, 6));
    if (koTrimmed && koIsPlausible) {
      captionState.koFinal = true;
      emitCaption('model', captionState.enFinal && captionState.koFinal);
    } else {
      emitDebug('turn-complete-without-ko', {
        enLength: enLen,
        koLength: koTrimmed.length
      });
    }
  }

  if (serverContent.interrupted) {
    if ((captionState.koText || '').trim()) {
      captionState.koFinal = true;
      emitCaption('model', true);
    }
  }
}

async function startLiveSession() {
  if (liveSession || sessionStarting) return;

  sessionStarting = true;
  intentionalClose = false;
  const authMode = USE_VERTEX_AI ? 'Vertex OAuth' : 'API Key';
  emitStatus('connecting', `Connecting (${authMode}, ${activeLiveModel})...`);
  emitDebug('session-starting', {
    authMode,
    model: activeLiveModel,
    apiVersion: GENAI_API_VERSION,
    vertexProject: USE_VERTEX_AI ? VERTEX_PROJECT : undefined,
    vertexLocation: USE_VERTEX_AI ? VERTEX_LOCATION : undefined,
    runtimeMarker: RUNTIME_MARKER,
    useModelOutputTranslation: false,
    enableSessionPrime: false
  });

  try {
    const client = getAiClient();
    resetCaptionState();
    receivedChunkCount = 0;
    sentChunkCount = 0;
    liveMessageCount = 0;

    liveSession = await client.live.connect({
      model: activeLiveModel,
      config: buildLiveConnectConfig(activeLiveModel),
      callbacks: {
        onopen: () => {
          fallbackTried = false;
          emitStatus('ready', 'Live session connected.');
          emitDebug('session-open', { model: activeLiveModel });

          flushQueuedAudio();
        },
        onmessage: (message) => {
          try {
            handleLiveServerMessage(message);
          } catch (error) {
            emitError(normalizeError(error));
          }
        },
        onerror: (error) => {
          emitStatus('error', 'Live session error.');
          emitError(normalizeError(error));
          emitDebug('session-error', { error: normalizeError(error) });
        },
        onclose: (event) => {
          const wasIntentional = intentionalClose;
          intentionalClose = false;
          liveSession = null;
          queuedAudio = [];
          const shouldFallback = (
            !wasIntentional &&
            !fallbackTried &&
            activeLiveModel !== FALLBACK_LIVE_MODEL &&
            isModelSupportClose(event)
          );

          if (shouldFallback) {
            fallbackTried = true;
            activeLiveModel = FALLBACK_LIVE_MODEL;
            emitStatus('connecting', `Model unavailable. Retrying with ${activeLiveModel}...`);
            emitDebug('session-fallback', {
              toModel: activeLiveModel,
              reason: event && typeof event.reason === 'string' ? event.reason : ''
            });
            startLiveSession();
            return;
          }

          if (!wasIntentional) {
            const code = event && typeof event.code === 'number' ? event.code : undefined;
            const reason = event && typeof event.reason === 'string' ? event.reason : '';
            const detail = code ? ` (code: ${code}${reason ? `, reason: ${reason}` : ''})` : '';
            emitError(`Live session closed unexpectedly${detail}.`);
          }
          emitDebug('session-closed', {
            code: event && typeof event.code === 'number' ? event.code : undefined,
            reason: event && typeof event.reason === 'string' ? event.reason : '',
            intentional: wasIntentional
          });
          emitStatus(wasIntentional ? 'idle' : 'closed', wasIntentional ? 'Live session stopped.' : 'Live session closed.');
        }
      }
    });

    if (liveSession) {
      emitDebug('session-prime-skipped', { reason: 'disabled-hardcoded' });
      flushQueuedAudio();
    }
  } catch (error) {
    liveSession = null;
    queuedAudio = [];
    emitStatus('error', 'Failed to start live session.');
    emitError(normalizeError(error));
    emitDebug('session-start-failed', { error: normalizeError(error) });
  } finally {
    sessionStarting = false;
  }
}

function stopLiveSession() {
  if (!liveSession) {
    intentionalClose = false;
    queuedAudio = [];
    if (fallbackTranslateTimer) {
      clearTimeout(fallbackTranslateTimer);
      fallbackTranslateTimer = null;
    }
    translationJobSeq = 0;
    latestRequestedTranslationSeq = 0;
    latestAppliedTranslationSeq = 0;
    lastRequestedInputText = '';
    lastRequestedInputIsFinal = false;
    lastInputTranscriptionAtMs = 0;
    streamingKoText = '';
    emitStatus('idle', 'Live session stopped.');
    return;
  }

  intentionalClose = true;

  try {
    liveSession.sendRealtimeInput({ audioStreamEnd: true });
  } catch {
    // Ignore transport shutdown race conditions.
  }

  try {
    liveSession.close();
  } catch {
    // Ignore close errors.
  }

  liveSession = null;
  queuedAudio = [];
  if (fallbackTranslateTimer) {
    clearTimeout(fallbackTranslateTimer);
    fallbackTranslateTimer = null;
  }
  translationJobSeq = 0;
  latestRequestedTranslationSeq = 0;
  latestAppliedTranslationSeq = 0;
  lastRequestedInputText = '';
  lastRequestedInputIsFinal = false;
  lastInputTranscriptionAtMs = 0;
  streamingKoText = '';
  activeLiveModel = PRIMARY_LIVE_MODEL;
  fallbackTried = false;
  emitDebug('session-stopped', {});
  emitStatus('idle', 'Live session stopped.');
}

function getRendererEntry() {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    return { type: 'url', target: devServerUrl };
  }

  const distEntry = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(distEntry)) {
    return { type: 'file', target: distEntry };
  }

  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 280,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const entry = getRendererEntry();

  if (entry) {
    if (entry.type === 'url') {
      mainWindow.loadURL(entry.target);
    } else {
      mainWindow.loadFile(entry.target);
    }
  } else {
    const fallbackHtml = '<html><body style="background:#111;color:#fff;font-family:sans-serif;padding:20px;">Build output not found. Run <code>npm run dev</code> or <code>npm run build</code>.</body></html>';
    mainWindow.loadURL(`data:text/html,${encodeURIComponent(fallbackHtml)}`);
  }

  mainWindow.on('closed', () => {
    stopLiveSession();
    mainWindow = null;
  });
}

ipcMain.handle('live-session-start', async () => {
  await startLiveSession();
  return { ok: Boolean(liveSession) };
});

ipcMain.on('live-audio-chunk', (_event, payload) => {
  const chunk = payload && payload.chunk !== undefined ? payload.chunk : payload;
  const mimeType = payload && payload.mimeType ? payload.mimeType : DEFAULT_AUDIO_MIME;

  if (!chunk) return;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  receivedChunkCount += 1;
  if (shouldEmitDebugSample(receivedChunkCount, DEBUG_AUDIO_LOG_EVERY)) {
    emitDebug('audio-received', {
      receivedChunkCount,
      mimeType,
      bytes: buffer.length
    });
  }

  if (!liveSession) {
    // Avoid rapid reconnect loops when the session is closed by server-side errors.
    queuedAudio = [];
    emitDebug('audio-dropped-no-session', {
      receivedChunkCount
    });
    return;
  }

  sendAudioToSession(buffer, mimeType);
});

ipcMain.on('live-session-end', () => {
  stopLiveSession();
});

ipcMain.handle('desktop-source-id', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window']
  });

  if (!sources.length) {
    throw new Error('No desktop capture source is available.');
  }

  const preferredScreen = sources.find((source) => source.id.startsWith('screen:'));
  const selected = preferredScreen || sources[0];

  return {
    id: selected.id,
    name: selected.name
  };
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  stopLiveSession();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
