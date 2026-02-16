const API_URL = window.location.origin + '/api';

// ---- Auth ----

function getAdminToken() {
  return sessionStorage.getItem('adminToken') || '';
}

function setAdminToken(token) {
  sessionStorage.setItem('adminToken', token);
}

function clearAdminToken() {
  sessionStorage.removeItem('adminToken');
}

function authHeaders() {
  const token = getAdminToken();
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

function showDashboard() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('logout-btn').classList.remove('hidden');
}

function showLoginScreen(errorMessage) {
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('logout-btn').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');

  const errorEl = document.getElementById('login-error');
  const input = document.getElementById('login-token');

  if (errorMessage) {
    errorEl.textContent = errorMessage;
    input.classList.add('error');
  } else {
    errorEl.textContent = '';
    input.classList.remove('error');
  }

  input.value = '';
  input.focus();
}

function logout() {
  clearAdminToken();
  // Clear any active polling
  if (analysisPollTimer) {
    clearInterval(analysisPollTimer);
    analysisPollTimer = null;
  }
  allSessions = [];
  showLoginScreen();
}

// ---- Login form ----

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const input = document.getElementById('login-token');
  const btn = document.getElementById('login-btn');
  const token = input.value.trim();

  if (!token) {
    document.getElementById('login-error').textContent = 'Please enter a token.';
    input.classList.add('error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Signing in...';

  setAdminToken(token);

  try {
    const response = await fetch(`${API_URL}/admin/sessions`, { headers: authHeaders() });

    if (response.status === 401) {
      clearAdminToken();
      btn.disabled = false;
      btn.textContent = 'Sign In';
      document.getElementById('login-error').textContent = 'Invalid token. Please try again.';
      input.classList.add('error');
      input.select();
      return;
    }

    if (response.status === 503) {
      clearAdminToken();
      btn.disabled = false;
      btn.textContent = 'Sign In';
      document.getElementById('login-error').textContent = 'Admin access is not configured on the server.';
      input.classList.add('error');
      return;
    }

    if (!response.ok) {
      throw new Error('Unexpected error');
    }

    // Token is valid -- show the dashboard and render sessions
    const sessions = await response.json();
    showDashboard();
    renderSessions(sessions);
  } catch (error) {
    console.error('Login error:', error);
    clearAdminToken();
    btn.disabled = false;
    btn.textContent = 'Sign In';
    document.getElementById('login-error').textContent = 'Connection error. Please try again.';
  }
});

document.getElementById('logout-btn').addEventListener('click', logout);

// ---- State ----

let allSessions = [];
let analysisPollTimer = null;
let pollAttempts = 0;
const MAX_POLL_ATTEMPTS = 60; // 3 minutes at 3s intervals

// ---- Utilities ----

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---- Sessions ----

function renderSessions(sessions) {
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
}

async function loadSessions() {
  try {
    const response = await fetch(`${API_URL}/admin/sessions`, { headers: authHeaders() });

    if (response.status === 401 || response.status === 503) {
      clearAdminToken();
      showLoginScreen(response.status === 401 ? 'Session expired. Please sign in again.' : 'Admin access is not configured.');
      return;
    }

    if (!response.ok) throw new Error('Failed to load sessions');
    const sessions = await response.json();
    renderSessions(sessions);
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
            <div class="empty-state-icon">&#8987;</div>
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

// ---- Init ----

(async function init() {
  // If we have a stored token, try it automatically
  if (getAdminToken()) {
    try {
      const response = await fetch(`${API_URL}/admin/sessions`, { headers: authHeaders() });

      if (response.ok) {
        const sessions = await response.json();
        showDashboard();
        renderSessions(sessions);
        return;
      }
    } catch (err) {
      console.warn('Auto-login failed:', err);
    }
    // Token was stale or invalid
    clearAdminToken();
  }

  // No valid token -- show login screen
  showLoginScreen();
})();
