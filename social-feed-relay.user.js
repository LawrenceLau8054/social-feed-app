// ==UserScript==
// @name         Social Feed Relay
// @namespace    http://localhost:3000
// @version      1.0
// @description  Relays X/Twitter and Truth Social posts to the Social Feed Viewer app
// @author       local
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://truthsocial.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      social-feed-app-production-c6b1.up.railway.app
// @updateURL    https://raw.githubusercontent.com/LawrenceLau8054/social-feed-app/master/social-feed-relay.user.js
// @downloadURL  https://raw.githubusercontent.com/LawrenceLau8054/social-feed-app/master/social-feed-relay.user.js
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const SERVER = 'https://social-feed-app-production-c6b1.up.railway.app';
  const IS_TRUTH = location.hostname.includes('truthsocial.com');
  const IS_X     = !IS_TRUTH;

  // ============================================================
  //  TRUTH SOCIAL
  // ============================================================
  if (IS_TRUTH) {
    const POLL_MS   = 10000;
    const CONFIG_MS = 3000;

    let HANDLES = [];
    let liveToken = null;
    let ws = null;
    let knownHandles = new Set();

    const _setHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
      if (header.toLowerCase() === 'authorization' && value.startsWith('Bearer ')) {
        var tok = value.slice(7);
        if (tok !== liveToken) { liveToken = tok; connectStream(); }
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
          if (tok !== liveToken) { liveToken = tok; connectStream(); }
        }
      } catch {}
      return _fetch.apply(this, arguments);
    };

    function connectStream() {
      if (!liveToken) return;
      if (ws && ws.readyState <= 1) return;
      try {
        ws = new WebSocket('wss://truthsocial.com/api/v1/streaming?access_token=' + liveToken + '&stream=public');
        ws.onopen = function () { console.log('[TruthRelay] Stream connected'); };
        ws.onmessage = function (e) {
          try {
            var msg = JSON.parse(e.data);
            if (msg.event !== 'update') return;
            var status = JSON.parse(msg.payload);
            if (status.reblog) return;
            var acct = status.account && status.account.acct;
            if (!acct) return;
            acct = acct.split('@')[0].toLowerCase();
            if (!HANDLES.includes(acct)) return;
            console.log('[TruthRelay] Stream: new post from @' + acct + ' — relaying immediately');
            relay(acct);
          } catch (e2) {}
        };
        ws.onclose = function () { ws = null; setTimeout(connectStream, 5000); };
        ws.onerror = function () { ws = null; };
      } catch (e) { ws = null; }
    }

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
      } catch (e) { console.error('[TruthRelay] relay error:', e); }
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

    async function syncConfig() {
      const cfg = await getConfig();
      HANDLES = (cfg.watchTruth || []).map(h => h.toLowerCase());
      const brandNew = HANDLES.filter(h => !knownHandles.has(h));
      if (brandNew.length) {
        console.log('[TruthRelay] New handle(s): ' + brandNew.join(', ') + ' — fetching immediately');
        brandNew.forEach(relay);
      }
      HANDLES.forEach(h => knownHandles.add(h));
      if (liveToken && (!ws || ws.readyState > 1)) connectStream();
    }

    setTimeout(() => {
      syncConfig();
      setInterval(syncConfig, CONFIG_MS);
      setInterval(() => HANDLES.forEach(relay), POLL_MS);
    }, 4000);

    console.log('[SocialRelay] Truth Social v1.0 loaded');
  }

  // ============================================================
  //  X / TWITTER
  // ============================================================
  if (IS_X) {
    const CONFIG_MS      = 3000;
    const POLL_MS        = 5000;
    const XHR_COOLDOWN_MS = 20000;

    let authToken = null;
    let csrfToken = null;
    let pollBackoffMs = POLL_MS;

    let userTweetsQueryId        = localStorage.getItem('xrelay_utQueryId')   || null;
    let userTweetsFeatures       = localStorage.getItem('xrelay_utFeatures')  || '';
    let userByScreenNameQueryId  = localStorage.getItem('xrelay_ubsnQueryId') || null;
    let userByScreenNameFeatures = localStorage.getItem('xrelay_ubsnFeatures')|| '';
    if (userTweetsQueryId) console.log('[XRelay] queryId restored from cache: ' + userTweetsQueryId);

    const userIdCache    = {};
    const userIdToHandle = {};
    const pendingByUserId = {};
    const lastRelayedAt  = {};
    const lastXhrAt      = {};
    let watchedHandles   = new Set();
    let knownHandles     = new Set();

    const _fetch      = window.fetch;
    const _xhrOpen    = XMLHttpRequest.prototype.open;
    const _xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    function grabTokens(h) {
      if (!h) return;
      const auth = typeof h.get === 'function' ? h.get('authorization') : (h.authorization || h.Authorization);
      const csrf = typeof h.get === 'function' ? h.get('x-csrf-token') : h['x-csrf-token'];
      if (auth && auth.startsWith('Bearer ') && !authToken) { authToken = auth; console.log('[XRelay] Auth token captured'); }
      if (csrf && !csrfToken) csrfToken = csrf;
    }

    XMLHttpRequest.prototype.open = function (method, url) {
      this._xrelayUrl = url || '';
      if (this._xrelayUrl.includes('/i/api/graphql/')) {
        var m = this._xrelayUrl.match(/\/graphql\/([^/]+)\/(\w+)/);
        if (m) {
          var opName = m[2];
          if (opName === 'UserTweets') {
            var newQid = m[1];
            try { var newFeat = new URL(this._xrelayUrl).searchParams.get('features') || ''; } catch(e) { var newFeat = ''; }
            if (newQid !== userTweetsQueryId) {
              userTweetsQueryId = newQid; userTweetsFeatures = newFeat;
              localStorage.setItem('xrelay_utQueryId', userTweetsQueryId);
              localStorage.setItem('xrelay_utFeatures', userTweetsFeatures);
              console.log('[XRelay] UserTweets queryId cached: ' + userTweetsQueryId);
            }
            try {
              var varsParam = new URL(this._xrelayUrl).searchParams.get('variables');
              if (varsParam) { var vars = JSON.parse(varsParam); if (vars.userId) this._xrelayUserId = vars.userId; }
            } catch(e) {}
          }
          if (opName === 'UserByScreenName') {
            var newUbsnQid = m[1];
            try { var newUbsnFeat = new URL(this._xrelayUrl).searchParams.get('features') || ''; } catch(e) { var newUbsnFeat = ''; }
            if (newUbsnQid !== userByScreenNameQueryId) {
              userByScreenNameQueryId = newUbsnQid; userByScreenNameFeatures = newUbsnFeat;
              localStorage.setItem('xrelay_ubsnQueryId', userByScreenNameQueryId);
              localStorage.setItem('xrelay_ubsnFeatures', userByScreenNameFeatures);
              console.log('[XRelay] UserByScreenName queryId cached');
            }
          }
        }
        var self = this;
        this.addEventListener('load', function () {
          try {
            if (self.status !== 200 || !self.responseText) return;
            var data = JSON.parse(self.responseText);
            var uid = self._xrelayUserId;
            if (uid) {
              lastXhrAt[uid] = Date.now();
              var handle = userIdToHandle[uid];
              if (handle && watchedHandles.has(handle)) passiveRelay(data);
              else pendingByUserId[uid] = data;
            } else { passiveRelay(data); }
          } catch(e) {}
        });
      }
      return _xhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try {
        if (name && name.toLowerCase() === 'authorization' && value && value.startsWith('Bearer ') && !authToken) {
          authToken = value; console.log('[XRelay] Auth token captured via XHR');
        }
      } catch(e) {}
      return _xhrSetHeader.apply(this, arguments);
    };

    window.fetch = async function (input, init) {
      var url = (typeof input === 'string' ? input : (input && input.url)) || '';
      try {
        if (init && init.headers) grabTokens(init.headers);
        if (input && typeof input === 'object' && input.headers) grabTokens(input.headers);
      } catch(e) {}
      var response = await _fetch.apply(this, arguments);
      if (url.includes('/i/api/graphql/') && watchedHandles.size > 0) {
        try { response.clone().json().then(passiveRelay).catch(function(){}); } catch(e) {}
      }
      return response;
    };

    function walkForTweets(obj, depth, found) {
      if (depth > 25 || !obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { for (var i = 0; i < obj.length; i++) walkForTweets(obj[i], depth+1, found); return; }
      var legacy = obj.legacy;
      if (legacy && legacy.id_str && legacy.full_text && !legacy.retweeted_status_result) {
        var core = obj.core;
        var screenName = core && core.user_results && core.user_results.result &&
          core.user_results.result.legacy && core.user_results.result.legacy.screen_name;
        var handle = screenName ? screenName.toLowerCase() : (userIdToHandle[legacy.user_id_str] || null);
        if (handle && watchedHandles.has(handle)) {
          if (!found[handle]) found[handle] = [];
          found[handle].push({
            id: legacy.id_str, text: legacy.full_text,
            created_at: new Date(legacy.created_at).toISOString(),
            platform: 'twitter', url: 'https://x.com/' + handle + '/status/' + legacy.id_str,
          });
        }
      }
      var keys = Object.keys(obj);
      for (var k = 0; k < keys.length; k++) walkForTweets(obj[keys[k]], depth+1, found);
    }

    function passiveRelay(data) {
      if (watchedHandles.size === 0) return;
      var found = {};
      try { walkForTweets(data, 0, found); } catch(e) {}
      Object.keys(found).forEach(function(handle) {
        var tweets = found[handle].slice(0, 10);
        if (tweets.length) {
          console.log('[XRelay] Relaying ' + tweets.length + ' tweets for @' + handle);
          lastRelayedAt[handle] = Date.now();
          relayTweets(handle, tweets);
        }
      });
    }

    function relayTweets(handle, tweets) {
      GM_xmlhttpRequest({
        method: 'POST', url: SERVER + '/api/ingest-twitter/' + handle,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ tweets }),
        onload: function(r) { console.log('[XRelay] Relayed ' + tweets.length + ' for @' + handle + ' -> ' + r.status); },
        onerror: function() { console.error('[XRelay] Could not reach server'); },
      });
    }

    async function resolveUserId(handle) {
      if (userIdCache[handle]) return userIdCache[handle];
      if (!userByScreenNameQueryId || !authToken) return null;
      try {
        var res = await _fetch(
          'https://x.com/i/api/graphql/' + userByScreenNameQueryId + '/UserByScreenName' +
          '?variables=' + encodeURIComponent(JSON.stringify({ screen_name: handle, withSafetyModeUserFields: true })) +
          '&features=' + encodeURIComponent(userByScreenNameFeatures),
          { headers: { authorization: authToken, 'x-csrf-token': csrfToken||'', 'x-twitter-active-user':'yes', 'content-type':'application/json' }, credentials: 'include' }
        );
        var data = await res.json();
        var userId = data && data.data && data.data.user && data.data.user.result && data.data.user.result.rest_id;
        if (userId) {
          userIdCache[handle] = userId; userIdToHandle[userId] = handle;
          console.log('[XRelay] Resolved @' + handle + ' -> ' + userId);
          if (pendingByUserId[userId]) { passiveRelay(pendingByUserId[userId]); delete pendingByUserId[userId]; }
        }
        return userId || null;
      } catch(e) { return null; }
    }

    async function pollActive(handle) {
      if (!authToken || !userTweetsQueryId) return;
      if (lastRelayedAt[handle] && (Date.now() - lastRelayedAt[handle]) < XHR_COOLDOWN_MS) return;
      var userId = await resolveUserId(handle);
      if (!userId) return;
      if (lastRelayedAt[handle] && (Date.now() - lastRelayedAt[handle]) < XHR_COOLDOWN_MS) return;
      if (lastXhrAt[userId]    && (Date.now() - lastXhrAt[userId])    < XHR_COOLDOWN_MS) return;
      try {
        var res = await _fetch(
          'https://x.com/i/api/graphql/' + userTweetsQueryId + '/UserTweets' +
          '?variables=' + encodeURIComponent(JSON.stringify({ userId, count:10, includePromotedContent:false, withVoice:true, withV2Timeline:true })) +
          '&features=' + encodeURIComponent(userTweetsFeatures),
          { headers: { authorization: authToken, 'x-csrf-token': csrfToken||'', 'x-twitter-active-user':'yes', 'content-type':'application/json' }, credentials: 'include' }
        );
        if (res.status === 429) {
          pollBackoffMs = Math.min(pollBackoffMs * 2, 120000);
          console.log('[XRelay] Rate limited — backing off to ' + pollBackoffMs/1000 + 's');
          return;
        }
        pollBackoffMs = POLL_MS;
        if (!res.ok) return;
        passiveRelay(await res.json());
      } catch(e) { console.error('[XRelay] poll error:', e); }
    }

    function getConfig() {
      return new Promise(function(resolve) {
        GM_xmlhttpRequest({
          method: 'GET', url: SERVER + '/api/config?_=' + Date.now(),
          onload: function(r) { try { resolve(JSON.parse(r.responseText)); } catch(e) { resolve({}); } },
          onerror: function() { resolve({}); },
        });
      });
    }

    async function syncConfig() {
      var cfg = await getConfig();
      var handles = (cfg.watchTwitter || []).map(function(h) { return h.toLowerCase(); });
      watchedHandles = new Set(handles);
      if (userTweetsQueryId && authToken) {
        var brandNew = handles.filter(function(h) { return !knownHandles.has(h); });
        if (brandNew.length) {
          console.log('[XRelay] New handle(s), polling immediately: ' + brandNew.join(', '));
          await Promise.all(brandNew.map(pollActive));
        }
      }
      handles.forEach(function(h) { knownHandles.add(h); });
    }

    async function regularPoll() {
      var handles = Array.from(watchedHandles);
      if (!handles.length || !userTweetsQueryId || !authToken) return;
      await Promise.all(handles.map(pollActive));
    }

    var csrfMatch = document.cookie.match(/ct0=([^;]+)/);
    if (csrfMatch) csrfToken = csrfMatch[1];

    setTimeout(function() {
      syncConfig();
      setInterval(syncConfig, CONFIG_MS);
      setInterval(regularPoll, POLL_MS);
    }, 6000);

    console.log('[SocialRelay] X/Twitter v1.0 loaded');
  }

})();
