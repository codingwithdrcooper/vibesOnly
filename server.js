require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const { exec } = require('child_process');
const axios = require('axios');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Configure multer for audio file uploads
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
const upload = multer({ dest: uploadsDir });

// Check if whisper.cpp binary and model are available
let whisperAvailable = false;
let whisperCppDir = null;

function checkWhisperAvailability() {
  try {
    // whisper-node installs whisper.cpp under its lib directory
    const whisperNodePath = require.resolve('whisper-node');
    whisperCppDir = path.join(path.dirname(whisperNodePath), '..', 'lib', 'whisper.cpp');
    const mainBinary = path.join(whisperCppDir, 'main');
    const modelFile = path.join(whisperCppDir, 'models', 'ggml-base.en.bin');

    if (fs.existsSync(mainBinary) && fs.existsSync(modelFile)) {
      whisperAvailable = true;
      console.log('whisper.cpp available at:', whisperCppDir);
    } else {
      console.warn('whisper.cpp binary or model not found.');
      if (!fs.existsSync(mainBinary)) console.warn('  Missing binary:', mainBinary);
      if (!fs.existsSync(modelFile)) console.warn('  Missing model:', modelFile);
    }
  } catch (err) {
    console.warn('whisper.cpp not available:', err.message);
    whisperAvailable = false;
  }
}

checkWhisperAvailability();

// SST status endpoint - client checks this to decide whisper vs browser fallback
app.get('/api/stt-status', (req, res) => {
  res.json({
    whisperAvailable,
    fallback: 'browser-speech-recognition',
  });
});

// Convert uploaded audio to 16kHz WAV using ffmpeg
function convertToWav(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath + '.wav';
    const cmd = `ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${outputPath}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`ffmpeg conversion failed: ${error.message}`));
        return;
      }
      resolve(outputPath);
    });
  });
}

// Run whisper.cpp directly, bypassing whisper-node's buggy output parser
function runWhisperCpp(wavPath) {
  return new Promise((resolve, reject) => {
    const mainBinary = path.join(whisperCppDir, 'main');
    const modelFile = path.join(whisperCppDir, 'models', 'ggml-base.en.bin');
    const cmd = `"${mainBinary}" -l en -m "${modelFile}" -f "${wavPath}" --no-timestamps 2>/dev/null`;

    exec(cmd, { cwd: whisperCppDir, timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`whisper.cpp failed: ${error.message}`));
        return;
      }
      // --no-timestamps outputs plain text, one segment per line
      const text = stdout.trim();
      resolve(text);
    });
  });
}

// Transcription endpoint using whisper.cpp directly
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }

  if (!whisperAvailable || !whisperCppDir) {
    // Clean up uploaded file
    fs.unlinkSync(req.file.path);
    return res.status(503).json({ error: 'Whisper transcription not available' });
  }

  let wavPath = null;
  try {
    // Convert uploaded audio to 16kHz WAV (whisper.cpp requires this)
    wavPath = await convertToWav(req.file.path);

    // Transcribe with whisper.cpp directly
    console.log('[whisper] Transcribing:', wavPath);
    const text = await runWhisperCpp(wavPath);
    console.log('[whisper] Result:', text ? `"${text.substring(0, 100)}..."` : '(empty)');

    res.json({ text });
  } catch (error) {
    console.error('[whisper] Transcription error:', error.message);
    res.status(500).json({ error: 'Transcription failed: ' + error.message });
  } finally {
    // Clean up temp files
    try {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      if (wavPath && fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
    } catch (cleanupErr) {
      console.warn('Cleanup error:', cleanupErr.message);
    }
  }
});

app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  
  if (!ELEVENLABS_API_KEY) {
    return res.status(500).json({ error: 'ElevenLabs API key not configured' });
  }
  
  try {
    const response = await axios.post(
      'https://api.elevenlabs.io/v1/text-to-speech/pNInz6obpgDQGcFmaJgB',
      {
        text: text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5
        }
      },
      {
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY
        },
        responseType: 'arraybuffer'
      }
    );
    
    const base64 = Buffer.from(response.data).toString('base64');
    res.json({ audio: base64, format: 'audio/mpeg' });
  } catch (error) {
    console.error('ElevenLabs error:', error.response?.data || error.message);
    res.status(500).json({ error: 'TTS failed' });
  }
});

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
    
    const systemPrompt = `${scenario.systemPrompt}\n\nIMPORTANT: Keep your responses SHORT - 2-5 sentences maximum. Be conversational, not a long speech. You are roleplaying as: ${scenario.characterName}`;
    
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
  const sessionDir = path.join(DATA_DIR, req.params.id);

  if (!fs.existsSync(sessionDir)) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Respond immediately so the participant isn't kept waiting
  res.status(202).json({ status: 'analyzing' });

  // Run the actual analysis in the background
  runAnalysis(req.params.id, sessionDir).catch(error => {
    console.error(`Background analysis error for session ${req.params.id}:`, error);
  });
});

async function runAnalysis(sessionId, sessionDir) {
  const transcriptPath = path.join(sessionDir, 'transcript.json');
  const transcript = JSON.parse(await fsp.readFile(transcriptPath, 'utf-8'));

  const analysisPrompt = `You are an expert workplace skills assessor. Analyze the transcript below and provide DETAILED feedback with SPECIFIC EXAMPLES from the conversation.
    
Transcript:
${transcript.map(m => `${m.role === 'user' ? 'PARTICIPANT' : 'AI SCENARIO'}: ${m.content}`).join('\n')}

For each dimension below, provide:
1. A score from 1-5
2. Detailed feedback (2-3 sentences) explaining the score
3. At least one SPECIFIC QUOTE from the transcript that supports your assessment

Return JSON in this exact format:
{
  "conflictResolution": { 
    "score": 1-5, 
    "quote": "specific quote from transcript",
    "feedback": "detailed explanation with specific example"
  },
  "professionalism": { 
    "score": 1-5, 
    "quote": "specific quote from transcript", 
    "feedback": "detailed explanation with specific example"
  },
  "articulation": { 
    "score": 1-5, 
    "quote": "specific quote from transcript", 
    "feedback": "detailed explanation with specific example"
  },
  "learning": { 
    "score": 1-5, 
    "quote": "specific quote from transcript", 
    "feedback": "detailed explanation with specific example"
  },
  "overallSummary": "2-3 sentence summary of participant performance"
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

  await fsp.writeFile(
    path.join(sessionDir, 'analysis.json'),
    JSON.stringify(analysis, null, 2)
  );

  console.log(`Analysis complete for session ${sessionId}`);
}

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
