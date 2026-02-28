# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Gemini Desktop Subtitle App — an Electron desktop app that captures microphone or system audio, streams it to the Gemini Live API, and overlays real-time English transcription + Korean translation as a transparent always-on-top window.

## Commands

```bash
npm install          # install dependencies (Node.js 20+ required)
npm run dev          # dev mode: Vite dev server + Electron (hot reload)
npm run build        # build React UI into dist/
npm start            # run Electron (loads dist/ or falls back to error page)
npm run typecheck    # tsc type-check only (no emit)
npm run lint         # eslint
npx electron test-ipc.js           # legacy IPC serialization smoke test
npx electron test-ipc-isolated.js  # context-isolated IPC bridge test
```

## Architecture

### Process Separation

This is a standard Electron app with three distinct layers:

**Main process** (`main.js`) — CommonJS, Node.js. Owns the Gemini API client, the WebSocket Live session, and all IPC handlers. Never directly touches the DOM.

**Preload** (`preload.js`) — CommonJS. Runs in renderer context but with Node access. Exposes `window.electronAPI` via `contextBridge` as the only communication channel. `contextIsolation: true`, `nodeIntegration: false`.

**Renderer** (`src/`) — Vite + React + TypeScript. A frameless transparent overlay. Accesses Electron only through `window.electronAPI`. **Note:** the root-level `renderer.js` and `style.css` are an older unused implementation; the active UI is the React app under `src/`.

### IPC Channels

| Direction | Channel | Type | Purpose |
|---|---|---|---|
| Renderer → Main | `live-session-start` | invoke | Start Gemini Live session |
| Renderer → Main | `live-audio-chunk` | send | Stream raw audio PCM |
| Renderer → Main | `live-session-end` | send | Stop session |
| Renderer → Main | `desktop-source-id` | invoke | Get screen capture source ID |
| Main → Renderer | `live-caption` | emit | EN+KO subtitle update |
| Main → Renderer | `live-status` | emit | Connection status |
| Main → Renderer | `live-error` | emit | Error notifications |
| Main → Renderer | `live-debug` | emit | Debug event stream |

The typed wrapper for renderer-side IPC is `src/lib/electronApi.ts`; types are in `src/types/electron.d.ts`.

### Translation Strategy

Two paths are used concurrently:

1. **Native audio model path** (primary): `gemini-live-2.5-flash-native-audio` — model receives PCM audio and outputs Korean via `outputTranscription`. Korean chunks are filtered by `/[가-힣]/` to reject non-Korean fragments.

2. **Fallback translation path**: When using non-native-audio Live models, `inputTranscription` gives English text, which is then sent to `TRANSLATION_MODEL` (`gemini-2.5-flash`) as a separate `generateContent` call with debouncing. Fallback also auto-activates if the primary model is unavailable (automatic model fallback to `gemini-2.0-flash-live-001`).

### Audio Pipeline (Renderer)

`AudioContext` at 16 kHz → `MediaStreamAudioSourceNode` → `ScriptProcessorNode` (2048 buffer) → converts to PCM16 mono via `audioBufferToPcm16Chunk()` → sends `audio/pcm;rate=16000` chunks via IPC. A muted `GainNode` is connected to the destination to keep the context active.

Input modes: `mic` (getUserMedia) or `system` (getDisplayMedia with audio, falling back to desktopCapturer if unsupported).

## Environment Variables

Store in `.env` (never commit). See `main.js` top section for all tuneable variables.

Required (pick one auth path):
- `GEMINI_API_KEY` or `GOOGLE_API_KEY` — Gemini API key
- `GOOGLE_GENAI_USE_VERTEXAI=true` + `GOOGLE_CLOUD_PROJECT` — Vertex AI OAuth (requires `gcloud auth application-default login`)

Optional model overrides:
- `GEMINI_LIVE_MODEL` — primary Live model (default: `gemini-live-2.5-flash-native-audio`)
- `GEMINI_TRANSLATION_MODEL` — fallback translation model (default: `gemini-2.5-flash`)

## Coding Conventions

- Root runtime files (`main.js`, `preload.js`): CommonJS (`require`), single quotes, semicolons, 2-space indent.
- `src/` React code: TypeScript, standard Vite/React patterns.
- IPC channel names: kebab-case (e.g., `live-audio-chunk`).
- Preload APIs: expose only what the renderer strictly needs.
- New ad-hoc test scripts: name as `test-*.js` at root.
