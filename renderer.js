let mediaRecorder;
let audioStream;
let isRecording = false;

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const originalTextEl = document.getElementById('originalText');
const translatedTextEl = document.getElementById('translatedText');

// 3초 단위로 끊어서 녹음 후 전송하는 함수
async function recordChunk() {
  if (!isRecording) return;
  
  // MediaRecorder를 매번 새로 생성하여 완벽한 WebM 헤더가 포함된 덩어리를 생성
  mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm;codecs=opus' });
  
  mediaRecorder.ondataavailable = async (e) => {
    if (e.data.size > 0) {
      const arrayBuffer = await e.data.arrayBuffer();
      window.electronAPI.sendAudioData(arrayBuffer);
    }
  };

  mediaRecorder.start();
  
  // 3초 후 녹음 중지. 중지 시 ondataavailable 이벤트가 발생하여 메인 프로세스로 데이터가 넘어감
  setTimeout(() => {
    if (mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    // 사용자가 정지하지 않았다면 다음 3초 청크 다시 시작
    if (isRecording) {
      recordChunk();
    }
  }, 3000);
}

startBtn.addEventListener('click', async () => {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // 키 체크 요청
    window.electronAPI.startAudioStream();
    
    isRecording = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    originalTextEl.textContent = '듣는 중 (약 3초 간격 갱신)...';
    translatedTextEl.textContent = 'Listening...';

    // 3초 단위 녹음 루프 시작
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
