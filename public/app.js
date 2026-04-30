(() => {
  const FRESH_THRESHOLD_MS = 5 * 60 * 1000;
  const PROXY_BASE = '';

  let currentPlatform = 'truthsocial';
  let currentHandle = '';
  let pollTimer = null;
  let seenIds = new Set();
  let ageTicker = null;
  let eventSource = null;

  const $ = (id) => document.getElementById(id);
  const handleInput = $('handle-input');
  const loadBtn = $('load-btn');
  const statusBar = $('status-bar');
  const statusLabel = $('status-label');
  const nextRefreshEl = $('next-refresh');
  const feed = $('feed');
  const postsContainer = $('posts-container');
  const errorBox = $('error-box');
  const errorMsg = $('error-msg');

  document.querySelector('[data-platform="truthsocial"]').classList.add('active');
  document.querySelector('[data-platform="twitter"]').classList.remove('active');
  document.body.className = 'platform-truthsocial';

  document.querySelectorAll('.platform-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.platform-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentPlatform = btn.dataset.platform;
      document.body.className = `platform-${currentPlatform}`;
    });
  });

  loadBtn.addEventListener('click', startFeed);
  handleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startFeed();
  });

  // SSE connection — receives pushes from server the instant Tampermonkey delivers data
  function connectSSE() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource(`${PROXY_BASE}/api/stream`);
    eventSource.onmessage = (e) => {
      try {
        const { platform, handle, posts } = JSON.parse(e.data);
        if (
          platform === currentPlatform &&
          handle === currentHandle.toLowerCase() &&
          posts?.length
        ) {
          hideError();
          renderPosts(posts, currentHandle, false);
          setLiveLabel();
        }
      } catch {}
    };
    eventSource.onerror = () => {
      // Reconnects automatically; no user-visible error needed
    };
  }

  function startFeed() {
    const handle = handleInput.value.trim().replace(/^@/, '');
    if (!handle) { handleInput.focus(); return; }
    currentHandle = handle;
    seenIds.clear();
    clearTimers();
    showLoader();
    connectSSE();
    fetchAndRender(true);
  }

  async function fetchAndRender(isInitial = false) {
    try {
      const res = await fetch(`${PROXY_BASE}/api/${currentPlatform}/${encodeURIComponent(currentHandle)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      hideError();
      renderPosts(data.posts, data.username || currentHandle, isInitial);
      setLiveLabel();
    } catch (err) {
      showError(err.message);
    }
  }

  // --- Rendering ---
  function renderPosts(posts, username, isInitial) {
    if (!posts || posts.length === 0) {
      postsContainer.innerHTML = `<div class="loader" style="padding:30px">No posts found for @${escHtml(username)}</div>`;
      feed.classList.remove('hidden');
      statusBar.classList.remove('hidden');
      updateStatusLabel(username, 0);
      return;
    }

    const newIds = new Set(posts.map((p) => p.id));
    const brandNew = isInitial ? new Set() : new Set([...newIds].filter((id) => !seenIds.has(id)));
    seenIds = newIds;

    const now = Date.now();
    postsContainer.innerHTML = posts.map((post) => {
      const ageMs = now - new Date(post.created_at).getTime();
      const isFresh = ageMs < FRESH_THRESHOLD_MS;
      const isNew = brandNew.has(post.id);

      return `<div class="post-card ${isFresh ? 'fresh' : 'stale'} ${isNew ? 'new-flash' : ''}"
                   data-id="${post.id}" data-created="${post.created_at}">
        <div class="post-header">
          <span class="post-age">${formatAge(ageMs)}</span>
          ${isNew ? '<span class="new-badge">New</span>' : ''}
        </div>
        <div class="post-text">${escHtml(post.text)}</div>
        <div class="post-footer">
          <a class="post-link" href="${post.url}" target="_blank" rel="noopener">
            Open on ${post.platform === 'twitter' ? 'X' : 'Truth Social'} ↗
          </a>
        </div>
      </div>`;
    }).join('');

    feed.classList.remove('hidden');
    statusBar.classList.remove('hidden');
    updateStatusLabel(username, brandNew.size);
    startAgeTicker();
  }

  function startAgeTicker() {
    if (ageTicker) clearInterval(ageTicker);
    ageTicker = setInterval(() => {
      const now = Date.now();
      document.querySelectorAll('.post-card').forEach((card) => {
        const ageMs = now - new Date(card.dataset.created).getTime();
        const isFresh = ageMs < FRESH_THRESHOLD_MS;
        card.classList.toggle('fresh', isFresh);
        card.classList.toggle('stale', !isFresh);
        const ageEl = card.querySelector('.post-age');
        if (ageEl) ageEl.textContent = formatAge(ageMs);
      });
    }, 15_000);
  }

  function setLiveLabel() {
    nextRefreshEl.textContent = 'Live';
  }

  function updateStatusLabel(username, newCount) {
    const dot = '<span class="dot"></span>';
    statusLabel.innerHTML = newCount > 0
      ? `${dot}@${escHtml(username)} · <strong style="color:#00ba7c">${newCount} new</strong>`
      : `${dot}@${escHtml(username)}`;
  }

  function showLoader() {
    postsContainer.innerHTML = `<div class="loader"><div class="spinner"></div>Loading @${escHtml(currentHandle)}…</div>`;
    feed.classList.remove('hidden');
    statusBar.classList.add('hidden');
    hideError();
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorBox.classList.remove('hidden');
    feed.classList.add('hidden');
    statusBar.classList.add('hidden');
    loadBtn.disabled = false;
  }

  function hideError() {
    errorBox.classList.add('hidden');
    loadBtn.disabled = false;
  }

  function clearTimers() {
    if (pollTimer) clearTimeout(pollTimer);
    if (ageTicker) clearInterval(ageTicker);
    ageTicker = null;
  }

  function formatAge(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
