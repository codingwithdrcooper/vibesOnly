const API_URL = 'http://localhost:3000/api';

let currentSessionId = null;
let currentScenario = null;
let isRecording = false;
let recognition = null;
let speechSynthesis = window.speechSynthesis;

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
  const response = await fetch(`${API_URL}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId })
  });
  
  const { sessionId, scenario, transcript } = await response.json();
  currentSessionId = sessionId;
  currentScenario = scenario;
  
  document.getElementById('scenario-select').classList.add('hidden');
  document.getElementById('conversation').classList.remove('hidden');
  
  displayTranscript(transcript);
  speak(scenario.initialMessage);
  initSpeechRecognition();
}

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

function initSpeechRecognition() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    alert('Speech recognition not supported in this browser. Please use Chrome or Edge.');
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
    const transcript = Array.from(event.results)
      .map(r => r[0].transcript)
      .join('');
    
    setStatus(`Heard: ${transcript}`);
  };
  
  recognition.onend = () => {
    setStatus('');
  };
  
  recognition.onerror = (e) => {
    console.error('Speech recognition error:', e);
    setStatus('Error listening');
  };
}

async function sendMessage(text) {
  setStatus('Processing...');
  
  const transcript = getCurrentTranscript();
  transcript.push({ role: 'user', content: text });
  displayTranscript(transcript);
  
  try {
    const response = await fetch(`${API_URL}/conversation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario: currentScenario,
        transcript: transcript.slice(0, -1),
        message: text
      })
    });
    
    const { response: aiResponse } = await response.json();
    
    transcript.push({ role: 'assistant', content: aiResponse });
    displayTranscript(transcript);
    
    await fetch(`${API_URL}/sessions/${currentSessionId}/transcript`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript })
    });
    
    speak(aiResponse);
  } catch (error) {
    console.error('Error:', error);
    setStatus('Error processing message');
  }
}

function getCurrentTranscript() {
  const container = document.getElementById('transcript');
  const messages = container.querySelectorAll('.message');
  const transcript = [];
  
  messages.forEach(msg => {
    const role = msg.classList.contains('user') ? 'user' : 'assistant';
    const content = msg.textContent.replace(/^(You|AI)\s*/, '');
    transcript.push({ role, content });
  });
  
  return transcript;
}

function speak(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  speechSynthesis.speak(utterance);
}

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

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

document.getElementById('record-btn').addEventListener('mousedown', () => {
  if (recognition) {
    isRecording = true;
    recognition.start();
    document.getElementById('record-btn').classList.add('recording');
  }
});

document.getElementById('record-btn').addEventListener('mouseup', () => {
  if (recognition && isRecording) {
    isRecording = false;
    recognition.stop();
    document.getElementById('record-btn').classList.remove('recording');
    
    const status = document.getElementById('status').textContent;
    if (status.startsWith('Heard:')) {
      const text = status.replace('Heard:', '').trim();
      if (text) {
        sendMessage(text);
      }
    }
  }
});

document.getElementById('end-btn').addEventListener('click', endConversation);

document.getElementById('new-btn').addEventListener('click', () => {
  location.reload();
});

loadScenarios();
