/* ══════════════════════════════════════════════════════════════════════
   Monochrome Radio — Frontend
   Flow: Spotify URL → Pandora station → artist+title → Tidal IDs → stream
   ══════════════════════════════════════════════════════════════════════ */

// ── Tidal cover helper ────────────────────────────────────────────────────────
function tidalCoverUrl(coverUuid, size = 320) {
  if (!coverUuid) return null;
  return `https://resources.tidal.com/images/${coverUuid.replace(/-/g, '/')}/${size}x${size}.jpg`;
}

function fmtDuration(secs) {
  if (!secs) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  queue:        [],          // Array of Tidal track objects
  queueIndex:   -1,
  currentTrack: null,        // { tidalId, title, artist, albumArt, quality }
  isPlaying:    false,
  isShuffle:    false,
  repeatMode:   'off',       // 'off' | 'one' | 'all'
  volume:       0.8,
  isMuted:      false,
  isLoading:    false,
  liked:        new Set(),
};

// ── Audio engine ──────────────────────────────────────────────────────────────
const audio    = new Audio();
audio.preload  = 'auto';
audio.volume   = state.volume;

// dash.js player instance (lazy)
let dashPlayer = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const el = {
  // Search
  searchInput: $('search-input'),
  searchBtn:   $('search-btn'),

  // Now playing panel
  npEmpty:     $('np-empty'),
  npContent:   $('np-content'),
  npArt:       $('np-art'),
  npArtPlaceholder: $('np-art-placeholder'),
  npSpinner:   $('np-spinner'),
  npTitle:     $('np-title'),
  npArtist:    $('np-artist'),
  npAlbum:     $('np-album'),
  npQuality:   $('np-quality'),

  // Queue
  queueList:   $('queue-list'),
  queueTitle:  $('queue-title'),
  queueSubtitle: $('queue-subtitle'),

  // Player bar
  playerThumb: $('player-thumb'),
  playerThumbPlaceholder: $('player-thumb-placeholder'),
  playerTitle: $('player-title'),
  playerArtist: $('player-artist'),
  playerHeart: $('player-heart'),
  playBtn:     $('play-btn'),
  prevBtn:     $('prev-btn'),
  nextBtn:     $('next-btn'),
  shuffleBtn:  $('shuffle-btn'),
  repeatBtn:   $('repeat-btn'),
  progressTrack: $('progress-track'),
  progressFill:  $('progress-fill'),
  progressThumb: $('progress-thumb'),
  timeCur:     $('time-cur'),
  timeTotal:   $('time-total'),
  volBtn:      $('vol-btn'),
  volumeTrack: $('volume-track'),
  volumeFill:  $('volume-fill'),
};

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, isError = false, duration = 3000) {
  const t = $('toast');
  t.textContent = msg;
  t.className   = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, duration);
}

// ── Update player UI ──────────────────────────────────────────────────────────
function updatePlayerUI() {
  const t = state.currentTrack;
  if (!t) return;

  // Player bar
  el.playerTitle.textContent  = t.title  || '—';
  el.playerArtist.textContent = t.artist || '—';
  if (t.albumArt) {
    el.playerThumb.src              = t.albumArt;
    el.playerThumb.style.display    = 'block';
    el.playerThumbPlaceholder.style.display = 'none';
  } else {
    el.playerThumb.style.display    = 'none';
    el.playerThumbPlaceholder.style.display = 'flex';
  }
  el.playerHeart.className = 'player-heart' + (state.liked.has(t.tidalId) ? ' liked' : '');

  // Now playing panel
  el.npTitle.textContent  = t.title  || '—';
  el.npArtist.textContent = t.artist || '—';
  el.npAlbum.textContent  = t.album  || '';
  el.npEmpty.style.display   = 'none';
  el.npContent.style.display = 'flex';
  el.npContent.classList.add('visible');

  if (t.albumArt) {
    el.npArt.src              = t.albumArt;
    el.npArt.style.display    = 'block';
    el.npArtPlaceholder.style.display = 'none';
  } else {
    el.npArt.style.display    = 'none';
    el.npArtPlaceholder.style.display = 'flex';
  }

  if (t.quality) {
    el.npQuality.textContent = t.quality.replace(/_/g, ' ');
    el.npQuality.style.display = 'inline-block';
  } else {
    el.npQuality.style.display = 'none';
  }
}

function updatePlayPauseBtn() {
  const icon = state.isPlaying
    ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`;
  el.playBtn.innerHTML = icon;
}

function updateShuffleBtn() {
  el.shuffleBtn.classList.toggle('active', state.isShuffle);
}

function updateRepeatBtn() {
  el.repeatBtn.classList.toggle('active', state.repeatMode !== 'off');
  el.repeatBtn.title = { off: 'Enable repeat', one: 'Repeat one', all: 'Repeat all' }[state.repeatMode];
  if (state.repeatMode === 'one') {
    el.repeatBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="9.5" y="15" font-size="8" fill="currentColor">1</text></svg>`;
  } else {
    el.repeatBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>`;
  }
}

function setLoadingState(on) {
  state.isLoading = on;
  el.npSpinner.style.display = on ? 'block' : 'none';
  el.playBtn.disabled        = on;
  el.searchBtn.disabled      = on;
  el.searchBtn.textContent   = on ? 'Loading…' : 'Play Radio';
}

// ── Progress bar ──────────────────────────────────────────────────────────────
audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  el.progressFill.style.width  = pct + '%';
  el.progressThumb.style.left  = `calc(${pct}% - 6px)`;
  el.timeCur.textContent   = fmtDuration(audio.currentTime);
  el.timeTotal.textContent = fmtDuration(audio.duration);
});

audio.addEventListener('play',  () => { state.isPlaying = true;  updatePlayPauseBtn(); markActiveTrack(); });
audio.addEventListener('pause', () => { state.isPlaying = false; updatePlayPauseBtn(); markActiveTrack(); });
audio.addEventListener('ended', () => {
  if (state.repeatMode === 'one') {
    audio.currentTime = 0; audio.play();
  } else {
    playNext();
  }
});
audio.addEventListener('error', e => {
  console.error('[Audio error]', audio.error);
  showToast('Audio error — skipping…', true);
  setTimeout(playNext, 1500);
});

el.progressTrack.addEventListener('click', e => {
  if (!audio.duration) return;
  const rect = el.progressTrack.getBoundingClientRect();
  const pct  = (e.clientX - rect.left) / rect.width;
  audio.currentTime = Math.max(0, Math.min(1, pct)) * audio.duration;
});

// Volume
el.volumeTrack.addEventListener('click', e => {
  const rect = el.volumeTrack.getBoundingClientRect();
  const v    = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  setVolume(v);
});

function setVolume(v) {
  state.volume       = v;
  state.isMuted      = v === 0;
  audio.volume       = v;
  audio.muted        = state.isMuted;
  el.volumeFill.style.width = (v * 100) + '%';
  el.volBtn.innerHTML = v === 0
    ? `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M3.63 3.63a.996.996 0 0 0 0 1.41L7.29 8.7 7 9H4c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1h3l3.29 3.29c.63.63 1.71.18 1.71-.71v-4.17l4.18 4.18c-.49.37-1.02.68-1.6.91-.36.15-.58.53-.58.92 0 .72.73 1.18 1.39.91.8-.33 1.55-.77 2.22-1.31l1.34 1.34a.996.996 0 1 0 1.41-1.41L5.05 3.63c-.39-.39-1.02-.39-1.42 0zM19 12c0 .82-.15 1.61-.41 2.34l1.53 1.53c.56-1.17.88-2.48.88-3.87 0-3.83-2.4-7.11-5.78-8.4-.59-.23-1.22.23-1.22.86v.19c0 .38.25.71.61.85C17.18 6.54 19 9.06 19 12zm-8.71-6.29-.17.17L12 7.76V6.41c0-.89-1.08-1.33-1.71-.7zM16.5 12A4.5 4.5 0 0 0 14 7.97v1.79l2.48 2.48c.01-.08.02-.16.02-.24z"/></svg>`
    : v < 0.5
    ? `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M18.5 12A4.5 4.5 0 0 0 16 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5zm7-.17v6.34L9.83 13H7v-2h2.83L12 8.83z"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
}

el.volBtn.addEventListener('click', () => {
  if (state.isMuted) {
    setVolume(state.volume || 0.7);
  } else {
    const prev   = state.volume;
    state.volume = prev;
    setVolume(0);
    state.volume = prev; // preserve for unmute
  }
});

// ── Play / Pause ──────────────────────────────────────────────────────────────
el.playBtn.addEventListener('click', () => {
  if (!state.currentTrack) return;
  if (audio.paused) audio.play().catch(console.warn);
  else              audio.pause();
});

// ── Prev / Next ───────────────────────────────────────────────────────────────
el.prevBtn.addEventListener('click', () => {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  playPrev();
});
el.nextBtn.addEventListener('click', playNext);

function playNext() {
  if (!state.queue.length) return;
  let idx = state.queueIndex;
  if (state.isShuffle) {
    idx = Math.floor(Math.random() * state.queue.length);
  } else {
    idx++;
    if (idx >= state.queue.length) {
      if (state.repeatMode === 'all') idx = 0;
      else return;
    }
  }
  playQueueItem(idx);
}

function playPrev() {
  if (!state.queue.length) return;
  let idx = state.queueIndex - 1;
  if (idx < 0) idx = state.repeatMode === 'all' ? state.queue.length - 1 : 0;
  playQueueItem(idx);
}

// ── Shuffle / Repeat ──────────────────────────────────────────────────────────
el.shuffleBtn.addEventListener('click', () => {
  state.isShuffle = !state.isShuffle;
  updateShuffleBtn();
});

el.repeatBtn.addEventListener('click', () => {
  const modes = ['off', 'all', 'one'];
  state.repeatMode = modes[(modes.indexOf(state.repeatMode) + 1) % modes.length];
  updateRepeatBtn();
});

// ── Heart / Like ──────────────────────────────────────────────────────────────
el.playerHeart.addEventListener('click', () => {
  if (!state.currentTrack) return;
  const id = state.currentTrack.tidalId;
  if (state.liked.has(id)) state.liked.delete(id);
  else                      state.liked.add(id);
  el.playerHeart.className = 'player-heart' + (state.liked.has(id) ? ' liked' : '');
});

// ── Parse Spotify URL → track ID ─────────────────────────────────────────────
function parseSpotifyId(input) {
  input = input.trim();
  // Full URL: https://open.spotify.com/track/ID or /intl-it/track/ID etc.
  let m = input.match(/\/track\/([A-Za-z0-9]{22})/);
  if (m) return m[1];
  // URI: spotify:track:TRACK_ID
  m = input.match(/spotify:track:([A-Za-z0-9]+)/);
  if (m) return m[1];
  // Raw ID (22 chars alphanumeric)
  if (/^[A-Za-z0-9]{22}$/.test(input)) return input;
  return null;
}

// ── Resolve artist+title → Tidal track object (via /api/tidal-search) ────────
async function resolveToTidal(artist, title) {
  const params = new URLSearchParams({ artist, title });
  const r = await fetch(`/api/tidal-search?${params}`);
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `Not found on Tidal: ${artist} — ${title}`);
  }
  return r.json(); // { tidalId, title, artist, album, albumArt, duration }
}

// ── Build Pandora radio queue from a Spotify track ────────────────────────────
async function buildPandoraRadio(spotifyId) {
  // 1. Fetch Spotify metadata (title + artist needed for Pandora search)
  showToast('Getting track info…');
  let artist, title, meta = null;
  const metaResp = await fetch(`/api/spotify/track/${spotifyId}`);
  if (metaResp.ok) {
    meta = await metaResp.json();
    if (meta.error) meta = null;
  }

  if (meta) {
    artist = meta.artists?.map(a => a.name).join(', ') || '—';
    title  = meta.name || '—';
  } else {
    // Spotify failed — resolve via song.link first to at least get Tidal ID,
    // then pull title/artist from Tidal metadata
    showToast('Spotify unavailable, using song.link…');
    const resolveResp = await fetch(`/api/resolve/${spotifyId}`);
    if (!resolveResp.ok) throw new Error('Track not found — check the Spotify link');
    const { tidalId } = await resolveResp.json();
    const infoResp = await fetch(`/api/tidal-info/${tidalId}`);
    const info = infoResp.ok ? await infoResp.json() : {};
    const d = info.data || info;
    const artists = d.artists || (d.artist ? [d.artist] : []);
    artist = Array.isArray(artists) ? artists.map(a => a.name || a).join(', ') : (d.artist?.name || '—');
    title  = d.title || '—';
    const cover = d.album?.cover || d.cover;
    return {
      seedTrack: {
        tidalId,
        title,
        artist,
        albumArt: cover ? tidalCoverUrl(cover, 640) : null,
        album:    d.album?.title || '',
        duration: d.duration || null,
      },
      recTracks:   [],
      stationName: `${title} Radio`,
      _skipPandora: { artist, title },
    };
  }

  // 2. Resolve seed track to Tidal
  showToast('Finding on Tidal…');
  let seedTrack;
  try {
    seedTrack = await resolveToTidal(artist, title);
  } catch (_) {
    // Fallback: song.link directly
    const resolveResp = await fetch(`/api/resolve/${spotifyId}`);
    if (!resolveResp.ok) throw new Error('Track not found on Tidal');
    const { tidalId } = await resolveResp.json();
    seedTrack = {
      tidalId,
      title,
      artist,
      albumArt: meta.album?.images?.[0]?.url || null,
      album:    meta.album?.name || '',
      duration: meta.duration_ms ? Math.round(meta.duration_ms / 1000) : null,
    };
  }

  // 3. Ask Pandora for similar tracks
  showToast('Building Pandora radio…');
  const pandoraParams = new URLSearchParams({ artist, title });
  const pandoraResp   = await fetch(`/api/pandora-radio?${pandoraParams}`);
  if (!pandoraResp.ok) {
    const e = await pandoraResp.json().catch(() => ({}));
    throw new Error(e.error || 'Pandora radio failed');
  }
  const pandoraData = await pandoraResp.json();
  const stationName = pandoraData.stationName || `${title} Radio`;

  // 4. Resolve each Pandora track to Tidal (parallel, best-effort)
  showToast(`Resolving ${pandoraData.tracks.length} tracks on Tidal…`);
  const resolved = await Promise.allSettled(
    pandoraData.tracks.map(t => resolveToTidal(t.artist, t.title))
  );

  const recTracks = resolved
    .map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      // Fallback: keep Pandora metadata, tidalId will be resolved on play
      const t = pandoraData.tracks[i];
      return { tidalId: null, title: t.title, artist: t.artist, albumArt: t.albumArt, album: t.album, duration: t.duration, _needsResolve: true };
    })
    .filter(t => t.tidalId !== null || t._needsResolve);

  return { seedTrack, recTracks, stationName };
}

// ── Load Spotify URL (main entry point) ───────────────────────────────────────
async function loadSpotifyUrl() {
  const raw = el.searchInput.value.trim();
  if (!raw) return;

  const spotifyId = parseSpotifyId(raw);
  if (!spotifyId) {
    showToast('Invalid Spotify link — paste a track URL', true);
    return;
  }

  setLoadingState(true);
  try {
    let { seedTrack, recTracks, stationName, _skipPandora } = await buildPandoraRadio(spotifyId);

    // If Spotify was unavailable we still have artist+title — build Pandora station now
    if (_skipPandora && recTracks.length === 0) {
      showToast('Building Pandora radio…');
      const pandoraParams = new URLSearchParams(_skipPandora);
      const pandoraResp   = await fetch(`/api/pandora-radio?${pandoraParams}`);
      if (pandoraResp.ok) {
        const pandoraData = await pandoraResp.json();
        stationName = pandoraData.stationName || stationName;
        showToast(`Resolving ${pandoraData.tracks.length} tracks on Tidal…`);
        const resolved = await Promise.allSettled(
          pandoraData.tracks.map(t => resolveToTidal(t.artist, t.title))
        );
        recTracks = resolved
          .map((r, i) => r.status === 'fulfilled' ? r.value : { tidalId: null, ...pandoraData.tracks[i], _needsResolve: true })
          .filter(t => t.tidalId !== null || t._needsResolve);
      }
    }

    state.queue      = [seedTrack, ...recTracks];
    state.queueIndex = -1;
    renderQueue(stationName);
    setLoadingState(false);
    showToast('Pandora radio ready ✦');
    playQueueItem(0);
  } catch (e) {
    setLoadingState(false);
    showToast(e.message || 'Something went wrong', true, 5000);
    console.error(e);
  }
}

// (Pandora flow — normaliseRecommendations no longer needed)

// ── Play a queue item by index ────────────────────────────────────────────────
async function playQueueItem(index) {
  if (index < 0 || index >= state.queue.length) return;
  const track = state.queue[index];
  state.queueIndex = index;

  // Track came from Pandora but wasn't resolved to Tidal yet — do it now
  if (track._needsResolve) {
    try {
      showToast(`Finding "${track.title}" on Tidal…`);
      const resolved = await resolveToTidal(track.artist, track.title);
      Object.assign(track, resolved);
      delete track._needsResolve;
    } catch (e) {
      showToast(`Skipping "${track.title}" — not on Tidal`, true);
      return playNext();
    }
  }

  // If track is missing key metadata, fetch from Tidal
  if (!track.albumArt || !track.title || track.title === '—' || !track.artist || track.artist === '—') {
    try {
      const r    = await fetch(`/api/tidal-info/${track.tidalId}`);
      const info = await r.json();
      const d    = info.data || info;
      if (!track.albumArt) track.albumArt = tidalCoverUrl(d.album?.cover || d.cover);
      if (!track.title || track.title === '—') track.title = d.title || track.title;
      if (!track.artist || track.artist === '—') {
        const a = d.artists || (d.artist ? [d.artist] : []);
        track.artist = Array.isArray(a)
          ? a.map(x => x.name || x).join(', ')
          : (d.artist?.name || '—');
      }
      track.album    = d.album?.title || '';
      track.duration = d.duration || track.duration;
    } catch (_) {}
  }

  state.currentTrack = track;
  updatePlayerUI();
  markActiveTrack();

  // Stop any existing playback
  audio.pause();
  audio.src = '';
  if (dashPlayer) { try { dashPlayer.reset(); } catch(_){} dashPlayer = null; }

  setLoadingState(true);

  try {
    // Get stream info
    const r    = await fetch(`/api/stream-info/${track.tidalId}`);
    if (!r.ok) throw new Error(`Stream error: ${r.status}`);
    const info = await r.json();
    if (info.error) throw new Error(info.error);

    track.quality = info.quality;
    if (info.bitDepth)   track.bitDepth   = info.bitDepth;
    if (info.sampleRate) track.sampleRate = info.sampleRate;
    updatePlayerUI();

    if (info.type === 'direct') {
      // Use our audio proxy endpoint for CORS-safe streaming
      audio.src = `/api/audio/${track.tidalId}`;
      audio.load();
      await audio.play();
    } else if (info.type === 'dash') {
      // DASH stream via dash.js
      await loadDashJs();
      const blob    = new Blob([info.xml], { type: 'application/dash+xml' });
      const blobUrl = URL.createObjectURL(blob);
      dashPlayer    = window.dashjs.MediaPlayer().create();
      dashPlayer.initialize(audio, blobUrl, true);
      state.isPlaying = true;
    } else {
      throw new Error('Unknown stream type');
    }

    setLoadingState(false);
  } catch (e) {
    setLoadingState(false);
    showToast('Failed to load: ' + e.message, true);
    console.error('[playQueueItem]', e);
  }
}

// ── Load dash.js lazily ────────────────────────────────────────────────────────
let dashJsLoaded = false;
async function loadDashJs() {
  if (dashJsLoaded) return;
  return new Promise((resolve, reject) => {
    const s   = document.createElement('script');
    s.src     = 'https://cdn.dashjs.org/v4.7.4/dash.all.min.js';
    s.onload  = () => { dashJsLoaded = true; resolve(); };
    s.onerror = () => reject(new Error('Failed to load dash.js'));
    document.head.appendChild(s);
  });
}

// ── Start radio from a queue track (Pandora station from its artist+title) ─────
async function startRadioFromTidal(tidalId, triggerTrack) {
  if (!triggerTrack.artist || !triggerTrack.title || triggerTrack.title === '—') {
    showToast('Not enough metadata to build a Pandora station', true);
    return;
  }
  setLoadingState(true);
  showToast('Building Pandora radio…');

  try {
    const params      = new URLSearchParams({ artist: triggerTrack.artist, title: triggerTrack.title });
    const pandoraResp = await fetch(`/api/pandora-radio?${params}`);
    if (!pandoraResp.ok) {
      const e = await pandoraResp.json().catch(() => ({}));
      throw new Error(e.error || 'Pandora radio failed');
    }
    const pandoraData = await pandoraResp.json();
    const stationName = pandoraData.stationName || `${triggerTrack.title} Radio`;

    showToast(`Resolving ${pandoraData.tracks.length} tracks on Tidal…`);
    const resolved = await Promise.allSettled(
      pandoraData.tracks.map(t => resolveToTidal(t.artist, t.title))
    );

    const recTracks = resolved
      .map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        const t = pandoraData.tracks[i];
        return { tidalId: null, title: t.title, artist: t.artist, albumArt: t.albumArt, album: t.album, duration: t.duration, _needsResolve: true };
      })
      .filter(t => t.tidalId !== null || t._needsResolve);

    state.queue      = [triggerTrack, ...recTracks];
    state.queueIndex = -1;
    renderQueue(stationName);
    setLoadingState(false);
    showToast('New radio ready ✦');
    playQueueItem(0);
  } catch (e) {
    setLoadingState(false);
    showToast(e.message, true, 4000);
    console.error(e);
  }
}

// ── Render queue list ─────────────────────────────────────────────────────────
function renderQueue(radioTitle) {
  el.queueTitle.textContent    = radioTitle || 'Radio Queue';
  el.queueSubtitle.textContent = `${state.queue.length} tracks`;
  el.queueList.innerHTML       = '';

  if (!state.queue.length) {
    el.queueList.innerHTML = `
      <div class="queue-empty">
        <div class="icon">📻</div>
        <p>Paste a Spotify link above to start a radio</p>
      </div>`;
    return;
  }

  state.queue.forEach((track, idx) => {
    const item = document.createElement('div');
    item.className = 'track-item';
    item.dataset.idx = idx;
    if (idx === state.queueIndex) item.classList.add('active');

    const cover = track.albumArt
      ? `<img class="track-art" src="${track.albumArt}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : '';
    const placeholder = `<div class="track-art-placeholder" ${track.albumArt ? 'style="display:none"' : ''}>♪</div>`;
    const dur = fmtDuration(track.duration);

    item.innerHTML = `
      <span class="track-num">${idx + 1}</span>
      <span class="track-playing-icon">
        <span class="eq-bars">
          <span class="eq-bar"></span><span class="eq-bar"></span>
          <span class="eq-bar"></span><span class="eq-bar"></span>
        </span>
      </span>
      ${cover}${placeholder}
      <div class="track-info">
        <div class="track-title">${escHtml(track.title)}</div>
        <div class="track-artist">${escHtml(track.artist)}</div>
      </div>
      <span class="track-duration">${dur}</span>
      <div class="track-actions">
        <button class="track-action-btn radio-btn" title="Start radio from this track">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3.24 6.15C2.51 6.43 2 7.17 2 8v12c0 1.1.89 1.99 2 1.99L16 22c1.1 0 2-.89 2-2v-1H6c-.55 0-1-.45-1-1V6c0-.38.1-.73.27-1.03-.01.06-.03.12-.03.18zm14.77 5.91c.01-.02.03-.04.04-.07.36-.75.57-1.59.57-2.49 0-3.31-2.69-6-6-6s-6 2.69-6 6 2.69 6 6 6c.9 0 1.74-.21 2.49-.57.03-.01.05-.03.07-.04L18.58 19l1.41-1.41-1.98-1.53zM12.62 15c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4z"/></svg>
        </button>
        <button class="track-action-btn play-track-btn" title="Play this track">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><polygon points="5,3 19,12 5,21"/></svg>
        </button>
      </div>`;

    // Click row → play
    item.addEventListener('click', e => {
      if (e.target.closest('.track-action-btn')) return;
      playQueueItem(idx);
    });

    // Play button
    item.querySelector('.play-track-btn').addEventListener('click', e => {
      e.stopPropagation();
      playQueueItem(idx);
    });

    // Radio button
    item.querySelector('.radio-btn').addEventListener('click', e => {
      e.stopPropagation();
      startRadioFromTidal(track.tidalId, track);
    });

    el.queueList.appendChild(item);
  });
}

// ── Mark active track in queue ────────────────────────────────────────────────
function markActiveTrack() {
  el.queueList.querySelectorAll('.track-item').forEach((item, idx) => {
    if (idx === state.queueIndex) {
      item.classList.add('active');
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      item.classList.remove('active');
    }
  });
}

// ── HTML escape ───────────────────────────────────────────────────────────────
function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Search submit ─────────────────────────────────────────────────────────────
el.searchBtn.addEventListener('click', loadSpotifyUrl);
el.searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') loadSpotifyUrl();
});

// ── Init UI defaults ──────────────────────────────────────────────────────────
(function init() {
  setVolume(0.8);
  updatePlayPauseBtn();
  updateShuffleBtn();
  updateRepeatBtn();

  // Empty queue message
  el.queueList.innerHTML = `
    <div class="queue-empty">
      <div class="icon">📻</div>
      <p>Paste a Spotify link above to start a radio</p>
    </div>`;
})();
