const axios = require('axios');

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*' };
  const spotifyId = event.queryStringParameters?.spotifyId
    || (event.path || '').split('/').filter(Boolean).pop();
  if (!spotifyId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing spotifyId' }) };

  try {
    const resp = await axios.get(
      `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent('spotify:track:' + spotifyId)}`,
      { headers: { 'User-Agent': 'MonochromeRadio/1.0' }, timeout: 15000 }
    );
    const d   = resp.data;
    const key = Object.keys(d.entitiesByUniqueId || {}).find(k => k.startsWith('TIDAL_SONG::'));
    if (key) return { statusCode: 200, headers, body: JSON.stringify({ tidalId: parseInt(key.split('::')[1], 10) }) };

    const url = d.linksByPlatform?.tidal?.url || '';
    const m   = url.match(/\/track\/(\d+)/);
    if (m)    return { statusCode: 200, headers, body: JSON.stringify({ tidalId: parseInt(m[1], 10) }) };

    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Track not found on Tidal' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
