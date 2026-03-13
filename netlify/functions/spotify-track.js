/**
 * Returns track metadata for a Spotify track ID.
 * Uses song.link (odesli) API — no Spotify Premium required.
 * Returns a shape compatible with what the frontend expects:
 *   { name, artists:[{name}], album:{name, images:[{url}]} }
 */
const axios = require('axios');

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*' };
  const spotifyId = event.queryStringParameters?.spotifyId
    || (event.path || '').split('/').filter(Boolean).pop();
  if (!spotifyId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing spotifyId' }) };

  try {
    // song.link resolves Spotify track → metadata + cross-platform links
    const r = await axios.get('https://api.song.link/v1-alpha.1/links', {
      params: { url: `spotify:track:${spotifyId}`, userCountry: 'US' },
      timeout: 10000,
    });

    const entities = r.data.entitiesByUniqueId || {};
    // Find the Spotify entity
    const spotifyKey = Object.keys(entities).find(k => k.startsWith('SPOTIFY_SONG::'));
    const entity = spotifyKey ? entities[spotifyKey] : Object.values(entities)[0];

    if (!entity) throw new Error('No metadata found for this track');

    // Return Spotify-API-compatible shape so frontend code doesn't change
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        id:      spotifyId,
        name:    entity.title,
        artists: [{ name: entity.artistName }],
        album: {
          name:   entity.collectionName || entity.title,
          images: entity.thumbnailUrl ? [{ url: entity.thumbnailUrl }] : [],
        },
        duration_ms: null,
      }),
    };
  } catch (e) {
    const status = e.response?.status || 500;
    return { statusCode: status, headers, body: JSON.stringify({ error: e.response?.data?.message || e.message }) };
  }
};
