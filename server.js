const express = require('express');
const axios   = require('axios');
const path    = require('path');
const crypto  = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ────────────────────────────────────────────────────────────────────
const PORT                  = process.env.PORT || 3000;
const SPOTIFY_CLIENT_ID     = '5d04043e27d04cee91b233ab4e7791fc';
const SPOTIFY_CLIENT_SECRET = '14dce712909a4311986a2c86dfae9848';
const MONO_BASE             = 'https://api.monochrome.tf';
const QUALITY_CHAIN         = ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'];

// ── Pandora partner credentials ───────────────────────────────────────────────
const PANDORA_PARTNER = {
  username:   'android',
  password:   'AC7IBG09A3DTSYM4R41UJWL07VLN8JI7',
  device:     'android-generic',
  version:    '5',
  decryptKey: 'R=U!LH$O2B#',
  encryptKey: '6#26FRL$ZWD',
};
const PANDORA_API = 'https://tuner.pandora.com/services/json/';

function bfDecrypt(hexStr, key) {
  const d = crypto.createDecipheriv('bf-ecb', Buffer.from(key), Buffer.alloc(0));
  d.setAutoPadding(false);
  return Buffer.concat([d.update(Buffer.from(hexStr, 'hex')), d.final()])
    .toString('utf8').replace(/\0/g, '');
}
function bfEncrypt(str, key) {
  const pad = (8 - (str.length % 8)) % 8;
  const c = crypto.createCipheriv('bf-ecb', Buffer.from(key), Buffer.alloc(0));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(Buffer.from(str + '\0'.repeat(pad), 'utf8')), c.final()])
    .toString('hex');
}
async function pandoraPost(method, body, params = {}, encrypt = false) {
  const bodyStr = JSON.stringify(body);
  const payload = encrypt ? bfEncrypt(bodyStr, PANDORA_PARTNER.encryptKey) : bodyStr;
  const resp = await axios.post(`${PANDORA_API}?method=${method}`, payload, {
    params,
    headers: { 'Content-Type': 'text/plain', 'User-Agent': 'Pandora/8.4 (Linux; Android 8.1)' },
    timeout: 20000,
  });
  if (resp.data.stat !== 'ok') throw new Error(resp.data.message || `Pandora [${resp.data.code}]`);
  return resp.data.result;
}
async function createPandoraSession(email, password) {
  const partner    = await pandoraPost('auth.partnerLogin', {
    username: PANDORA_PARTNER.username, password: PANDORA_PARTNER.password,
    deviceModel: PANDORA_PARTNER.device, version: PANDORA_PARTNER.version, includeUrls: true,
  });
  const serverTime = parseInt(bfDecrypt(partner.syncTime, PANDORA_PARTNER.decryptKey).slice(4), 10);
  const timeOffset = Math.floor(Date.now() / 1000) - serverTime;
  const user = await pandoraPost('auth.userLogin', {
    loginType: 'user', username: email, password,
    partnerAuthToken: partner.partnerAuthToken,
    syncTime: Math.floor(Date.now() / 1000) - timeOffset,
  }, { partner_id: partner.partnerId, auth_token: partner.partnerAuthToken }, true);
  return { partnerId: partner.partnerId, partnerToken: partner.partnerAuthToken,
           userId: user.userId, userToken: user.userAuthToken, timeOffset };
}
const pandoraAuthParams = s => ({ partner_id: s.partnerId, user_id: s.userId, auth_token: s.userToken });
const pandoraSyncNow    = s => Math.floor(Date.now() / 1000) - s.timeOffset;

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
    const detail = e.response?.data?.error?.message || e.message;
    console.error('[Spotify]', detail);
    res.status(e.response?.status || 500).json({ error: detail });
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

// ── Pandora radio ─────────────────────────────────────────────────────────────
app.get('/api/pandora-radio', async (req, res) => {
  const { artist, title } = req.query;
  if (!artist || !title) return res.status(400).json({ error: 'Missing artist or title' });
  const email    = process.env.PANDORA_EMAIL;
  const password = process.env.PANDORA_PASSWORD;
  if (!email || !password) return res.status(500).json({ error: 'Pandora credentials not set in env (PANDORA_EMAIL / PANDORA_PASSWORD)' });
  try {
    const session = await createPandoraSession(email, password);
    const params  = pandoraAuthParams(session);
    const search  = await pandoraPost('music.search', {
      searchText: `${artist} ${title}`, includeNearMatches: true, includeGenreStations: false,
      userAuthToken: session.userToken, syncTime: pandoraSyncNow(session),
    }, params, true);
    const song = (search.songs || [])[0];
    if (!song) return res.status(404).json({ error: 'Track not found on Pandora' });
    const station = await pandoraPost('station.createStation', {
      musicType: 'song', musicToken: song.musicToken,
      userAuthToken: session.userToken, syncTime: pandoraSyncNow(session),
    }, params, true);
    const plBody = { stationToken: station.stationToken, includeTrackLength: true, userAuthToken: session.userToken };
    const [pl1, pl2] = await Promise.all([
      pandoraPost('station.getPlaylist', { ...plBody, syncTime: pandoraSyncNow(session) }, params, true),
      pandoraPost('station.getPlaylist', { ...plBody, syncTime: pandoraSyncNow(session) }, params, true),
    ]);
    const seen  = new Set();
    const tracks = [...(pl1.items || []), ...(pl2.items || [])]
      .filter(t => t.songTitle && t.artistName)
      .map(t => ({ artist: t.artistName, title: t.songTitle, album: t.albumName || null, albumArt: t.albumArtUrl || null, duration: t.trackLength || null }))
      .filter(t => { const k = `${t.artist}|${t.title}`.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    res.json({ stationName: station.stationName, tracks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Tidal search (artist+title → Tidal ID via Spotify + song.link) ────────────
app.get('/api/tidal-search', async (req, res) => {
  const { artist, title } = req.query;
  if (!artist || !title) return res.status(400).json({ error: 'Missing artist or title' });
  try {
    const token  = await getSpotifyToken();
    const q      = encodeURIComponent(`track:${title} artist:${artist}`);
    const search = await axios.get(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 });
    const sp = search.data?.tracks?.items?.[0];
    if (!sp) return res.status(404).json({ error: 'Not found on Spotify' });
    const odesli = await axios.get(
      `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent('spotify:track:' + sp.id)}`,
      { headers: { 'User-Agent': 'MonochromeRadio/1.0' }, timeout: 15000 });
    const d   = odesli.data;
    const key = Object.keys(d.entitiesByUniqueId || {}).find(k => k.startsWith('TIDAL_SONG::'));
    let tidalId = key ? parseInt(key.split('::')[1], 10) : null;
    if (!tidalId) { const m = (d.linksByPlatform?.tidal?.url || '').match(/\/track\/(\d+)/); if (m) tidalId = parseInt(m[1], 10); }
    if (!tidalId) return res.status(404).json({ error: 'Not found on Tidal' });
    let albumArt = sp.album?.images?.[0]?.url || null;
    let album    = sp.album?.name || '';
    let duration = sp.duration_ms ? Math.round(sp.duration_ms / 1000) : null;
    try {
      const info = await axios.get(`${MONO_BASE}/info/?id=${tidalId}`, { timeout: 8000 });
      const m = info.data?.data || info.data;
      const cover = m?.album?.cover || m?.cover;
      if (cover) albumArt = `https://resources.tidal.com/images/${cover.replace(/-/g,'/')}/${640}x${640}.jpg`;
      if (m?.album?.title) album    = m.album.title;
      if (m?.duration)     duration = m.duration;
    } catch (_) {}
    res.json({ tidalId, spotifyId: sp.id, title: sp.name, artist: sp.artists?.map(a => a.name).join(', ') || artist, album, albumArt, duration });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Diagnostic test endpoint ──────────────────────────────────────────────────
app.get('/api/test', async (req, res) => {
  const results = {};

  // 1. Spotify token
  try {
    const token = await getSpotifyToken();
    results.spotify_token = { ok: true, token: token.slice(0, 10) + '…' };
  } catch (e) {
    results.spotify_token = { ok: false, error: e.response?.data || e.message };
  }

  // 2. Spotify track lookup (test with a well-known track)
  const TEST_SPOTIFY_ID = '4iV5W9uYEdYUVa79Axb7Rh'; // Shape of You
  if (results.spotify_token.ok) {
    try {
      const token = await getSpotifyToken();
      const r = await axios.get(`https://api.spotify.com/v1/tracks/${TEST_SPOTIFY_ID}`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 });
      results.spotify_track = { ok: true, name: r.data.name, artist: r.data.artists?.[0]?.name };
    } catch (e) {
      results.spotify_track = { ok: false, error: e.response?.data || e.message };
    }
  } else {
    results.spotify_track = { ok: false, error: 'Skipped — token failed' };
  }

  // 3. song.link (odesli)
  try {
    const r = await axios.get(
      `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent('spotify:track:' + TEST_SPOTIFY_ID)}`,
      { headers: { 'User-Agent': 'MonochromeRadio/1.0' }, timeout: 15000 });
    const tidal = r.data.linksByPlatform?.tidal?.url;
    results.songlink = { ok: !!tidal, tidalUrl: tidal || '(not found on Tidal)' };
  } catch (e) {
    results.songlink = { ok: false, error: e.message };
  }

  // 4. monochrome.tf
  try {
    const r = await axios.get(`${MONO_BASE}/info/?id=64975005`, { timeout: 8000 });
    results.monochrome = { ok: true, title: r.data?.data?.title || r.data?.title };
  } catch (e) {
    results.monochrome = { ok: false, error: e.message };
  }

  // 5. Pandora
  const email    = process.env.PANDORA_EMAIL;
  const password = process.env.PANDORA_PASSWORD;
  if (email && password) {
    try {
      await createPandoraSession(email, password);
      results.pandora = { ok: true };
    } catch (e) {
      results.pandora = { ok: false, error: e.message };
    }
  } else {
    results.pandora = { ok: false, error: 'PANDORA_EMAIL / PANDORA_PASSWORD not set' };
  }

  console.log('\n[/api/test]', JSON.stringify(results, null, 2));
  res.json(results);
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
