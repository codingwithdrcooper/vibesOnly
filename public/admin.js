const API_URL = 'http://localhost:3000/api';

async function loadSessions() {
  const response = await fetch(`${API_URL}/admin/sessions`);
  const sessions = await response.json();
  
  const list = document.getElementById('sessions-list');
  
  if (sessions.length === 0) {
    list.innerHTML = '<p>No sessions yet</p>';
    return;
  }
  
  list.innerHTML = sessions.map(s => `
    <div class="scenario-card" data-id="${s.id}">
      <h3>Session ${s.id}</h3>
      <p>${s.summary || 'No transcript'}</p>
    </div>
  `).join('');
  
  list.querySelectorAll('.scenario-card').forEach(card => {
    card.addEventListener('click', () => loadSession(card.dataset.id));
  });
}

async function loadSession(id) {
  const response = await fetch(`${API_URL}/sessions/${id}`);
  const { transcript, analysis } = await response.json();
  
  console.log('Transcript:', transcript);
  console.log('Analysis:', analysis);
  
  let output = '=== TRANSCRIPT ===\n\n';
  transcript.forEach(m => {
    output += `${m.role === 'user' ? 'Participant' : 'AI'}: ${m.content}\n\n`;
  });
  
  output += '\n=== ANALYSIS ===\n\n';
  if (analysis) {
    output += `Conflict Resolution: ${analysis.conflictResolution?.score}/5 - ${analysis.conflictResolution?.feedback}\n\n`;
    output += `Professionalism: ${analysis.professionalism?.score}/5 - ${analysis.professionalism?.feedback}\n\n`;
    output += `Articulation: ${analysis.articulation?.score}/5 - ${analysis.articulation?.feedback}\n\n`;
    output += `Learning: ${analysis.learning?.score}/5 - ${analysis.learning?.feedback}\n\n`;
    output += `Overall: ${analysis.overallSummary}\n`;
  } else {
    output += 'Not yet analyzed';
  }
  
  alert(output);
}

loadSessions();
