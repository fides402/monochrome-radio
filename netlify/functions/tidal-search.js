/**
 * Resolve artist + title → Tidal ID.
 * Flow: iTunes search (free) → Apple Music URL → song.link → Tidal ID → monochrome.tf metadata
 * No Spotify API needed.
 */

const axios = require('axios');
const MONO_BASE = 'https://api.monochrome.tf';

exports.handler = async (event) => {
  const CORS = { 'Access-Control-Allow-Origin': '*' };
  const { artist, title } = event.queryStringParameters || {};
  if (!artist || !title) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing artist or title' }) };
  }

  try {
    // 1. iTunes search (free, no auth)
    const itunesResp = await axios.get('https://itunes.apple.com/search', {
      params: { term: `${artist} ${title}`, entity: 'song', limit: 3 },
      timeout: 10000,
    });
    const itunesTrack = (itunesResp.data?.results || [])
      .find(t => t.trackViewUrl) || null;

    if (!itunesTrack) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Not found on iTunes' }) };
    }

    // 2. song.link: Apple Music URL → Tidal ID
    const odesli = await axios.get('https://api.song.link/v1-alpha.1/links', {
      params: { url: itunesTrack.trackViewUrl, userCountry: 'US' },
      timeout: 15000,
    });

    const d   = odesli.data;
    let tidalId = null;

    const tidalKey = Object.keys(d.entitiesByUniqueId || {}).find(k => k.startsWith('TIDAL_SONG::'));
    if (tidalKey) {
      tidalId = parseInt(tidalKey.split('::')[1], 10);
    }
    if (!tidalId) {
      const url = d.linksByPlatform?.tidal?.url || '';
      const m   = url.match(/\/track\/(\d+)/);
      if (m) tidalId = parseInt(m[1], 10);
    }

    if (!tidalId) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Not found on Tidal' }) };
    }

    // 3. Enrich with monochrome.tf metadata
    let tidalMeta = null;
    try {
      const infoResp = await axios.get(`${MONO_BASE}/info/?id=${tidalId}`, { timeout: 8000 });
      tidalMeta = infoResp.data?.data || infoResp.data;
    } catch (_) {}

    const tidalCoverUrl = (uuid, size = 640) =>
      uuid ? `https://resources.tidal.com/images/${uuid.replace(/-/g, '/')}/${size}x${size}.jpg` : null;

    const cover    = tidalMeta?.album?.cover || tidalMeta?.cover;
    const albumArt = cover
      ? tidalCoverUrl(cover)
      : (itunesTrack.artworkUrl100?.replace('100x100bb', '640x640bb') || null);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        tidalId,
        title:    tidalMeta?.title    || itunesTrack.trackName  || title,
        artist:   tidalMeta?.artist?.name || tidalMeta?.artists?.map(a=>a.name).join(', ')
                  || itunesTrack.artistName || artist,
        album:    tidalMeta?.album?.title  || itunesTrack.collectionName || '',
        albumArt,
        duration: tidalMeta?.duration || (itunesTrack.trackTimeMillis ? Math.round(itunesTrack.trackTimeMillis/1000) : null),
      }),
    };

  } catch (e) {
    console.error('[tidal-search]', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
