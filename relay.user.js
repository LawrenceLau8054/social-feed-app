// ==UserScript==
// @name         Truth Social Feed Relay
// @namespace    http://localhost:3000
// @version      3.0
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
  const POLL_MS = 5000;
  let HANDLES = [];

  let liveToken = null;

  // Intercept XHR before page scripts run
  const _open = XMLHttpRequest.prototype.open;
  const _setHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
    if (header.toLowerCase() === 'authorization' && value.startsWith('Bearer ')) {
      liveToken = value.slice(7);
    }
    return _setHeader.apply(this, arguments);
  };

  // Intercept fetch before page scripts run
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const headers = (init && init.headers) || {};
      const auth = headers['Authorization'] || headers['authorization'];
      if (auth && auth.startsWith('Bearer ')) {
        liveToken = auth.slice(7);
      }
    } catch {}
    return _fetch.apply(this, arguments);
  };

  async function relay(handle) {
    if (!liveToken) {
      console.log('[TruthRelay] No token yet — waiting for page to make an authenticated request');
      return;
    }

    try {
      const accountRes = await _fetch(
        `/api/v1/accounts/lookup?acct=${handle}`,
        { headers: { Authorization: `Bearer ${liveToken}` } }
      );
      if (!accountRes.ok) {
        console.warn(`[TruthRelay] lookup failed: ${accountRes.status} — token may be expired`);
        liveToken = null; // force re-capture on next poll
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
        onerror: () => console.error('[TruthRelay] Could not reach localhost:3000 — is the server running?'),
      });
    } catch (e) {
      console.error('[TruthRelay] Error:', e);
    }
  }

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

  async function syncAndPoll() {
    const cfg = await getConfig();
    HANDLES = cfg.watchTruth || [];
    console.log('[TruthRelay] sync: ' + HANDLES.length + ' handle(s) — ' + (liveToken ? 'token ready' : 'no token yet'));
    HANDLES.forEach(relay);
  }

  setTimeout(() => {
    syncAndPoll();
    setInterval(syncAndPoll, POLL_MS);
  }, 4000);

  console.log('[TruthRelay] Script loaded (document-start) — token interceptor active');
})();
