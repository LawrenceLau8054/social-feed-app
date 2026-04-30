// ==UserScript==
// @name         Truth Social Feed Relay
// @namespace    http://localhost:3000
// @version      4.0
// @description  Relays Truth Social posts to the local Social Feed Viewer app
// @author       local
// @match        https://truthsocial.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      social-feed-app-production-c6b1.up.railway.app
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const SERVER = 'https://social-feed-app-production-c6b1.up.railway.app';
  const POLL_MS = 10000;   // fallback poll every 10s in case stream misses something
  const CONFIG_MS = 3000;  // check for new handles every 3s

  let HANDLES = [];
  let liveToken = null;
  let ws = null;
  let knownHandles = new Set();

  // --- Token capture ---

  const _open = XMLHttpRequest.prototype.open;
  const _setHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
    if (header.toLowerCase() === 'authorization' && value.startsWith('Bearer ')) {
      var tok = value.slice(7);
      if (tok !== liveToken) {
        liveToken = tok;
        connectStream(); // reconnect stream with fresh token
      }
    }
    return _setHeader.apply(this, arguments);
  };

  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const headers = (init && init.headers) || {};
      const auth = headers['Authorization'] || headers['authorization'];
      if (auth && auth.startsWith('Bearer ')) {
        var tok = auth.slice(7);
        if (tok !== liveToken) {
          liveToken = tok;
          connectStream();
        }
      }
    } catch {}
    return _fetch.apply(this, arguments);
  };

  // --- WebSocket streaming (instant updates) ---

  function connectStream() {
    if (!liveToken) return;
    if (ws && ws.readyState <= 1) return; // already connecting or open

    try {
      ws = new WebSocket(
        'wss://truthsocial.com/api/v1/streaming?access_token=' + liveToken + '&stream=public'
      );

      ws.onopen = function () {
        console.log('[TruthRelay] Stream connected — watching for live posts');
      };

      ws.onmessage = function (e) {
        try {
          var msg = JSON.parse(e.data);
          if (msg.event !== 'update') return;
          var status = JSON.parse(msg.payload);
          if (status.reblog) return; // skip reblogs
          var acct = status.account && status.account.acct;
          if (!acct) return;
          // Strip instance domain if present (e.g. user@truthsocial.com -> user)
          acct = acct.split('@')[0].toLowerCase();
          if (!HANDLES.includes(acct)) return;
          console.log('[TruthRelay] Stream: new post from @' + acct + ' — relaying immediately');
          relay(acct); // fetch latest 10 and push to server
        } catch (e2) {}
      };

      ws.onclose = function () {
        console.log('[TruthRelay] Stream disconnected — reconnecting in 5s');
        ws = null;
        setTimeout(connectStream, 5000);
      };

      ws.onerror = function () {
        ws = null;
      };
    } catch (e) {
      ws = null;
    }
  }

  // --- Relay latest 10 posts for a handle ---

  async function relay(handle) {
    if (!liveToken) return;
    try {
      const accountRes = await _fetch(
        `/api/v1/accounts/lookup?acct=${handle}`,
        { headers: { Authorization: `Bearer ${liveToken}` } }
      );
      if (!accountRes.ok) {
        if (accountRes.status === 401) { liveToken = null; ws && ws.close(); }
        return;
      }
      const account = await accountRes.json();
      const statusesRes = await _fetch(
        `/api/v1/accounts/${account.id}/statuses?limit=10&exclude_replies=true&exclude_reblogs=true`,
        { headers: { Authorization: `Bearer ${liveToken}` } }
      );
      const statuses = await statusesRes.json();
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${SERVER}/api/ingest/${handle}`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ statuses }),
        onload: (r) => console.log(`[TruthRelay] Relayed ${statuses.length} posts for @${handle} → ${r.status}`),
        onerror: () => console.error('[TruthRelay] Could not reach server'),
      });
    } catch (e) {
      console.error('[TruthRelay] relay error:', e);
    }
  }

  // --- Config polling (detect new handles) ---

  function getConfig() {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `${SERVER}/api/config?_=${Date.now()}`,
        onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch (e) { resolve({}); } },
        onerror: () => resolve({}),
      });
    });
  }

  async function syncConfig() {
    const cfg = await getConfig();
    HANDLES = (cfg.watchTruth || []).map(h => h.toLowerCase());

    // Immediately relay any newly-added handles
    const brandNew = HANDLES.filter(h => !knownHandles.has(h));
    if (brandNew.length) {
      console.log('[TruthRelay] New handle(s): ' + brandNew.join(', ') + ' — fetching immediately');
      brandNew.forEach(relay);
    }
    HANDLES.forEach(h => knownHandles.add(h));

    // Connect stream once we have a token
    if (liveToken && (!ws || ws.readyState > 1)) connectStream();
  }

  async function regularPoll() {
    // Fallback: re-relay all handles in case stream missed anything
    HANDLES.forEach(relay);
  }

  setTimeout(() => {
    syncConfig();
    setInterval(syncConfig, CONFIG_MS);
    setInterval(regularPoll, POLL_MS);
  }, 4000);

  console.log('[TruthRelay] v4.0 loaded');
})();
