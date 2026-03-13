const axios = require('axios');

const CLIENT_ID     = '5d04043e27d04cee91b233ab4e7791fc';
const CLIENT_SECRET = '14dce712909a4311986a2c86dfae9848';

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const r = await axios.post(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    {
      headers: {
        Authorization:  'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  cachedToken = r.data.access_token;
  tokenExpiry  = Date.now() + (r.data.expires_in - 60) * 1000;
  return cachedToken;
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*' };
  // Support both ?spotifyId= query param (Netlify redirect) and last path segment fallback
  const spotifyId = event.queryStringParameters?.spotifyId
    || (event.path || '').split('/').filter(Boolean).pop();
  if (!spotifyId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing spotifyId' }) };

  try {
    const token = await getToken();
    const r     = await axios.get(
      `https://api.spotify.com/v1/tracks/${spotifyId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return { statusCode: 200, headers, body: JSON.stringify(r.data) };
  } catch (e) {
    const status = e.response?.status || 500;
    return { statusCode: status, headers, body: JSON.stringify({ error: e.response?.data?.error?.message || e.message }) };
  }
};
