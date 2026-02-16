const API_URL = window.location.origin + '/api';

// Read admin token from URL query param or prompt
const urlParams = new URLSearchParams(window.location.search);
let adminToken = urlParams.get('token') || '';

function authHeaders() {
  return adminToken ? { 'Authorization': `Bearer ${adminToken}` } : {};
}

let allSessions = [];
let analysisPollTimer = null;
let pollAttempts = 0;
const MAX_POLL_ATTEMPTS = 60; // 3 minutes at 3s intervals

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function loadSessions() {
  try {
    const response = await fetch(`${API_URL}/admin/sessions`, { headers: authHeaders() });
    if (!response.ok) throw new Error('Failed to load sessions');
    const sessions = await response.json();
  allSessions = sessions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  const list = document.getElementById('sessions-list');
  
  if (allSessions.length === 0) {
    list.innerHTML = '<div class="no-sessions">No sessions yet</div>';
    return;
  }
  
  list.innerHTML = allSessions.map(s => {
    const date = new Date(s.created_at);
    const dateStr = date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    return `
      <div class="session-item" data-id="${escapeHtml(s.id)}">
        <div class="session-id">Session #${escapeHtml(String(s.id).slice(-6))}</div>
        <div class="session-date">${escapeHtml(dateStr)}</div>
        <div class="session-summary">${escapeHtml(s.summary || 'No transcript yet')}</div>
      </div>
    `;
  }).join('');

  // Attach click handlers via addEventListener (not inline onclick)
  list.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', () => loadSession(el.dataset.id));
  });
  } catch (error) {
    console.error('Failed to load sessions:', error);
    const list = document.getElementById('sessions-list');
    list.innerHTML = '<div class="no-sessions">Failed to load sessions. Please refresh.</div>';
  }
}

async function loadSession(id) {
  // Clear any previous polling timer
  if (analysisPollTimer) {
    clearInterval(analysisPollTimer);
    analysisPollTimer = null;
  }

  document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`[data-id="${id}"]`)?.classList.add('active');
  try {
  const response = await fetch(`${API_URL}/sessions/${id}`, { headers: authHeaders() });
  if (!response.ok) throw new Error('Failed to load session');
  const { transcript, analysis, created_at } = await response.json();
  
  const date = new Date(created_at);
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
        <div class="detail-title">Session #${escapeHtml(id.slice(-6))}</div>
        <div class="detail-date">${escapeHtml(dateStr)}</div>
      </div>
      <div class="detail-content">
        <div class="empty-state">
          <div class="empty-state-icon">⏳</div>
          <p>Analysis in progress... this will update automatically.</p>
        </div>
      </div>
    `;
    // Poll every 3 seconds until analysis is available
    pollAttempts = 0;
    analysisPollTimer = setInterval(() => {
      pollAttempts++;
      if (pollAttempts >= MAX_POLL_ATTEMPTS) {
        clearInterval(analysisPollTimer);
        analysisPollTimer = null;
        const container = document.getElementById('detail-content');
        container.innerHTML += '<p style="color: red; text-align: center; margin-top: 10px;">Analysis timed out. Please refresh to check again.</p>';
        return;
      }
      loadSession(id);
    }, 3000);
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
      <div class="detail-title">Session #${escapeHtml(id.slice(-6))}</div>
      <div class="detail-date">${escapeHtml(dateStr)}</div>
    </div>
    <div class="detail-content">
      <div class="overall-section">
        <div class="overall-label">Overall Assessment</div>
        <div class="overall-summary">${escapeHtml(analysis.overallSummary || 'No summary available')}</div>
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
                ${data.quote ? `<div class="score-quote">"${escapeHtml(data.quote)}"</div>` : ''}
                <div class="score-feedback">${escapeHtml(data.feedback || '')}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
      
      <div class="transcript-section">
        <div class="section-title">Conversation Transcript</div>
        ${(transcript || []).map(m => `
          <div class="transcript-item ${m.role === 'user' ? 'participant' : 'ai'}">
            <div class="transcript-role">${m.role === 'user' ? 'Participant' : 'AI Scenario'}</div>
            <div class="transcript-text">${escapeHtml(m.content)}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  } catch (error) {
    console.error('Failed to load session:', error);
    const container = document.getElementById('detail-content');
    container.innerHTML = '<div class="empty-state"><p>Failed to load session details.</p></div>';
  }
}

loadSessions().catch(err => console.error('Init error:', err));
