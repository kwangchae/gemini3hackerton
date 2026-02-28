const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const originalTextEl = document.getElementById('originalText');
const translatedTextEl = document.getElementById('translatedText');

let mediaRecorder;
let audioStream;
let isRecording = false;

// 1.5초 단위로 끊어서 녹음 후 전송하는 함수 (기존 3초에서 단축하여 속도 증가)
async function recordChunk() {
  if (!isRecording) return;
  
  mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm;codecs=opus' });
  
  mediaRecorder.ondataavailable = async (e) => {
    if (e.data.size > 0) {
      const arrayBuffer = await e.data.arrayBuffer();
      window.electronAPI.sendAudioData(arrayBuffer);
    }
  };

  mediaRecorder.start();
  
  // 1.5초 후 녹음 중지 (빠른 인식)
  setTimeout(() => {
    if (mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    if (isRecording) {
      recordChunk();
    }
  }, 1500);
}

startBtn.addEventListener('click', async () => {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // 키 체크 요청
    window.electronAPI.startAudioStream();
    
    isRecording = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    originalTextEl.textContent = '듣는 중... (빠른 인식 모드)';
    translatedTextEl.textContent = 'Listening...';

    // 1.5초 단위 녹음 루프 시작
    recordChunk();

  } catch (err) {
    console.error('마이크 접근 오류:', err);
    alert('마이크 접근 권한이 필요합니다: ' + err.message);
  }
});

stopBtn.addEventListener('click', () => {
  isRecording = false;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
  }
  
  window.electronAPI.endAudioStream();

  startBtn.disabled = false;
  stopBtn.disabled = true;
  originalTextEl.textContent = '대기 중...';
  translatedTextEl.textContent = 'Waiting...';
});

// 메인 프로세스에서 받은 원본(한국어) 텍스트 업데이트
window.electronAPI.onTranscriptResult((data) => {
  originalTextEl.textContent = data.text;
  originalTextEl.style.color = '#7bed9f'; 
  setTimeout(() => { originalTextEl.style.color = '#ffffff'; }, 1500);
});

// 메인 프로세스에서 받은 번역(영어) 텍스트 업데이트
window.electronAPI.onTranslationResult((data) => {
  translatedTextEl.textContent = data.text;
});

// 에러 처리
window.electronAPI.onError((err) => {
  console.error('API Error:', err);
  originalTextEl.textContent = 'API 연결 오류 발생';
  translatedTextEl.textContent = err;
  
  if (isRecording) {
    stopBtn.click();
  }
});
