import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DeepSeekClient, DeepSeekError } from './lib/deepseek.mjs';
import { PowSolver } from './lib/pow.mjs';
import { listModels, loadModelPrompt } from './lib/models.mjs';

const execAsync = promisify(exec);

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

    // ===== PC Control API =====

    // Full Access Mode - Execute ANY command
    if (pathname === '/api/pc/full' && req.method === 'POST') {
      const body = await readBody(req);
      const command = String(body.command || '');
      const confirm = body.confirm || false;
      
      if (!command.trim()) return json(res, 400, { error: 'command required' });
      
      // Dangerous commands require explicit confirmation
      const dangerousPatterns = [
        /\brm\s/,
        /\bdel\s/,
        /\bdelete\s/,
        /\bformat\s/,
        /\bdd\s/,
        /\b:.*\\$/,  // Format drive
        /\b>\s*null/,
        /\bchmod\s/,
        /\bchown\s/,
        /\bshutdown/,
        /\breboot/,
        /\bpkill/,
        /\bkill\s/,
      ];
      
      const isDangerous = dangerousPatterns.some(p => p.test(command.toLowerCase()));
      
      if (isDangerous && !confirm) {
        return json(res, 403, { 
          error: 'ОПАСНАЯ КОМАНДА!',
          command,
          warning: 'Эта команда может повредить систему. Для выполнения отправьте confirm: true',
          dangerous: true
        });
      }
      
      try {
        const { stdout, stderr } = await execAsync(command, { 
          timeout: 30000,
          maxBuffer: 1024 * 1024 * 10  // 10MB
        });
        
        return json(res, 200, {
          success: true,
          command,
          output: stdout || stderr || 'Команда выполнена успешно',
          timestamp: new Date().toISOString()
        });
      } catch (e) {
        return json(res, 500, {
          error: String(e.message || e),
          command,
          timestamp: new Date().toISOString()
        });
      }
    }

    // Full Access - File operations
    if (pathname === '/api/pc/file' && req.method === 'POST') {
      const body = await readBody(req);
      const action = String(body.action || '');
      const filePath = String(body.path || '');
      const content = body.content || '';
      const confirm = body.confirm || false;
      
      if (!action || !filePath) return json(res, 400, { error: 'action and path required' });
      
      // Security: prevent path traversal
      const normalizedPath = path.normalize(filePath);
      if (normalizedPath.includes('..') || normalizedPath.startsWith('/')) {
        return json(res, 403, { error: 'Invalid path' });
      }
      
      const fullPath = path.join(process.cwd(), normalizedPath);
      
      try {
        switch (action) {
          case 'read':
            if (!fs.existsSync(fullPath)) {
              return json(res, 404, { error: 'File not found', path: filePath });
            }
            const stats = fs.statSync(fullPath);
            if (!stats.isFile()) {
              return json(res, 400, { error: 'Not a file', path: filePath });
            }
            const fileContent = fs.readFileSync(fullPath, 'utf8');
            return json(res, 200, {
              success: true,
              action: 'read',
              path: filePath,
              content: fileContent,
              size: stats.size,
              modified: stats.mtime
            });
          
          case 'write':
            if (!confirm) {
              return json(res, 403, {
                error: 'ПИСЬМО В ФАЙЛ!',
                action,
                path: filePath,
                warning: 'Для записи в файл отправьте confirm: true'
              });
            }
            fs.writeFileSync(fullPath, content, 'utf8');
            return json(res, 200, {
              success: true,
              action: 'write',
              path: filePath,
              message: 'Файл успешно записан'
            });
          
          case 'delete':
            if (!confirm) {
              return json(res, 403, {
                error: 'УДАЛЕНИЕ ФАЙЛА!',
                action,
                path: filePath,
                warning: 'Для удаления файла отправьте confirm: true'
              });
            }
            if (fs.existsSync(fullPath)) {
              fs.unlinkSync(fullPath);
              return json(res, 200, {
                success: true,
                action: 'delete',
                path: filePath,
                message: 'Файл удален'
              });
            }
            return json(res, 404, { error: 'File not found', path: filePath });
          
          case 'list':
            const files = fs.readdirSync(fullPath).map(f => {
              const fp = path.join(fullPath, f);
              const stat = fs.statSync(fp);
              return {
                name: f,
                path: path.join(filePath, f),
                isDirectory: stat.isDirectory(),
                size: stat.size,
                modified: stat.mtime
              };
            });
            return json(res, 200, {
              success: true,
              action: 'list',
              path: filePath,
              files
            });
          
          default:
            return json(res, 400, { error: 'Unknown action', action });
        }
      } catch (e) {
        return json(res, 500, {
          error: String(e.message || e),
          action,
          path: filePath
        });
      }
    }

    // Full Access - Process management
    if (pathname === '/api/pc/process' && req.method === 'POST') {
      const body = await readBody(req);
      const action = String(body.action || '');
      const processName = String(body.name || '');
      const pid = body.pid ? Number(body.pid) : null;
      const confirm = body.confirm || false;
      
      if (!action) return json(res, 400, { error: 'action required' });
      
      try {
        switch (action) {
          case 'list':
            if (os.platform() === 'win32') {
              const { stdout } = await execAsync('tasklist /FO JSON');
              return json(res, 200, { success: true, processes: stdout });
            } else {
              const { stdout } = await execAsync('ps aux');
              return json(res, 200, { success: true, processes: stdout });
            }
          
          case 'kill':
            if (!pid && !processName) return json(res, 400, { error: 'pid or name required' });
            if (!confirm) {
              return json(res, 403, {
                error: 'УБИЙСТВО ПРОЦЕССА!',
                action,
                pid,
                name: processName,
                warning: 'Для убийства процесса отправьте confirm: true'
              });
            }
            if (pid) {
              if (os.platform() === 'win32') {
                await execAsync(`taskkill /PID ${pid} /F`);
              } else {
                await execAsync(`kill -9 ${pid}`);
              }
              return json(res, 200, { success: true, action: 'kill', pid, message: 'Процесс убит' });
            } else {
              if (os.platform() === 'win32') {
                await execAsync(`taskkill /IM ${processName} /F`);
              } else {
                await execAsync(`pkill -9 ${processName}`);
              }
              return json(res, 200, { success: true, action: 'kill', name: processName, message: 'Процесс убит' });
            }
          
          case 'start':
            if (!processName) return json(res, 400, { error: 'name required' });
            if (os.platform() === 'win32') {
              await execAsync(`start ${processName}`);
            } else {
              await execAsync(processName);
            }
            return json(res, 200, { success: true, action: 'start', name: processName, message: 'Процесс запущен' });
          
          default:
            return json(res, 400, { error: 'Unknown action', action });
        }
      } catch (e) {
        return json(res, 500, { error: String(e.message || e) });
      }
    }

    if (pathname === '/api/pc/system' && req.method === 'GET') {
      try {
        const systemInfo = {
          platform: os.platform(),
          arch: os.arch(),
          cpus: os.cpus().length,
          totalMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024) + ' GB',
          freeMemory: Math.round(os.freemem() / 1024 / 1024 / 1024) + ' GB',
          hostname: os.hostname(),
          uptime: Math.round(os.uptime() / 60) + ' minutes',
          nodeVersion: process.version,
        };
        return json(res, 200, systemInfo);
      } catch (e) {
        return json(res, 500, { error: String(e.message || e) });
      }
    }

    if (pathname === '/api/pc/execute' && req.method === 'POST') {
      const body = await readBody(req);
      const command = String(body.command || '');
      if (!command.trim()) return json(res, 400, { error: 'command required' });

      try {
        // Security: Only allow safe commands
        const safeCommands = ['system_info', 'processes', 'files', 'network'];
        if (safeCommands.includes(command)) {
          let result = '';
          
          switch (command) {
            case 'system_info':
              result = JSON.stringify({
                platform: os.platform(),
                arch: os.arch(),
                cpus: os.cpus().length,
                totalMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024) + ' GB',
                freeMemory: Math.round(os.freemem() / 1024 / 1024 / 1024) + ' GB',
                hostname: os.hostname(),
                uptime: Math.round(os.uptime() / 60) + ' minutes',
              }, null, 2);
              break;
            case 'processes':
              // List running processes (platform independent)
              if (os.platform() === 'win32') {
                const { stdout } = await execAsync('tasklist /FI "MEMUSAGE gt 0" /FO CSV');
                result = stdout;
              } else {
                const { stdout } = await execAsync('ps aux --sort=-%mem | head -20');
                result = stdout;
              }
              break;
            case 'files':
              // List files in current directory
              const files = fs.readdirSync(process.cwd()).slice(0, 20);
              result = files.join('\n');
              break;
            case 'network':
              // Network info
              if (os.platform() === 'win32') {
                const { stdout } = await execAsync('ipconfig');
                result = stdout;
              } else {
                const { stdout } = await execAsync('ifconfig || ip addr');
                result = stdout;
              }
              break;
          }
          
          return json(res, 200, { output: result });
        } else {
          // For custom commands, add security checks
          // Allow only basic safe commands
          const allowedPatterns = [
            /^ls\s/,
            /^dir\s/,
            /^cd\s/,
            /^pwd/,
            /^echo\s/,
            /^date/,
            /^time/,
            /^whoami/,
          ];
          
          const isAllowed = allowedPatterns.some(pattern => pattern.test(command.toLowerCase()));
          
          if (!isAllowed) {
            return json(res, 400, { error: 'Command not allowed for security reasons' });
          }
          
          // Execute the command
          const { stdout, stderr } = await execAsync(command, { timeout: 10000 });
          const output = stdout || stderr;
          return json(res, 200, { output });
        }
      } catch (e) {
        return json(res, 500, { error: String(e.message || e) });
      }
    }

    // ===== AI Agent API - Execute commands from AI =====
    if (pathname === '/api/ai/execute' && req.method === 'POST') {
      const body = await readBody(req);
      const command = String(body.command || '');
      const sessionId = body.sessionId || null;
      
      if (!command.trim()) return json(res, 400, { error: 'command required' });
      
      try {
        // Security: Only allow safe commands
        const safeCommands = ['system_info', 'processes', 'files', 'network', 'list_files', 'cpu_info', 'memory_info'];
        if (safeCommands.includes(command)) {
          let result = '';
          
          switch (command) {
            case 'system_info':
              result = JSON.stringify({
                type: 'system_info',
                data: {
                  platform: os.platform(),
                  arch: os.arch(),
                  cpus: os.cpus().length,
                  totalMemoryGB: Math.round(os.totalmem() / 1024 / 1024 / 1024),
                  freeMemoryGB: Math.round(os.freemem() / 1024 / 1024 / 1024),
                  hostname: os.hostname(),
                  uptimeMinutes: Math.round(os.uptime() / 60),
                  nodeVersion: process.version,
                }
              }, null, 2);
              break;
            case 'processes':
              if (os.platform() === 'win32') {
                const { stdout } = await execAsync('tasklist /FO CSV /NH');
                result = stdout;
              } else {
                const { stdout } = await execAsync('ps aux --sort=-%mem | head -20');
                result = stdout;
              }
              break;
            case 'files':
            case 'list_files':
              const files = fs.readdirSync(process.cwd()).slice(0, 30);
              result = files.join('\n');
              break;
            case 'network':
              if (os.platform() === 'win32') {
                const { stdout } = await execAsync('ipconfig');
                result = stdout;
              } else {
                const { stdout } = await execAsync('ifconfig 2>/dev/null || ip addr');
                result = stdout;
              }
              break;
            case 'cpu_info':
              result = JSON.stringify({
                type: 'cpu_info',
                data: os.cpus().map(c => ({
                  model: c.model,
                  speed: c.speed,
                  times: c.times
                }))
              }, null, 2);
              break;
            case 'memory_info':
              result = JSON.stringify({
                type: 'memory_info',
                data: {
                  total: os.totalmem(),
                  free: os.freemem(),
                  used: os.totalmem() - os.freemem(),
                  usagePercent: Math.round((1 - os.freemem() / os.totalmem()) * 100)
                }
              }, null, 2);
              break;
          }
          
          // Save to session if provided
          if (sessionId && sessions[sessionId]) {
            const aiMsg = {
              role: 'assistant',
              content: `Команда выполнена: ${command}\n\nРезультат:\n\n${result}`,
              modelId: sessions[sessionId].modelId,
              at: Date.now(),
              isCommand: true,
              command: command
            };
            sessions[sessionId].messages.push(aiMsg);
            sessions[sessionId].updatedAt = Date.now();
            persistSessions();
          }
          
          return json(res, 200, { 
            success: true, 
            command, 
            result,
            message: `Команда "${command}" выполнена успешно` 
          });
        } else {
          // For custom commands, add security checks
          const allowedPatterns = [
            /^ls\s/,
            /^dir\s/,
            /^cd\s/,
            /^pwd/,
            /^echo\s/,
            /^cat\s/,
            /^type\s/,
            /^date/,
            /^time/,
            /^whoami/,
            /^uname/,
            /^df\s/,
            /^free/,
          ];
          
          const isAllowed = allowedPatterns.some(pattern => pattern.test(command.toLowerCase()));
          
          if (!isAllowed) {
            return json(res, 400, { 
              error: 'Команда не разрешена по соображениям безопасности',
              suggestion: 'Используйте: system_info, processes, files, network'
            });
          }
          
          const { stdout, stderr } = await execAsync(command, { timeout: 15000 });
          const output = stdout || stderr;
          
          return json(res, 200, { 
            success: true, 
            command, 
            result: output,
            message: `Команда "${command}" выполнена` 
          });
        }
      } catch (e) {
        return json(res, 500, { 
          error: String(e.message || e), 
          command 
        });
      }
    }

    // ===== AI Agent API - List available commands =====
    if (pathname === '/api/ai/commands' && req.method === 'GET') {
      return json(res, 200, {
        commands: [
          { name: 'system_info', description: 'Получить информацию о системе', safe: true },
          { name: 'processes', description: 'Показать активные процессы', safe: true },
          { name: 'files', description: 'Список файлов в текущей директории', safe: true },
          { name: 'network', description: 'Сетевая информация', safe: true },
          { name: 'cpu_info', description: 'Информация о процессоре', safe: true },
          { name: 'memory_info', description: 'Информация о памяти', safe: true },
        ],
        capabilities: [
          'Чат с AI',
          'Выполнение команд на ПК',
          'Анализ файлов',
          'Управление процессами',
          'Получение системной информации'
        ]
      });
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