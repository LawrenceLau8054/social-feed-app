// ==UserScript==
// @name         X (Twitter) Feed Relay
// @namespace    http://localhost:3000
// @version      5.4
// @description  Relays X/Twitter posts to the local Social Feed Viewer app
// @author       local
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      social-feed-app-production-c6b1.up.railway.app
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const SERVER = 'https://social-feed-app-production-c6b1.up.railway.app';
  const CONFIG_MS = 3000;  // how often to check for newly-added handles
  const POLL_MS = 15000;   // how often to actively poll existing handles
  const XHR_COOLDOWN_MS = 20000; // skip active poll if x.com itself made a UserTweets XHR this recently

  let authToken = null;
  let csrfToken = null;
  let pollBackoffMs = POLL_MS;

  // Load cached queryIds from localStorage so we can poll immediately without a profile visit
  let userTweetsQueryId = localStorage.getItem('xrelay_utQueryId') || null;
  let userTweetsFeatures = localStorage.getItem('xrelay_utFeatures') || '';
  let userByScreenNameQueryId = localStorage.getItem('xrelay_ubsnQueryId') || null;
  let userByScreenNameFeatures = localStorage.getItem('xrelay_ubsnFeatures') || '';
  if (userTweetsQueryId) console.log('[XRelay] UserTweets queryId restored from cache: ' + userTweetsQueryId);

  const userIdCache = {};      // handle -> userId
  const userIdToHandle = {};   // userId -> handle
  const pendingByUserId = {};  // userId -> response data (received before userId was resolved)
  const lastRelayedAt = {};    // handle -> timestamp of last relay
  const lastXhrAt = {};        // userId -> timestamp of last UserTweets XHR x.com made for this userId
  let watchedHandles = new Set();

  const _fetch = window.fetch;
  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  // --- Token capture ---

  function grabTokens(h) {
    if (!h) return;
    const auth = typeof h.get === 'function' ? h.get('authorization') : (h.authorization || h.Authorization);
    const csrf = typeof h.get === 'function' ? h.get('x-csrf-token') : h['x-csrf-token'];
    if (auth && auth.startsWith('Bearer ') && !authToken) {
      authToken = auth;
      console.log('[XRelay] Auth token captured');
    }
    if (csrf && !csrfToken) csrfToken = csrf;
  }

  // --- XHR interceptor ---

  XMLHttpRequest.prototype.open = function (method, url) {
    this._xrelayUrl = url || '';
    if (this._xrelayUrl.includes('/i/api/graphql/')) {
      var m = this._xrelayUrl.match(/\/graphql\/([^/]+)\/(\w+)/);
      if (m) {
        var opName = m[2];
        if (opName === 'UserTweets') {
          var newQid = m[1];
          try { var newFeat = new URL(this._xrelayUrl).searchParams.get('features') || ''; } catch (e) { var newFeat = ''; }
          if (newQid !== userTweetsQueryId) {
            userTweetsQueryId = newQid;
            userTweetsFeatures = newFeat;
            localStorage.setItem('xrelay_utQueryId', userTweetsQueryId);
            localStorage.setItem('xrelay_utFeatures', userTweetsFeatures);
            console.log('[XRelay] UserTweets queryId captured & cached: ' + userTweetsQueryId);
          }
        }
        if (opName === 'UserByScreenName') {
          var newUbsnQid = m[1];
          try { var newUbsnFeat = new URL(this._xrelayUrl).searchParams.get('features') || ''; } catch (e) { var newUbsnFeat = ''; }
          if (newUbsnQid !== userByScreenNameQueryId) {
            userByScreenNameQueryId = newUbsnQid;
            userByScreenNameFeatures = newUbsnFeat;
            localStorage.setItem('xrelay_ubsnQueryId', userByScreenNameQueryId);
            localStorage.setItem('xrelay_ubsnFeatures', userByScreenNameFeatures);
            console.log('[XRelay] UserByScreenName queryId captured & cached');
          }
        }
        // Extract userId from UserTweets variables so we can match the response
        if (opName === 'UserTweets') {
          try {
            var varsParam = new URL(this._xrelayUrl).searchParams.get('variables');
            if (varsParam) {
              var vars = JSON.parse(varsParam);
              if (vars.userId) this._xrelayUserId = vars.userId;
            }
          } catch (e) {}
        }
      }

      var self = this;
      this.addEventListener('load', function () {
        try {
          if (self.status !== 200 || !self.responseText) return;
          var data = JSON.parse(self.responseText);
          var uid = self._xrelayUserId;
          if (uid) {
            // Record that x.com itself made a UserTweets XHR for this userId
            lastXhrAt[uid] = Date.now();
            var handle = userIdToHandle[uid];
            if (handle && watchedHandles.has(handle)) {
              passiveRelay(data); // userId already resolved
            } else {
              pendingByUserId[uid] = data; // store until userId is resolved
            }
          } else {
            passiveRelay(data);
          }
        } catch (e) {}
      });
    }
    return _xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (name && name.toLowerCase() === 'authorization' && value && value.startsWith('Bearer ') && !authToken) {
        authToken = value;
        console.log('[XRelay] Auth token captured via XHR');
      }
    } catch (e) {}
    return _xhrSetHeader.apply(this, arguments);
  };

  // --- Fetch interceptor ---

  window.fetch = async function (input, init) {
    var url = (typeof input === 'string' ? input : (input && input.url)) || '';
    try {
      if (init && init.headers) grabTokens(init.headers);
      if (input && typeof input === 'object' && input.headers) grabTokens(input.headers);
    } catch (e) {}
    var response = await _fetch.apply(this, arguments);
    if (url.includes('/i/api/graphql/') && watchedHandles.size > 0) {
      try { response.clone().json().then(passiveRelay).catch(function () {}); } catch (e) {}
    }
    return response;
  };

  // --- Tweet walker ---

  function walkForTweets(obj, depth, found) {
    if (depth > 25 || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) walkForTweets(obj[i], depth + 1, found);
      return;
    }
    var legacy = obj.legacy;
    if (legacy && legacy.id_str && legacy.full_text && !legacy.retweeted_status_result) {
      var core = obj.core;
      var screenName = core && core.user_results && core.user_results.result &&
        core.user_results.result.legacy && core.user_results.result.legacy.screen_name;
      var handle = screenName ? screenName.toLowerCase() : (userIdToHandle[legacy.user_id_str] || null);
      if (handle && watchedHandles.has(handle)) {
        if (!found[handle]) found[handle] = [];
        found[handle].push({
          id: legacy.id_str,
          text: legacy.full_text,
          created_at: new Date(legacy.created_at).toISOString(),
          platform: 'twitter',
          url: 'https://x.com/' + handle + '/status/' + legacy.id_str,
        });
      }
    }
    var keys = Object.keys(obj);
    for (var k = 0; k < keys.length; k++) walkForTweets(obj[keys[k]], depth + 1, found);
  }

  function passiveRelay(data) {
    if (watchedHandles.size === 0) return;
    var found = {};
    try { walkForTweets(data, 0, found); } catch (e) {}
    Object.keys(found).forEach(function (handle) {
      var tweets = found[handle].slice(0, 10);
      if (tweets.length) {
        console.log('[XRelay] Relaying ' + tweets.length + ' tweets for @' + handle);
        lastRelayedAt[handle] = Date.now();
        relay(handle, tweets);
      }
    });
  }

  // --- Relay to server ---

  function relay(handle, tweets) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: SERVER + '/api/ingest-twitter/' + handle,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ tweets: tweets }),
      onload: function (r) { console.log('[XRelay] Relayed ' + tweets.length + ' for @' + handle + ' -> ' + r.status); },
      onerror: function () { console.error('[XRelay] Could not reach localhost:3000'); },
    });
  }

  // --- Active polling ---

  async function resolveUserId(handle) {
    if (userIdCache[handle]) return userIdCache[handle];
    if (!userByScreenNameQueryId || !authToken) return null;
    try {
      var res = await _fetch(
        'https://x.com/i/api/graphql/' + userByScreenNameQueryId + '/UserByScreenName' +
        '?variables=' + encodeURIComponent(JSON.stringify({ screen_name: handle, withSafetyModeUserFields: true })) +
        '&features=' + encodeURIComponent(userByScreenNameFeatures),
        { headers: { authorization: authToken, 'x-csrf-token': csrfToken || '', 'x-twitter-active-user': 'yes', 'content-type': 'application/json' }, credentials: 'include' }
      );
      var data = await res.json();
      var userId = data && data.data && data.data.user && data.data.user.result && data.data.user.result.rest_id;
      if (userId) {
        userIdCache[handle] = userId;
        userIdToHandle[userId] = handle;
        console.log('[XRelay] Resolved @' + handle + ' -> ' + userId);
        // Process any XHR responses that arrived before we knew the userId
        if (pendingByUserId[userId]) {
          console.log('[XRelay] Processing pending XHR response for @' + handle);
          passiveRelay(pendingByUserId[userId]);
          delete pendingByUserId[userId];
        }
      }
      return userId || null;
    } catch (e) { return null; }
  }

  async function pollActive(handle) {
    if (!authToken || !userTweetsQueryId) return;
    // Skip if passive intercept already delivered fresh data recently
    if (lastRelayedAt[handle] && (Date.now() - lastRelayedAt[handle]) < XHR_COOLDOWN_MS) {
      console.log('[XRelay] @' + handle + ' already fresh, skipping active poll');
      return;
    }
    var userId = await resolveUserId(handle);
    if (!userId) return;
    // Re-check after resolveUserId — it may have just processed pending XHR data
    if (lastRelayedAt[handle] && (Date.now() - lastRelayedAt[handle]) < XHR_COOLDOWN_MS) {
      console.log('[XRelay] @' + handle + ' fresh after userId resolution, skipping active poll');
      return;
    }
    // Skip if x.com itself recently made a UserTweets XHR for this userId — avoid back-to-back 429
    if (lastXhrAt[userId] && (Date.now() - lastXhrAt[userId]) < XHR_COOLDOWN_MS) {
      console.log('[XRelay] @' + handle + ' x.com XHR was recent, skipping active poll to avoid 429');
      return;
    }
    try {
      var res = await _fetch(
        'https://x.com/i/api/graphql/' + userTweetsQueryId + '/UserTweets' +
        '?variables=' + encodeURIComponent(JSON.stringify({ userId: userId, count: 10, includePromotedContent: false, withVoice: true, withV2Timeline: true })) +
        '&features=' + encodeURIComponent(userTweetsFeatures),
        { headers: { authorization: authToken, 'x-csrf-token': csrfToken || '', 'x-twitter-active-user': 'yes', 'content-type': 'application/json' }, credentials: 'include' }
      );
      if (res.status === 429) {
        pollBackoffMs = Math.min(pollBackoffMs * 2, 120000);
        console.log('[XRelay] Rate limited — backing off to ' + pollBackoffMs / 1000 + 's');
        return;
      }
      pollBackoffMs = POLL_MS;
      if (!res.ok) return;
      var data = await res.json();
      passiveRelay(data);
    } catch (e) { console.error('[XRelay] Active poll error:', e); }
  }

  // --- Config + sync ---

  function getConfig() {
    return new Promise(function (resolve) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: SERVER + '/api/config?_=' + Date.now(),
        onload: function (r) { try { resolve(JSON.parse(r.responseText)); } catch (e) { resolve({}); } },
        onerror: function () { resolve({}); },
      });
    });
  }

  var knownHandles = new Set(); // handles we've already polled at least once

  async function syncConfig() {
    var cfg = await getConfig();
    var handles = (cfg.watchTwitter || []).map(function (h) { return h.toLowerCase(); });
    watchedHandles = new Set(handles);

    // Immediately poll any handle that just appeared in the watchlist
    if (userTweetsQueryId && authToken) {
      var brand_new = handles.filter(function (h) { return !knownHandles.has(h); });
      if (brand_new.length) {
        console.log('[XRelay] New handle(s) detected, polling immediately: ' + brand_new.join(', '));
        await Promise.all(brand_new.map(pollActive));
      }
    }
    handles.forEach(function (h) { knownHandles.add(h); });
  }

  async function regularPoll() {
    var handles = Array.from(watchedHandles);
    if (!handles.length || !userTweetsQueryId || !authToken) return;
    console.log('[XRelay] regular poll: ' + handles.length + ' handle(s)');
    await Promise.all(handles.map(pollActive));
  }

  var csrfMatch = document.cookie.match(/ct0=([^;]+)/);
  if (csrfMatch) csrfToken = csrfMatch[1];

  // Wait 6s before first sync — lets x.com finish its page-load XHR burst first
  setTimeout(function () {
    syncConfig();
    setInterval(syncConfig, CONFIG_MS);   // check for new handles every 3s
    setInterval(regularPoll, POLL_MS);    // full poll every 15s
  }, 6000);

  console.log('[XRelay] v5.4 loaded');
})();
