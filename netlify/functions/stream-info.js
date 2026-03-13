const axios = require('axios');

const MONO_BASE     = 'https://api.monochrome.tf';
const QUALITY_CHAIN = ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'];

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*' };
  const tidalId = event.queryStringParameters?.tidalId
    || (event.path || '').split('/').filter(Boolean).pop();
  if (!tidalId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing tidalId' }) };

  let lastErr;
  for (const quality of QUALITY_CHAIN) {
    try {
      const resp  = await axios.get(`${MONO_BASE}/track/?id=${tidalId}&quality=${quality}`, { timeout: 12000 });
      const track = resp.data?.data;
      if (!track?.manifest) continue;

      const decoded = Buffer.from(track.manifest, 'base64').toString('utf8');

      if (track.manifestMimeType === 'application/vnd.tidal.bts') {
        const manifest = JSON.parse(decoded);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            type:       'direct',
            url:        manifest.urls[0],
            mimeType:   manifest.mimeType,
            quality,
            bitDepth:   track.bitDepth,
            sampleRate: track.sampleRate,
          }),
        };
      }

      if (track.manifestMimeType === 'application/dash+xml') {
        // Chrome MSE only supports AAC (mp4a.40.x) and Opus in DASH.
        // Skip FLAC, ALAC, Dolby AC3/EC3, and any other codec not on the whitelist.
        const codecMatch = decoded.match(/codecs="([^"]+)"/i);
        if (!codecMatch || !/mp4a\.40|opus/i.test(codecMatch[1])) continue;

        // Only rewrite actual media URLs inside initialization= and media= attributes.
        // Other http:// occurrences are XML namespace URIs and must NOT be proxied.
        // Also decode HTML entities (&amp; → &) before URL-encoding.
        const rewritten = decoded.replace(
          /((?:initialization|media)=")([^"]+)(")/g,
          (_, attr, rawUrl, end) => {
            const url = rawUrl.replace(/&amp;/g, '&');
            return `${attr}/api/segment?url=${encodeURIComponent(url)}${end}`;
          }
        );
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            type:       'dash',
            xml:        rewritten,
            quality,
            bitDepth:   track.bitDepth,
            sampleRate: track.sampleRate,
          }),
        };
      }
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  return { statusCode: 500, headers, body: JSON.stringify({ error: lastErr?.message || 'No stream available' }) };
};
