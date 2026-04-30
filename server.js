require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Allow Tampermonkey scripts (running on x.com, truthsocial.com) to reach the API
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// In-memory stores — keyed by handle (lowercase)
const truthStore = {};
const twitterStore = {};
const watchedTwitter = new Set();
const watchedTruth = new Set();

// SSE clients — push updates instantly to the browser
const sseClients = new Set();

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function pushUpdate(platform, handle, posts) {
  const payload = `data: ${JSON.stringify({ platform, handle, posts })}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// --- Truth Social ingest (Tampermonkey relay) ---
app.post('/api/ingest/:handle', (req, res) => {
  const { handle } = req.params;
  const { statuses } = req.body;
  if (!Array.isArray(statuses)) return res.status(400).json({ error: 'invalid payload' });

  const stripHtml = (html) =>
    (html || '')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim();

  const posts = statuses.slice(0, 10).map((s) => ({
    id: s.id,
    text: stripHtml(s.content),
    created_at: s.created_at,
    platform: 'truthsocial',
    url: s.url || `https://truthsocial.com/@${handle}`,
  }));

  truthStore[handle.toLowerCase()] = { posts };
  pushUpdate('truthsocial', handle.toLowerCase(), posts);
  res.json({ ok: true });
});

// --- Twitter ingest (Tampermonkey relay) ---
app.post('/api/ingest-twitter/:handle', (req, res) => {
  const { handle } = req.params;
  const { tweets } = req.body;
  if (!Array.isArray(tweets)) return res.status(400).json({ error: 'invalid payload' });

  const posts = tweets.slice(0, 10);
  twitterStore[handle.toLowerCase()] = { posts };
  pushUpdate('twitter', handle.toLowerCase(), posts);
  res.json({ ok: true });
});

// --- Config + watch lists (read by Tampermonkey scripts) ---
app.get('/api/config', (req, res) => {
  res.json({
    truthSocialToken: process.env.TRUTH_SOCIAL_TOKEN || null,
    watchTwitter: [...watchedTwitter],
    watchTruth: [...watchedTruth],
  });
});

// --- Twitter GET ---
app.get('/api/twitter/:handle', (req, res) => {
  const key = req.params.handle.toLowerCase();
  watchedTwitter.add(key);
  const stored = twitterStore[key];
  if (!stored) {
    return res.status(503).json({
      error: `Waiting for data — make sure x.com is open in a Chrome tab with the X Feed Relay Tampermonkey script running.`,
    });
  }
  res.json({ posts: stored.posts, username: req.params.handle });
});

// --- Truth Social GET ---
app.get('/api/truthsocial/:handle', (req, res) => {
  const key = req.params.handle.toLowerCase();
  watchedTruth.add(key);
  const stored = truthStore[key];
  if (!stored) {
    return res.status(503).json({
      error: 'No data yet. Make sure truthsocial.com is open in a Chrome tab with the Tampermonkey relay script installed.',
    });
  }
  res.json({ posts: stored.posts, username: req.params.handle });
});

app.listen(PORT, () => {
  console.log(`\n  Social Feed App running at http://localhost:${PORT}\n`);
});
