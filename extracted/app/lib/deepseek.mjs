import { PowSolver } from './pow.mjs';

const BASE = 'https://chat.deepseek.com';
const COMPLETION_PATH = '/api/v0/chat/completion';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export class DeepSeekError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DeepSeekError';
    this.code = code;
  }
}

export class DeepSeekClient {
  constructor({ token, deviceId = '', solver } = {}) {
    this.token = token || '';
    this.deviceId = deviceId || '';
    this.solver = solver || new PowSolver({ size: Math.max(1, Math.min(4, Math.floor((globalThis.navigator?.hardwareConcurrency || 4) / 2))) });
    this.warm = null;
  }

  setToken(token) {
    if (token !== this.token) this.warm = null;
    this.token = token;
  }

  #headers(extra = {}) {
    return {
      accept: '*/*',
      'accept-language': 'en-GB,en;q=0.9',
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      origin: BASE,
      referer: `${BASE}/`,
      'user-agent': UA,
      'x-client-bundle-id': 'com.deepseek.chat',
      'x-client-locale': 'en_GB',
      'x-client-platform': 'web',
      'x-client-timezone-offset': '0',
      'x-client-version': '2.7.1',
      ...(this.deviceId ? { 'x-device-id': this.deviceId, 'x-device-model': '' } : {}),
      ...extra,
    };
  }

  async #getJson(pathName) {
    const res = await fetch(BASE + pathName, { method: 'GET', headers: this.#headers() });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new DeepSeekError(`bad json from ${pathName}: ${text.slice(0, 120)}`, res.status); }
    if (json.code !== 0) throw new DeepSeekError(json.msg || `api code ${json.code}`, json.code);
    return json.data?.biz_data;
  }

  async #postJson(pathName, body) {
    const res = await fetch(BASE + pathName, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new DeepSeekError(`bad json from ${pathName}: ${text.slice(0, 200)}`, res.status); }
    if (json.code !== 0) throw new DeepSeekError(json.msg || `api code ${json.code}`, json.code);
    return json.data?.biz_data;
  }

  async currentUser() {
    return this.#getJson('/api/v0/users/current');
  }

  async createSession() {
    const data = await this.#postJson('/api/v0/chat_session/create', {});
    return data.chat_session;
  }

  async createChallenge(targetPath = COMPLETION_PATH) {
    const data = await this.#postJson('/api/v0/chat/create_pow_challenge', { target_path: targetPath });
    return data.challenge;
  }

  /** Solve a challenge ahead of time so a real send is instant. */
  async prefetch() {
    if (this.warm) return this.warm;
    this.warm = (async () => {
      const challenge = await this.createChallenge();
      const answer = await this.solver.solve(challenge);
      return { challenge, answer, header: this.solver.buildHeader(answer, COMPLETION_PATH), createdAt: Date.now() };
    })();
    this.warm.catch(() => { this.warm = null; });
    return this.warm;
  }

  async #takePow() {
    const warm = this.warm;
    this.warm = null;
    if (warm) {
      try {
        const solved = await warm;
        if (Date.now() - solved.createdAt < 240_000) return solved.header;
      } catch { /* fall through to a fresh solve */ }
    }
    const challenge = await this.createChallenge();
    const answer = await this.solver.solve(challenge);
    return this.solver.buildHeader(answer, COMPLETION_PATH);
  }

  /**
   * Stream a completion. Yields {type:'text'|'thinking'|'status'|'done'|'error', ...}
   */
  async *completion({ sessionId, parentMessageId = null, prompt, thinking = false, search = true, modelType = null }) {
    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      const pow = await this.#takePow();
      const res = await fetch(BASE + COMPLETION_PATH, {
        method: 'POST',
        headers: this.#headers({ 'x-ds-pow-response': pow, accept: 'text/event-stream' }),
        body: JSON.stringify({
          chat_session_id: sessionId,
          parent_message_id: parentMessageId,
          model_type: modelType,
          prompt,
          ref_file_ids: [],
          thinking_enabled: thinking,
          search_enabled: search,
          action: null,
          preempt: false,
        }),
      });

      const ctype = res.headers.get('content-type') || '';
      if (!ctype.includes('text/event-stream')) {
        const text = await res.text();
        let code;
        try { code = JSON.parse(text).code; } catch { /* ignore */ }
        // 40301 INVALID_POW_RESPONSE / 40303 CHALLENGE_REQUIRED — retry with a fresh solve.
        if (attempt === 1 && (code === 40301 || code === 40303)) continue;
        throw new DeepSeekError(text.slice(0, 300), code);
      }

      let responseMessageId = null;
      const fragTypes = new Map();
      let textIndex = -1;

      for await (const evt of parseSse(res.body)) {
        if (evt.type === 'error') throw new DeepSeekError(evt.message, 'stream');
        let d = evt.data;
        if (!d || typeof d !== 'object') continue;

        // The opening snapshot arrives wrapped: {"v":{"response":{...}}}
        if (d.response === undefined && d.v && typeof d.v === 'object' && d.v.response) {
          d = d.v;
        }

        if (d.response) {
          responseMessageId = d.response.message_id ?? responseMessageId;
          const frags = d.response.fragments || [];
          for (let i = 0; i < frags.length; i++) {
            const f = frags[i];
            fragTypes.set(i, f.type);
            if (f.type === 'RESPONSE') {
              textIndex = i;
              // The opening fragment arrives with content already in it.
              if (f.content) yield { type: 'text', text: String(f.content) };
            }
          }
          if (d.response.search_triggered !== undefined) {
            yield { type: 'status', searchTriggered: d.response.search_triggered };
          }
          continue;
        }

        if (typeof d.p === 'string' && d.o === 'APPEND' && d.p.endsWith('/content')) {
          const m = d.p.match(/fragments\/(-?\d+)\/content$/);
          let idx = m ? Number(m[1]) : -1;
          if (idx === -1) idx = fragTypes.size ? fragTypes.size - 1 : 0;
          const kind = fragTypes.get(idx) || 'RESPONSE';
          if (kind === 'RESPONSE') {
            textIndex = idx;
            yield { type: 'text', text: String(d.v ?? '') };
          } else {
            yield { type: 'thinking', text: String(d.v ?? '') };
          }
          continue;
        }

        // Later chunks omit the path entirely: {"v":" more text"} continues the
        // fragment the server already announced.
        if (d.p === undefined && typeof d.v === 'string') {
          const kind = textIndex >= 0 ? fragTypes.get(textIndex) || 'RESPONSE' : 'RESPONSE';
          if (kind === 'RESPONSE') yield { type: 'text', text: d.v };
          else yield { type: 'thinking', text: d.v };
          continue;
        }

        if (d.p === 'response/status' && d.v === 'FINISHED') {
          yield { type: 'done', messageId: responseMessageId, textIndex };
          return;
        }
        if (d.p === 'response' && Array.isArray(d.v)) {
          const fin = d.v.find((x) => x.p === 'quasi_status' && x.v === 'FINISHED');
          if (fin) {
            yield { type: 'done', messageId: responseMessageId, textIndex };
            return;
          }
        }
      }
      yield { type: 'done', messageId: responseMessageId, textIndex };
      return;
    }
  }
}

async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buf = '';
  const reader = body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evt = parseBlock(block);
      if (evt) yield evt;
    }
  }
  if (buf.trim()) {
    const evt = parseBlock(buf);
    if (evt) yield evt;
  }
}

function parseBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  const raw = dataLines.join('\n');
  if (event === 'error') return { type: 'error', message: raw };
  if (event !== 'message' && event !== 'data') {
    if (event === 'close') return { type: 'close', data: safeJson(raw) };
    return { type: 'event', event, data: safeJson(raw) };
  }
  return { type: 'data', data: safeJson(raw) };
}

function safeJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}