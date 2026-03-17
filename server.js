const express = require('express');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const GEMINI_BIN = process.env.GEMINI_BIN || 'gemini';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.DEFAULT_TIMEOUT_MS || '120000', 10);

// sessionKey -> sessionId
const sessions = new Map();

function getSessionKey(req) {
  return (
    req.header('x-session-key') ||
    req.body?.sessionKey ||
    req.query?.sessionKey ||
    req.ip
  );
}

function runGemini({ prompt, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const args = [];

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    args.push('-p', prompt);
    args.push('--output-format', 'json');

    const child = spawn(GEMINI_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (killed) {
        return reject(new Error('gemini_timeout'));
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout.trim() || '{}');
      } catch (e) {
        return reject(new Error(`invalid_json_output: ${e.message}\n${stdout}\n${stderr}`));
      }

      resolve({
        code,
        data: parsed,
        stderr,
      });
    });
  });
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

app.post('/run', async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) {
      return res.status(400).json({ error: 'missing prompt' });
    }

    const sessionKey = getSessionKey(req);
    const savedSessionId = sessionKey ? sessions.get(sessionKey) : null;

    const output = await runGemini({
      prompt,
      sessionId: req.body?.sessionId || savedSessionId || null,
      timeoutMs: req.body?.timeoutMs,
    });

    // 실제 session id 키 이름은 CLI 버전에 따라 달라질 수 있어 방어적으로 처리
    const sessionId =
      output.data?.sessionId ||
      output.data?.session_id ||
      output.data?.session?.id ||
      null;

    if (sessionKey && sessionId) {
      sessions.set(sessionKey, sessionId);
    }

    res.json({
      ok: output.code === 0,
      sessionKey,
      sessionId,
      response: output.data?.response ?? output.data,
      stats: output.data?.stats ?? null,
      stderr: output.stderr || null,
      raw: output.data,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/resetSession', (req, res) => {
  const sessionKey = String(
    req.body?.sessionKey || req.header('x-session-key') || ''
  ).trim();

  if (!sessionKey) {
    return res.status(400).json({ error: 'missing sessionKey' });
  }

  sessions.delete(sessionKey);
  res.json({ ok: true, cleared: true, sessionKey });
});

app.listen(PORT, () => {
  console.log(`Gemini wrapper listening on :${PORT}`);
});
