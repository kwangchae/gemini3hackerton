# Repository Guidelines

## Project Structure & Module Organization
- Root Electron runtime files are the source of truth for the app flow:
  - `main.js`: Electron main process, Gemini API calls, and IPC handlers.
  - `preload.js`: secure renderer bridge (`contextBridge`).
  - `renderer.js`, `index.html`, `style.css`: overlay UI and microphone capture loop.
- IPC test utilities live at the root: `test-ipc.js`, `test-ipc-isolated.js`, `preload-test.js`.
- `src/` and `public/` contain Vite React starter files and are currently not launched by `npm start`.
- Keep secrets in `.env` (for example `GEMINI_API_KEY`); never commit credentials.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm start`: run the Electron app (`electron .`) using `main.js`.
- `npx electron test-ipc.js`: run legacy IPC serialization smoke test.
- `npx electron test-ipc-isolated.js`: run context-isolated IPC bridge test.
- Recommended runtime: Node.js 20+ (required by `@google/genai`).

## Coding Style & Naming Conventions
- Use 2-space indentation.
- In root runtime scripts, follow existing CommonJS style: `require`, single quotes, semicolons.
- Use `camelCase` for variables/functions and `PascalCase` only for React component names.
- Keep IPC channel names kebab-case (example: `audio-stream-data`, `translation-result`).
- Keep preload APIs minimal: expose only methods required by the renderer.

## Testing Guidelines
- No Jest/Vitest suite is configured yet; use the Electron test scripts plus manual verification.
- For feature changes, validate:
  1. App starts with valid `.env`.
  2. Start/stop recording works without crashes.
  3. Transcript and translation updates appear in the overlay.
  4. Missing API key path shows a user-visible error.
- Name any new ad-hoc scripts as `test-*.js`.

## Commit & Pull Request Guidelines
- Current history is minimal (`Initial commit: Gemini Desktop Subtitle App`); keep commit messages short, imperative, and specific.
- Prefer one logical change per commit.
- PRs should include: purpose, key changes, manual test evidence (commands + results), and screenshots/video for UI updates.

## Security & Configuration Tips
- Keep `contextIsolation: true` and `nodeIntegration: false` for renderer security.
- Do not log API keys or raw audio payloads in production logs.
