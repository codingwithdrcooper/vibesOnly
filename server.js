require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const DATA_DIR = path.join(__dirname, 'data', 'sessions');
const SCENARIOS_DIR = path.join(__dirname, 'data', 'scenarios');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/scenarios', (req, res) => {
  ensureDir(SCENARIOS_DIR);
  const files = fs.readdirSync(SCENARIOS_DIR).filter(f => f.endsWith('.json'));
  const scenarios = files.map(f => {
    const data = fs.readFileSync(path.join(SCENARIOS_DIR, f), 'utf-8');
    return JSON.parse(data);
  });
  res.json(scenarios);
});

app.post('/api/sessions', (req, res) => {
  const { scenarioId } = req.body;
  const sessionId = Date.now().toString();
  const sessionDir = path.join(DATA_DIR, sessionId);
  
  ensureDir(sessionDir);
  
  const scenarioPath = path.join(SCENARIOS_DIR, `${scenarioId}.json`);
  if (!fs.existsSync(scenarioPath)) {
    return res.status(404).json({ error: 'Scenario not found' });
  }
  
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf-8'));
  
  const transcript = [{
    role: 'assistant',
    content: scenario.initialMessage
  }];
  
  fs.writeFileSync(
    path.join(sessionDir, 'transcript.json'),
    JSON.stringify(transcript, null, 2)
  );
  
  res.json({ sessionId, scenario, transcript });
});

app.get('/api/sessions/:id', (req, res) => {
  const sessionDir = path.join(DATA_DIR, req.params.id);
  
  if (!fs.existsSync(sessionDir)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const transcript = JSON.parse(
    fs.readFileSync(path.join(sessionDir, 'transcript.json'), 'utf-8')
  );
  
  let analysis = null;
  const analysisPath = path.join(sessionDir, 'analysis.json');
  if (fs.existsSync(analysisPath)) {
    analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
  }
  
  res.json({ transcript, analysis });
});

app.put('/api/sessions/:id/transcript', (req, res) => {
  const sessionDir = path.join(DATA_DIR, req.params.id);
  const transcriptPath = path.join(sessionDir, 'transcript.json');
  
  if (!fs.existsSync(sessionDir)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  fs.writeFileSync(transcriptPath, JSON.stringify(req.body.transcript, null, 2));
  
  res.json({ success: true });
});

app.post('/api/conversation', async (req, res) => {
  try {
    const { transcript, scenario, message } = req.body;
    
    const systemPrompt = `${scenario.systemPrompt}\n\nYou are roleplaying as: ${scenario.characterName}`;
    
    const messages = [];
    
    if (transcript && transcript.length > 0) {
      transcript.forEach(msg => {
        messages.push(msg);
      });
    }
    
    messages.push({
      role: 'user',
      content: message
    });
    
    const response = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages
    });
    
    res.json({ 
      response: response.content[0].text,
      role: 'assistant'
    });
  } catch (error) {
    console.error('Claude error:', error);
    res.status(500).json({ error: 'Conversation failed' });
  }
});

app.post('/api/sessions/:id/analyze', async (req, res) => {
  try {
    const sessionDir = path.join(DATA_DIR, req.params.id);
    const transcriptPath = path.join(sessionDir, 'transcript.json');
    
    if (!fs.existsSync(sessionDir)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
    
    const analysisPrompt = `You are evaluating a participant's performance in a workplace roleplay scenario. 
    
Analyze the following transcript and provide scores (1-5) for each dimension, along with specific feedback:

Transcript:
${transcript.map(m => `${m.role === 'user' ? 'Participant' : 'AI'}: ${m.content}`).join('\n')}

Provide your analysis in this JSON format:
{
  "conflictResolution": { "score": 1-5, "feedback": "..." },
  "professionalism": { "score": 1-5, "feedback": "..." },
  "articulation": { "score": 1-5, "feedback": "..." },
  "learning": { "score": 1-5, "feedback": "..." },
  "overallSummary": "..."
}`;
    
    const response = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 2048,
      messages: [{ role: 'user', content: analysisPrompt }]
    });
    
    let analysis;
    try {
      analysis = JSON.parse(response.content[0].text);
    } catch {
      analysis = { rawAnalysis: response.content[0].text };
    }
    
    fs.writeFileSync(
      path.join(sessionDir, 'analysis.json'),
      JSON.stringify(analysis, null, 2)
    );
    
    res.json(analysis);
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

app.get('/api/admin/sessions', (req, res) => {
  ensureDir(DATA_DIR);
  const sessions = fs.readdirSync(DATA_DIR).filter(f => {
    return fs.statSync(path.join(DATA_DIR, f)).isDirectory();
  });
  
  const sessionsList = sessions.map(id => {
    const sessionDir = path.join(DATA_DIR, id);
    const transcriptPath = path.join(sessionDir, 'transcript.json');
    
    let summary = null;
    if (fs.existsSync(transcriptPath)) {
      const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
      const firstUser = transcript.find(m => m.role === 'user');
      summary = firstUser ? firstUser.content.substring(0, 100) + '...' : 'No messages';
    }
    
    return { id, summary };
  });
  
  res.json(sessionsList);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
