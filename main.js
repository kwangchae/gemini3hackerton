const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const dotenv = require('dotenv');
const { GoogleGenAI } = require('@google/genai');

dotenv.config();

let ai = null;
if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 180,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // win.setIgnoreMouseEvents(true); // 마우스 클릭 통과 옵션

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 프론트엔드에서 녹음 시작 시 API 키 체크
ipcMain.on('audio-stream-start', (event) => {
  if (!ai) {
    if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "여기에_GEMINI_API_KEY를_입력하세요") {
      ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    } else {
      event.reply('error', 'GEMINI_API_KEY가 설정되지 않았습니다 (.env 파일 확인).');
      return;
    }
  }
});

// 프론트엔드에서 3초 단위로 오디오(WebM) 조각을 받아옴
ipcMain.on('audio-stream-data', async (event, chunk) => {
  if (!ai) return;

  try {
    // ArrayBuffer -> Base64 변환
    const base64Audio = Buffer.from(chunk).toString('base64');

    // Gemini 1.5 Flash에 음성 파일 전송 및 JSON 형태 응답 요청
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: 'audio/webm',
                data: base64Audio
              }
            },
            {
              text: "이 오디오를 듣고 텍스트를 파악해 줘. 말소리가 명확하다면 한국어 원문(ko)과 영어 번역본(en)을 작성해. 만약 잡음이나 침묵만 있다면 ko와 en의 값을 빈 문자열로 해."
            }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            ko: { type: "STRING" },
            en: { type: "STRING" }
          }
        }
      }
    });

    const resultText = response.text;
    const parsed = JSON.parse(resultText);

    // 텍스트가 존재할 경우에만 화면 갱신
    if (parsed.ko || parsed.en) {
      if (parsed.ko) event.reply('transcript-result', { text: parsed.ko, isFinal: true });
      if (parsed.en) event.reply('translation-result', { text: parsed.en, isFinal: true });
    }

  } catch (error) {
    console.error('Gemini API Error:', error);
    // API 한도 초과 등 명확한 에러 발생 시 프론트에 알림
    if (error.message.includes('403') || error.message.includes('429')) {
      event.reply('error', 'Gemini API 호출 에러: ' + error.message);
    }
  }
});

ipcMain.on('audio-stream-end', () => {
  // 별도의 자원 정리가 필요 없음
});
