/**
 * Generic URL proxy for DASH segments — used when stream-info returns DASH manifest.
 * The frontend rewrites segment URLs in the manifest to go through this endpoint.
 */
const axios = require('axios');

exports.handler = async (event) => {
  const { url } = event.queryStringParameters || {};
  if (!url) return { statusCode: 400, body: 'Missing url' };

  try {
    const headers = { 'User-Agent': 'MonochromeRadio/1.0' };
    if (event.headers?.range) headers['Range'] = event.headers.range;

    const upstream = await axios.get(url, {
      responseType:   'arraybuffer',
      headers,
      validateStatus: s => s < 500,
      timeout:        20000,
    });

    const isPartial = upstream.status === 206;
    const respHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type':  upstream.headers['content-type'] || 'audio/mp4',
      'Accept-Ranges': 'bytes',
    };
    if (upstream.headers['content-range'])  respHeaders['Content-Range']  = upstream.headers['content-range'];
    if (upstream.headers['content-length']) respHeaders['Content-Length'] = upstream.headers['content-length'];

    return {
      statusCode:      isPartial ? 206 : 200,
      headers:         respHeaders,
      body:            Buffer.from(upstream.data).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: e.message }) };
  }
};
