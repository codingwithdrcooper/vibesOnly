require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const { execFile } = require('child_process');
const crypto = require('crypto');
const axios = require('axios');
const db = require('./db');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// Configure multer for audio file uploads
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/') || file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  }
});

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
    execFile('ffmpeg', ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath], (error, stdout, stderr) => {
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

    execFile(mainBinary, ['-l', 'en', '-m', modelFile, '-f', wavPath, '--no-timestamps'], { cwd: whisperCppDir, timeout: 60000 }, (error, stdout, stderr) => {
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
    try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore cleanup error */ }
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
    res.status(500).json({ error: 'Transcription failed' });
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

  if (!text || typeof text !== 'string' || text.length > 5000) {
    return res.status(400).json({ error: 'text is required and must be under 5000 characters' });
  }
  
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

const SCENARIOS_DIR = path.join(__dirname, 'data', 'scenarios');

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/scenarios', async (req, res) => {
  try {
    const files = (await fs.promises.readdir(SCENARIOS_DIR)).filter(f => f.endsWith('.json'));
    const scenarios = await Promise.all(files.map(async f => {
      const data = await fs.promises.readFile(path.join(SCENARIOS_DIR, f), 'utf-8');
      return JSON.parse(data);
    }));
    res.json(scenarios);
  } catch (error) {
    console.error('Load scenarios error:', error);
    res.status(500).json({ error: 'Failed to load scenarios' });
  }
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { scenarioId } = req.body;
    if (!scenarioId || typeof scenarioId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(scenarioId)) {
      return res.status(400).json({ error: 'Invalid scenario ID' });
    }
    const sessionId = crypto.randomUUID();

    const scenarioPath = path.join(SCENARIOS_DIR, `${scenarioId}.json`);
    try { await fs.promises.access(scenarioPath); } catch {
      return res.status(404).json({ error: 'Scenario not found' });
    }

    const scenario = JSON.parse(await fs.promises.readFile(scenarioPath, 'utf-8'));

    const transcript = [{
      role: 'assistant',
      content: scenario.initialMessage
    }];

    // Insert session and initial transcript message in a transaction
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO sessions (id, scenario_id) VALUES ($1, $2)',
        [sessionId, scenarioId]
      );
      await client.query(
        'INSERT INTO transcript_messages (session_id, role, content, position) VALUES ($1, $2, $3, $4)',
        [sessionId, 'assistant', scenario.initialMessage, 0]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ sessionId, scenario, transcript });
  } catch (error) {
    console.error('Create session error:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  try {
    const sessionId = req.params.id;

    // Check session exists
    const sessionResult = await db.query('SELECT id, created_at FROM sessions WHERE id = $1', [sessionId]);
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Get transcript messages ordered by position
    const msgResult = await db.query(
      'SELECT role, content FROM transcript_messages WHERE session_id = $1 ORDER BY position',
      [sessionId]
    );
    const transcript = msgResult.rows.map(r => ({ role: r.role, content: r.content }));

    // Get analysis if it exists
    const analysisResult = await db.query(
      'SELECT result FROM analyses WHERE session_id = $1',
      [sessionId]
    );
    const analysis = analysisResult.rows.length > 0 ? analysisResult.rows[0].result : null;

    res.json({ transcript, analysis, created_at: sessionResult.rows[0].created_at });
  } catch (error) {
    console.error('Get session error:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

app.put('/api/sessions/:id/transcript', async (req, res) => {
  try {
    const sessionId = req.params.id;

    // Check session exists
    const sessionResult = await db.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const messages = req.body.transcript;

    // Validate transcript format
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'transcript must be an array' });
    }
    for (const msg of messages) {
      if (!msg || typeof msg.role !== 'string' || typeof msg.content !== 'string') {
        return res.status(400).json({ error: 'Each message must have role and content strings' });
      }
      if (!['user', 'assistant'].includes(msg.role)) {
        return res.status(400).json({ error: 'role must be "user" or "assistant"' });
      }
    }

    // Replace all transcript messages in a transaction
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM transcript_messages WHERE session_id = $1', [sessionId]);
      for (let i = 0; i < messages.length; i++) {
        await client.query(
          'INSERT INTO transcript_messages (session_id, role, content, position) VALUES ($1, $2, $3, $4)',
          [sessionId, messages[i].role, messages[i].content, i]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Update transcript error:', error);
    res.status(500).json({ error: 'Failed to update transcript' });
  }
});

app.post('/api/conversation', async (req, res) => {
  try {
    const { transcript, scenario, message } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }
    if (!scenario || typeof scenario.systemPrompt !== 'string' || typeof scenario.characterName !== 'string') {
      return res.status(400).json({ error: 'Invalid scenario data' });
    }
    
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
      response: response.content?.[0]?.text || '',
      role: 'assistant'
    });
  } catch (error) {
    console.error('Claude error:', error);
    res.status(500).json({ error: 'Conversation failed' });
  }
});

app.post('/api/sessions/:id/analyze', async (req, res) => {
  try {
    const sessionId = req.params.id;

    // Check session exists
    const sessionResult = await db.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Respond immediately so the participant isn't kept waiting
    res.status(202).json({ status: 'analyzing' });

    // Run the actual analysis in the background
    runAnalysis(sessionId).catch(error => {
      console.error(`Background analysis error for session ${sessionId}:`, error);
    });
  } catch (error) {
    console.error('Analyze session error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to start analysis' });
    }
  }
});

async function runAnalysis(sessionId) {
  // Read transcript from database
  const msgResult = await db.query(
    'SELECT role, content FROM transcript_messages WHERE session_id = $1 ORDER BY position',
    [sessionId]
  );
  const transcript = msgResult.rows;

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
    const responseText = response.content?.[0]?.text;
    if (!responseText) throw new Error('Empty response from API');
    analysis = JSON.parse(responseText);
  } catch {
    analysis = { rawAnalysis: response.content?.[0]?.text || 'Analysis failed to parse' };
  }

  // Upsert analysis result
  await db.query(
    `INSERT INTO analyses (session_id, result) VALUES ($1, $2)
     ON CONFLICT (session_id) DO UPDATE SET result = $2, updated_at = NOW()`,
    [sessionId, JSON.stringify(analysis)]
  );

  console.log(`Analysis complete for session ${sessionId}`);
}

// Simple token-based admin auth middleware
function requireAdminAuth(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    return res.status(503).json({ error: 'Admin access not configured' });
  }
  const provided = req.headers.authorization?.replace('Bearer ', '');
  if (provided !== adminToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/admin/sessions', requireAdminAuth, async (req, res) => {
  try {
    // Single query: get all sessions with the first user message as summary
    const result = await db.query(`
      SELECT
        s.id,
        s.created_at,
        COALESCE(
          CASE WHEN LENGTH(first_user_msg.content) > 100 THEN SUBSTRING(first_user_msg.content FROM 1 FOR 100) || '...' ELSE first_user_msg.content END,
          'No messages'
        ) AS summary
      FROM sessions s
      LEFT JOIN LATERAL (
        SELECT content
        FROM transcript_messages tm
        WHERE tm.session_id = s.id AND tm.role = 'user'
        ORDER BY tm.position
        LIMIT 1
      ) first_user_msg ON true
      ORDER BY s.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Admin sessions error:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    db.pool.end().then(() => {
      console.log('Database pool closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  server.close(() => {
    db.pool.end().then(() => {
      console.log('Database pool closed');
      process.exit(0);
    });
  });
});
