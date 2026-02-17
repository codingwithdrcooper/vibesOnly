import { createRequire } from 'node:module';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { query } from './db.js';

// pg-workflows ESM build has a lodash import bug, so we use the CJS build via createRequire.
// Types are re-exported below for convenience.
const require = createRequire(import.meta.url);
const {
  WorkflowEngine: WorkflowEngineClass,
  workflow: workflowFn,
  WorkflowStatus: WorkflowStatusEnum,
} = require('pg-workflows') as typeof import('pg-workflows');

// Re-export types so consumers can use them without the createRequire workaround
export type {
  WorkflowEngine,
  WorkflowRunProgress,
} from 'pg-workflows';
export const WorkflowStatus = WorkflowStatusEnum;

// ---- Analysis workflow definition ----

const analyzeSessionWorkflow = workflowFn(
  'analyze-session',
  async ({ step, input }) => {
    // Step 1: Fetch transcript from DB (durable -- result persisted after completion)
    const transcript = await step.run(
      'fetch-transcript',
      async (): Promise<Array<{ role: string; content: string }>> => {
        const result = await query(
          'SELECT role, content FROM transcript_messages WHERE session_id = $1 ORDER BY position',
          [input.sessionId],
        );
        return result.rows as Array<{ role: string; content: string }>;
      },
    );

    // Step 2: Call Claude API to generate the analysis (durable -- retried on failure)
    const analysis = await step.run('generate-analysis', async () => {
      const anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });

      const analysisPrompt = `You are an expert workplace skills assessor. Analyze the transcript below and provide DETAILED feedback with SPECIFIC EXAMPLES from the conversation.
    
Transcript:
${transcript.map((m: { role: string; content: string }) => `${m.role === 'user' ? 'PARTICIPANT' : 'AI SCENARIO'}: ${m.content}`).join('\n')}

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
        messages: [{ role: 'user', content: analysisPrompt }],
      });

      let parsedAnalysis: unknown;
      try {
        const responseText = response.content?.[0];
        if (!responseText || responseText.type !== 'text') {
          throw new Error('Empty response from API');
        }
        parsedAnalysis = JSON.parse(responseText.text);
      } catch {
        const text =
          response.content?.[0]?.type === 'text'
            ? response.content[0].text
            : 'Analysis failed to parse';
        parsedAnalysis = { rawAnalysis: text };
      }

      return parsedAnalysis;
    });

    // Step 3: Save the analysis to the database (durable -- guaranteed to run if step 2 succeeded)
    await step.run('save-analysis', async () => {
      await query(
        `INSERT INTO analyses (session_id, result) VALUES ($1, $2)
         ON CONFLICT (session_id) DO UPDATE SET result = $2, updated_at = NOW()`,
        [input.sessionId, JSON.stringify(analysis)],
      );
      console.log(`Analysis complete for session ${input.sessionId}`);
    });

    return analysis;
  },
  {
    inputSchema: z.object({ sessionId: z.string() }),
    retries: 3,
    timeout: 5 * 60 * 1000, // 5 minutes
  },
);

// ---- Engine lifecycle ----

type WorkflowEngineInstance = InstanceType<typeof WorkflowEngineClass>;

let engine: WorkflowEngineInstance | null = null;

export async function startWorkflowEngine(): Promise<WorkflowEngineInstance> {
  const { PgBoss } = await import('pg-boss');

  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL!,
  });

  engine = new WorkflowEngineClass({
    boss,
    workflows: [analyzeSessionWorkflow],
  }) as WorkflowEngineInstance;

  await engine.start();
  console.log('Workflow engine started');
  return engine;
}

export async function stopWorkflowEngine(): Promise<void> {
  if (engine) {
    await engine.stop();
    console.log('Workflow engine stopped');
    engine = null;
  }
}

export function getEngine(): WorkflowEngineInstance {
  if (!engine) {
    throw new Error(
      'Workflow engine not started. Call startWorkflowEngine() first.',
    );
  }
  return engine;
}
