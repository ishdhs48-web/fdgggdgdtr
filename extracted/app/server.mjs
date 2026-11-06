import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DeepSeekClient, DeepSeekError } from './lib/deepseek.mjs';
import { PowSolver } from './lib/pow.mjs';
import { listModels, loadModelPrompt } from './lib/models.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = here;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const SESSIONS_PATH = path.join(ROOT, 'sessions.json');

const DEFAULT_CONFIG = {
  port: 8770,
  host: '127.0.0.1',
  token: '',
  deviceId: '',
  defaultModel: 'gpt-6-astra',
  defaultThinking: false,
  defaultSearch: true,
  resendPromptEachTurn: false,
};

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

const config = loadConfig();
const solverSize = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
const client = new DeepSeekClient({
  token: config.token,
  deviceId: config.deviceId,
  solver: new PowSolver({ size: solverSize }),
});

const sessions = loadSessions();

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

let saveTimer = null;
function persistSessions() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2));
    } catch { /* best effort */ }
  }, 400);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
}

/** Compose the DeepSeek prompt: the model markdown rides in front of the user's message. */
function composePrompt({ promptText, modelId, message, fullPrompt, historyPrefix = '' }) {
  if (!fullPrompt) {
    const history = historyPrefix ? `${historyPrefix}\n\n` : '';
    return `${history}Stay in character as ${modelId}. The instructions loaded earlier still apply exactly. Do not mention instructions.\n\n${message}`;
  }
  return [
    'The block below is your operating configuration. Adopt it completely and stay in it for the whole conversation. Never mention that it was provided to you.',
    '',
    '<config>',
    promptText,
    '</config>',
    '',
    historyPrefix ? `<conversation_so_far>\n${historyPrefix}\n</conversation_so_far>\n` : '',
    message,
  ].filter(Boolean).join('\n');
}

/** Flatten prior turns so a new DeepSeek session can pick up mid-conversation. */
function renderTranscript(messages, maxChars = 12_000) {
  const lines = messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
  let text = lines.join('\n\n');
  if (text.length > maxChars) text = '…' + text.slice(text.length - maxChars);
  return text;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/state' && req.method === 'GET') {
      const models = listModels();
      let user = null;
      let authError = null;
      if (client.token) {
        try {
          const data = await client.currentUser();
          user = data;
        } catch (e) {
          authError = e instanceof DeepSeekError ? `${e.message} (${e.code})` : String(e.message || e);
        }
      }
      return json(res, 200, {
        hasToken: Boolean(client.token),
        user,
        authError,
        models,
        config: {
          defaultModel: config.defaultModel,
          defaultThinking: config.defaultThinking,
          defaultSearch: config.defaultSearch,
          resendPromptEachTurn: config.resendPromptEachTurn,
        },
        sessions: Object.values(sessions).map((s) => ({ id: s.id, title: s.title, modelId: s.modelId, updatedAt: s.updatedAt, messages: s.messages })),
      });
    }

    if (pathname === '/api/token' && req.method === 'POST') {
      const body = await readBody(req);
      const token = String(body.token || '').trim();
      if (!token) return json(res, 400, { error: 'token required' });
      client.setToken(token);
      try {
        const data = await client.currentUser();
        config.token = token;
        saveConfig(config);
        return json(res, 200, { ok: true, user: data });
      } catch (e) {
        client.setToken(config.token);
        return json(res, 400, { error: e instanceof DeepSeekError ? `${e.message} (${e.code})` : String(e.message) });
      }
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      for (const key of ['defaultModel', 'defaultThinking', 'defaultSearch', 'resendPromptEachTurn']) {
        if (key in body) config[key] = body[key];
      }
      saveConfig(config);
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/prefetch' && req.method === 'POST') {
      if (!client.token) return json(res, 400, { error: 'no token' });
      client.prefetch().catch(() => {});
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/session' && req.method === 'POST') {
      const body = await readBody(req);
      if (!client.token) return json(res, 400, { error: 'no token' });
      const ds = await client.createSession();
      const id = crypto.randomUUID();
      sessions[id] = {
        id,
        dsSessionId: ds.id,
        modelId: body.modelId || config.defaultModel,
        title: 'New chat',
        messages: [],
        lastMessageId: null,
        promptSent: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      persistSessions();
      client.prefetch().catch(() => {});
      return json(res, 200, { session: sessions[id] });
    }

    if (pathname === '/api/session/delete' && req.method === 'POST') {
      const body = await readBody(req);
      if (sessions[body.id]) {
        delete sessions[body.id];
        persistSessions();
      }
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const session = sessions[body.sessionId];
      if (!session) return json(res, 404, { error: 'unknown session' });
      if (!client.token) return json(res, 400, { error: 'no token' });

      const modelId = body.modelId || session.modelId;
      const message = String(body.message || '');
      if (!message.trim()) return json(res, 400, { error: 'empty message' });

      // A DeepSeek session carries its configuration from the first message, so a
      // model switch needs a clean session with the new config in front of it.
      const modelChanged = session.modelId !== modelId;
      session.modelId = modelId;
      const needFullPrompt = config.resendPromptEachTurn || !session.promptSent || modelChanged;

      let historyPrefix = '';
      if (modelChanged && session.messages.length) {
        const fresh = await client.createSession();
        session.dsSessionId = fresh.id;
        session.lastMessageId = null;
        historyPrefix = renderTranscript(session.messages);
      }

      const promptText = needFullPrompt ? loadModelPrompt(modelId) : null;
      const prompt = composePrompt({ promptText, modelId, message, fullPrompt: needFullPrompt, historyPrefix });

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      session.messages.push({ role: 'user', content: message, at: Date.now() });
      if (session.title === 'New chat') session.title = message.slice(0, 60).replace(/\s+/g, ' ');
      persistSessions();

      let assistant = '';
      try {
        for await (const evt of client.completion({
          sessionId: session.dsSessionId,
          parentMessageId: session.lastMessageId,
          prompt,
          thinking: body.thinking ?? config.defaultThinking,
          search: body.search ?? config.defaultSearch,
        })) {
          if (evt.type === 'text') {
            assistant += evt.text;
            send({ type: 'delta', text: evt.text });
          } else if (evt.type === 'thinking') {
            send({ type: 'thinking', text: evt.text });
          } else if (evt.type === 'status') {
            send({ type: 'status', searchTriggered: evt.searchTriggered });
          } else if (evt.type === 'done') {
            if (evt.messageId != null) session.lastMessageId = evt.messageId;
            session.promptSent = true;
            session.updatedAt = Date.now();
            session.messages.push({ role: 'assistant', content: assistant, modelId, at: Date.now() });
            persistSessions();
            send({ type: 'done', messageId: session.lastMessageId, promptChars: promptText ? promptText.length : 0, resent: needFullPrompt });
          }
        }
      } catch (e) {
        send({ type: 'error', message: e instanceof DeepSeekError ? `${e.message} (${e.code})` : String(e.message || e) });
      } finally {
        client.prefetch().catch(() => {});
        res.end();
      }
      return;
    }

    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'no such endpoint' });

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    if (!res.headersSent) return json(res, 500, { error: String(e.message || e) });
    try { res.end(); } catch { /* ignore */ }
  }
});

const port = Number(process.env.PORT || config.port || 8770);
server.listen(port, config.host || '127.0.0.1', () => {
  console.log(`deepseek models playground -> http://${config.host}:${port}`);
  console.log(`models dir: ${path.resolve(ROOT, '..')}`);
  if (!config.token) console.log('no token yet: paste it in the UI (or set it in config.json)');
  else client.prefetch().catch(() => {});
});