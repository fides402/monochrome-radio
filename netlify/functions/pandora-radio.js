/**
 * Pandora radio proxy — authenticates with Pandora, creates a station from
 * an artist+title search, and returns the playlist.
 *
 * Credentials come from Netlify env vars:
 *   PANDORA_EMAIL / PANDORA_PASSWORD
 *
 * Uses Node.js built-in `crypto` (Blowfish-ECB via OpenSSL) — no extra deps.
 */

const axios  = require('axios');
const crypto = require('crypto');

// ── Partner credentials (android client — publicly reverse-engineered) ────────
const PARTNER = {
  username:   'android',
  password:   'AC7IBG09A3DTSYM4R41UJWL07VLN8JI7',
  device:     'android-generic',
  version:    '5',
  decryptKey: 'R=U!LH$O2B#',
  encryptKey: '6#26FRL$ZWD',
};

const API = 'https://tuner.pandora.com/services/json/';

// ── Blowfish helpers (ECB, no padding — OpenSSL built-in) ────────────────────
function bfDecrypt(hexStr, key) {
  const d = crypto.createDecipheriv('bf-ecb', Buffer.from(key), Buffer.alloc(0));
  d.setAutoPadding(false);
  return Buffer.concat([d.update(Buffer.from(hexStr, 'hex')), d.final()])
    .toString('utf8').replace(/\0/g, '');
}

function bfEncrypt(str, key) {
  const pad    = (8 - (str.length % 8)) % 8;
  const padded = str + '\0'.repeat(pad);
  const c = crypto.createCipheriv('bf-ecb', Buffer.from(key), Buffer.alloc(0));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(Buffer.from(padded, 'utf8')), c.final()])
    .toString('hex');
}

// ── Low-level API call ────────────────────────────────────────────────────────
async function pandoraPost(method, body, params = {}, encrypt = false) {
  const bodyStr = JSON.stringify(body);
  const payload = encrypt ? bfEncrypt(bodyStr, PARTNER.encryptKey) : bodyStr;

  const resp = await axios.post(`${API}?method=${method}`, payload, {
    params,
    headers: {
      'Content-Type': 'text/plain',
      'User-Agent':   'Pandora/8.4 (Linux; Android 8.1)',
    },
    timeout: 20000,
  });

  if (resp.data.stat !== 'ok') {
    throw new Error(resp.data.message || `Pandora error [${resp.data.code}]`);
  }
  return resp.data.result;
}

// ── Session — partner + user login ───────────────────────────────────────────
async function createSession(email, password) {
  // 1. Partner login (plain)
  const partner = await pandoraPost('auth.partnerLogin', {
    username:    PARTNER.username,
    password:    PARTNER.password,
    deviceModel: PARTNER.device,
    version:     PARTNER.version,
    includeUrls: true,
  });

  // Decrypt syncTime: first 4 bytes are garbage, rest is ASCII unix timestamp
  const rawTime    = bfDecrypt(partner.syncTime, PARTNER.decryptKey);
  const serverTime = parseInt(rawTime.slice(4), 10);
  const timeOffset = Math.floor(Date.now() / 1000) - serverTime;

  // 2. User login (encrypted)
  const user = await pandoraPost(
    'auth.userLogin',
    {
      loginType:        'user',
      username:         email,
      password:         password,
      partnerAuthToken: partner.partnerAuthToken,
      syncTime:         Math.floor(Date.now() / 1000) - timeOffset,
    },
    {
      partner_id: partner.partnerId,
      auth_token: partner.partnerAuthToken,
    },
    true,
  );

  return {
    partnerId:    partner.partnerId,
    partnerToken: partner.partnerAuthToken,
    userId:       user.userId,
    userToken:    user.userAuthToken,
    timeOffset,
  };
}

// Helpers
const authParams = s => ({
  partner_id: s.partnerId,
  user_id:    s.userId,
  auth_token: s.userToken,
});
const syncNow = s => Math.floor(Date.now() / 1000) - s.timeOffset;

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const CORS = { 'Access-Control-Allow-Origin': '*' };

  // OPTIONS pre-flight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET' }, body: '' };
  }

  const { artist, title } = event.queryStringParameters || {};
  if (!artist || !title) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing artist or title' }) };
  }

  const email    = process.env.PANDORA_EMAIL;
  const password = process.env.PANDORA_PASSWORD;
  if (!email || !password) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Pandora credentials not set in env vars' }) };
  }

  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const session = await createSession(email, password);
    const params  = authParams(session);

    // ── Search track on Pandora ───────────────────────────────────────────────
    const search = await pandoraPost(
      'music.search',
      {
        searchText:          `${artist} ${title}`,
        includeNearMatches:  true,
        includeGenreStations: false,
        userAuthToken:       session.userToken,
        syncTime:            syncNow(session),
      },
      params,
      true,
    );

    const song = (search.songs || [])[0];
    if (!song) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Track not found on Pandora' }) };
    }

    // ── Create station ────────────────────────────────────────────────────────
    const station = await pandoraPost(
      'station.createStation',
      {
        musicType:     'song',
        musicToken:    song.musicToken,
        userAuthToken: session.userToken,
        syncTime:      syncNow(session),
      },
      params,
      true,
    );

    // ── Get playlist (call twice to get ~8-10 tracks) ─────────────────────────
    const playlistBody = {
      stationToken:       station.stationToken,
      includeTrackLength: true,
      userAuthToken:      session.userToken,
    };

    const [pl1, pl2] = await Promise.all([
      pandoraPost('station.getPlaylist', { ...playlistBody, syncTime: syncNow(session) }, params, true),
      pandoraPost('station.getPlaylist', { ...playlistBody, syncTime: syncNow(session) }, params, true),
    ]);

    const allItems = [...(pl1.items || []), ...(pl2.items || [])];
    const tracks = allItems
      .filter(t => t.songTitle && t.artistName) // exclude ads
      .map(t => ({
        artist:   t.artistName,
        title:    t.songTitle,
        album:    t.albumName    || null,
        albumArt: t.albumArtUrl  || null,
        duration: t.trackLength  || null,
      }));

    // De-duplicate by artist+title
    const seen = new Set();
    const unique = tracks.filter(t => {
      const key = `${t.artist}|${t.title}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ stationName: station.stationName, tracks: unique }),
    };

  } catch (e) {
    console.error('[pandora-radio]', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
