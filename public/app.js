const API_URL = window.location.origin + '/api';

let currentSessionId = null;
let currentScenario = null;
let currentTranscript = [];
let isRecording = false;
let speechSynthesis = window.speechSynthesis;

// STT state
let sttMode = null; // 'whisper' or 'browser'
let mediaStream = null;
let mediaRecorder = null;
let audioChunks = [];

// Browser STT fallback (only initialized if whisper is unavailable)
let recognition = null;
let lastRecognizedText = '';

// ---- STT Mode Detection ----

async function detectSttMode() {
  try {
    const res = await fetch(`${API_URL}/stt-status`);
    const status = await res.json();
    if (status.whisperAvailable) {
      sttMode = 'whisper';
      console.log('STT mode: whisper.cpp (server-side)');
      updateSttBadge();
      return;
    }
  } catch (err) {
    console.warn('Could not check STT status:', err);
  }

  // Fallback to browser speech recognition
  sttMode = 'browser';
  console.log('STT mode: browser SpeechRecognition (fallback)');
  updateSttBadge();
}

function updateSttBadge() {
  const badge = document.getElementById('stt-mode-badge');
  if (!badge) return;

  badge.classList.remove('hidden', 'whisper', 'browser');
  if (sttMode === 'whisper') {
    badge.textContent = 'STT: whisper.cpp (server)';
    badge.classList.add('whisper');
  } else {
    badge.textContent = 'STT: browser speech recognition (fallback)';
    badge.classList.add('browser');
  }
}

// ---- Whisper Mode: MediaRecorder ----

async function startWhisperRecording() {
  try {
    audioChunks = [];
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mediaStream, {
      mimeType: getSupportedMimeType(),
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.start();
    setStatus('Listening...');
  } catch (err) {
    console.error('Failed to start audio recording:', err);
    setStatus('Microphone access denied');

    // If mic access fails, try falling back to browser STT
    sttMode = 'browser';
    updateSttBadge();
    initBrowserSpeechRecognition();
    startBrowserRecording();
  }
}

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return ''; // let browser pick default
}

async function stopWhisperRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    return;
  }

  return new Promise((resolve) => {
    mediaRecorder.onstop = async () => {
      // Stop all tracks on the media stream
      if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
      }

      if (audioChunks.length === 0) {
        setStatus('');
        resolve();
        return;
      }

      const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      audioChunks = [];

      setStatus('Transcribing...');

      try {
        const text = await transcribeAudio(audioBlob);
        if (text && text.trim()) {
          sendMessage(text.trim());
        } else {
          setStatus('No speech detected. Try again.');
          setTimeout(() => setStatus(''), 2000);
        }
      } catch (err) {
        console.error('Transcription failed:', err);

        // If whisper fails at runtime, offer fallback
        if (err.status === 503) {
          console.warn('Whisper became unavailable, switching to browser STT fallback');
          sttMode = 'browser';
          updateSttBadge();
          setStatus('Whisper unavailable. Switched to browser speech recognition.');
          setTimeout(() => setStatus(''), 3000);
        } else {
          setStatus('Transcription error. Try again.');
          setTimeout(() => setStatus(''), 2000);
        }
      }

      resolve();
    };

    mediaRecorder.stop();
  });
}

async function transcribeAudio(audioBlob) {
  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');

  const response = await fetch(`${API_URL}/transcribe`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const err = new Error('Transcription request failed');
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  return data.text;
}

// ---- Browser Speech Recognition Fallback ----

function initBrowserSpeechRecognition() {
  if (recognition) return; // already initialized

  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    console.warn('Browser SpeechRecognition not available in this browser.');
    // Only alert if there's truly no STT option at all
    if (sttMode !== 'whisper') {
      setStatus('Browser speech recognition not supported. Server-side whisper is also unavailable.');
    }
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    setStatus('Listening...');
  };

  recognition.onresult = (event) => {
    lastRecognizedText = Array.from(event.results)
      .map(r => r[0].transcript)
      .join('');
    setStatus(`Heard: ${lastRecognizedText}`);
  };

  recognition.onend = () => {};

  recognition.onerror = (e) => {
    console.error('Speech error:', e);
  };
}

function startBrowserRecording() {
  if (!recognition) {
    initBrowserSpeechRecognition();
  }
  if (!recognition) return; // browser doesn't support it

  lastRecognizedText = '';
  recognition.start();
}

function stopBrowserRecording() {
  if (!recognition) return;

  recognition.stop();

  const text = lastRecognizedText.trim();
  lastRecognizedText = '';

  if (text) {
    sendMessage(text);
  }
  setStatus('');
}

// ---- Unified Recording Controls ----

function startRecording() {
  if (sttMode === 'whisper') {
    startWhisperRecording();
  } else {
    // Lazy-init browser speech recognition only when actually falling back
    if (!recognition) {
      initBrowserSpeechRecognition();
    }
    if (recognition) {
      startBrowserRecording();
    } else {
      setStatus('No speech recognition available. Set up whisper on the server, or use Chrome/Edge.');
    }
  }
}

async function stopRecording() {
  if (sttMode === 'whisper') {
    await stopWhisperRecording();
  } else {
    stopBrowserRecording();
  }
}

// ---- Scenarios & Session ----

async function loadScenarios() {
  const response = await fetch(`${API_URL}/scenarios`);
  const scenarios = await response.json();

  const list = document.getElementById('scenarios-list');
  list.innerHTML = scenarios.map(s => `
    <div class="scenario-card" data-id="${s.id}">
      <h3>${s.name}</h3>
      <p>${s.description}</p>
    </div>
  `).join('');

  list.querySelectorAll('.scenario-card').forEach(card => {
    card.addEventListener('click', () => startSession(card.dataset.id));
  });
}

async function startSession(scenarioId) {
  // Detect STT mode before starting the session
  await detectSttMode();

  const response = await fetch(`${API_URL}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId })
  });

  const { sessionId, scenario, transcript } = await response.json();
  currentSessionId = sessionId;
  currentScenario = scenario;
  currentTranscript = transcript;

  document.getElementById('scenario-select').classList.add('hidden');
  document.getElementById('conversation').classList.remove('hidden');

  displayTranscript(currentTranscript);
  speak(scenario.initialMessage);
}

// ---- Transcript ----

function displayTranscript(messages) {
  const container = document.getElementById('transcript');
  container.innerHTML = messages.map(m => `
    <div class="message ${m.role}">
      <strong>${m.role === 'user' ? 'You' : 'AI'}</strong>
      ${m.content}
    </div>
  `).join('');

  container.scrollTop = container.scrollHeight;
}

// ---- Conversation ----

async function sendMessage(text) {
  setStatus('Processing...');

  currentTranscript.push({ role: 'user', content: text });
  displayTranscript(currentTranscript);

  try {
    const response = await fetch(`${API_URL}/conversation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario: currentScenario,
        transcript: currentTranscript.slice(0, -1),
        message: text
      })
    });

    const { response: aiResponse } = await response.json();

    currentTranscript.push({ role: 'assistant', content: aiResponse });
    displayTranscript(currentTranscript);

    await fetch(`${API_URL}/sessions/${currentSessionId}/transcript`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: currentTranscript })
    });

    speak(aiResponse);
  } catch (error) {
    console.error('Error:', error);
    setStatus('Error processing message');
  }
}

// ---- TTS ----

function speak(text) {
  setStatus('Speaking...');

  fetch(`${API_URL}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  })
  .then(res => res.json())
  .then(data => {
    if (data.audio) {
      const audio = new Audio(`data:audio/mpeg;base64,${data.audio}`);
      audio.onended = () => setStatus('');
      audio.onerror = () => {
        browserSpeak(text);
      };
      audio.play();
    } else {
      browserSpeak(text);
    }
  })
  .catch(() => {
    browserSpeak(text);
  });
}

function browserSpeak(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  utterance.onend = () => setStatus('');
  utterance.onerror = () => setStatus('');
  speechSynthesis.speak(utterance);
}

// ---- End / Analyze ----

async function endConversation() {
  setStatus('Analyzing conversation...');

  try {
    const response = await fetch(`${API_URL}/sessions/${currentSessionId}/analyze`, {
      method: 'POST'
    });

    const analysis = await response.json();

    document.getElementById('conversation').classList.add('hidden');
    document.getElementById('results').classList.remove('hidden');

    console.log('Analysis:', analysis);
  } catch (error) {
    console.error('Analysis error:', error);
    setStatus('Error analyzing conversation');
  }
}

// ---- UI ----

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

// Record button - toggle start/stop
document.getElementById('record-btn').addEventListener('click', async () => {
  if (isRecording) {
    isRecording = false;
    document.getElementById('record-btn').classList.remove('recording');
    document.getElementById('record-btn').textContent = 'Start Speaking';
    await stopRecording();
  } else {
    isRecording = true;
    document.getElementById('record-btn').classList.add('recording');
    document.getElementById('record-btn').textContent = 'Stop Speaking';
    startRecording();
  }
});

document.getElementById('end-btn').addEventListener('click', endConversation);

document.getElementById('new-btn').addEventListener('click', () => {
  location.reload();
});

loadScenarios();
