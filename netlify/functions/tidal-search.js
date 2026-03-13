/**
 * Resolve artist + title → Tidal ID.
 * Flow: Spotify search (artist+title) → Spotify track ID → song.link → Tidal ID
 * Also returns album art URL and full metadata from Tidal.
 */

const axios = require('axios');

const SPOTIFY_CLIENT_ID     = '5d04043e27d04cee91b233ab4e7791fc';
const SPOTIFY_CLIENT_SECRET = '14dce712909a4311986a2c86dfae9848';
const MONO_BASE             = 'https://api.monochrome.tf';

// ── Spotify token cache (module-level, reused across warm Lambda invocations) ─
let _spotifyToken  = null;
let _spotifyExpiry = 0;

async function getSpotifyToken() {
  if (_spotifyToken && Date.now() < _spotifyExpiry) return _spotifyToken;
  const r = await axios.post(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    {
      headers: {
        Authorization:  'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    },
  );
  _spotifyToken  = r.data.access_token;
  _spotifyExpiry = Date.now() + (r.data.expires_in - 60) * 1000;
  return _spotifyToken;
}

exports.handler = async (event) => {
  const CORS = { 'Access-Control-Allow-Origin': '*' };
  const { artist, title } = event.queryStringParameters || {};
  if (!artist || !title) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing artist or title' }) };
  }

  try {
    // 1. Spotify search
    const token   = await getSpotifyToken();
    const q       = encodeURIComponent(`track:${title} artist:${artist}`);
    const search  = await axios.get(
      `https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 },
    );

    const spotifyTrack = search.data?.tracks?.items?.[0];
    if (!spotifyTrack) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Not found on Spotify' }) };
    }

    const spotifyId = spotifyTrack.id;

    // 2. song.link → Tidal ID
    const odesli = await axios.get(
      `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent('spotify:track:' + spotifyId)}`,
      { headers: { 'User-Agent': 'MonochromeRadio/1.0' }, timeout: 15000 },
    );
    const d   = odesli.data;
    const key = Object.keys(d.entitiesByUniqueId || {}).find(k => k.startsWith('TIDAL_SONG::'));
    let tidalId = key ? parseInt(key.split('::')[1], 10) : null;

    if (!tidalId) {
      const url = d.linksByPlatform?.tidal?.url || '';
      const m   = url.match(/\/track\/(\d+)/);
      if (m) tidalId = parseInt(m[1], 10);
    }

    if (!tidalId) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Not found on Tidal' }) };
    }

    // 3. Enrich with Tidal metadata from monochrome.tf
    let tidalMeta = null;
    try {
      const infoResp = await axios.get(`${MONO_BASE}/info/?id=${tidalId}`, { timeout: 8000 });
      tidalMeta = infoResp.data?.data || infoResp.data;
    } catch (_) {}

    const tidalCoverUrl = (uuid, size = 320) =>
      uuid ? `https://resources.tidal.com/images/${uuid.replace(/-/g, '/')}/${size}x${size}.jpg` : null;

    let albumArt = spotifyTrack.album?.images?.[0]?.url || null;
    let album    = spotifyTrack.album?.name || '';
    let duration = spotifyTrack.duration_ms ? Math.round(spotifyTrack.duration_ms / 1000) : null;

    if (tidalMeta) {
      const cover = tidalMeta.album?.cover || tidalMeta.cover;
      if (cover) albumArt = tidalCoverUrl(cover, 640);
      album    = tidalMeta.album?.title || tidalMeta.album?.name || album;
      duration = tidalMeta.duration || duration;
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        tidalId,
        spotifyId,
        title:    spotifyTrack.name,
        artist:   spotifyTrack.artists?.map(a => a.name).join(', ') || artist,
        album,
        albumArt,
        duration,
      }),
    };

  } catch (e) {
    console.error('[tidal-search]', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
