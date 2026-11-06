// ===== State Management =====
const state = {
  models: [],
  sessions: [],
  activeModelId: null,
  activeSessionId: null,
  sending: false,
  pcMode: false,
};

const el = (id) => document.getElementById(id);

const ui = {
  // Main elements
  modelList: el('modelList'),
  modelCount: el('modelCount'),
  sessionList: el('sessionList'),
  messages: el('messages'),
  emptyState: el('emptyState'),
  activeModel: el('activeModel'),
  activeMeta: el('activeMeta'),
  accountLine: el('accountLine'),
  input: el('input'),
  sendBtn: el('sendBtn'),
  composer: el('composer'),
  
  // Quick actions
  newChatBtn: el('newChatBtn'),
  pcControlBtn: el('pcControlBtn'),
  
  // PC Panel
  pcPanel: el('pcPanel'),
  closePCPanel: el('closePCPanel'),
  pcCommandInput: el('pcCommandInput'),
  execPCCommand: el('execPCCommand'),
  pcOutput: el('pcOutput'),
  
  // Toggles
  thinkingToggle: el('thinkingToggle'),
  searchToggle: el('searchToggle'),
  
  // Modals
  tokenModal: el('tokenModal'),
  closeTokenModal: el('closeTokenModal'),
  tokenInput: el('tokenInput'),
  tokenError: el('tokenError'),
  tokenSave: el('tokenSave'),
  
  settingsModal: el('settingsModal'),
  closeSettingsModal: el('closeSettingsModal'),
  closeSettingsBtn: el('closeSettingsBtn'),
  saveSettingsBtn: el('saveSettingsBtn'),
  settingsBtn: el('settingsBtn'),
  defaultModelSelect: el('defaultModelSelect'),
  defaultThinkingSetting: el('defaultThinkingSetting'),
  defaultSearchSetting: el('defaultSearchSetting'),
  
  // System info
  systemStatus: el('systemStatus'),
};

// ===== Utility Functions =====
function fmtTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
  return String(n);
}

function activeModel() {
  return state.models.find((m) => m.id === state.activeModelId) || null;
}

function activeSession() {
  return state.sessions.find((s) => s.id === state.activeSessionId) || null;
}

// ===== Rendering: Sidebar =====
function renderModels() {
  ui.modelCount.textContent = String(state.models.length);
  ui.modelList.innerHTML = '';
  for (const m of state.models) {
    const node = document.createElement('div');
    node.className = 'model-item' + (m.id === state.activeModelId ? ' active' : '');
    node.innerHTML = `<div class="mi-name"></div><div class="mi-file"></div>`;
    node.querySelector('.mi-name').textContent = m.name;
    node.querySelector('.mi-file').textContent = `${m.file} • ~${fmtTokens(m.estTokens)} tok`;
    node.addEventListener('click', () => selectModel(m.id));
    ui.modelList.appendChild(node);
  }
}

function renderSessions() {
  ui.sessionList.innerHTML = '';
  const sorted = [...state.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const s of sorted) {
    const node = document.createElement('div');
    node.className = 'session-item' + (s.id === state.activeSessionId ? ' active' : '');
    
    const icon = document.createElement('div');
    icon.className = 'si-icon';
    icon.innerHTML = s.modelId ? '🤖' : '💬';
    
    const title = document.createElement('div');
    title.className = 'si-title';
    title.textContent = s.title || 'Новый чат';
    
    const del = document.createElement('button');
    del.className = 'si-del';
    del.textContent = '×';
    del.title = 'Удалить чат';
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await fetch('/api/session/delete', { 
        method: 'POST', 
        headers: { 'content-type': 'application/json' }, 
        body: JSON.stringify({ id: s.id }) 
      });
      state.sessions = state.sessions.filter((x) => x.id !== s.id);
      if (state.activeSessionId === s.id) state.activeSessionId = null;
      renderSessions();
      renderMessages();
    });
    
    node.append(icon, title, del);
    node.addEventListener('click', () => {
      state.activeSessionId = s.id;
      if (s.modelId) selectModel(s.modelId, { keepSession: true });
      renderSessions();
      renderMessages();
    });
    ui.sessionList.appendChild(node);
  }
}

function renderHeader() {
  const m = activeModel();
  ui.activeModel.textContent = m ? m.name : '—';
  ui.activeMeta.textContent = m ? `${m.file} • ~${fmtTokens(m.estTokens)} токенов` : '';
}

// ===== Rendering: Messages =====
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function markdown(src) {
  const blocks = [];
  let text = escapeHtml(src).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  text = text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<em>$2</em>')
    .replace(/^#{1,6}\s+(.*)$/gm, '<p><strong>$1</strong></p>');

  const paragraphs = text.split(/\n{2,}/).map((chunk) => {
    const trimmed = chunk.trim();
    if (!trimmed) return '';
    if (/^\u0000BLOCK\d+\u0000$/.test(trimmed)) return trimmed;
    const withBreaks = trimmed.replace(/\n/g, '<br/>');
    return `<p>${withBreaks}</p>`;
  }).join('');

  return paragraphs.replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

function renderMessages() {
  const session = activeSession();
  ui.messages.innerHTML = '';
  if (!session || !session.messages || session.messages.length === 0) {
    ui.messages.appendChild(ui.emptyState);
    ui.emptyState.hidden = false;
    return;
  }
  ui.emptyState.hidden = true;
  for (const msg of session.messages) appendMessageDom(msg.role, msg.content, false);
  scrollToBottom();
}

function appendMessageDom(role, content, streaming) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = role === 'user' ? 'you' : 'ai';
  const body = document.createElement('div');
  body.className = 'body' + (streaming ? ' cursor' : '');
  if (role === 'assistant') body.innerHTML = markdown(content);
  else body.textContent = content;
  wrap.append(who, body);
  ui.messages.appendChild(wrap);
  return { wrap, body };
}

function scrollToBottom() {
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

// ===== PC Control Functions =====
function showPCPanel() {
  state.pcMode = true;
  ui.pcPanel.hidden = false;
  ui.pcOutput.textContent = 'Готов к выполнению команд...';
  ui.pcCommandInput.value = '';
  ui.pcCommandInput.focus();
}

function hidePCPanel() {
  state.pcMode = false;
  ui.pcPanel.hidden = true;
}

async function executePCCommand(cmd) {
  try {
    ui.pcOutput.textContent = 'Выполняется...';
    
    const res = await fetch('/api/pc/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: cmd }),
    });
    
    const data = await res.json();
    
    if (data.error) {
      ui.pcOutput.textContent = `Ошибка: ${data.error}`;
    } else {
      ui.pcOutput.textContent = data.output || 'Команда выполнена успешно';
    }
  } catch (err) {
    ui.pcOutput.textContent = `Ошибка: ${err.message}`;
  }
}

// ===== Actions =====
function selectModel(modelId, opts = {}) {
  state.activeModelId = modelId;
  renderModels();
  renderHeader();
  const session = activeSession();
  if (session && session.modelId !== modelId) {
    session.modelId = modelId;
  }
  if (!opts.keepSession) {
    const current = activeSession();
    if (current && current.messages && current.messages.length) {
      // keep the chat
    }
  }
}

async function newChat() {
  if (!state.activeModelId) return;
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: state.activeModelId }),
  });
  const data = await res.json();
  if (data.error) return;
  state.sessions.push({ ...data.session, messages: [] });
  state.activeSessionId = data.session.id;
  renderSessions();
  renderMessages();
  ui.input.focus();
}

async function send(message) {
  if (state.sending) return;
  if (!state.activeSessionId) await newChat();
  const session = activeSession();
  if (!session) return;

  state.sending = true;
  ui.sendBtn.disabled = true;

  session.messages = session.messages || [];
  session.messages.push({ role: 'user', content: message });
  if (!session.title || session.title === 'New chat') session.title = message.slice(0, 60);
  renderSessions();
  renderMessages();

  const { body } = appendMessageDom('assistant', '', true);
  let text = '';
  let lastPaint = 0;
  const paint = (force) => {
    const now = performance.now();
    if (!force && now - lastPaint < 55) return;
    lastPaint = now;
    body.innerHTML = markdown(text);
    scrollToBottom();
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.id,
        modelId: state.activeModelId,
        message,
        thinking: ui.thinkingToggle.checked,
        search: ui.searchToggle.checked,
      }),
    });

    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: 'request failed' }));
      throw new Error(err.error || 'request failed');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!block.startsWith('data:')) continue;
        let evt;
        try { evt = JSON.parse(block.slice(5).trim()); } catch { continue; }
        if (evt.type === 'delta') { text += evt.text; paint(false); }
        else if (evt.type === 'error') { text += (text ? '\n\n' : '') + `[ошибка: ${evt.message}]`; paint(true); }
        else if (evt.type === 'done') paint(true);
      }
    }
  } catch (err) {
    text += (text ? '\n\n' : '') + `[ошибка: ${err.message}]`;
  } finally {
    paint(true);
    body.classList.remove('cursor');
    session.messages.push({ role: 'assistant', content: text, modelId: state.activeModelId });
    session.updatedAt = Date.now();
    renderSessions();
    state.sending = false;
    ui.sendBtn.disabled = false;
    ui.input.focus();
  }
}

// ===== Boot =====
async function loadState() {
  const res = await fetch('/api/state');
  const data = await res.json();
  state.models = data.models || [];
  state.sessions = data.sessions || [];
  if (!state.activeModelId) {
    const preferred = data.config?.defaultModel;
    state.activeModelId = state.models.some((m) => m.id === preferred) ? preferred : state.models[0]?.id || null;
  }
  ui.thinkingToggle.checked = Boolean(data.config?.defaultThinking);
  ui.searchToggle.checked = data.config?.defaultSearch !== false;
  ui.defaultThinkingSetting.checked = Boolean(data.config?.defaultThinking);
  ui.defaultSearchSetting.checked = data.config?.defaultSearch !== false;

  if (data.user) {
    const name = data.user.id_profile?.name || data.user.email || 'connected';
    ui.accountLine.textContent = name;
  } else {
    ui.accountLine.textContent = data.hasToken ? 'token issue' : 'no token';
  }

  renderModels();
  renderSessions();
  renderHeader();
  renderMessages();

  // Fill model select in settings
  ui.defaultModelSelect.innerHTML = '';
  for (const m of state.models) {
    const option = document.createElement('option');
    option.value = m.id;
    option.textContent = m.name;
    if (m.id === data.config?.defaultModel) option.selected = true;
    ui.defaultModelSelect.appendChild(option);
  }

  if (!data.hasToken || data.authError) {
    ui.tokenModal.hidden = false;
    if (data.authError) ui.tokenError.textContent = data.authError;
  } else {
    fetch('/api/prefetch', { method: 'POST' }).catch(() => {});
  }
}

// ===== Event Listeners =====
ui.newChatBtn.addEventListener('click', newChat);

ui.composer.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const value = ui.input.value.trim();
  if (!value) return;
  ui.input.value = '';
  ui.input.style.height = 'auto';
  send(value);
});

ui.input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    ui.composer.requestSubmit();
  }
});

ui.input.addEventListener('input', () => {
  ui.input.style.height = 'auto';
  ui.input.style.height = Math.min(ui.input.scrollHeight, 200) + 'px';
});

// PC Control
ui.pcControlBtn.addEventListener('click', showPCPanel);
ui.closePCPanel.addEventListener('click', hidePCPanel);

ui.execPCCommand.addEventListener('click', () => {
  const cmd = ui.pcCommandInput.value.trim();
  if (cmd) executePCCommand(cmd);
});

ui.pcCommandInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    const cmd = ui.pcCommandInput.value.trim();
    if (cmd) executePCCommand(cmd);
  }
});

// Command buttons
document.querySelectorAll('.cmd-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const cmd = btn.dataset.cmd;
    executePCCommand(cmd);
  });
});

// Token Modal
ui.closeTokenModal.addEventListener('click', () => {
  ui.tokenModal.hidden = true;
});

ui.tokenSave.addEventListener('click', async () => {
  ui.tokenError.textContent = '';
  const token = ui.tokenInput.value.trim();
  if (!token) return;
  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const data = await res.json();
  if (data.error) {
    ui.tokenError.textContent = data.error;
    return;
  }
  ui.tokenModal.hidden = true;
  loadState();
});

// Settings Modal
ui.settingsBtn.addEventListener('click', () => {
  ui.settingsModal.hidden = false;
});

ui.closeSettingsModal.addEventListener('click', () => {
  ui.settingsModal.hidden = true;
});

ui.closeSettingsBtn.addEventListener('click', () => {
  ui.settingsModal.hidden = true;
});

ui.saveSettingsBtn.addEventListener('click', async () => {
  const settings = {
    defaultModel: ui.defaultModelSelect.value,
    defaultThinking: ui.defaultThinkingSetting.checked,
    defaultSearch: ui.defaultSearchSetting.checked,
  };
  
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  });
  
  ui.settingsModal.hidden = true;
  loadState();
});

// Close modals on outside click
ui.tokenModal.addEventListener('click', (ev) => {
  if (ev.target === ui.tokenModal) ui.tokenModal.hidden = true;
});

ui.settingsModal.addEventListener('click', (ev) => {
  if (ev.target === ui.settingsModal) ui.settingsModal.hidden = true;
});

// Initialize
loadState();
