const axios = require('axios');

const MONO_BASE = 'https://api.monochrome.tf';

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*' };
  const tidalId = event.queryStringParameters?.tidalId
    || (event.path || '').split('/').filter(Boolean).pop();
  if (!tidalId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing tidalId' }) };

  try {
    const r = await axios.get(`${MONO_BASE}/recommendations/?id=${tidalId}`, { timeout: 20000 });
    return { statusCode: 200, headers, body: JSON.stringify(r.data) };
  } catch (e) {
    return { statusCode: e.response?.status || 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
