import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import multer from 'multer';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import axios from 'axios';
import { query, pool } from './db.js';
import {
  startWorkflowEngine,
  stopWorkflowEngine,
  getEngine,
} from './workflow-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Configure multer for audio file uploads
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype.startsWith('audio/') ||
      file.mimetype === 'application/octet-stream'
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  },
});

// Check if whisper.cpp binary and model are available
let whisperAvailable = false;
let whisperCppDir: string | null = null;

function checkWhisperAvailability(): void {
  try {
    // whisper-node installs whisper.cpp under its lib directory
    const whisperNodePath: string = import.meta.resolve('whisper-node');
    const resolved = whisperNodePath.startsWith('file://')
      ? fileURLToPath(whisperNodePath)
      : whisperNodePath;
    whisperCppDir = path.join(
      path.dirname(resolved),
      '..',
      'lib',
      'whisper.cpp',
    );
    const mainBinary = path.join(whisperCppDir, 'main');
    const modelFile = path.join(whisperCppDir, 'models', 'ggml-base.en.bin');

    if (fs.existsSync(mainBinary) && fs.existsSync(modelFile)) {
      whisperAvailable = true;
      console.log('whisper.cpp available at:', whisperCppDir);
    } else {
      console.warn('whisper.cpp binary or model not found.');
      if (!fs.existsSync(mainBinary))
        console.warn('  Missing binary:', mainBinary);
      if (!fs.existsSync(modelFile))
        console.warn('  Missing model:', modelFile);
    }
  } catch (err) {
    console.warn(
      'whisper.cpp not available:',
      err instanceof Error ? err.message : err,
    );
    whisperAvailable = false;
  }
}

checkWhisperAvailability();

// SST status endpoint - client checks this to decide whisper vs browser fallback
app.get('/api/stt-status', (_req: Request, res: Response) => {
  res.json({
    whisperAvailable,
    fallback: 'browser-speech-recognition',
  });
});

// Convert uploaded audio to 16kHz WAV using ffmpeg
function convertToWav(inputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath + '.wav';
    execFile(
      'ffmpeg',
      [
        '-y',
        '-i',
        inputPath,
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        outputPath,
      ],
      (error) => {
        if (error) {
          reject(new Error(`ffmpeg conversion failed: ${error.message}`));
          return;
        }
        resolve(outputPath);
      },
    );
  });
}

// Run whisper.cpp directly, bypassing whisper-node's buggy output parser
function runWhisperCpp(wavPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mainBinary = path.join(whisperCppDir!, 'main');
    const modelFile = path.join(
      whisperCppDir!,
      'models',
      'ggml-base.en.bin',
    );

    execFile(
      mainBinary,
      ['-l', 'en', '-m', modelFile, '-f', wavPath, '--no-timestamps'],
      { cwd: whisperCppDir!, timeout: 60000 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`whisper.cpp failed: ${error.message}`));
          return;
        }
        // --no-timestamps outputs plain text, one segment per line
        const text = stdout.trim();
        resolve(text);
      },
    );
  });
}

// Transcription endpoint using whisper.cpp directly
app.post(
  '/api/transcribe',
  upload.single('audio'),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No audio file provided' });
      return;
    }

    if (!whisperAvailable || !whisperCppDir) {
      // Clean up uploaded file
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        /* ignore cleanup error */
      }
      res
        .status(503)
        .json({ error: 'Whisper transcription not available' });
      return;
    }

    let wavPath: string | null = null;
    try {
      // Convert uploaded audio to 16kHz WAV (whisper.cpp requires this)
      wavPath = await convertToWav(req.file.path);

      // Transcribe with whisper.cpp directly
      console.log('[whisper] Transcribing:', wavPath);
      const text = await runWhisperCpp(wavPath);
      console.log(
        '[whisper] Result:',
        text ? `"${text.substring(0, 100)}..."` : '(empty)',
      );

      res.json({ text });
    } catch (error) {
      console.error(
        '[whisper] Transcription error:',
        error instanceof Error ? error.message : error,
      );
      res.status(500).json({ error: 'Transcription failed' });
    } finally {
      // Clean up temp files
      try {
        if (req.file && fs.existsSync(req.file.path))
          fs.unlinkSync(req.file.path);
        if (wavPath && fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
      } catch (cleanupErr) {
        console.warn(
          'Cleanup error:',
          cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
        );
      }
    }
  },
);

app.post('/api/tts', async (req: Request, res: Response) => {
  const { text } = req.body;

  if (!text || typeof text !== 'string' || text.length > 5000) {
    res
      .status(400)
      .json({ error: 'text is required and must be under 5000 characters' });
    return;
  }

  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

  if (!ELEVENLABS_API_KEY) {
    res.status(500).json({ error: 'ElevenLabs API key not configured' });
    return;
  }

  try {
    const response = await axios.post(
      'https://api.elevenlabs.io/v1/text-to-speech/pNInz6obpgDQGcFmaJgB',
      {
        text: text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
        },
      },
      {
        headers: {
          Accept: 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY,
        },
        responseType: 'arraybuffer',
      },
    );

    const base64 = Buffer.from(response.data as ArrayBuffer).toString(
      'base64',
    );
    res.json({ audio: base64, format: 'audio/mpeg' });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('ElevenLabs error:', error.response?.data || error.message);
    } else {
      console.error('ElevenLabs error:', error);
    }
    res.status(500).json({ error: 'TTS failed' });
  }
});

const SCENARIOS_DIR = path.join(__dirname, '..', 'data', 'scenarios');

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.get('/api/scenarios', async (_req: Request, res: Response) => {
  try {
    const files = (await fs.promises.readdir(SCENARIOS_DIR)).filter((f) =>
      f.endsWith('.json'),
    );
    const scenarios = await Promise.all(
      files.map(async (f) => {
        const data = await fs.promises.readFile(
          path.join(SCENARIOS_DIR, f),
          'utf-8',
        );
        return JSON.parse(data);
      }),
    );
    res.json(scenarios);
  } catch (error) {
    console.error('Load scenarios error:', error);
    res.status(500).json({ error: 'Failed to load scenarios' });
  }
});

app.post('/api/sessions', async (req: Request, res: Response) => {
  try {
    const { scenarioId } = req.body;
    if (
      !scenarioId ||
      typeof scenarioId !== 'string' ||
      !/^[a-zA-Z0-9_-]+$/.test(scenarioId)
    ) {
      res.status(400).json({ error: 'Invalid scenario ID' });
      return;
    }
    const sessionId = crypto.randomUUID();

    const scenarioPath = path.join(SCENARIOS_DIR, `${scenarioId}.json`);
    try {
      await fs.promises.access(scenarioPath);
    } catch {
      res.status(404).json({ error: 'Scenario not found' });
      return;
    }

    const scenario = JSON.parse(
      await fs.promises.readFile(scenarioPath, 'utf-8'),
    );

    const transcript = [
      {
        role: 'assistant',
        content: scenario.initialMessage,
      },
    ];

    // Insert session and initial transcript message in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO sessions (id, scenario_id) VALUES ($1, $2)',
        [sessionId, scenarioId],
      );
      await client.query(
        'INSERT INTO transcript_messages (session_id, role, content, position) VALUES ($1, $2, $3, $4)',
        [sessionId, 'assistant', scenario.initialMessage, 0],
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

app.get('/api/sessions/:id', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;

    // Check session exists
    const sessionResult = await query(
      'SELECT id, created_at FROM sessions WHERE id = $1',
      [sessionId],
    );
    if (sessionResult.rows.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Get transcript messages ordered by position
    const msgResult = await query(
      'SELECT role, content FROM transcript_messages WHERE session_id = $1 ORDER BY position',
      [sessionId],
    );
    const transcript = msgResult.rows.map(
      (r: { role: string; content: string }) => ({
        role: r.role,
        content: r.content,
      }),
    );

    // Get analysis if it exists
    const analysisResult = await query(
      'SELECT result FROM analyses WHERE session_id = $1',
      [sessionId],
    );
    const analysis =
      analysisResult.rows.length > 0
        ? (analysisResult.rows[0] as { result: unknown }).result
        : null;

    res.json({
      transcript,
      analysis,
      created_at: (sessionResult.rows[0] as { created_at: string }).created_at,
    });
  } catch (error) {
    console.error('Get session error:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

app.put('/api/sessions/:id/transcript', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;

    // Check session exists
    const sessionResult = await query(
      'SELECT id FROM sessions WHERE id = $1',
      [sessionId],
    );
    if (sessionResult.rows.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const messages: Array<{ role: string; content: string }> =
      req.body.transcript;

    // Validate transcript format
    if (!Array.isArray(messages)) {
      res.status(400).json({ error: 'transcript must be an array' });
      return;
    }
    for (const msg of messages) {
      if (
        !msg ||
        typeof msg.role !== 'string' ||
        typeof msg.content !== 'string'
      ) {
        res
          .status(400)
          .json({ error: 'Each message must have role and content strings' });
        return;
      }
      if (!['user', 'assistant'].includes(msg.role)) {
        res
          .status(400)
          .json({ error: 'role must be "user" or "assistant"' });
        return;
      }
    }

    // Replace all transcript messages in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM transcript_messages WHERE session_id = $1',
        [sessionId],
      );
      for (let i = 0; i < messages.length; i++) {
        await client.query(
          'INSERT INTO transcript_messages (session_id, role, content, position) VALUES ($1, $2, $3, $4)',
          [sessionId, messages[i].role, messages[i].content, i],
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

app.post('/api/conversation', async (req: Request, res: Response) => {
  try {
    const { transcript, scenario, message } = req.body;

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    if (
      !scenario ||
      typeof scenario.systemPrompt !== 'string' ||
      typeof scenario.characterName !== 'string'
    ) {
      res.status(400).json({ error: 'Invalid scenario data' });
      return;
    }

    const systemPrompt = `${scenario.systemPrompt}\n\nIMPORTANT: Keep your responses SHORT - 2-5 sentences maximum. Be conversational, not a long speech. You are roleplaying as: ${scenario.characterName}`;

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    if (transcript && transcript.length > 0) {
      transcript.forEach(
        (msg: { role: 'user' | 'assistant'; content: string }) => {
          messages.push(msg);
        },
      );
    }

    messages.push({
      role: 'user',
      content: message,
    });

    const response = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages,
    });

    res.json({
      response: response.content?.[0]?.type === 'text' ? response.content[0].text : '',
      role: 'assistant',
    });
  } catch (error) {
    console.error('Claude error:', error);
    res.status(500).json({ error: 'Conversation failed' });
  }
});

// ---- Analysis via durable workflow ----

// pg-workflows uses varchar(32) for resource_id, so we strip hyphens from UUIDs (36 → 32 chars)
function compactUUID(uuid: string): string {
  return uuid.replaceAll('-', '');
}

app.post('/api/sessions/:id/analyze', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;

    // Check session exists
    const sessionResult = await query(
      'SELECT id FROM sessions WHERE id = $1',
      [sessionId],
    );
    if (sessionResult.rows.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Start a durable workflow instead of fire-and-forget
    const run = await getEngine().startWorkflow({
      workflowId: 'analyze-session',
      resourceId: compactUUID(sessionId),
      input: { sessionId },
    });

    res.status(202).json({ status: 'analyzing', runId: run.id });
  } catch (error) {
    console.error('Analyze session error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to start analysis' });
    }
  }
});

// ---- Admin ----

// Simple token-based admin auth middleware
function requireAdminAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    res.status(503).json({ error: 'Admin access not configured' });
    return;
  }
  const provided = req.headers.authorization?.replace('Bearer ', '');
  if (provided !== adminToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.get(
  '/api/admin/sessions',
  requireAdminAuth,
  async (_req: Request, res: Response) => {
    try {
      // Single query: get all sessions with the first user message as summary
      const result = await query(`
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
  },
);

// Admin endpoint to check workflow progress for a session's analysis
app.get(
  '/api/admin/sessions/:id/analysis-status',
  requireAdminAuth,
  async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id;
      const resourceId = compactUUID(sessionId);

      // Look up the most recent workflow run for this session
      const engine = getEngine();
      const { items } = await engine.getRuns({
        resourceId,
        workflowId: 'analyze-session',
        limit: 1,
      });

      if (items.length === 0) {
        res.json({ status: 'none', message: 'No analysis workflow found' });
        return;
      }

      const run = items[0];
      const progress = await engine.checkProgress({
        runId: run.id,
        resourceId,
      });

      res.json({
        status: progress.status,
        runId: run.id,
        completionPercentage: progress.completionPercentage,
        completedSteps: progress.completedSteps,
        totalSteps: progress.totalSteps,
        retryCount: run.retryCount,
        maxRetries: run.maxRetries,
        error: run.error,
        createdAt: run.createdAt,
        completedAt: run.completedAt,
      });
    } catch (error) {
      console.error('Analysis status error:', error);
      res.status(500).json({ error: 'Failed to check analysis status' });
    }
  },
);

// ---- Server lifecycle ----

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Start the workflow engine after the HTTP server is listening.
  // This ensures any incomplete workflows from previous crashes are picked up.
  startWorkflowEngine().catch((err) => {
    console.error('Failed to start workflow engine:', err);
    process.exit(1);
  });
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down gracefully...`);

  // Stop the workflow engine first (finishes in-progress step, stops polling)
  try {
    await stopWorkflowEngine();
  } catch (err) {
    console.error('Error stopping workflow engine:', err);
  }

  server.close(() => {
    pool.end().then(() => {
      console.log('Database pool closed');
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
