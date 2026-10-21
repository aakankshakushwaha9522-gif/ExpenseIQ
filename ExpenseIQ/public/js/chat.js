/**
 * chat.js — AI assistant UI.
 * The browser never talks to Gemini. It sends only the question to our backend, which
 * identifies the user from the login cookie, loads *that user's* data, computes the
 * numbers, and only then calls Gemini with the API key kept in server environment variables.
 * Chat history is stored by the server and pushed live (also to other open tabs).
 */
const Chat = (function () {
  const SUGGESTIONS = [
    'How much money did I spend this month?',
    'Which category has the highest expenses?',
    'What is my total monthly budget?',
    "Compare this month's expenses with last month's.",
    'How can I reduce unnecessary expenses?',
    'Predict my expenses for next month.',
  ];
  const MAX_LEN = 500;

  let history = [];          // from the server
  let local = [];            // optimistic / not-yet-synced messages
  let busy = false;
  let loaded = false;

  /** Escapes first, then applies a tiny safe subset of markdown. */
  function renderMd(text) {
    const lines = esc(text).split('\n');
    let html = '', inList = false;
    for (const raw of lines) {
      const line = raw.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      const m = /^\s*(?:[-*•])\s+(.*)$/.exec(line);
      if (m) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${m[1]}</li>`; }
      else { if (inList) { html += '</ul>'; inList = false; } html += line.trim() ? `<p>${line}</p>` : ''; }
    }
    return html + (inList ? '</ul>' : '');
  }

  const time = (ts) => new Date(ts).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });

  function bubble(m) {
    const bot = m.role === 'assistant';
    const warn = bot && m.degraded ? '<div class="bubble-note">⚠️ AI unavailable — this summary was calculated directly from your data.</div>' : '';
    const body = bot ? renderMd(m.text) : `<p>${esc(m.text)}</p>`;
    return `<div class="msg ${bot ? 'msg-bot' : 'msg-user'}${m.error ? ' msg-error' : ''}">
      <div class="msg-avatar" aria-hidden="true">${bot ? '🤖' : '🙂'}</div>
      <div class="msg-bubble"><span class="sr-only">${bot ? 'Assistant' : 'You'}: </span>${body}${warn}<time class="msg-time">${esc(time(m.ts))}</time></div>
    </div>`;
  }

  function render() {
    const log = $('chat-log');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    // drop local copies once the database delivered the same message
    local = local.filter((l) => !(l.synced !== false && history.some((h) => h.role === l.role && h.text === l.text && Math.abs(h.ts - l.ts) < 120000)));
    const all = [...history, ...local].sort((a, b) => a.ts - b.ts);

    let html = '';
    if (!loaded && !all.length) html = '<div class="chat-empty"><div class="spinner"></div></div>';
    else if (!all.length) html = `<div class="chat-empty"><div class="empty-icon" aria-hidden="true">🤖</div><div class="empty-title">Ask me about your money</div><div class="empty-sub">Try one of the suggestions below.</div></div>`;
    else html = all.map(bubble).join('');
    if (busy) html += `<div class="msg msg-bot"><div class="msg-avatar" aria-hidden="true">🤖</div><div class="msg-bubble typing" role="status" aria-label="Assistant is typing"><span></span><span></span><span></span></div></div>`;
    log.innerHTML = html;
    if (nearBottom || busy) log.scrollTop = log.scrollHeight;

    $('chat-send').disabled = busy;
    $('chat-input').disabled = busy;
    $('chat-suggestions').innerHTML = SUGGESTIONS.map((s) =>
      `<button type="button" class="quick-chip" data-action="chat-suggest" data-arg="${esc(s)}"${busy ? ' disabled' : ''}>${esc(s)}</button>`).join('');
  }

  const setHistory = (messages) => {
    history = (messages || []).map((m) => ({ role: m.role, text: String(m.text || ''), ts: Number(m.ts) || 0, degraded: !!m.degraded }));
    loaded = true;
    render();
  };
  // The server pushes the history over the live stream (initially and whenever it changes).
  Store.onChat(setHistory);

  async function start() {
    stop();
    try {
      const res = await apiFetch('GET', '/api/chat/history');
      if (res.ok && !loaded) setHistory(res.data.messages);
    } catch { /* the live stream will deliver it */ }
    loaded = true; render();
  }

  function stop() { history = []; local = []; busy = false; loaded = false; }

  async function send(text) {
    text = String(text || '').trim();
    if (busy || !text) return;
    if (text.length > MAX_LEN) { toast(`Please keep questions under ${MAX_LEN} characters.`, 'error'); return; }
    if (navigator.onLine === false) { toast('You are offline — the assistant needs a connection.', 'error'); return; }

    const sentAt = Date.now();
    local.push({ role: 'user', text, ts: sentAt });
    busy = true;
    $('chat-input').value = '';
    render();

    try {
      const res = await apiFetch('POST', '/api/chat', { message: text, month: thisMonth(), today: todayStr() });
      const data = res.data;
      if (res.status === 401) Store.notifySessionExpired();
      if (!res.ok) {
        const msg = res.status === 401 ? 'Your session expired. Please sign in again.'
          : res.status === 429 ? (data.error || 'Too many messages — please wait a moment.')
          : (data.error || 'Something went wrong. Please try again.');
        local.push({ role: 'assistant', text: msg, ts: Date.now(), error: true, synced: false });
      } else {
        local.push({ role: 'assistant', text: data.reply, ts: data.timestamp || Date.now(), degraded: !!data.degraded });
        if (data.degraded && data.notice) toast(data.notice, 'error');
      }
    } catch (err) {
      local.push({ role: 'assistant', text: 'Could not reach the server. Check your connection and try again.', ts: Date.now(), error: true, synced: false });
    } finally {
      busy = false;
      render();
      $('chat-input').focus();
    }
  }

  async function clear() {
    try {
      const res = await apiFetch('DELETE', '/api/chat/history');
      if (!res.ok) throw new Error('failed');
      local = [];
      toast('Chat cleared', 'success');
    } catch { toast('Could not clear the chat.', 'error'); }
  }

  function onShow() { render(); setTimeout(() => $('chat-input').focus(), 50); }

  return { start, stop, send, clear, onShow, renderMd };
}());
