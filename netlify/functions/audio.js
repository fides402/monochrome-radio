/**
 * Audio endpoint for Netlify — returns a 302 redirect to the direct Tidal CDN URL.
 * The browser's <audio> element follows the redirect and streams natively.
 * Range requests (seeking) work because the browser sends them directly to Tidal CDN.
 */
const axios = require('axios');

const MONO_BASE     = 'https://api.monochrome.tf';
const QUALITY_CHAIN = ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'];

exports.handler = async (event) => {
  const { tidalId } = event.queryStringParameters || {};
  if (!tidalId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing tidalId' }) };
  }

  for (const quality of QUALITY_CHAIN) {
    try {
      const resp  = await axios.get(`${MONO_BASE}/track/?id=${tidalId}&quality=${quality}`, { timeout: 12000 });
      const track = resp.data?.data;
      if (!track?.manifest) continue;

      const decoded = Buffer.from(track.manifest, 'base64').toString('utf8');

      if (track.manifestMimeType === 'application/vnd.tidal.bts') {
        const manifest = JSON.parse(decoded);
        const url      = manifest.urls[0];
        // 302 redirect — browser streams directly from Tidal CDN
        return {
          statusCode: 302,
          headers: {
            Location:                 url,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control':          'no-store',
          },
          body: '',
        };
      }

      // DASH — tell client to use stream-info instead
      if (track.manifestMimeType === 'application/dash+xml') {
        continue; // try lower quality for a direct URL
      }
    } catch (_) { continue; }
  }

  return {
    statusCode: 404,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ error: 'No direct stream found for this track' }),
  };
};
