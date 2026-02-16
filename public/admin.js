const API_URL = window.location.origin + '/api';

let allSessions = [];
let analysisPollTimer = null;

async function loadSessions() {
  const response = await fetch(`${API_URL}/admin/sessions`);
  const sessions = await response.json();
  allSessions = sessions.sort((a, b) => b.id - a.id);
  
  const list = document.getElementById('sessions-list');
  
  if (allSessions.length === 0) {
    list.innerHTML = '<div class="no-sessions">No sessions yet</div>';
    return;
  }
  
  list.innerHTML = allSessions.map(s => {
    const date = new Date(parseInt(s.id));
    const dateStr = date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    return `
      <div class="session-item" data-id="${s.id}" onclick="loadSession('${s.id}')">
        <div class="session-id">Session #${s.id.slice(-6)}</div>
        <div class="session-date">${dateStr}</div>
        <div class="session-summary">${s.summary || 'No transcript yet'}</div>
      </div>
    `;
  }).join('');
}

async function loadSession(id) {
  // Clear any previous polling timer
  if (analysisPollTimer) {
    clearInterval(analysisPollTimer);
    analysisPollTimer = null;
  }

  document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`[data-id="${id}"]`)?.classList.add('active');
  
  const response = await fetch(`${API_URL}/sessions/${id}`);
  const { transcript, analysis } = await response.json();
  
  const date = new Date(parseInt(id));
  const dateStr = date.toLocaleDateString('en-US', { 
    weekday: 'long',
    year: 'numeric', 
    month: 'long', 
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  
  const container = document.getElementById('detail-content');
  
  if (!analysis) {
    container.innerHTML = `
      <div class="detail-header">
        <div class="detail-title">Session #${id.slice(-6)}</div>
        <div class="detail-date">${dateStr}</div>
      </div>
      <div class="detail-content">
        <div class="empty-state">
          <div class="empty-state-icon">⏳</div>
          <p>Analysis in progress... this will update automatically.</p>
        </div>
      </div>
    `;
    // Poll every 3 seconds until analysis is available
    analysisPollTimer = setInterval(() => loadSession(id), 3000);
    return;
  }
  
  const getScoreClass = (score) => {
    if (score >= 4) return 'high';
    if (score >= 3) return 'mid';
    return 'low';
  };
  
  const dimensions = [
    { key: 'conflictResolution', label: 'Conflict Resolution' },
    { key: 'professionalism', label: 'Professionalism' },
    { key: 'articulation', label: 'Articulation' },
    { key: 'learning', label: 'Learning & Growth' }
  ];
  
  container.innerHTML = `
    <div class="detail-header">
      <div class="detail-title">Session #${id.slice(-6)}</div>
      <div class="detail-date">${dateStr}</div>
    </div>
    <div class="detail-content">
      <div class="overall-section">
        <div class="overall-label">Overall Assessment</div>
        <div class="overall-summary">${analysis.overallSummary || 'No summary available'}</div>
      </div>
      
      <div class="scores-section">
        <div class="section-title">Dimension Scores</div>
        <div class="score-cards">
          ${dimensions.map(dim => {
            const data = analysis[dim.key] || {};
            return `
              <div class="score-card">
                <div class="score-card-header">
                  <span class="score-label">${dim.label}</span>
                  <span class="score-value ${getScoreClass(data.score)}">${data.score || '-'}/5</span>
                </div>
                ${data.quote ? `<div class="score-quote">"${data.quote}"</div>` : ''}
                <div class="score-feedback">${data.feedback || ''}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
      
      <div class="transcript-section">
        <div class="section-title">Conversation Transcript</div>
        ${transcript.map(m => `
          <div class="transcript-item ${m.role === 'user' ? 'participant' : 'ai'}">
            <div class="transcript-role">${m.role === 'user' ? 'Participant' : 'AI Scenario'}</div>
            <div class="transcript-text">${m.content}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

loadSessions();
