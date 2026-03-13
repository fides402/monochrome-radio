const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ────────────────────────────────────────────────────────────────────
const PORT                  = process.env.PORT || 3000;
const SPOTIFY_CLIENT_ID     = '5d04043e27d04cee91b233ab4e7791fc';
const SPOTIFY_CLIENT_SECRET = '14dce712909a4311986a2c86dfae9848';
const MONO_BASE             = 'https://api.monochrome.tf';
const QUALITY_CHAIN         = ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'];

// ── Spotify token cache ───────────────────────────────────────────────────────
let cachedToken  = null;
let tokenExpiry  = 0;

async function getSpotifyToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const resp = await axios.post(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    {
      headers: {
        Authorization:  'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  cachedToken = resp.data.access_token;
  tokenExpiry  = Date.now() + (resp.data.expires_in - 60) * 1000;
  return cachedToken;
}

// ── Spotify track info ────────────────────────────────────────────────────────
app.get('/api/spotify/track/:id', async (req, res) => {
  try {
    const token = await getSpotifyToken();
    const resp  = await axios.get(
      `https://api.spotify.com/v1/tracks/${req.params.id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(resp.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Resolve Spotify → Tidal ID (via odesli/song.link) ────────────────────────
app.get('/api/resolve/:spotifyId', async (req, res) => {
  try {
    const resp = await axios.get(
      `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent('spotify:track:' + req.params.spotifyId)}`,
      { headers: { 'User-Agent': 'MonochromeRadio/1.0' }, timeout: 15000 }
    );
    const d   = resp.data;
    const key = Object.keys(d.entitiesByUniqueId || {}).find(k => k.startsWith('TIDAL_SONG::'));
    if (key) return res.json({ tidalId: parseInt(key.split('::')[1], 10) });
    const url = d.linksByPlatform?.tidal?.url || '';
    const m   = url.match(/\/track\/(\d+)/);
    if (m)    return res.json({ tidalId: parseInt(m[1], 10) });
    res.status(404).json({ error: 'Track not found on Tidal' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Tidal/Monochrome track info ───────────────────────────────────────────────
app.get('/api/tidal-info/:tidalId', async (req, res) => {
  try {
    const resp = await axios.get(`${MONO_BASE}/info/?id=${req.params.tidalId}`, { timeout: 10000 });
    res.json(resp.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Recommendations (radio queue) ─────────────────────────────────────────────
app.get('/api/recommendations/:tidalId', async (req, res) => {
  try {
    const resp = await axios.get(`${MONO_BASE}/recommendations/?id=${req.params.tidalId}`, { timeout: 15000 });
    res.json(resp.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Stream manifest (returns metadata about how to play the track) ────────────
app.get('/api/stream-info/:tidalId', async (req, res) => {
  const { tidalId } = req.params;
  let lastErr;
  for (const quality of QUALITY_CHAIN) {
    try {
      const resp  = await axios.get(`${MONO_BASE}/track/?id=${tidalId}&quality=${quality}`, { timeout: 12000 });
      const track = resp.data?.data;
      if (!track?.manifest) continue;

      const decoded = Buffer.from(track.manifest, 'base64').toString('utf8');

      if (track.manifestMimeType === 'application/vnd.tidal.bts') {
        const manifest = JSON.parse(decoded);
        return res.json({
          type:       'direct',
          url:        manifest.urls[0],
          mimeType:   manifest.mimeType,
          quality,
          bitDepth:   track.bitDepth,
          sampleRate: track.sampleRate,
        });
      }

      if (track.manifestMimeType === 'application/dash+xml') {
        // Serve the manifest with URLs rewritten to go through our segment proxy
        const rewritten = decoded.replace(
          /https?:\/\/[^\s"<>]+/g,
          url => `http://localhost:${PORT}/api/segment?url=${encodeURIComponent(url)}`
        );
        return res.json({
          type:    'dash',
          xml:     rewritten,
          quality,
          bitDepth:   track.bitDepth,
          sampleRate: track.sampleRate,
        });
      }
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  res.status(500).json({ error: lastErr?.message || 'No stream available' });
});

// ── Audio proxy (for direct streams — CORS bypass) ────────────────────────────
app.get('/api/audio/:tidalId', async (req, res) => {
  const { tidalId } = req.params;

  // Get stream info
  let streamUrl, mimeType;
  for (const quality of QUALITY_CHAIN) {
    try {
      const resp  = await axios.get(`${MONO_BASE}/track/?id=${tidalId}&quality=${quality}`, { timeout: 12000 });
      const track = resp.data?.data;
      if (!track?.manifest) continue;
      const decoded = Buffer.from(track.manifest, 'base64').toString('utf8');
      if (track.manifestMimeType === 'application/vnd.tidal.bts') {
        const manifest = JSON.parse(decoded);
        streamUrl = manifest.urls[0];
        mimeType  = manifest.mimeType || 'audio/flac';
        break;
      }
      // For DASH, skip to next quality hoping for BTS
    } catch (_) { continue; }
  }

  if (!streamUrl) return res.status(404).json({ error: 'No direct stream found' });

  try {
    const headers = { 'User-Agent': 'MonochromeRadio/1.0' };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const upstream = await axios.get(streamUrl, {
      responseType:   'stream',
      headers,
      validateStatus: s => s < 500,
      timeout:        30000,
    });

    res.status(upstream.status);
    res.setHeader('Content-Type', mimeType || upstream.headers['content-type'] || 'audio/flac');
    res.setHeader('Accept-Ranges', 'bytes');
    if (upstream.headers['content-range'])  res.setHeader('Content-Range',  upstream.headers['content-range']);
    if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
    upstream.data.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
});

// ── Generic URL proxy (for DASH segments and fallback audio) ──────────────────
app.get('/api/segment', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });
  try {
    const headers = { 'User-Agent': 'MonochromeRadio/1.0' };
    if (req.headers.range) headers['Range'] = req.headers.range;
    const upstream = await axios.get(url, {
      responseType:   'stream',
      headers,
      validateStatus: s => s < 500,
      timeout:        20000,
    });
    res.status(upstream.status);
    const ct = upstream.headers['content-type'];
    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', 'bytes');
    if (upstream.headers['content-range'])  res.setHeader('Content-Range',  upstream.headers['content-range']);
    if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
    upstream.data.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ✦ Monochrome Radio  →  http://localhost:${PORT}\n`);
});
