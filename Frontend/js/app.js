/* ═══════════════════════════════════════════════════════════════════════════
   EV_Q:?  ·  Main Application
   Routing · GSAP · Charts · Chat · Vehicle Telemetry · Toaster
════════════════════════════════════════════════════════════════════════════ */

'use strict';

/* ── Config ─────────────────────────────────────────────────────────────── */
const API = 'http://localhost:8000';

const AGENT_META = {
  TechnicianAgent:     { icon: '⚙️',  color: '#00e5ff', role: 'Technical Support' },
  ResellerAgent:       { icon: '🚗',  color: '#00ff9d', role: 'Sales & Resale' },
  FinancierAgent:      { icon: '💳',  color: '#ffb800', role: 'Finance & EMI' },
  PolicyAgent:         { icon: '🛡️', color: '#ff6b35', role: 'Policy & Legal' },
  RecommendationAgent: { icon: '🧠',  color: '#a78bfa', role: 'Personalization' },
};

/* ── App State ──────────────────────────────────────────────────────────── */
// Persistent session ID — one per browser tab, kept for the whole session
const SESSION_ID = crypto.randomUUID ? crypto.randomUUID()
                 : Math.random().toString(36).slice(2) + Date.now().toString(36);

const S = {
  currentPage:   null,          // null = nothing initialized yet
  currentMode:   'NORMAL',
  vehicleHistory: { speed: [], battery: [], power: [], labels: [] },
  vehiclePollId: null,
  charts:        {},
  chatHistory:   [],
  sessionAgentCounts: {},
  queryCount:    0,
  prevVehicleData: null,
};
const MAX_HISTORY = 40;

/* ══════════════════════════════════════════════════════════════════════════
   TOAST
══════════════════════════════════════════════════════════════════════════ */
const Toast = {
  _container: null,
  _init() {
    this._container = document.getElementById('toast-container');
  },
  show(msg, type = 'info', duration = 3500) {
    const icons = { success: '✅', error: '❌', info: '⚡', warning: '⚠️' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type]}</span><span class="toast-msg">${msg}</span>`;
    this._container.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, duration);
  },
  success: (m, d) => Toast.show(m, 'success', d),
  error:   (m, d) => Toast.show(m, 'error',   d),
  info:    (m, d) => Toast.show(m, 'info',    d),
  warning: (m, d) => Toast.show(m, 'warning', d),
};

/* ══════════════════════════════════════════════════════════════════════════
   ROUTER
══════════════════════════════════════════════════════════════════════════ */
function showPage(id) {
  const prev = S.currentPage;
  // Skip only if navigating to same page that's already been initialized
  if (prev === id && S._pageInitialized) return;
  S._pageInitialized = true;
  S.currentPage = id;

  // Show / hide pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(`page-${id}`);
  if (target) target.classList.add('active');

  // Nav links active state
  document.querySelectorAll('.nav-link, .drawer-link').forEach(a => {
    a.classList.toggle('active', a.dataset.page === id);
  });

  // Cleanup vehicle-matrix subscribers when leaving (keep bus alive for badge)
  if (prev === 'vehicle-matrix') {
    stopVehiclePoll();
    VehicleBus.subscribe('badge', _updateVehicleSensorBadge);
    VehicleBus.start();
  }

  // Init new page — guard flags inside each init prevent re-running heavy work
  if      (id === 'home')           initHome();
  else if (id === 'neural-hub')     initNeuralHub();
  else if (id === 'vehicle-matrix') initVehicleMatrix();
  else if (id === 'about')          initAbout();

  closeDrawer();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/* ══════════════════════════════════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════════════════════════════════ */
function initNav() {
  const ham      = document.getElementById('hamburger');
  const drawer   = document.getElementById('mobile-drawer');
  const backdrop = document.getElementById('drawer-backdrop');
  const closeBtn = document.getElementById('drawer-close');

  function openDrawer() {
    ham?.classList.add('open');
    ham?.setAttribute('aria-expanded', 'true');
    drawer?.classList.add('open');
    drawer?.setAttribute('aria-hidden', 'false');
    backdrop?.classList.add('visible');
    document.body.style.overflow = 'hidden';  // prevent background scroll
  }

  function doClose() {
    ham?.classList.remove('open');
    ham?.setAttribute('aria-expanded', 'false');
    drawer?.classList.remove('open');
    drawer?.setAttribute('aria-hidden', 'true');
    backdrop?.classList.remove('visible');
    document.body.style.overflow = '';
  }

  ham?.addEventListener('click', () => {
    if (drawer?.classList.contains('open')) doClose(); else openDrawer();
  });

  // Close on backdrop click
  backdrop?.addEventListener('click', doClose);

  // Close button inside drawer
  closeBtn?.addEventListener('click', doClose);

  // Close on Escape
  document.addEventListener('keydown', e => { if (e.key === 'Escape') doClose(); });

  // Nav links (all [data-page] elements)
  document.querySelectorAll('[data-page]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      showPage(a.dataset.page);
    });
  });

  // CTA buttons
  document.querySelectorAll('[data-goto]').forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.dataset.goto));
  });

  // Quick query cards on home
  document.querySelectorAll('.quick-card[data-query]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.pendingQuery = btn.dataset.query;
      showPage('neural-hub');
    });
  });

  // Hash routing
  const hash = location.hash.replace('#', '');
  const valid = ['home', 'neural-hub', 'vehicle-matrix', 'about'];
  if (valid.includes(hash)) showPage(hash);

  // Scroll nav shadow
  window.addEventListener('scroll', () => {
    document.getElementById('nav')?.classList.toggle('scrolled', window.scrollY > 10);
  }, { passive: true });
}

function closeDrawer() {
  document.getElementById('hamburger')?.classList.remove('open');
  document.getElementById('mobile-drawer')?.classList.remove('open');
  document.getElementById('drawer-backdrop')?.classList.remove('visible');
  document.body.style.overflow = '';
}

/* ══════════════════════════════════════════════════════════════════════════
   API STATUS
══════════════════════════════════════════════════════════════════════════ */
async function checkApiStatus() {
  const dots   = document.querySelectorAll('.status-dot');
  const labels = ['#api-status-label', '#drawer-status-label'].map(s => document.querySelector(s));
  try {
    const r = await fetch(`${API}/`, { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    const online = d.status === 'online' && d.agents;
    dots.forEach(d2 => {
      d2.classList.toggle('online', online);
      d2.classList.toggle('offline', !online);
    });
    labels.forEach(l => { if (l) l.textContent = online ? 'Online · Agents Ready' : 'Initialising…'; });
    if (online) Toast.success('EV_Q agents are online and ready!');
    else        Toast.info('Agents are initialising — please wait…');
    return online;
  } catch {
    dots.forEach(d2 => { d2.classList.add('offline'); d2.classList.remove('online'); });
    labels.forEach(l => { if (l) l.textContent = 'Offline'; });
    Toast.error('Cannot reach backend. Start server: uvicorn server:app --reload', 6000);
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   HOME PAGE
══════════════════════════════════════════════════════════════════════════ */
function initHome() {
  // ── Three.js hero: init on first visit, stays alive permanently ────────
  if (!S._homeThreeInit) {
    S._homeThreeInit = true;
    // Triple rAF: page active → browser paint → layout calc → Three.js init
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => HeroScene.init('hero-canvas'))
      )
    );
  }

  // ── One-time setup: counters, GSAP, charts ───────────────────────────────
  if (!S._homeStaticInit) {
    S._homeStaticInit = true;

    animateCounters();

    gsap.registerPlugin(ScrollTrigger);
    gsap.utils.toArray('.feature-card').forEach((card, i) => {
      gsap.from(card, {
        scrollTrigger: { trigger: card, start: 'top 88%', toggleActions: 'play none none none' },
        opacity: 0, y: 40, duration: 0.6, delay: i * 0.07, ease: 'power3.out',
      });
    });
    gsap.utils.toArray('.quick-card').forEach((card, i) => {
      gsap.from(card, {
        scrollTrigger: { trigger: card, start: 'top 90%' },
        opacity: 0, x: -20, duration: 0.5, delay: i * 0.06, ease: 'power2.out',
      });
    });

    gsap.from('.hero-badge',    { opacity: 0, y: -20, duration: 0.6, ease: 'power3.out', delay: 0.2 });
    gsap.from('.hero-title',    { opacity: 0, y: 30,  duration: 0.8, ease: 'power3.out', delay: 0.35 });
    gsap.from('.hero-sub',      { opacity: 0, y: 20,  duration: 0.7, ease: 'power3.out', delay: 0.55 });
    gsap.from('.hero-counters', { opacity: 0, y: 20,  duration: 0.7, ease: 'power3.out', delay: 0.7 });
    gsap.from('.hero-cta',      { opacity: 0, y: 20,  duration: 0.7, ease: 'power3.out', delay: 0.85 });

    buildHomeCharts();
  }

  // ── Always refresh live stats on each visit ──────────────────────────────
  fetchAndUpdateStats();
  refreshAgentChart();
}

function animateCounters() {
  document.querySelectorAll('.counter-val[data-target]').forEach(el => {
    const target = +el.dataset.target;
    gsap.fromTo(el, { innerText: 0 }, {
      innerText: target, duration: 1.8, delay: 0.9,
      snap: { innerText: 1 }, ease: 'power2.out',
      onUpdate() { el.textContent = Math.round(+el.innerText || 0); },
    });
  });
}

async function fetchAndUpdateStats() {
  try {
    const r = await fetch(`${API}/api/stats`);
    const d = await r.json();
    const qEl = document.getElementById('stat-queries');
    if (qEl) {
      gsap.fromTo({ v: 0 }, { v: d.total_queries }, {
        duration: 1.2, ease: 'power2.out',
        onUpdate() { qEl.textContent = Math.round(this.targets()[0].v); },
      });
    }
    S.queryCount = d.total_queries;
  } catch (_) {}
}

function buildHomeCharts() {
  const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#3d6578', font: { family: 'Space Mono', size: 10 } }, grid: { color: 'rgba(0,229,255,.07)' } },
      y: { ticks: { color: '#3d6578', font: { family: 'Space Mono', size: 10 } }, grid: { color: 'rgba(0,229,255,.07)' } },
    },
  };

  // Agent utilisation bar chart
  const agentCtx = document.getElementById('home-agent-chart');
  if (agentCtx && !S.charts.homeAgent) {
    S.charts.homeAgent = new Chart(agentCtx, {
      type: 'bar',
      data: {
        labels: ['Technician', 'Reseller', 'Financier', 'Policy', 'Recommender'],
        datasets: [{
          data: [0, 0, 0, 0, 0],
          backgroundColor: ['rgba(0,229,255,.25)', 'rgba(0,255,157,.25)', 'rgba(255,184,0,.25)', 'rgba(255,107,53,.25)', 'rgba(167,139,250,.25)'],
          borderColor:     ['#00e5ff', '#00ff9d', '#ffb800', '#ff6b35', '#a78bfa'],
          borderWidth: 2, borderRadius: 4,
        }],
      },
      options: { ...chartDefaults },
    });
    refreshAgentChart();
  }

  // Topic doughnut
  const topicCtx = document.getElementById('home-topic-chart');
  if (topicCtx && !S.charts.homeTopic) {
    S.charts.homeTopic = new Chart(topicCtx, {
      type: 'doughnut',
      data: {
        labels: ['Technical', 'Sales', 'Finance', 'Policy', 'Personalization'],
        datasets: [{
          data: [32, 24, 18, 14, 12],
          backgroundColor: ['rgba(0,229,255,.3)', 'rgba(0,255,157,.3)', 'rgba(255,184,0,.3)', 'rgba(255,107,53,.3)', 'rgba(167,139,250,.3)'],
          borderColor:     ['#00e5ff', '#00ff9d', '#ffb800', '#ff6b35', '#a78bfa'],
          borderWidth: 2,
        }],
      },
      options: {
        ...chartDefaults,
        plugins: {
          legend: {
            display: true,
            position: 'right',
            labels: { color: '#7ab8cc', font: { family: 'Space Mono', size: 10 }, boxWidth: 10, padding: 12 },
          },
        },
        cutout: '65%',
      },
    });
  }
}

async function refreshAgentChart() {
  try {
    const r = await fetch(`${API}/api/agents`);
    const d = await r.json();
    const chart = S.charts.homeAgent;
    if (chart && d.agents) {
      chart.data.datasets[0].data = d.agents.map(a => a.queries || 0);
      chart.update('none');
    }
  } catch (_) {}
}

/* ══════════════════════════════════════════════════════════════════════════
   NEURAL HUB — CHAT
══════════════════════════════════════════════════════════════════════════ */
function initNeuralHub() {
  // ── Always-refresh on each visit ─────────────────────────────────────────
  buildAgentPanel();
  buildSessionChart();
  VehicleBus.subscribe('badge', _updateVehicleSensorBadge);
  VehicleBus.start();

  // ── Pending query from home quick-card (handle before guard) ─────────────
  const input = document.getElementById('chat-input');
  if (S.pendingQuery && input) {
    input.value    = S.pendingQuery;
    S.pendingQuery = null;
    setTimeout(doSend, 400);
  }

  // ── Event listeners: attach ONCE using a guard flag ───────────────────────
  if (S._hubListenersAttached) return;
  S._hubListenersAttached = true;

  const sendBtn  = document.getElementById('send-btn');
  const clearBtn = document.getElementById('clear-chat');

  // Auto-resize textarea
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });

  // Enter to send
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });

  sendBtn?.addEventListener('click', doSend);

  clearBtn?.addEventListener('click', () => {
    S.chatHistory = []; S.sessionAgentCounts = {}; S.queryCount = 0;
    const c = document.getElementById('chat-messages');
    if (c) c.innerHTML = buildWelcomeMsg();
    updatePanelStats();
    Toast.info('Conversation cleared');
  });

  // Quick pills — use event delegation on parent to prevent duplicate bindings
  const pillParent = document.querySelector('.chat-quick-pills');
  if (pillParent) {
    pillParent.addEventListener('click', e => {
      const pill = e.target.closest('.pill[data-query]');
      if (!pill) return;
      const inp = document.getElementById('chat-input');
      if (inp) { inp.value = pill.dataset.query; inp.focus(); }
      doSend();
    });
  }

  // GSAP entrance (first visit only)
  gsap.from('.chat-header',  { opacity: 0, y: -20, duration: 0.5, ease: 'power2.out' });
  gsap.from('.agents-panel', { opacity: 0, x: -30, duration: 0.6, ease: 'power3.out', delay: 0.1 });
}

function buildWelcomeMsg() {
  return `
  <div class="msg-row assistant">
    <div class="msg-avatar">⚡</div>
    <div class="msg-bubble">
      <p>Welcome to <strong>EV_Q Neural Hub</strong>. I'm your multi-agent EV intelligence system.</p>
      <p>Ask me anything about electric vehicles — technical, financial, legal, or recommendations!</p>
      <div class="msg-agents-row">
        <span class="msg-agent-badge" style="--c:#00e5ff">⚙️ Technician</span>
        <span class="msg-agent-badge" style="--c:#00ff9d">🚗 Reseller</span>
        <span class="msg-agent-badge" style="--c:#ffb800">💳 Financier</span>
        <span class="msg-agent-badge" style="--c:#ff6b35">🛡️ Policy</span>
        <span class="msg-agent-badge" style="--c:#a78bfa">🧠 Recommender</span>
      </div>
    </div>
  </div>`;
}

function buildAgentPanel() {
  const list = document.getElementById('agents-list');
  if (!list) return;
  list.innerHTML = Object.entries(AGENT_META).map(([id, meta]) => `
    <div class="agent-item" id="agent-item-${id}">
      <div class="ai-avatar" style="color:${meta.color};border-color:${meta.color}40;">${meta.icon}</div>
      <div class="ai-info">
        <div class="ai-name">${id.replace('Agent', '')}</div>
        <div class="ai-role">${meta.role}</div>
      </div>
      <div class="ai-count" id="agent-count-${id}">0</div>
    </div>
  `).join('');
}

function buildSessionChart() {
  const ctx = document.getElementById('session-agent-chart');
  if (!ctx || S.charts.sessionAgent) return;
  S.charts.sessionAgent = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: Object.keys(AGENT_META).map(k => k.replace('Agent', '')),
      datasets: [{
        data: Array(5).fill(0),
        backgroundColor: Object.values(AGENT_META).map(m => m.color + '33'),
        borderColor:     Object.values(AGENT_META).map(m => m.color),
        borderWidth: 2, borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      animation: { duration: 300 },
      scales: {
        x: {
          ticks: { color: '#3d6578', font: { size: 8 }, maxRotation: 0 },
          grid:  { color: 'rgba(0,229,255,.07)' },
        },
        y: {
          ticks: { color: '#3d6578', font: { size: 8 }, maxTicksLimit: 4 },
          grid:  { color: 'rgba(0,229,255,.07)' },
          beginAtZero: true,
        },
      },
    },
  });
}

function highlightAgents(agents) {
  document.querySelectorAll('.agent-item').forEach(el => el.classList.remove('active'));
  agents.forEach(name => {
    const el = document.getElementById(`agent-item-${name}`);
    el?.classList.add('active');
    setTimeout(() => el?.classList.remove('active'), 3000);
    S.sessionAgentCounts[name] = (S.sessionAgentCounts[name] || 0) + 1;
    const countEl = document.getElementById(`agent-count-${name}`);
    if (countEl) countEl.textContent = S.sessionAgentCounts[name];
  });
  updatePanelStats();
  updateSessionChart();
}

function updatePanelStats() {
  const total = Object.values(S.sessionAgentCounts).reduce((a, b) => a + b, 0);
  document.getElementById('panel-query-count')  && (document.getElementById('panel-query-count').textContent  = S.queryCount);
  document.getElementById('panel-agents-fired') && (document.getElementById('panel-agents-fired').textContent = total);
}

function updateSessionChart() {
  const chart = S.charts.sessionAgent;
  if (!chart) return;
  const keys = Object.keys(AGENT_META);
  chart.data.datasets[0].data = keys.map(k => S.sessionAgentCounts[k] || 0);
  chart.update('none');
}

async function doSend() {
  const input = document.getElementById('chat-input');
  const msg   = input?.value.trim();
  if (!msg) return;
  input.value = '';
  input.style.height = 'auto';

  S.queryCount++;
  appendMessage('user', msg);
  const thinkingId = appendThinking();

  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) sendBtn.disabled = true;

  try {
    // Attach the latest vehicle snapshot so get_vehicle_status() returns real data
    const vehiclePayload = S.prevVehicleData || null;

    const r = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message:      msg,
        session_id:   SESSION_ID,
        vehicle_data: vehiclePayload,
      }),
    });

    if (!r.ok) throw new Error(`Server error ${r.status}`);
    const d = await r.json();

    removeThinking(thinkingId);
    appendMessage('assistant', d.response, d.agents_used || []);
    highlightAgents(d.agents_used || []);

    const usedVehicleTool = (d.agents_used || []).includes('TechnicianAgent');
    Toast.success(
      usedVehicleTool
        ? '⚙️ Technician read your live vehicle sensors'
        : `Response from ${d.agents_used?.length || 1} agent(s)`,
      2800
    );
  } catch (err) {
    removeThinking(thinkingId);
    appendMessage('assistant', `❌ **Error:** ${err.message}\n\nMake sure the backend is running: \`uvicorn server:app --reload\``);
    Toast.error('Backend not responding', 4000);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    input?.focus();
  }
}

function appendMessage(role, content, agents = []) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const avatar = role === 'user' ? '👤' : '⚡';
  const rendered = role === 'assistant' && typeof marked !== 'undefined'
    ? marked.parse(content)
    : escapeHtml(content).replace(/\n/g, '<br>');

  let agentBadges = '';
  if (agents.length) {
    agentBadges = `<div class="msg-agents-row">${agents.map(a => {
      const m = AGENT_META[a];
      return m ? `<span class="msg-agent-badge" style="--c:${m.color}">${m.icon} ${a.replace('Agent', '')}</span>` : '';
    }).join('')}</div>`;
  }

  const html = `
    <div class="msg-row ${role}" id="msg-${Date.now()}">
      <div class="msg-avatar">${avatar}</div>
      <div class="msg-bubble">
        ${rendered}
        ${agentBadges}
        <div class="msg-ts">${ts}</div>
      </div>
    </div>`;

  container.insertAdjacentHTML('beforeend', html);
  gsap.from(container.lastElementChild, { opacity: 0, y: 15, duration: 0.4, ease: 'power2.out' });
  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });

  S.chatHistory.push({ role, content, agents, ts });
}

function appendThinking() {
  const id = `think-${Date.now()}`;
  const container = document.getElementById('chat-messages');
  if (!container) return id;
  container.insertAdjacentHTML('beforeend', `
    <div class="msg-row assistant thinking-bubble" id="${id}">
      <div class="msg-avatar">⚡</div>
      <div class="msg-bubble">
        <span style="font-size:.8rem;color:var(--text-3);font-family:var(--font-mono);letter-spacing:.1em;">Processing</span>
        <div class="typing-dots"><span></span><span></span><span></span></div>
      </div>
    </div>`);
  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  return id;
}

function removeThinking(id) {
  document.getElementById(id)?.remove();
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

/* ══════════════════════════════════════════════════════════════════════════
   VEHICLE MATRIX
══════════════════════════════════════════════════════════════════════════ */
function initVehicleMatrix() {
  initVehicleCharts();
  // Three.js: init on every visit (destroy is called on leave)
  // Triple rAF ensures hologram-frame has its final CSS dimensions
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => VehicleScene.init('vehicle-canvas'))
    )
  );
  startVehiclePoll();
  initModeSelector();

  gsap.from('.vm-header',      { opacity: 0, y: -30, duration: 0.6, ease: 'power3.out' });
  gsap.from('.hologram-frame', { opacity: 0, scale: 0.95, duration: 0.8, delay: 0.2, ease: 'power3.out' });
  gsap.from('.gauge-wrap',     { opacity: 0, y: 30, stagger: 0.1, duration: 0.5, delay: 0.4, ease: 'power2.out' });
  gsap.from('.mode-btn',       { opacity: 0, y: 15, stagger: 0.08, duration: 0.4, delay: 0.55, ease: 'back.out(1.5)' });
}

/* ══════════════════════════════════════════════════════════════════════════
   DRIVE MODE SELECTOR — 7 modes + Emergency system
══════════════════════════════════════════════════════════════════════════ */
const MODE_COLORS = {
  ECO: '#00ff9d', NORMAL: '#00e5ff', RACE: '#ff6b35',
  RISK: '#ffb800', HIGH_RISK: '#ff4040', ACCIDENT: '#ff0000', DEFECT: '#a78bfa',
};
const MODE_ICONS = {
  ECO: '🌿', NORMAL: '⚡', RACE: '🏎️',
  RISK: '⚠️', HIGH_RISK: '🔴', ACCIDENT: '🚨', DEFECT: '🔧',
};
const FRAME_CLASSES = {
  RACE: 'race-mode', RISK: 'risk-mode', HIGH_RISK: 'high-risk-mode',
  ACCIDENT: 'accident-mode', DEFECT: 'defect-mode',
};

function initModeSelector() {
  if (S._modeListeners) return;
  S._modeListeners = true;

  // Event delegation — one listener for all mode buttons
  const sel  = document.getElementById('mode-selector');
  const wrap = document.getElementById('mode-selector-wrap');

  if (sel) {
    sel.addEventListener('click', e => {
      const btn = e.target.closest('.mode-btn[data-mode]');
      if (btn) switchMode(btn.dataset.mode);
    });

    // Show/hide right-fade based on scroll position
    function updateFade() {
      if (!wrap) return;
      const atEnd = sel.scrollLeft + sel.clientWidth >= sel.scrollWidth - 8;
      wrap.classList.toggle('no-fade', atEnd);
    }
    sel.addEventListener('scroll', updateFade, { passive: true });
    // Run after layout settles
    requestAnimationFrame(() => requestAnimationFrame(updateFade));
    window.addEventListener('resize', updateFade, { passive: true });
  }

  // Cancel emergency button
  document.getElementById('eo-cancel')?.addEventListener('click', () => {
    switchMode('NORMAL');
    hideEmergency();
    Toast.info('Emergency cancelled — switched to NORMAL mode');
  });

  // Fetch current mode from server
  fetch(`${API}/api/mode`)
    .then(r => r.json())
    .then(d => applyModeUI(d.mode, d.profile))
    .catch(() => applyModeUI('NORMAL'));
}

async function switchMode(mode) {
  try {
    const r = await fetch(`${API}/api/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!r.ok) throw new Error('Server error');
    const d = await r.json();
    S.prevVehicleData = null;  // force fresh telemetry
    applyModeUI(d.mode, d.profile);

    // Mode-specific toasts
    const toastMap = {
      ECO: ['success', '🌿 ECO MODE — Max range activated'],
      NORMAL: ['info', '⚡ NORMAL MODE — Balanced driving'],
      RACE: ['warning', '🏎️ RACE MODE — Max performance!'],
      RISK: ['warning', '⚠️ RISK MODE — Monitor sensors'],
      HIGH_RISK: ['error', '🔴 HIGH RISK — Critical stress! Check temps immediately'],
      ACCIDENT: ['error', '🚨 ACCIDENT MODE — Emergency SOS activating…'],
      DEFECT: ['warning', '🔧 DEFECT — Limp mode active. Service required'],
    };
    const [type, msg] = toastMap[mode] || ['info', mode + ' MODE'];
    Toast[type](msg, 3500);

    // Trigger emergency overlay for ACCIDENT mode
    if (mode === 'ACCIDENT') triggerEmergency();

  } catch (e) {
    Toast.error('Could not switch mode — check backend', 2500);
  }
}

function applyModeUI(mode, profile) {
  S.currentMode = mode;
  const color = MODE_COLORS[mode] || '#00e5ff';

  // Buttons
  document.querySelectorAll('.mode-btn[data-mode]').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });

  // Drive mode badge
  const badge = document.getElementById('vm-drive-mode');
  if (badge) {
    badge.textContent    = mode.replace('_', ' ') + ' MODE';
    badge.style.color       = color;
    badge.style.borderColor = color;
    badge.style.boxShadow   = `0 0 16px ${color}40`;
    gsap.from(badge, { scale: 1.18, duration: 0.3, ease: 'power2.out' });
  }

  // Hologram frame glow class
  const frame = document.querySelector('.hologram-frame');
  if (frame) {
    frame.classList.remove(...Object.values(FRAME_CLASSES));
    if (FRAME_CLASSES[mode]) frame.classList.add(FRAME_CLASSES[mode]);
  }

  // Mode banner
  const banner = document.getElementById('mode-banner');
  if (banner) {
    const modeKey = mode.toLowerCase();
    banner.className   = `mode-banner visible ${modeKey}`;
    banner.textContent = profile?.description || '';
    if (profile?.warnings?.length) {
      setTimeout(() => { banner.textContent = profile.warnings.join(' · '); }, 2500);
    }
  }

  // Sensor badge in Neural Hub
  const sbadge = document.getElementById('vehicle-sensor-badge');
  if (sbadge) sbadge.style.color = color;
}

/* ══════════════════════════════════════════════════════════════════════════
   EMERGENCY SYSTEM — Accident mode
══════════════════════════════════════════════════════════════════════════ */
let _emergencyTimer = null;
let _emergencyCountdown = 10;

function triggerEmergency() {
  const overlay = document.getElementById('emergency-overlay');
  if (!overlay) return;
  overlay.classList.add('active');
  overlay.setAttribute('aria-hidden', 'false');

  // Try get GPS location
  const locText = document.getElementById('eo-loc-text');
  let lat = 28.6139, lng = 77.2090, locName = 'Location unavailable — using last known';

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        lat = pos.coords.latitude; lng = pos.coords.longitude;
        locName = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        if (locText) locText.textContent = `📍 ${locName}`;
        const mapDiv = document.getElementById('eo-map-link');
        if (mapDiv) mapDiv.innerHTML = `<a href="https://maps.google.com/?q=${lat},${lng}" target="_blank">🗺️ Open in Google Maps</a>`;
      },
      () => {
        if (locText) locText.textContent = `📍 ${locName}`;
      }
    );
  } else {
    if (locText) locText.textContent = `📍 ${locName}`;
  }

  // Countdown & auto-send
  _emergencyCountdown = 10;
  const cdEl = document.getElementById('eo-countdown');
  if (cdEl) cdEl.textContent = _emergencyCountdown;
  if (_emergencyTimer) clearInterval(_emergencyTimer);

  _emergencyTimer = setInterval(() => {
    _emergencyCountdown--;
    if (cdEl) cdEl.textContent = _emergencyCountdown;
    if (_emergencyCountdown <= 0) {
      clearInterval(_emergencyTimer);
      _sendEmergencyAlert(lat, lng, locName);
    }
  }, 1000);
}

async function _sendEmergencyAlert(lat, lng, locName) {
  // Update contact status to SENT
  document.querySelectorAll('.eo-status.sending').forEach(el => {
    el.textContent = 'SENT ✓';
    el.classList.replace('sending', 'sent');
  });

  const msgEl = document.getElementById('eo-msg');

  try {
    const r = await fetch(`${API}/api/emergency/alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location_lat: lat, location_lng: lng, location_name: locName,
        contacts: ['Ambulance: 108', 'Police: 100', 'Family Member'],
      }),
    });
    const d = await r.json();
    if (msgEl) msgEl.textContent = d.event?.message || 'Emergency alert sent.';
    Toast.error('🚨 Emergency alert sent to all contacts!', 6000);
  } catch(e) {
    if (msgEl) msgEl.textContent = '⚠️ Could not reach backend. Call 108 manually!';
    Toast.error('Backend offline — call 108 immediately!', 8000);
  }
}

function hideEmergency() {
  if (_emergencyTimer) { clearInterval(_emergencyTimer); _emergencyTimer = null; }
  const overlay = document.getElementById('emergency-overlay');
  if (overlay) {
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
  }
  // Reset contact statuses
  document.querySelectorAll('.eo-status').forEach(el => {
    el.textContent = 'NOTIFYING…';
    el.className = 'eo-status sending';
  });
  document.getElementById('eo-msg') && (document.getElementById('eo-msg').textContent = '');
}

/* ══════════════════════════════════════════════════════════════════════════
   VEHICLE TELEMETRY BUS — message-broker style
   ─────────────────────────────────────────────────────────────────────────
   Architecture:
     • One global poller (VehicleBus) — runs at UI_INTERVAL regardless of page
     • Subscribers register handlers (dashboard, charts, badge, Three.js, chat)
     • Backend push happens at a SLOWER rate (BACKEND_INTERVAL) — reduces load
     • Exponential backoff on backend failures (max BACKOFF_MAX ms)
     • Consumers just subscribe; they never call fetch themselves
══════════════════════════════════════════════════════════════════════════ */
const VehicleBus = (() => {
  const UI_INTERVAL      =  2000;   // ms — how often UI updates
  const BACKEND_INTERVAL = 10000;   // ms — how often we push to FastAPI
  const BACKOFF_BASE     =  4000;   // ms — starting retry delay on error
  const BACKOFF_MAX      = 60000;   // ms — max retry delay

  let _timerId       = null;
  let _lastBackendPush = 0;
  let _failCount     = 0;
  let _currentDelay  = UI_INTERVAL;
  let _subscribers   = [];          // array of { id, fn } objects

  // ── Public: subscribe ─────────────────────────────────────────────────────
  function subscribe(id, fn) {
    _subscribers = _subscribers.filter(s => s.id !== id); // dedup by id
    _subscribers.push({ id, fn });
  }

  function unsubscribe(id) {
    _subscribers = _subscribers.filter(s => s.id !== id);
  }

  // ── Internal: fetch from server ───────────────────────────────────────────
  async function _fetch() {
    try {
      const r = await fetch(`${API}/api/vehicle/status`,
                            { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();

      // Reset backoff on success
      _failCount    = 0;
      _currentDelay = UI_INTERVAL;

      // Store globally for chat
      S.prevVehicleData = d;

      // Notify all subscribers
      _subscribers.forEach(s => { try { s.fn(d); } catch(_) {} });

      // Backend push (throttled — only every BACKEND_INTERVAL ms)
      const now = Date.now();
      if (now - _lastBackendPush >= BACKEND_INTERVAL) {
        _lastBackendPush = now;
        fetch(`${API}/api/vehicle/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vehicle_data: d }),
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      }

    } catch (err) {
      // Exponential backoff — don't hammer a slow server
      _failCount++;
      _currentDelay = Math.min(BACKOFF_BASE * Math.pow(1.8, _failCount - 1), BACKOFF_MAX);
      console.warn(`VehicleBus: poll failed (${_failCount}), retry in ${(_currentDelay/1000).toFixed(1)}s`);
      _schedule();
      return;
    }

    _schedule();
  }

  function _schedule() {
    if (_timerId) clearTimeout(_timerId);
    _timerId = setTimeout(_fetch, _currentDelay);
  }

  // ── Public: start / stop ──────────────────────────────────────────────────
  function start() {
    if (_timerId) return;     // already running
    _fetch();                 // immediate first fetch
  }

  function stop() {
    if (_timerId) { clearTimeout(_timerId); _timerId = null; }
  }

  function isRunning() { return _timerId !== null; }

  return { start, stop, subscribe, unsubscribe, isRunning };
})();

/* ── Legacy wrappers (pages call these; they just delegate to VehicleBus) ── */
function startVehiclePoll() {
  // Register page-specific subscribers
  VehicleBus.subscribe('dashboard', updateDashboard);
  VehicleBus.subscribe('threejs',   d => VehicleScene.update(d));
  VehicleBus.subscribe('history',   d => { pushVehicleHistory(d); updateVehicleCharts(); });
  VehicleBus.subscribe('badge',     _updateVehicleSensorBadge);
  VehicleBus.start();
}

function stopVehiclePoll() {
  // Remove page-specific subscribers (bus keeps running for Neural Hub badge)
  VehicleBus.unsubscribe('dashboard');
  VehicleBus.unsubscribe('threejs');
  VehicleBus.unsubscribe('history');
  VehicleScene.destroy?.();
}

// Kept for backward compat but now unused internally
async function fetchVehicle() {
  // no-op — VehicleBus handles all fetching
}

/** Shows a live sensor badge inside the chat header when on Neural Hub */
function _updateVehicleSensorBadge(d) {
  const badge = document.getElementById('vehicle-sensor-badge');
  if (!badge) return;
  const bat   = d.battery_level ?? d.battery_level_pct ?? '--';
  const spd   = d.speed         ?? d.speed_kmh         ?? '--';
  const range = d.range_km      ?? '--';
  const mode  = d.drive_mode    ?? S.currentMode ?? 'NORMAL';
  const temp  = d.battery_temp  ?? '--';
  badge.textContent = `🔋 ${bat}%  ⚡ ${spd} km/h  📍 ${range} km  🌡️ ${temp}°C  ${MODE_ICONS?.[mode] ?? ''} ${mode}`;
  badge.style.opacity = '1';
  badge.style.color   = (MODE_COLORS?.[mode]) || 'var(--text-1)';
}

function updateDashboard(d) {
  if (!d) return;

  // ── Safe field access — handles both old & new field names ───────────────
  const speed      = d.speed      ?? d.speed_kmh         ?? 0;
  const range_km   = d.range_km   ?? d.estimated_range_km ?? 0;
  const motor_rpm  = d.motor_rpm  ?? 0;
  const power_kw   = d.power_kw   ?? d.power_output_kw   ?? 0;
  const bat_temp   = d.battery_temp  ?? d.battery_temp_c  ?? 0;
  const bat_health = d.battery_health?? d.battery_health_pct ?? 0;
  const cabin_temp = d.cabin_temp    ?? d.cabin_temp_c    ?? 0;
  const odometer   = d.odometer      ?? d.odometer_km     ?? 0;
  const efficiency = d.efficiency    ?? d.efficiency_kwh_per_100km ?? 0;
  const bat_level  = d.battery_level ?? d.battery_level_pct ?? 0;
  const drive_mode = d.drive_mode    ?? 'ECO';
  const regen      = d.regen_active  ?? d.regen_braking   ?? false;
  const tires      = d.tire_pressures?? d.tire_pressure_psi ?? null;

  // ── HUD overlay tags ──────────────────────────────────────────────────────
  setText('hv-speed', `${speed} km/h`);
  setText('hv-range', `${range_km} km`);
  setText('hv-rpm',   motor_rpm.toLocaleString());
  setText('hv-power', `${power_kw} kW`);

  // ── Stat tiles ────────────────────────────────────────────────────────────
  setText('vmst-bat-temp',   `${bat_temp}°C`);
  setText('vmst-bat-health', `${bat_health}%`);
  setText('vmst-cabin-temp', `${cabin_temp}°C`);
  setText('vmst-odo',        `${odometer.toLocaleString()} km`);
  setText('vmst-efficiency', `${efficiency} kWh`);

  // ── Drive mode badge ──────────────────────────────────────────────────────
  const modeEl = document.getElementById('vm-drive-mode');
  if (modeEl) {
    modeEl.textContent   = drive_mode + ' MODE';
    const mc = drive_mode === 'ECO' ? '#00ff9d' : drive_mode === 'SPORT' ? '#ff6b35' : '#00e5ff';
    modeEl.style.color       = mc;
    modeEl.style.borderColor = mc;
    modeEl.style.boxShadow   = `0 0 14px ${mc}40`;
  }

  // ── Regen indicator ───────────────────────────────────────────────────────
  document.getElementById('holo-regen')?.classList.toggle('visible', !!regen);

  // ── Gauge theme based on mode ─────────────────────────────────────────────
  const theme = d.gauge_theme || _modeGaugeTheme(drive_mode);
  const THEMES = {
    green:     { speed:'#00ff9d', bat:'#00ff9d', power:'#00ff9d', maxSpd:80,  maxPwr:40  },
    cyan:      { speed:'#00e5ff', bat:'#00e5ff', power:'#a78bfa', maxSpd:120, maxPwr:80  },
    orange:    { speed:'#ff6b35', bat:'#ffb800', power:'#ff6b35', maxSpd:200, maxPwr:260 },
    yellow:    { speed:'#ffb800', bat:'#ffb800', power:'#ffb800', maxSpd:150, maxPwr:170 },
    red:       { speed:'#ff4040', bat:'#ff4040', power:'#ff4040', maxSpd:80,  maxPwr:50  },
    emergency: { speed:'#ff0000', bat:'#ff0000', power:'#ff0000', maxSpd:10,  maxPwr:10  },
    purple:    { speed:'#a78bfa', bat:'#a78bfa', power:'#a78bfa', maxSpd:30,  maxPwr:20  },
  };
  const T = THEMES[theme] || THEMES.cyan;

  // Battery color always reflects actual level regardless of mode
  const batGaugeColor = bat_level < 20 ? '#ff4040'
                      : bat_level < 35 ? '#ff6b35'
                      : bat_level < 55 ? '#ffb800'
                      : T.bat;

  drawGauge('speedometer-canvas', speed,    T.maxSpd, T.speed, 'km/h');
  drawGauge('battery-canvas',     bat_level, 100,     batGaugeColor, '%');
  drawGauge('power-canvas',       power_kw,  T.maxPwr, T.power, 'kW');

  // Apply gauge-wrap glow theme
  document.querySelectorAll('.gauge-wrap').forEach(g => {
    g.className = g.className.replace(/theme-\w+/g, '').trim();
    g.classList.add(`theme-${theme}`);
  });

  // DEFECT mode — fault blink on stat tiles
  const isFault = d.is_fault || drive_mode === 'DEFECT';
  document.querySelectorAll('.vm-stat-tile').forEach(t => {
    t.classList.toggle('defect-fault', isFault);
  });

  // ── Tyre pressures with mode-aware warning states ─────────────────────────
  if (tires) {
    const warnPos  = (d.tire_warn_positions || '').split(',');
    const tireMode = d.tire_mode || 'normal';
    setTyre('fl', tires.FL, warnPos.includes('FL'), tireMode);
    setTyre('fr', tires.FR, warnPos.includes('FR'), tireMode);
    setTyre('rl', tires.RL, warnPos.includes('RL'), tireMode);
    setTyre('rr', tires.RR, warnPos.includes('RR'), tireMode);
  }

  // ── Puncture alert ────────────────────────────────────────────────────────
  if (d.puncture_alert) {
    Toast.error('⚠️ PUNCTURE ALERT: Low tire pressure at high speed!', 5000);
  }
}

function _modeGaugeTheme(mode) {
  const map = { ECO:'green', NORMAL:'cyan', RACE:'orange', RISK:'yellow',
                HIGH_RISK:'red', ACCIDENT:'emergency', DEFECT:'purple' };
  return map[mode] || 'cyan';
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setTyre(pos, psi, isWarn, tireMode) {
  const el   = document.getElementById(`tv-${pos}`);
  const tile = document.getElementById(`tyre-${pos}`);
  if (!el || !tile) return;

  if (psi === null || psi === undefined) {
    el.textContent = '--';
    tile.className = 'tyre-tile';
    return;
  }
  if (typeof psi === 'string' && psi.startsWith('ERR')) {
    el.textContent = 'ERR';
    tile.className = 'tyre-tile tyre-fault';
    return;
  }
  const val = typeof psi === 'number' ? psi : parseFloat(psi) || 0;
  el.textContent = val.toFixed(1);

  // Determine tile state
  const isCritical = val < 20;
  const isLow      = val < 30;
  const isHigh     = val > 36;
  const isAccident = tireMode === 'accident';

  tile.classList.remove('warn', 'tyre-critical', 'tyre-high', 'tyre-fault', 'tyre-accident');
  if (isAccident || isCritical) tile.classList.add('tyre-accident');
  else if (isWarn || isLow)     tile.classList.add('warn');
  else if (isHigh)              tile.classList.add('tyre-high');
}

/* ── Canvas Gauges ──────────────────────────────────────────────────────── */
function drawGauge(id, value, maxVal, color, unit) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const s   = Math.min(canvas.parentElement?.clientWidth || 160, 180);
  canvas.width  = s * dpr;
  canvas.height = s * dpr;
  canvas.style.width  = s + 'px';
  canvas.style.height = s + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const cx = s / 2, cy = s / 2, r = s * 0.38;
  const startA = Math.PI * 0.75;
  const sweepA = Math.PI * 1.5;
  const pct    = Math.min(value / maxVal, 1);

  ctx.clearRect(0, 0, s, s);

  // Track (background arc)
  ctx.beginPath();
  ctx.arc(cx, cy, r, startA, startA + sweepA);
  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.lineWidth   = s * 0.07;
  ctx.lineCap     = 'round';
  ctx.stroke();

  // Value arc
  if (pct > 0.01) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, startA, startA + sweepA * pct);
    ctx.strokeStyle = color;
    ctx.lineWidth   = s * 0.07;
    ctx.lineCap     = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur  = 14;
    ctx.stroke();
    ctx.shadowBlur  = 0;
  }

  // Tick marks
  for (let i = 0; i <= 10; i++) {
    const a     = startA + (i / 10) * sweepA;
    const inner = i % 5 === 0 ? r - s * 0.1 : r - s * 0.065;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a) * r,     cy + Math.sin(a) * r);
    ctx.strokeStyle = i % 5 === 0 ? color : 'rgba(255,255,255,.1)';
    ctx.lineWidth   = i % 5 === 0 ? 2 : 1;
    ctx.shadowBlur  = 0;
    ctx.stroke();
  }

  // Value text
  ctx.fillStyle   = '#e8f4f8';
  ctx.font        = `bold ${s * 0.2}px Orbitron, sans-serif`;
  ctx.textAlign   = 'center';
  ctx.textBaseline= 'middle';
  ctx.fillText(Math.round(value), cx, cy + s * 0.04);

  // Unit text
  ctx.fillStyle   = 'rgba(122,184,204,.7)';
  ctx.font        = `${s * 0.09}px Space Mono, monospace`;
  ctx.fillText(unit, cx, cy + s * 0.25);
}

/* ── Vehicle History & Charts ───────────────────────────────────────────── */
function pushVehicleHistory(d) {
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  // Safe read — handles both old & new field names
  S.vehicleHistory.speed.push(d.speed   ?? d.speed_kmh        ?? 0);
  S.vehicleHistory.battery.push(d.battery_level ?? d.battery_level_pct ?? 0);
  S.vehicleHistory.power.push(d.power_kw ?? d.power_output_kw  ?? 0);
  S.vehicleHistory.labels.push(ts);
  if (S.vehicleHistory.speed.length > MAX_HISTORY) {
    ['speed','battery','power','labels'].forEach(k => S.vehicleHistory[k].shift());
  }
}

function initVehicleCharts() {
  const commonOptions = (label, color) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#3d6578', font: { family: 'Space Mono', size: 9 }, maxTicksLimit: 6 }, grid: { color: 'rgba(0,229,255,.06)' } },
      y: { ticks: { color: '#3d6578', font: { family: 'Space Mono', size: 9 } }, grid: { color: 'rgba(0,229,255,.06)' } },
    },
    elements: { point: { radius: 0 }, line: { tension: 0.4 } },
  });

  const makeDataset = (color) => ({
    data: [],
    borderColor: color,
    backgroundColor: color.replace(')', ', 0.08)').replace('rgb', 'rgba'),
    borderWidth: 2,
    fill: true,
  });

  if (!S.charts.vmSpeed) {
    const c = document.getElementById('vm-speed-chart');
    if (c) S.charts.vmSpeed = new Chart(c, {
      type: 'line',
      data: { labels: [], datasets: [makeDataset('#00e5ff')] },
      options: commonOptions('Speed', '#00e5ff'),
    });
  }
  if (!S.charts.vmBattery) {
    const c = document.getElementById('vm-battery-chart');
    if (c) S.charts.vmBattery = new Chart(c, {
      type: 'line',
      data: { labels: [], datasets: [makeDataset('#00ff9d')] },
      options: commonOptions('Battery', '#00ff9d'),
    });
  }
  if (!S.charts.vmPower) {
    const c = document.getElementById('vm-power-chart');
    if (c) S.charts.vmPower = new Chart(c, {
      type: 'line',
      data: { labels: [], datasets: [makeDataset('#a78bfa')] },
      options: commonOptions('Power', '#a78bfa'),
    });
  }
}

function updateVehicleCharts() {
  const h = S.vehicleHistory;
  const update = (chart, data) => {
    if (!chart) return;
    chart.data.labels = [...h.labels];
    chart.data.datasets[0].data = [...data];
    chart.update('none');
  };
  update(S.charts.vmSpeed,   h.speed);
  update(S.charts.vmBattery, h.battery);
  update(S.charts.vmPower,   h.power);
}

/* ══════════════════════════════════════════════════════════════════════════
   ABOUT PAGE
══════════════════════════════════════════════════════════════════════════ */
function initAbout() {
  gsap.from('.about-hero',    { opacity: 0, y: -30, duration: 0.7, ease: 'power3.out' });
  gsap.from('.about-mission', { opacity: 0, y: 20,  duration: 0.6, delay: 0.2, ease: 'power2.out' });
  gsap.utils.toArray('.about-card, .who-card').forEach((el, i) => {
    gsap.from(el, {
      scrollTrigger: { trigger: el, start: 'top 88%' },
      opacity: 0, y: 30, duration: 0.5, delay: i * 0.06, ease: 'power2.out',
    });
  });
  gsap.utils.toArray('.tech-pill').forEach((el, i) => {
    gsap.from(el, {
      scrollTrigger: { trigger: el, start: 'top 95%' },
      opacity: 0, scale: 0.85, duration: 0.4, delay: i * 0.04, ease: 'back.out(1.5)',
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  Toast._init();
  gsap.registerPlugin(ScrollTrigger);

  // Set marked options if available
  if (typeof marked !== 'undefined') {
    marked.setOptions({ breaks: true, gfm: true });
  }

  // Chart.js defaults
  Chart.defaults.color = '#3d6578';
  Chart.defaults.borderColor = 'rgba(0,229,255,.08)';
  Chart.defaults.font.family = "'Exo 2', sans-serif";

  initNav();
  checkApiStatus();

  // Initial page
  const hash = location.hash.replace('#', '');
  const valid = ['home', 'neural-hub', 'vehicle-matrix', 'about'];
  showPage(valid.includes(hash) ? hash : 'home');

  // Refresh API status every 30s
  setInterval(checkApiStatus, 30000);
});