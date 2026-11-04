/* ============================================================
   SelamatKu — Deteksi & Evakuasi Bencana (Mobile PWA)
   Dependencies: Leaflet (CDN)
   APIs used:    BMKG, USGS, Overpass API, OSRM
   Features:     Offline, Notifications, Family Sharing,
                 History/Favorites, Wake Lock, Haptics
   ============================================================ */

// ── STATE ──────────────────────────────────────────────────────
const state = {
  userPos: null,
  map: null,
  userMarker: null,
  shelterMarkers: [],
  familyMarkers: [],
  routeLayer: null,
  zoneCircle: null,
  activeShelters: [],
  activeRoute: null,
  navIndex: 0,
  soundOn: true,
  notificationsOn: false,
  lastQuakeIds: new Set(),
  scannerActive: false,
};

// ── CONSTANTS ──────────────────────────────────────────────────
const BMKG_FEED_URL = 'https://data.bmkg.go.id/DATA/GEMPA/TELESEISMIC/REALTIME/feed.xml';
const USGS_FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const OVERPASS_API  = 'https://overpass-api.de/api/interpreter';
const OSRM_API      = 'https://router.project-osrm.org/route/v1/foot/';
const SHELTER_RADIUS = 3000;

const SHELTER_ICONS = {
  hospital: '🏥', school: '🏫', police: '🚓',
  fire: '🚒', mosque: '🕌', church: '⛪', park: '🌳'
};
const SHELTER_LABELS = {
  hospital: 'Rumah Sakit', school: 'Sekolah / Gedung', police: 'Pos Polisi',
  fire: 'Damkar', mosque: 'Masjid', church: 'Gereja', park: 'Ruang Terbuka'
};

// ── LOCALSTORAGE HELPERS ───────────────────────────────────────
const LS_KEYS = {
  FAMILY:    'selamatku_family',
  FAVORITES: 'selamatku_favorites',
  HISTORY:   'selamatku_history',
  SETTINGS:  'selamatku_settings',
  POS:       'selamatku_pos',
};

function loadLS(key, fallback = []) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch(e) { return fallback; }
}
function saveLS(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch(e) {}
}

// ── AUDIO & HAPTICS ────────────────────────────────────────────
let audioCtx = null;
let alarmInterval = null; // for repeating alarm

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function beep(freq = 880, dur = 0.15, volume = 0.3) {
  if (!state.soundOn) return;
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square'; // more attention-grabbing
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(); osc.stop(ctx.currentTime + dur);
  } catch(e) { console.warn('beep error:', e); }
}

/** Start repeating emergency alarm — plays until stopAlarm() is called */
function startAlarm() {
  stopAlarm(); // clear any existing
  showStopAlarmButton();

  const playCycle = () => {
    if (!state.soundOn || !alarmInterval) return;
    // Siren pattern: high-low-high
    beep(880, 0.25, 0.5);
    setTimeout(() => beep(660, 0.25, 0.5), 300);
    setTimeout(() => beep(880, 0.25, 0.5), 600);
  };
  playCycle(); // immediate first burst
  alarmInterval = setInterval(playCycle, 2000); // repeat every 2 seconds
}

/** Stop the repeating alarm */
function stopAlarm() {
  if (alarmInterval) {
    clearInterval(alarmInterval);
    alarmInterval = null;
  }
  hideStopAlarmButton();
}

/** Floating STOP button visible whenever alarm is active */
function showStopAlarmButton() {
  let btn = document.getElementById('floating-stop-alarm');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'floating-stop-alarm';
    btn.innerHTML = '🔇 MATIKAN ALARM';
    btn.style.cssText = `
      position:fixed; bottom:calc(var(--nav-h,60px) + env(safe-area-inset-bottom) + 16px);
      left:50%; transform:translateX(-50%); z-index:99999;
      padding:14px 28px; border-radius:30px; border:none;
      background:#dc2626; color:#fff; font-size:.9rem; font-weight:700;
      box-shadow:0 4px 20px rgba(220,38,38,.5); cursor:pointer;
      animation:pulse-btn 1s infinite;
    `;
    if (!document.getElementById('pulse-btn-css')) {
      const s = document.createElement('style');
      s.id = 'pulse-btn-css';
      s.textContent = '@keyframes pulse-btn{0%,100%{transform:translateX(-50%) scale(1)}50%{transform:translateX(-50%) scale(1.05)}}';
      document.head.appendChild(s);
    }
    btn.addEventListener('click', () => {
      stopAlarm();
      hapticTap();
    });
    document.body.appendChild(btn);
  }
  btn.style.display = '';
}

function hideStopAlarmButton() {
  const btn = document.getElementById('floating-stop-alarm');
  if (btn) btn.style.display = 'none';
}

// Legacy alias
function alarm() { startAlarm(); }

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}
function hapticTap()      { vibrate(20); }
function hapticTurn()     { vibrate([50, 30, 50]); }
function hapticDanger()   { vibrate([200, 100, 200, 100, 200]); }

// ── WAKE LOCK ──────────────────────────────────────────────────
let wakeLockSentinel = null;
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        console.log('Wake lock released');
      });
    }
  } catch(e) { console.warn('Wake Lock not available:', e); }
}
async function releaseWakeLock() {
  try {
    if (wakeLockSentinel) {
      await wakeLockSentinel.release();
      wakeLockSentinel = null;
    }
  } catch(e) {}
}

// ── NOTIFICATIONS ──────────────────────────────────────────────
// Detect if running inside Android WebView (APK)
const IS_WEBVIEW = /Android.*Version\/[\d.]+.*Mobile Safari/.test(navigator.userAgent)
  && !/Chrome\/[\d.]+ Mobile/.test(navigator.userAgent);

async function initNotifications() {
  const btn = document.getElementById('btn-notification');

  // In WebView (APK), hide notification button — use in-app alerts instead
  if (IS_WEBVIEW || !('Notification' in window)) {
    if (btn) btn.style.display = 'none';
    state.notificationsOn = false;
    return;
  }

  // Restore previous preference
  const settings = loadLS(LS_KEYS.SETTINGS, {});
  state.notificationsOn = settings.notificationsOn || false;
  updateNotifButton();

  if (state.notificationsOn && Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      state.notificationsOn = false;
      saveLS(LS_KEYS.SETTINGS, { notificationsOn: false });
      updateNotifButton();
    }
  }
}

function toggleNotifications() {
  if (IS_WEBVIEW || !('Notification' in window)) {
    showInAppAlert('ℹ️ Info', 'Notifikasi system tidak tersedia di mode aplikasi.\nPeringatan gempa tetap tampil di dalam aplikasi dengan suara & getaran.');
    return;
  }

  if (!state.notificationsOn) {
    Notification.requestPermission().then(perm => {
      if (perm === 'granted') {
        state.notificationsOn = true;
        saveLS(LS_KEYS.SETTINGS, { notificationsOn: true });
        updateNotifButton();
        showTestNotification();
      } else {
        showInAppAlert('⚠️ Izin Ditolak', 'Izin notifikasi ditolak oleh browser.\nAnda tetap mendapat peringatan di dalam aplikasi.');
      }
    });
  } else {
    state.notificationsOn = false;
    saveLS(LS_KEYS.SETTINGS, { notificationsOn: false });
    updateNotifButton();
  }
}

function updateNotifButton() {
  const btn = document.getElementById('btn-notification');
  if (!btn) return;
  btn.textContent = state.notificationsOn ? '🔔' : '🔕';
  btn.classList.toggle('active', state.notificationsOn);
}

function showTestNotification() {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('🛡️ SelamatKu', {
      body: 'Notifikasi aktif! Anda akan mendapat peringatan gempa besar.',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
    });
  }
}

/** Show an in-app alert modal (works everywhere including WebView) */
function showInAppAlert(title, message) {
  let overlay = document.getElementById('inapp-alert');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'inapp-alert';
    overlay.className = 'modal-backdrop';
    overlay.innerHTML = `<div class="modal" style="max-height:60vh">
      <div class="modal-header"><h2 id="inapp-title"></h2>
      <button class="icon-btn" onclick="document.getElementById('inapp-alert').classList.add('hidden')">✕</button></div>
      <div class="modal-body"><p id="inapp-msg" style="font-size:14px;line-height:1.7;color:var(--clr-text-2)"></p></div>
      <div class="modal-footer"><button class="btn-primary btn-full" onclick="document.getElementById('inapp-alert').classList.add('hidden')">OK</button></div>
    </div>`;
    document.body.appendChild(overlay);
  }
  document.getElementById('inapp-title').textContent = title;
  document.getElementById('inapp-msg').textContent = message;
  overlay.classList.remove('hidden');
}

/** Emergency alert — persists until user explicitly dismisses.
 *  Stops repeating alarm when closed. Used for M5+ earthquakes. */
function showEmergencyAlert(title, message, isMajor) {
  let overlay = document.getElementById('emergency-alert');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'emergency-alert';
    const bgColor = isMajor ? '#dc2626' : '#d97706';
    overlay.innerHTML = `<div class="modal-backdrop" style="background:rgba(0,0,0,.85);z-index:10001">
      <div class="modal" style="max-height:70vh;border-top:4px solid ${bgColor};animation:pulse-border 1s infinite">
        <div class="modal-header">
          <h2 id="emerg-title" style="color:${bgColor}"></h2>
        </div>
        <div class="modal-body">
          <p id="emerg-msg" style="font-size:14px;line-height:1.7;color:var(--clr-text-2);white-space:pre-line"></p>
          ${isMajor ? '<p style="margin-top:12px;font-size:12px;color:#dc2626;font-weight:600">🔊 Alarm aktif — tekan TUTUP untuk mematikan</p>' : ''}
        </div>
        <div class="modal-footer">
          <button class="btn-primary btn-full" id="btn-dismiss-emerg" style="${isMajor ? 'background:#dc2626' : ''}">
            ${isMajor ? ' TUTUP & MATIKAN ALARM' : 'OK'}
          </button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    // Inject pulse animation
    if (!document.getElementById('pulse-border-css')) {
      const s = document.createElement('style');
      s.id = 'pulse-border-css';
      s.textContent = '@keyframes pulse-border{0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,.4)}50%{box-shadow:0 0 0 8px rgba(220,38,38,0)}}';
      document.head.appendChild(s);
    }
  }

  document.getElementById('emerg-title').textContent = title;
  document.getElementById('emerg-msg').textContent = message;
  overlay.classList.remove('hidden');
  overlay.style.display = '';

  // Dismiss button stops alarm
  const dismissBtn = document.getElementById('btn-dismiss-emerg');
  if (dismissBtn) {
    // Remove old listeners
    const newBtn = dismissBtn.cloneNode(true);
    dismissBtn.parentNode.replaceChild(newBtn, dismissBtn);
    newBtn.addEventListener('click', () => {
      stopAlarm();
      overlay.style.display = 'none';
      hapticTap();
    });
  }
}

/** Unified earthquake alert: uses system notification if available,
 *  otherwise falls back to in-app visual + sound + vibration */
function notifyEarthquake(quake) {
  const isMajor = quake.mag >= 6;
  const isModerate = quake.mag >= 5;
  if (!isMajor && !isModerate) return;

  // Dedup
  const quakeId = `${quake.lat.toFixed(3)},${quake.lng.toFixed(3)},${quake.time}`;
  if (state.lastQuakeIds.has(quakeId)) return;
  state.lastQuakeIds.add(quakeId);
  if (state.lastQuakeIds.size > 50) {
    state.lastQuakeIds = new Set([...state.lastQuakeIds].slice(-50));
  }

  const distText = state.userPos
    ? ` · Jarak: ${formatDist(haversineKm(state.userPos.lat, state.userPos.lng, quake.lat, quake.lng))}`
    : '';
  const title = `🌍 Gempa M${quake.mag}${isMajor ? ' ⚠️ BESAR' : ''}`;
  const body = `${quake.place || 'Lokasi tidak diketahui'}${distText}\n${timeAgo(quake.time)}`;

  // Try system notification first (browser only)
  if (!IS_WEBVIEW && 'Notification' in window &&
      Notification.permission === 'granted' && state.notificationsOn) {
    try {
      new Notification(title, {
        body,
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        tag: `quake-${quakeId}`,
        requireInteraction: isMajor,
      });
    } catch(e) {}
  }

  // Sound: major = repeating alarm until dismissed, moderate = single beep
  if (isMajor) {
    hapticDanger();
    startAlarm(); // repeats every 2s until user dismisses
  } else {
    hapticTurn();
    beep(880, .3, 0.4);
  }

  // ALWAYS show in-app alert for significant quakes (with alarm-stop on dismiss)
  showEmergencyAlert(title, body, isMajor);

  // Update status banner
  setStatus(isMajor ? 'danger' : 'warning',
    `Gempa M${quake.mag} terdeteksi`,
    quake.place || '');

  // Auto-trigger safety scan CTA after 2s
  selectedDisasterType = 'gempa';
  setTimeout(() => triggerAutoScan('gempa'), 2000);
}

// ── GEO MATH ───────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatDist(km) {
  return km < 1 ? `${Math.round(km*1000)} m` : `${km.toFixed(1)} km`;
}
function formatDuration(sec) {
  const min = Math.round(sec / 60);
  return min < 1 ? '< 1 menit' : `± ${min} menit`;
}
function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1)   return 'Baru saja';
  if (min < 60)  return `${min} menit lalu`;
  const hr = Math.floor(min / 60);
  if (hr < 24)   return `${hr} jam lalu`;
  return `${Math.floor(hr/24)} hari lalu`;
}
function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) +
         ' ' + d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

// ── MAP INIT ───────────────────────────────────────────────────
function initMap() {
  state.map = L.map('map').setView([-6.2, 106.8], 13);

  // Primary: CARTO dark tiles (no API key, no regional blocking)
  const cartoLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
    subdomains: 'abcd'
  }).addTo(state.map);

  // Fallback: if CARTO fails, try standard OSM tiles
  cartoLayer.on('tileerror', function() {
    if (!state._osmFallbackTried) {
      state._osmFallbackTried = true;
      state.map.removeLayer(cartoLayer);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
      }).addTo(state.map);
    }
  });

  // Always start real-time GPS watch
  // If saved position exists, show it immediately while GPS loads
  const savedPos = loadLS(LS_KEYS.POS, null);
  if (savedPos && savedPos.lat != null) {
    state.userPos = savedPos;
    updateUserMarker();
    state.map.setView([savedPos.lat, savedPos.lng], 15);
    setStatus('info', 'Memuat posisi terakhir…',
      `Mencari GPS real-time — posisi sementara: ${savedPos.lat.toFixed(4)}, ${savedPos.lng.toFixed(4)}`);
    fetchEarthquakes();
    fetchNearbyShelters();
    checkTsunamiRisk();
  }

  // Start continuous GPS tracking regardless
  if (navigator.geolocation) {
    geoFirstFix = !state.userPos; // if we have saved pos, don't re-center on first fix
    startGeoWatch();
  } else {
    showManualPosModal('Browser tidak mendukung geolocation.');
  }
}

// ── AI SAFETY SCANNER ────────────────────────────────────────
let scannerStream = null;
let selectedDisasterType = 'gempa';

async function openSafetyScanner(disasterType) {
  const overlay = document.getElementById('scanner-overlay');
  if (!overlay) return;

  // Pre-select disaster type if provided
  if (disasterType) selectedDisasterType = disasterType;
  updateChipSelection();

  overlay.classList.remove('hidden');
  overlay.style.display = '';
  document.getElementById('scanner-loading').classList.add('hidden');
  document.getElementById('scanner-results').classList.add('hidden');
  document.getElementById('scanner-status').textContent = 'Memuat kamera…';
  document.getElementById('scanner-hint').textContent = 'Mengaktifkan kamera…';
  const btnCap = document.getElementById('btn-capture');
  if (btnCap) btnCap.disabled = true;

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Browser tidak mendukung kamera. Gunakan Chrome terbaru.');
    }

    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false
    });

    const video = document.getElementById('scanner-video');
    video.srcObject = scannerStream;

    // Wait for video to actually be ready
    await new Promise((resolve, reject) => {
      if (video.readyState >= 2) return resolve();
      const timeout = setTimeout(() => reject(new Error('Kamera lambat dimuat')), 8000);
      video.onloadeddata = () => { clearTimeout(timeout); resolve(); };
      video.onerror = (e) => { clearTimeout(timeout); reject(new Error('Video error')); };
    });

    await video.play();
    document.getElementById('scanner-status').textContent = '● Kamera aktif';
    document.getElementById('scanner-hint').textContent = 'Arahkan kamera ke sekitar Anda, lalu tekan tombol untuk capture';
    if (btnCap) btnCap.disabled = false;

  } catch (err) {
    console.error('[Scanner] Camera error:', err.message);
    document.getElementById('scanner-status').textContent = '✕ Gagal';
    document.getElementById('scanner-status').style.color = '#ef4444';
    document.getElementById('scanner-hint').innerHTML =
      `⚠️ ${esc(err.message)}<br><small>Penyelahan:<br>• Pastikan izin kamera sudah diberikan<br>• Tutup app lain yang memakai kamera<br>• Refresh halaman dan coba lagi</small>`;
  }
}

function closeSafetyScanner() {
  stopAlarm(); // make sure alarm stops
  stopCamera();
  const overlay = document.getElementById('scanner-overlay');
  if (overlay) { overlay.classList.add('hidden'); overlay.style.display = ''; }
  state.scannerActive = false;
}

function stopCamera() {
  if (scannerStream) {
    scannerStream.getTracks().forEach(t => t.stop());
    scannerStream = null;
  }
  const video = document.getElementById('scanner-video');
  if (video) video.srcObject = null;
}

function updateChipSelection() {
  document.querySelectorAll('#scanner-disaster-types .chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.type === selectedDisasterType);
  });
}

function captureFrame() {
  const video = document.getElementById('scanner-video');
  const canvas = document.getElementById('scanner-canvas');

  console.log('[Scanner] captureFrame: video exists:', !!video,
    'readyState:', video?.readyState,
    'videoWidth:', video?.videoWidth,
    'videoHeight:', video?.videoHeight);

  if (!video || video.readyState < 2 || !video.videoWidth) {
    console.warn('[Scanner] Video not ready for capture');
    return null;
  }

  // Cap at 640px for faster upload (still good enough for AI)
  const maxDim = 640;
  let w = video.videoWidth, h = video.videoHeight;
  if (w > maxDim || h > maxDim) {
    const ratio = Math.min(maxDim / w, maxDim / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
  console.log('[Scanner] Captured frame:', w + 'x' + h, 'size:', Math.round(dataUrl.length / 1024) + 'KB');
  return dataUrl;
}

/** Sleep helper */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Analyze scene — accepts single frame string or array of frames (video) */
// ── RULE-BASED FALLBACK (embedded — works offline / no API key) ──
function ruleBasedAnalysis(disasterType, isVideo, context) {
  const loc = context ? context.replace('Lokasi: ', '') : '';
  const rules = {
    gempa: {
      riskLevel: 'danger',
      summary: isVideo
        ? `Dari rekaman lingkungan Anda${loc ? ' ('+loc+')' : ''}: ambil posisi Drop-Cover-Hold SEKARANG.`
        : `Gempa aktif${loc ? ' di area '+loc : ''}. Ambil posisi melindungi diri segera.`,
      recommendations: [
        { action: 'DROP: Turunkan tubuh ke posisi merangkak/berlutut — JANGAN berdiri', location: 'Tanpa bergerak dari posisi Anda', priority: 1 },
        { action: 'COVER: Selipkan diri di bawah meja/kursi terkuat yang Anda lihat. Pegang kaki meja erat-erat', location: 'Meja/kursi terdekat (radius 1-2m)', priority: 1 },
        { action: 'JAUHI: Pindah minimal 2m menjauh dari jendela kaca, lemari >1.5m, lampu gantung', location: 'Ke area dinding dalam (tanpa jendela)', priority: 1 },
        { action: 'HOLD: Berpegangan pada struktur sampai goncangan berhenti total', location: 'Posisi berlindung Anda', priority: 2 },
        { action: 'SETELAH AMAN: Matikan gas/listrik jika bisa, keluar via tangga (JANGAN lift)', location: 'Titik kumpul: area terbuka terdekat', priority: 3 }
      ],
      dangerZones: ['Jendela & partisi kaca','Lemari/rak >1.5m','Lampu gantung & plafon','D bata ringan/plafon gypsum'],
      nearestSafety: 'Area terbuka minimal 50m dari bangunan tertinggi.',
      confidence: isVideo ? 0.75 : 0.6
    },
    tsunami: {
      riskLevel: 'danger',
      summary: `ALERT TSUNAMI${loc ? ' — posisi: '+loc : ''}. Bergerak SEKARANG.`,
      recommendations: [
        { action: 'NAIK: Menuju elevasi >15m dari permukaan laut ATAU jarak >30m dari pantai', location: 'Bukit/bangunan tinggi TERDEKAT', priority: 1 },
        { action: 'JARAK: Jauhi SEMUA area air — pantai, sungai, muara', location: 'Arah JAUH dari garis pantai', priority: 1 },
        { action: 'CEPAT: Jalan kaki > kendaraan. Ikuti tanda panah evakuasi tsunami', location: 'Jalur evakuasi vertikal terdekat', priority: 2 },
        { action: 'MINIMAL: Bawa hanya HP + dompet. Maks 60 detik persiapan', location: 'Ambil dari saku/meja dekat Anda', priority: 3 }
      ],
      dangerZones: ['Garis pantai & area <30m dari air','Sungai, muara, kanal','Area cekungan/rendah','Jembatan dekat air'],
      nearestSafety: 'Tempat tinggi: bukit, gedung >5 lantai, atau tangga evakuasi bertanda.',
      confidence: 0.8
    },
    banjir: {
      riskLevel: 'caution',
      summary: `Potensi banjir${loc ? ' di '+loc : ''}. Naik sekarang sebelum terlambat.`,
      recommendations: [
        { action: 'NAIK: Pindah ke lantai 2+ atau atap', location: 'Lantai atas / tangga ke rooftop', priority: 1 },
        { action: 'MATIKAN: Cabut semua stopkontak, matikan MCB utama. Listrik + air = bahaya', location: 'Panel listrik (dekat pintu masuk)', priority: 1 },
        { action: 'HINDARI: JANGAN lewat genangan >30cm. Arus 15cm sudah membalik motor', location: 'Semua jalan tergenang — cari rute kering', priority: 2 },
        { action: 'SIAPKAN: Tas berisi obat, air mineral, powerbank, dokumen foto', location: 'Samping pintu keluar lantai atas', priority: 3 }
      ],
      dangerZones: ['Genangan >15cm','Kolam listrik, trafo, kabel putus','Balkon lantai 1','Bawah jembatan'],
      nearestSafety: 'Bangunan bertingkat terdekat (minimal 2 lantai).',
      confidence: 0.7
    },
    angin: {
      riskLevel: 'caution',
      summary: `Angin kencang${loc ? ' di '+loc : ''}. Risiko: benda terbang, kaca pecah. Masuk ke interior sekarang.`,
      recommendations: [
        { action: 'MASUK: Ke ruangan paling dalam (tanpa jendela/pintu kaca)', location: 'Ruangan interior terdalam', priority: 1 },
        { action: 'TURUNKAN: Tutup semua jendela. Tarik tirai tebal sebagai lapisan tambahan', location: 'Semua jendela terbuka', priority: 1 },
        { action: 'RENDAH: Jika outdoor: berbaring prone di parit/turunan, lindungi kepala', location: 'Area rendah terlindung dari arah angin', priority: 2 },
        { action: 'JAUHI: Pohon besar, tiang listrik, reklame, bangunan seng', location: 'Minimal 10m dari objek tersebut', priority: 3 }
      ],
      dangerZones: ['Jendela & kaca','Papan reklame & spanduk','Pohon besar','Atap seng/prefab','Tiang listrik'],
      nearestSafety: 'Interior bangunan tanpa kaca, atau area di balik tembok beton.',
      confidence: 0.7
    },
    umum: {
      riskLevel: 'caution',
      summary: `Kondisi darurat terdeteksi${loc ? ' di '+loc : ''}. Tetap tenang, amati, bergerak ke tempat aman.`,
      recommendations: [
        { action: 'AMATI: 5 detik — lihat ke segala arah. Identifikasi bahaya & jalur keluar', location: 'Posisi Anda sekarang', priority: 1 },
        { action: 'GERAK: Arahkan ke pintu keluar/exit TERDEKAT. Jauhi sumber bahaya >5m', location: 'Jalur keluar terdekat (bukan lift)', priority: 1 },
        { action: 'LINDUNGI: Kepala selalu dilindungi (tangan, tas, benda keras)', location: 'Selama bergerak', priority: 2 },
        { action: 'KUMPUL: Setelah aman, hubungi keluarga. Laporkan kondisi', location: 'Titik kumpul / area terbuka', priority: 3 }
      ],
      dangerZones: ['Sumber bahaya utama','Jalur sempit/sumpek','Benda yang bisa jatuh'],
      nearestSafety: 'Area terbuka tanpa struktur overhead, minimal 20m dari sumber bahaya.',
      confidence: 0.5
    }
  };
  return { ...(rules[disasterType] || rules.umum) };
}

// ── MODELSCOPE QWEN VISION (direct from browser) ─────────────
async function modelScopeVision(frames, disasterType, context) {
  const apiKey = localStorage.getItem('ms_api_key');
  if (!apiKey) return null;

  const baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const model   = 'qwen-vl-plus'; // vision model
  const isVideo = frames.length > 1;
  const locInfo = context || 'Lokasi tidak diketahui';

  // Use only first frame for vision (saves tokens)
  const imageDataUrl = frames[0];

  const prompt = `Kamu analis keselamatan darurat Indonesia. Lihat gambar ini PERHATI.

JENIS BENCANA: ${disasterType.toUpperCase()}
LOKASI PENGGUNA: ${locInfo}
MODE: ${isVideo ? `Video ${frames.length} frame` : 'Foto sekali'}

LANGKAH:
1. DAFTARKAN semua objek besar yang terlihat (meja, kursi, jendela, pintu, lemari, tiang, dinding, pohon, jalan, dll) — sebutkan POSISI relatifnya
2. IDENTIFIKASI bahaya spesifik berdasarkan jenis bencana + objek
3. BERIKAN rekomendasi SPESIFIK merujuk objek yang kamu lihat (bukan generic)

Balas HANYA JSON valid:
{"objectsSeen":["objek1 di posisi X"],"riskLevel":"safe|caution|danger","summary":"1-2 kalimat kondisi + risiko","recommendations":[{"action":"Tindakan spesifik","location":"Posisi relatif","priority":1}],"dangerZones":["Bahaya + posisi"],"nearestSafety":"Tempat aman terdekat","confidence":0.85}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: prompt }
          ]
        }],
        max_tokens: 1024,
        temperature: 0.3
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn('[ModelScope Vision] API error:', res.status);
      return null;
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);

  } catch(e) {
    console.warn('[ModelScope Vision] failed:', e.message);
    return null;
  }
}

// ── ANALYZE SCENE (orchestrator) ─────────────────────────────
async function analyzeScene(frames) {
  // Normalize to array
  if (typeof frames === 'string') frames = [frames];

  const loadingEl = document.getElementById('scanner-loading');
  const resultsEl = document.getElementById('scanner-results');
  const hintEl    = document.getElementById('scanner-hint');

  // Visual flash
  const video = document.getElementById('scanner-video');
  if (video) {
    video.style.filter = 'brightness(2)';
    setTimeout(() => { if (video) video.style.filter = ''; }, 150);
  }

  loadingEl.classList.remove('hidden');
  resultsEl.classList.add('hidden');
  const isVideo = frames.length > 1;
  if (hintEl) hintEl.textContent = isVideo ? `📤 Menganalisis ${frames.length} frame…` : '📤 Menganalisis…';

  const context = state.userPos
    ? `Lokasi: ${state.userPos.lat.toFixed(4)}, ${state.userPos.lng.toFixed(4)}`
    : '';

  // Pick which frames to send (max 3 for bandwidth)
  const framesToSend = frames.length <= 3
    ? frames
    : [frames[0], frames[Math.floor(frames.length/2)], frames[frames.length-1]];

  let result = null;

  // Priority 1: ModelScope Qwen Vision (if API key set)
  if (localStorage.getItem('ms_api_key')) {
    if (hintEl) hintEl.textContent = '🤖 AI sedang menganalisis lingkungan…';
    result = await modelScopeVision(framesToSend, selectedDisasterType, context);
    if (result) result.source = 'modelscope-qwen';
  }

  // Priority 2: Server-side API (ModelScope /api/analyze-safety or Vercel).
  // On localhost there is no backend, so this is skipped and we fall to rule-based.
  if (!result && location.hostname !== 'localhost') {
    try {
      if (hintEl) hintEl.textContent = '📡 Mengirim ke server…';
      const resp = await fetch('/api/analyze-safety', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: framesToSend,
          disasterType: selectedDisasterType,
          isVideo,
          context,
          msApiKey: localStorage.getItem('ms_api_key') || ''
        })
      });
      if (resp.ok) {
        result = await resp.json();
      }
    } catch(e) {
      console.warn('[Scanner] Server API unavailable:', e.message);
    }
  }

  // Priority 3: Embedded rule-based (always works, no network needed)
  if (!result) {
    result = ruleBasedAnalysis(selectedDisasterType, isVideo, context);
    result.source = 'rule-based';
  }

  // Ensure structure
  if (!result.riskLevel) result.riskLevel = 'caution';
  if (!Array.isArray(result.recommendations)) result.recommendations = [];
  if (!Array.isArray(result.dangerZones)) result.dangerZones = [];
  if (result.confidence == null) result.confidence = 0.5;

  renderSafetyResult(result);
}

function renderSafetyResult(result) {
  const loadingEl = document.getElementById('scanner-loading');
  const resultsEl = document.getElementById('scanner-results');
  loadingEl.classList.add('hidden');
  resultsEl.classList.remove('hidden');

  // Risk badge
  const badges = { safe: '✅', caution: '⚠️', danger: '🚨' };
  document.getElementById('result-risk-badge').textContent = badges[result.riskLevel] || '⚠️';

  // Summary
  document.getElementById('result-summary').textContent = result.summary || '';

  // Recommendations
  const recsEl = document.getElementById('result-recs');
  recsEl.innerHTML = '';
  (result.recommendations || []).sort((a, b) => a.priority - b.priority).forEach(rec => {
    const pClass = `p${Math.min(rec.priority, 3)}`;
    recsEl.innerHTML += `<div class="rec-card ${pClass}">
      <span class="rec-priority">${rec.priority}</span>
      <div class="rec-text"><strong>${esc(rec.action)}</strong><span>📍 ${esc(rec.location)}</span></div>
    </div>`;
  });

  // Objects seen (from AI vision)
  let objectsHtml = '';
  if (result.objectsSeen && result.objectsSeen.length > 0) {
    objectsHtml = `<div style="margin-bottom:12px;padding:10px;background:rgba(79,70,229,.06);border-radius:8px;border:1px solid rgba(79,70,229,.15)">
      <strong style="font-size:.78rem;color:var(--clr-primary)">👁️ Objek terdeteksi:</strong>
      <p style="font-size:.78rem;color:var(--clr-text-2);margin-top:4px">${result.objectsSeen.map(o => esc(o)).join(' · ')}</p>
    </div>`;
  }

  // Nearest safety (radius 50km context)
  let safetyHtml = '';
  if (result.nearestSafety) {
    safetyHtml = `<div style="margin-bottom:12px;padding:10px;background:rgba(34,197,94,.06);border-radius:8px;border:1px solid rgba(34,197,94,.15)">
      <strong style="font-size:.78rem;color:#16a34a">🛡️ Tempat aman terdekat (radius 50km):</strong>
      <p style="font-size:.78rem;color:var(--clr-text-2);margin-top:4px">${esc(result.nearestSafety)}</p>
    </div>`;
  }

  // Inject before recs
  const recsContainer = document.getElementById('result-recs');
  recsContainer.insertAdjacentHTML('beforebegin', objectsHtml + safetyHtml);

  // Danger zones
  const dangersEl = document.getElementById('result-dangers');
  const dangerList = document.getElementById('result-danger-list');
  if (result.dangerZones && result.dangerZones.length > 0) {
    dangersEl.classList.remove('hidden');
    dangerList.innerHTML = result.dangerZones.map(z => `<li>${esc(z)}</li>`).join('');
  } else {
    dangersEl.classList.add('hidden');
  }

  // Confidence + source
  const conf = result.confidence != null ? Math.round(result.confidence * 100) : null;
  const srcLabel = result.source === 'modelscope-qwen' ? 'Qwen Vision AI' : result.source === 'cloudflare-ai' ? 'Cloudflare AI' : 'Rule Engine';
  document.getElementById('result-confidence').textContent =
    `${srcLabel} · Confidence: ${conf || '?'}%${result.framesAnalyzed > 1 ? ` · ${result.framesAnalyzed} frame dianalisis` : ''}`;

  // Haptic feedback based on risk
  if (result.riskLevel === 'danger') hapticDanger();
  else hapticTurn();
}

function triggerAutoScan(disasterType) {
  const banner = document.getElementById('scan-cta-banner');
  if (!banner) return;
  banner.classList.remove('hidden');
  // Auto-dismiss after 15s
  setTimeout(() => banner.classList.add('hidden'), 15000);
}

// Escape HTML helper
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// ── LOCATION ─────────────────────────────────────────────────
let geoWatchId = null;
let geoRetryCount = 0;
const GEO_MAX_RETRIES = 5;

function requestLocation() {
  setStatus('info', 'Mengambil lokasi…', 'Mohon izinkan akses lokasi Anda.');

  if (!navigator.geolocation) {
    showManualPosModal('Browser tidak mendukung geolocation.\nMasukkan koordinat Anda secara manual:');
    return;
  }

  // Use watchPosition for real-time continuous tracking
  startGeoWatch();
}

function startGeoWatch() {
  if (geoWatchId !== null) return; // already watching

  geoWatchId = navigator.geolocation.watchPosition(
    onGeoSuccess,
    onGeoError,
    {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 10000  // accept cached position up to 10s old
    }
  );
}

function stopGeoWatch() {
  if (geoWatchId !== null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
}

/** Show a modal asking user to manually enter coordinates */
function showManualPosModal(reason) {
  let overlay = document.getElementById('manual-pos-overlay');
  if (overlay) overlay.remove();

  const saved = loadLS(LS_KEYS.POS, null);
  const defLat = saved ? saved.lat : -6.2;
  const defLng = saved ? saved.lng : 106.8;

  overlay = document.createElement('div');
  overlay.id = 'manual-pos-overlay';
  overlay.className = 'modal-backdrop';
  overlay.innerHTML = `<div class="modal">
    <div class="modal-header"><h2>📍 Lokasi Manual</h2></div>
    <div class="modal-body">
      <p style="font-size:13px;color:var(--clr-text-2);margin-bottom:14px;line-height:1.6">${reason}</p>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Latitude</label>
        <input type="number" step="0.0001" id="manual-lat" value="${defLat}"
          class="form-input" placeholder="-6.2000">
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Longitude</label>
        <input type="number" step="0.0001" id="manual-lng" value="${defLng}"
          class="form-input" placeholder="106.8000">
      </div>
      <p style="font-size:11px;color:var(--clr-text-3)">💡 Contoh Jakarta: Lat -6.2, Lng 106.8<br>Contoh Bandung: Lat -6.9, Lng 107.6</p>
    </div>
    <div class="modal-footer" style="gap:8px">
      <button class="btn-secondary btn-full" onclick="document.getElementById('manual-pos-overlay').classList.add('hidden')">Batal</button>
      <button class="btn-primary btn-full" id="btn-manual-save">Simpan</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  document.getElementById('btn-manual-save').addEventListener('click', () => {
    const lat = parseFloat(document.getElementById('manual-lat').value);
    const lng = parseFloat(document.getElementById('manual-lng').value);
    if (isNaN(lat) || isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      alert('Koordinat tidak valid!');
      return;
    }
    state.userPos = { lat, lng };
    saveLS(LS_KEYS.POS, state.userPos);
    overlay.classList.add('hidden');
    updateUserMarker();
    fetchEarthquakes();
    fetchNearbyShelters();
    checkTsunamiRisk();
    setStatus('safe', 'Lokasi diset manual', `Koordinat: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
  });
}

function updateUserMarker() {
  if (!state.userPos) return;
  const { lat, lng } = state.userPos;
  if (state.userMarker) state.map.removeLayer(state.userMarker);
  state.userMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: '',
      html: `<div style="
        width:18px;height:18px;border-radius:50%;
        background:#1a73e8;border:3px solid #fff;
        box-shadow:0 0 0 4px rgba(26,115,232,.3);
        animation:pulse-dot 2s infinite;"></div>`,
      iconSize: [18, 18], iconAnchor: [9, 9]
    })
  }).addTo(state.map);
  injectPulseCSS();
}

let geoFirstFix = true;

function onGeoSuccess(pos) {
  const { latitude: lat, longitude: lng } = pos.coords;
  const accuracy = pos.coords.accuracy || 0;
  state.userPos = { lat, lng };
  saveLS(LS_KEYS.POS, state.userPos);
  updateUserMarker();

  // Only re-center map on first fix, then just update marker
  if (geoFirstFix) {
    geoFirstFix = false;
    geoRetryCount = 0;
    state.map.setView([lat, lng], 15);
    setStatus('safe', '📡 Lokasi real-time aktif',
      `Akurasi: ±${Math.round(accuracy)}m · Update otomatis`);
    fetchEarthquakes();
    fetchNearbyShelters();
    checkTsunamiRisk();
  } else {
    // Update status subtly to show live tracking
    const banner = document.getElementById('status-banner');
    if (banner && banner.classList.contains('banner-safe')) {
      document.getElementById('status-msg').textContent =
        `Live: ${lat.toFixed(5)}, ${lng.toFixed(5)} (±${Math.round(accuracy)}m)`;
    }
  }
}

function onGeoError(err) {
  geoRetryCount++;
  const msgs = {
    1: 'Izin lokasi ditolak di browser.',
    2: 'GPS tidak tersedia / sinyal lemah.',
    3: 'Menunggu sinyal GPS…'
  };
  const msg = msgs[err.code] || err.message;

  // Permission denied → stop watching, offer manual
  if (err.code === 1) {
    stopGeoWatch();
    if (IS_WEBVIEW) {
      showManualPosModal(`${msg}\n\nDi mode aplikasi, GPS dibatasi.\nMasukkan koordinat Anda:`);
    } else {
      setStatus('warning', 'Izin lokasi diperlukan',
        msg + '\nBuka Settings → Site Permissions → Location → Allow');
    }
    return;
  }

  // Timeout / unavailable → retry up to max, then fallback
  if (geoRetryCount >= GEO_MAX_RETRIES && !state.userPos) {
    stopGeoWatch();
    setStatus('warning', 'GPS belum terdeteksi',
      'Mencoba ulang otomatis… atau gunakan ✏️ untuk set manual');
    // Offer manual as secondary option (not blocking)
    setTimeout(() => {
      if (!state.userPos) {
        showManualPosModal('GPS belum memberikan posisi setelah beberapa percobaan.\n\nAnda bisa tunggu (akan terus retry) atau set manual:');
      }
    }, 5000);
  } else {
    // Still retrying — show progress
    if (!state.userPos) {
      setStatus('info', 'Mencari sinyal GPS…',
        `Percobaan ${geoRetryCount}/${GEO_MAX_RETRIES} — ${msg}`);
    }
  }
}

function injectPulseCSS() {
  if (document.getElementById('pulse-css')) return;
  const s = document.createElement('style');
  s.id = 'pulse-css';
  s.textContent = `@keyframes pulse-dot{0%{box-shadow:0 0 0 0 rgba(26,115,232,.5)}70%{box-shadow:0 0 0 12px rgba(26,115,232,0)}100%{box-shadow:0 0 0 0 rgba(26,115,232,0)}}`;
  document.head.appendChild(s);
}

// ── STATUS BANNER ──────────────────────────────────────────────
function setStatus(type, title, msg) {
  const banner = document.getElementById('status-banner');
  const icons  = { safe:'✅', warning:'⚠️', danger:'🚨', info:'ℹ️' };
  banner.className = `banner banner-${type}`;
  document.getElementById('status-icon').textContent  = icons[type];
  document.getElementById('status-title').textContent = title;
  document.getElementById('status-msg').textContent   = msg;
  if (type === 'danger') { alarm(); hapticDanger(); }
}

// ── EARTHQUAKE DATA ────────────────────────────────────────────
async function fetchEarthquakes() {
  const listEl = document.getElementById('disaster-list');
  listEl.innerHTML = '<div class="loading-state"><span class="spinner"></span>Memuat data gempa…</div>';

  let quakes = [];

  try {
    const resp = await fetch(BMKG_FEED_URL, { mode: 'cors' });
    if (resp.ok) {
      const xml = await resp.text();
      quakes = parseBMKG(xml);
    }
  } catch(e) { console.warn('BMKG failed:', e); }

  if (quakes.length === 0) {
    try {
      const resp = await fetch(USGS_FEED_URL);
      if (resp.ok) {
        const json = await resp.json();
        quakes = json.features.slice(0, 30).map(f => ({
          mag:       f.properties.mag,
          place:     f.properties.place,
          time:      f.properties.time,
          depth:     f.geometry.coordinates[2],
          lat:       f.geometry.coordinates[1],
          lng:       f.geometry.coordinates[0],
          tsunami:   false
        }));
      }
    } catch(e) { console.warn('USGS failed:', e); }
  }

  renderEarthquakes(quakes);

  // Notify for significant quakes
  quakes.forEach(q => {
    if (q.mag >= 5) notifyEarthquake(q);
  });
}

function parseBMKG(xmlText) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, 'text/xml');
  const items  = doc.querySelectorAll('item');
  const results = [];

  items.forEach(item => {
    const text = item.querySelector('description')?.textContent || '';
    const magMatch   = text.match(/Mag[:\s]*([\d.]+)/i);
    const dateMatch  = text.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
    const coordMatch = text.match(/#?(-?\d+\.?\d*)[, ](-?\d+\.?\d*)/);
    const depthMatch = text.match(/[Dd]epth[:\s]*(\d+)/i);
    const tsunamiFlag = /tsunami/i.test(text);

    if (magMatch && coordMatch && dateMatch) {
      results.push({
        mag:      parseFloat(magMatch[1]),
        place:    text.replace(/Mag[:\s]*[\d.]+,\s*/i, '').replace(/Depth:.*/, '').trim(),
        time:     dateMatch[1] + 'Z',
        depth:    depthMatch ? parseInt(depthMatch[1]) : null,
        lat:      parseFloat(coordMatch[1]),
        lng:      parseFloat(coordMatch[2]),
        tsunami:  tsunamiFlag
      });
    }
  });
  return results.slice(0, 30);
}

function renderEarthquakes(quakes) {
  const listEl = document.getElementById('disaster-list');
  if (!quakes.length) {
    listEl.innerHTML = '<div class="empty-state"><span class="empty-icon">🌍</span>Tidak ada data gempa saat ini.<br>Sumber data mungkin sedang offline.</div>';
    return;
  }

  const sorted = [...quakes].sort((a,b) => b.mag - a.mag);
  listEl.innerHTML = sorted.map(q => {
    const level  = q.mag >= 6 ? 'high' : q.mag >= 4 ? 'medium' : 'low';
    const dist   = state.userPos ? haversineKm(state.userPos.lat, state.userPos.lng, q.lat, q.lng) : null;
    const tsunamiBadge = q.tsunami ? ' <span style="color:var(--clr-danger);font-weight:700;">🌊 TSUNAMI</span>' : '';
    return `
      <div class="disaster-card ${level}">
        <div class="disaster-card-header">
          <span class="disaster-type">🌍 Gempa M${q.mag}${tsunamiBadge}</span>
          <span class="disaster-time">${timeAgo(q.time)}</span>
        </div>
        <p class="disaster-meta">
          ${q.place || '—'}
          ${q.depth != null ? `<br>Dalaman: ${q.depth} km` : ''}
        </p>
        ${dist != null ? `<p class="disaster-distance">📍 Jarak dari Anda: ${formatDist(dist)}</p>` : ''}
      </div>`;
  }).join('');
}

// ── TSUNAMI RISK CHECK ─────────────────────────────────────────
function checkTsunamiRisk() {
  fetchEarthquakes().then(() => {
    const listEl = document.getElementById('disaster-list');
    const highQuakes = Array.from(listEl.querySelectorAll('.disaster-card.high'));
    if (highQuakes.length > 0) {
      setStatus('warning', 'Peringatan: Gempa kuat terdeteksi',
        'Perhatikan potensi gelombang tsunami. Pindahkan diri ke tempat tinggi.');
    }
  });
}

// ── SHELTERS (Overpass API) ────────────────────────────────────
async function fetchNearbyShelters() {
  const listEl = document.getElementById('shelter-list');
  listEl.innerHTML = '<div class="loading-state"><span class="spinner"></span>Mencari tempat aman…</div>';

  const { lat, lng } = state.userPos;
  const r = SHELTER_RADIUS;

  const query = `
    [out:json][timeout:25];
    (
      node["amenity"~"hospital|clinic"](${lat-r},${lng-r},${lat+r},${lng+r});
      way["amenity"~"hospital|clinic"](${lat-r},${lng-r},${lat+r},${lng+r});
      node["amenity"="school"](${lat-r},${lng-r},${lat+r},${lng+r});
      way["amenity"="school"](${lat-r},${lng-r},${lat+r},${lng+r});
      node["amenity"="police"](${lat-r},${lng-r},${lat+r},${lng+r});
      way["amenity"="police"](${lat-r},${lng-r},${lat+r},${lng+r});
      node["amenity"="fire_station"](${lat-r},${lng-r},${lat+r},${lng+r});
      way["amenity"="fire_station"](${lat-r},${lng-r},${lat+r},${lng+r});
      node["amenity"="place_of_worship"]["religion"="islam"](${lat-r},${lng-r},${lat+r},${lng+r});
      way["amenity"="place_of_worship"]["religion"="islam"](${lat-r},${lng-r},${lat+r},${lng+r});
      node["amenity"="place_of_worship"]["religion"="christian"](${lat-r},${lng-r},${lat+r},${lng+r});
      way["amenity"="place_of_worship"]["religion"="christian"](${lat-r},${lng-r},${lat+r},${lng+r});
      node["leisure"="park"](${lat-r},${lng-r},${lat+r},${lng+r});
      way["leisure"="park"](${lat-r},${lng-r},${lat+r},${lng+r});
    );
    out center tags;
  `;

  try {
    const form = new URLSearchParams({ data: query });
    const resp = await fetch(OVERPASS_API, { method: 'POST', body: form });
    if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
    const json = await resp.json();

    const shelters = json.elements.map(el => {
      const lat2 = el.lat ?? el.center?.lat;
      const lng2 = el.lon ?? el.center?.lon;
      if (!lat2 || !lng2) return null;
      const type = classifyShelter(el.tags);
      return {
        id:   el.id,
        name: el.tags.name || SHELTER_LABELS[type] || 'Tempat Aman',
        type,
        lat:  lat2,
        lng:  lng2,
        dist: haversineKm(lat, lng, lat2, lng2)
      };
    }).filter(Boolean).sort((a,b) => a.dist - b.dist).slice(0, 20);

    state.activeShelters = shelters;
    renderShelters(shelters);
    drawShelterMarkers(shelters);

  } catch(e) {
    console.error('Shelter fetch error:', e);
    listEl.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">⚠️</span>
        Gagal memuat data tempat aman.<br>
        <small>${e.message}<br>Coba lagi beberapa saat.</small>
      </div>`;
  }
}

function classifyShelter(tags) {
  if (!tags) return 'park';
  if (tags.amenity === 'hospital' || tags.amenity === 'clinic') return 'hospital';
  if (tags.amenity === 'school') return 'school';
  if (tags.amenity === 'police') return 'police';
  if (tags.amenity === 'fire_station') return 'fire';
  if (tags.amenity === 'place_of_worship') {
    if (tags.religion === 'islam') return 'mosque';
    return 'church';
  }
  return 'park';
}

// ── FAVORITES ──────────────────────────────────────────────────
function getFavorites() { return loadLS(LS_KEYS.FAVORITES, []); }
function isFavorite(shelterId) {
  return getFavorites().some(f => f.shelterId === shelterId);
}
function toggleFavorite(shelter) {
  let favs = getFavorites();
  const idx = favs.findIndex(f => f.shelterId === shelter.id);
  if (idx >= 0) {
    favs.splice(idx, 1);
    hapticTap();
  } else {
    favs.unshift({
      shelterId: shelter.id,
      name: shelter.name,
      type: shelter.type,
      lat: shelter.lat,
      lng: shelter.lng,
      addedAt: Date.now()
    });
    hapticTap();
    beep(880, .1);
  }
  saveLS(LS_KEYS.FAVORITES, favs);
  renderFavorites();
  // Re-render shelter list to update star icons
  const filter = document.getElementById('shelter-type').value;
  renderShelters(state.activeShelters, filter);
}

function removeFavorite(shelterId) {
  let favs = getFavorites().filter(f => f.shelterId !== shelterId);
  saveLS(LS_KEYS.FAVORITES, favs);
  renderFavorites();
}

function renderFavorites() {
  const favs = getFavorites();
  const listEl = document.getElementById('favorites-list');
  if (!favs.length) {
    listEl.innerHTML = `<div class="empty-state"><span class="empty-icon">⭐</span>Belum ada favorit.<br>Tekan ⭐ di tab Tempat Aman untuk menyimpan.</div>`;
    return;
  }
  listEl.innerHTML = favs.map(f => `
    <div class="fav-card">
      <span class="shelter-icon">${SHELTER_ICONS[f.type]}</span>
      <div class="fav-info">
        <div class="fav-name">${f.name}</div>
        <div class="fav-type">${SHELTER_LABELS[f.type]}</div>
      </div>
      <button class="remove-fav" onclick="removeFavorite(${f.shelterId})" title="Hapus favorit">✕</button>
    </div>
  `).join('');
}

// ── HISTORY ────────────────────────────────────────────────────
function addHistory(entry) {
  let history = loadLS(LS_KEYS.HISTORY, []);
  history.unshift({ ...entry, startedAt: Date.now() });
  // Keep max 50 entries
  if (history.length > 50) history = history.slice(0, 50);
  saveLS(LS_KEYS.HISTORY, history);
  renderHistory();
}

function clearHistory() {
  if (!confirm('Hapus semua riwayat evakuasi?')) return;
  saveLS(LS_KEYS.HISTORY, []);
  renderHistory();
}

function renderHistory() {
  const history = loadLS(LS_KEYS.HISTORY, []);
  const listEl = document.getElementById('history-list');
  if (!history.length) {
    listEl.innerHTML = '<div class="empty-state"><span class="empty-icon">🕐</span>Belum ada riwayat evakuasi.</div>';
    return;
  }
  listEl.innerHTML = history.map(h => `
    <div class="history-card">
      <div class="history-card-header">
        <span class="history-dest">${SHELTER_ICONS[h.destType] || '📍'} ${h.destName}</span>
        <span class="history-date">${formatDate(h.startedAt)}</span>
      </div>
      <div class="history-stats">
        <span>📏 ${formatDist(h.distanceKm)}</span>
        <span>⏱️ ${formatDuration(h.durationSec)}</span>
        ${h.completed ? '<span style="color:var(--clr-safe)">✓ Selesai</span>' : '<span style="color:var(--clr-warning)">● Berjalan</span>'}
      </div>
    </div>
  `).join('');
}

// ── RENDER SHELTERS (with favorite button) ─────────────────────
function renderShelters(shelters, filter = 'all') {
  const listEl = document.getElementById('shelter-list');
  const filtered = filter === 'all' ? shelters : shelters.filter(s => s.type === filter);

  if (!filtered.length) {
    listEl.innerHTML = '<div class="empty-state"><span class="empty-icon">🏥</span>Tidak ada tempat aman dalam radius 3 km.</div>';
    return;
  }

  listEl.innerHTML = filtered.map((s, i) => {
    const fav = isFavorite(s.id);
    return `
    <div class="shelter-card">
      <span class="shelter-icon">${SHELTER_ICONS[s.type]}</span>
      <div class="shelter-info">
        <div class="shelter-name">${s.name}</div>
        <div class="shelter-dist">📍 ${formatDist(s.dist)} dari Anda</div>
        <span class="shelter-type-badge">${SHELTER_LABELS[s.type]}</span>
      </div>
      <div class="shelter-actions">
        <button class="fav-btn ${fav ? 'active' : ''}" onclick="toggleFavorite({id:${s.id},name:'${s.name.replace(/'/g, "\\'")}',type:'${s.type}',lat:${s.lat},lng:${s.lng}})" title="Favorit">
          ${fav ? '★' : '☆'}
        </button>
        <button class="shelter-route-btn" onclick="navigateToShelter(${i}, '${filter}')">🧭 Rute</button>
      </div>
    </div>`;
  }).join('');

  state._filteredShelters = filtered;
}

function drawShelterMarkers(shelters) {
  state.shelterMarkers.forEach(m => state.map.removeLayer(m));
  state.shelterMarkers = [];

  shelters.forEach(s => {
    const icon = L.divIcon({
      className: '',
      html: `<div style="font-size:24px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5));">${SHELTER_ICONS[s.type]}</div>`,
      iconSize: [28, 28], iconAnchor: [14, 14]
    });
    const marker = L.marker([s.lat, s.lng], { icon })
      .bindPopup(`<strong>${s.name}</strong><br>${SHELTER_LABELS[s.type]}<br>📍 ${formatDist(s.dist)}`)
      .addTo(state.map);
    state.shelterMarkers.push(marker);
  });
}

// ── ROUTING (OSRM) ─────────────────────────────────────────────
async function getRoute(from, to) {
  const url = `${OSRM_API}${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`OSRM ${resp.status}`);
  const json = await resp.json();
  if (json.code !== 'Ok' || !json.routes?.length) throw new Error('Rute tidak ditemukan');
  return json.routes[0];
}

function buildTurnByTurn(route) {
  return route.legs[0].steps.map(step => {
    const man = step.maneuver;
    const type = man.type;
    const mod  = man.modifier || '';
    const icons = {
      depart:         '🚶', arrive: '🏁',
      'turn': mod.includes('left') ? '⬅️' : '➡️',
      'new name':     '→',
      merge:          '🔀', 'on ramp': '⤴️', 'off ramp': '⤵️',
      fork:           '⑂', 'end of road': '🛑',
      continue:       '↑', roundabout: '🔄', rotary: '🔄'
    };
    const icon = icons[type] || '→';
    const street = step.narrative?.out || step.narrative?.name || '';
    const distTxt = step.distance < 100
      ? `${Math.round(step.distance)} m`
      : `${(step.distance/1000).toFixed(1)} km`;
    return { icon, street, distTxt, type, modifier: mod };
  });
}

// ── NAVIGATE TO SHELTER ────────────────────────────────────────
async function navigateToShelter(idx, filter) {
  const target = state._filteredShelters?.[idx] || state.activeShelters[idx];
  if (!target || !state.userPos) return;

  hapticTap();
  document.getElementById('evac-modal').classList.remove('hidden');
  document.getElementById('evac-target-info').innerHTML = `
    <strong>${SHELTER_ICONS[target.type]} ${target.name}</strong><br>
    ${SHELTER_LABELS[target.type]} · Jarak garis lurus: ${formatDist(target.dist)}
  `;
  document.getElementById('route-summary').classList.add('hidden');
  document.getElementById('turn-by-turn').innerHTML = '';
  document.getElementById('route-loading').classList.remove('hidden');
  document.getElementById('btn-start-nav').disabled = true;

  try {
    const route = await getRoute(state.userPos, { lat: target.lat, lng: target.lng });
    state.activeRoute = route;
    state.navIndex = 0;
    state._navTarget = target;
    state._navStart = Date.now();

    const summary = document.getElementById('route-summary');
    summary.classList.remove('hidden');
    document.getElementById('route-distance').textContent = formatDist(route.distance / 1000);
    document.getElementById('route-time').textContent     = formatDuration(route.duration);

    const tbt = buildTurnByTurn(route);
    document.getElementById('turn-by-turn').innerHTML = tbt.map(t => `
      <div class="turn-item">
        <span class="turn-icon">${t.icon}</span>
        <span class="turn-text">${t.street || 'Lanjut jalan'}</span>
        <span class="turn-dist">${t.distTxt}</span>
      </div>
    `).join('');

    drawRouteLine(route);
    document.getElementById('btn-start-nav').disabled = false;
    document.getElementById('route-loading').classList.add('hidden');

    const bounds = L.geoJSON(route.geometry).getBounds();
    state.map.fitBounds(bounds, { padding: [40, 40] });

  } catch(e) {
    document.getElementById('route-loading').innerHTML =
      `<div class="empty-state"><span class="empty-icon">⚠️</span>Gagal menghitung rute: ${e.message}</div>`;
  }
}

function drawRouteLine(route) {
  if (state.routeLayer) state.map.removeLayer(state.routeLayer);
  const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);
  state.routeLayer = L.polyline(coords, {
    color: '#1a73e8', weight: 5, opacity: .85,
    lineCap: 'round', lineJoin: 'round'
  }).addTo(state.map);

  const dest = coords[coords.length - 1];
  L.circleMarker(dest, {
    radius: 10, color: '#fff', fillColor: '#2e7d32', fillOpacity: 1, weight: 3
  }).addTo(state.map).bindPopup('🏁 Tujuan');
}

// ── START NAVIGATION MODE ──────────────────────────────────────
function startNavigation() {
  if (!state.activeRoute) return;
  hapticTap();
  document.getElementById('nav-overlay').classList.remove('hidden');
  document.getElementById('evac-modal').classList.add('hidden');
  updateNavInstruction();
  beep(880, .1);
  acquireWakeLock(); // Keep screen on during navigation
}

function updateNavInstruction() {
  const tbt = buildTurnByTurn(state.activeRoute);
  const step = tbt[state.navIndex];
  if (!step) {
    document.getElementById('nav-instruction').innerHTML = `
      <div class="nav-turn-icon">🏁</div>
      <div class="nav-street">Anda sudah tiba!</div>
      <div class="nav-distance">Selamat, Anda telah mencapai tempat aman.</div>`;
    document.getElementById('nav-progress-bar').style.width = '100%';
    // Log to history
    logEvacuationComplete();
    return;
  }
  document.getElementById('nav-instruction').innerHTML = `
    <div class="nav-turn-icon">${step.icon}</div>
    <div class="nav-street">${step.street || 'Lanjutkan'}</div>
    <div class="nav-distance">${step.distTxt}</div>`;

  const total = tbt.length;
  document.getElementById('nav-progress-bar').style.width =
    `${(state.navIndex / total) * 100}%`;
}

function advanceNavStep() {
  state.navIndex++;
  updateNavInstruction();
  hapticTurn();
  beep(660, .1);
}

function endNavigation() {
  document.getElementById('nav-overlay').classList.add('hidden');
  if (state.routeLayer) state.map.removeLayer(state.routeLayer);
  state.activeRoute = null;
  state.navIndex = 0;
  releaseWakeLock();
}

function logEvacuationComplete() {
  if (!state._navTarget || !state._navStart) return;
  const durationSec = Math.round((Date.now() - state._navStart) / 1000);
  addHistory({
    destName:  state._navTarget.name,
    destType:  state._navTarget.type,
    distanceKm: state._navTarget.dist,
    durationSec,
    completed: true
  });
  state._navTarget = null;
  state._navStart = null;
}

// ── FAMILY SHARING ─────────────────────────────────────────────
function getFamily() { return loadLS(LS_KEYS.FAMILY, []); }

function addFamilyMember() {
  const nameInput  = document.getElementById('member-name');
  const phoneInput = document.getElementById('member-phone');
  const name  = nameInput.value.trim();
  const phone = phoneInput.value.trim();

  if (!name)  { nameInput.focus(); return; }
  if (!phone || !/^0\d{8,12}$/.test(phone)) {
    phoneInput.focus();
    phoneInput.style.borderColor = 'var(--clr-danger)';
    setTimeout(() => phoneInput.style.borderColor = '', 2000);
    return;
  }

  let family = getFamily();
  // Prevent duplicate phone
  if (family.some(m => m.phone === phone)) {
    alert('Nomor HP sudah terdaftar.');
    return;
  }

  family.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    name,
    phone,
    lastShared: null
  });
  saveLS(LS_KEYS.FAMILY, family);

  nameInput.value = '';
  phoneInput.value = '';
  hapticTap();
  beep(880, .1);
  renderFamily();
}

function removeFamilyMember(id) {
  if (!confirm('Hapus anggota keluarga ini?')) return;
  let family = getFamily().filter(m => m.id !== id);
  saveLS(LS_KEYS.FAMILY, family);
  renderFamily();
}

function sharePosition(memberId, method) {
  if (!state.userPos) {
    alert('Lokasi belum tersedia. Tunggu sampai posisi terdeteksi.');
    return;
  }

  const member = getFamily().find(m => m.id === memberId);
  if (!member) return;

  const { lat, lng } = state.userPos;
  const mapsUrl = `https://maps.google.com/?q=${lat},${lng}`;
  const message = `📍 Posisi saya sekarang:\n${mapsUrl}\n\nKirim via SelamatKu — tolong dicek!`;

  // Normalize phone: 08xx → 628xx
  const intlPhone = '62' + member.phone.substring(1);

  if (method === 'sms') {
    window.location.href = `sms:+${intlPhone}?body=${encodeURIComponent(message)}`;
  } else if (method === 'wa') {
    window.open(`https://wa.me/${intlPhone}?text=${encodeURIComponent(message)}`, '_blank');
  }

  // Update last shared
  let family = getFamily();
  const m = family.find(x => x.id === memberId);
  if (m) {
    m.lastShared = Date.now();
    saveLS(LS_KEYS.FAMILY, family);
    renderFamily();
  }
  hapticTap();
}

function renderFamily() {
  const family = getFamily();
  const listEl = document.getElementById('family-list');

  if (!family.length) {
    listEl.innerHTML = `<div class="empty-state"><span class="empty-icon">👨‍👩‍👧👦</span>Belum ada anggota keluarga.<br>Tambahkan di atas untuk berbagi posisi saat darurat.</div>`;
    return;
  }

  listEl.innerHTML = family.map(m => {
    const initial = m.name.charAt(0).toUpperCase();
    const lastShare = m.lastShared ? formatDate(m.lastShared) : 'Belum pernah';
    return `
    <div class="member-card">
      <div class="member-header">
        <div class="member-avatar">${initial}</div>
        <div>
          <div class="member-name">${m.name}</div>
          <div class="member-phone">${m.phone}</div>
        </div>
      </div>
      <div class="member-last-share">Terakhir berbagi: ${lastShare}</div>
      <div class="member-actions">
        <button class="share-btn sms" onclick="sharePosition('${m.id}','sms')">📱 SMS</button>
        <button class="share-btn wa"  onclick="sharePosition('${m.id}','wa')">💬 WhatsApp</button>
        <button class="share-btn remove" onclick="removeFamilyMember('${m.id}')" title="Hapus">✕</button>
      </div>
    </div>`;
  }).join('');
}

// ── BOTTOM NAV TAB SWITCHING ───────────────────────────────────
function initTabs() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      hapticTap();
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const tabId = btn.dataset.tab;
      document.getElementById(`tab-${tabId}`).classList.add('active');

      if (tabId === 'map') setTimeout(() => state.map.invalidateSize(), 50);
      if (tabId === 'history') { renderFavorites(); renderHistory(); }
      if (tabId === 'family')  renderFamily();
    });
  });

  // Handle deep link from manifest shortcuts (?tab=xxx)
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  if (tab) {
    const btn = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    if (btn) btn.click();
  }
}

// ── PULL TO REFRESH ────────────────────────────────────────────
function initPullToRefresh() {
  let startY = 0;
  let pulling = false;

  document.addEventListener('touchstart', e => {
    if (window.scrollY <= 0) {
      startY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    const diff = e.touches[0].clientY - startY;
    const activeTab = document.querySelector('.nav-item.active')?.dataset.tab;
    const indicator = document.getElementById(`pull-indicator-${activeTab}`);
    if (indicator && diff > 50) {
      indicator.classList.add('active');
    }
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!pulling) return;
    pulling = false;
    const diff = e.changedTouches[0].clientY - startY;
    const activeTab = document.querySelector('.nav-item.active')?.dataset.tab;
    const indicator = document.getElementById(`pull-indicator-${activeTab}`);

    if (indicator) indicator.classList.remove('active');

    if (diff > 80) {
      refreshCurrentTab(activeTab);
    }
  });
}

function refreshCurrentTab(tab) {
  const indicators = {
    disasters: 'pull-indicator-disasters',
    shelter:   'pull-indicator-shelter',
  };
  const ind = document.getElementById(indicators[tab]);
  if (ind) {
    ind.classList.add('refreshing');
    setTimeout(() => ind.classList.remove('refreshing'), 2000);
  }

  if (tab === 'disasters' && state.userPos) fetchEarthquakes();
  if (tab === 'shelter'   && state.userPos) fetchNearbyShelters();
  if (tab === 'map'       && state.userPos) {
    fetchEarthquakes();
    fetchNearbyShelters();
  }
}

// ── ONLINE/OFFLINE DETECTION ───────────────────────────────────
function initConnectivity() {
  const badge = document.createElement('div');
  badge.className = 'offline-badge';
  badge.id = 'offline-badge';
  badge.textContent = '📡 Mode Offline — Data terakhir ditampilkan';
  document.body.appendChild(badge);

  function update() {
    badge.classList.toggle('visible', !navigator.onLine);
  }
  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
  update();
}

// ── SERVICE WORKER REGISTRATION ────────────────────────────────
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js')
      .then(reg => {
        console.log('SW registered, scope:', reg.scope);
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('New SW available and ready');
            }
          });
        });
      })
      .catch(err => console.warn('SW registration failed:', err));
  }
}

// ── PERIODIC BACKGROUND CHECK ──────────────────────────────────
function startPeriodicCheck() {
  // Check for new earthquakes every 5 minutes while page is visible
  setInterval(() => {
    if (document.visibilityState === 'visible' && state.userPos) {
      fetchEarthquakes();
    }
  }, 5 * 60 * 1000);
}

// ── EVENT LISTENERS ────────────────────────────────────────────
function initEvents() {
  // Sound toggle
  document.getElementById('btn-sound').addEventListener('click', function() {
    state.soundOn = !state.soundOn;
    this.textContent = state.soundOn ? '🔊' : '🔇';
    this.classList.toggle('active', state.soundOn);
    hapticTap();
  });

  // Notification toggle
  document.getElementById('btn-notification').addEventListener('click', () => {
    hapticTap();
    toggleNotifications();
  });

  // Recenter — if no position yet, offer manual entry
  document.getElementById('btn-recenter').addEventListener('click', () => {
    hapticTap();
    if (state.userPos) {
      state.map.setView([state.userPos.lat, state.userPos.lng], 15);
    } else {
      requestLocation();
    }
  });

  // Change position manually
  const btnChangePos = document.getElementById('btn-change-pos');
  if (btnChangePos) btnChangePos.addEventListener('click', () => {
    hapticTap();
    showManualPosModal('Ubah koordinat posisi Anda:');
  });

  // ── AI Safety Scanner events ──
  const btnScanSafety = document.getElementById('btn-scan-safety');
  if (btnScanSafety) btnScanSafety.addEventListener('click', () => {
    hapticTap();
    state.scannerActive = true;
    openSafetyScanner();
  });

  const btnCloseScanner = document.getElementById('btn-close-scanner');
  if (btnCloseScanner) btnCloseScanner.addEventListener('click', closeSafetyScanner);

  // Capture: tap = single photo, hold 1s+ = record 3s video (3 frames)
  const btnCapture = document.getElementById('btn-capture');
  let pressTimer = null;
  let isRecording = false;

  if (btnCapture) {
    btnCapture.addEventListener('touchstart', onCaptureStart);
    btnCapture.addEventListener('touchend', onCaptureEnd);
    btnCapture.addEventListener('mousedown', onCaptureStart);
    btnCapture.addEventListener('mouseup', onCaptureEnd);
  }

  function onCaptureStart() {
    hapticTap();
    const video = document.getElementById('scanner-video');
    if (!video || video.readyState < 2) {
      showInAppAlert('⚠️ Kamera belum siap', 'Tunggu sampai pratinjau kamera muncul.');
      return;
    }
    // Start timer for hold detection
    pressTimer = setTimeout(() => {
      startVideoRecording();
    }, 600); // hold for 600ms to trigger video mode
  }

  function onCaptureEnd() {
    if (isRecording) return; // already in video mode
    clearTimeout(pressTimer);
    // Short press = single frame capture
    const frame = captureFrame();
    if (!frame) {
      showInAppAlert('⚠️ Gagal capture', 'Kamera tidak menghasilkan gambar. Coba lagi.');
      return;
    }
    analyzeScene([frame]);
  }

  async function startVideoRecording() {
    if (isRecording) return;
    isRecording = true;
    btnCapture.disabled = true;

    const timerEl = document.getElementById('scanner-timer');
    const countEl = document.getElementById('timer-count');
    const ring = document.getElementById('capture-ring');
    const icon = document.getElementById('capture-icon');
    if (ring) ring.style.borderColor = '#ef4444';
    if (icon) icon.textContent = '⏺';
    if (timerEl) timerEl.classList.remove('hidden');

    const frames = [];
    const duration = 3000; // 3 seconds
    const interval = 1000; // capture every 1 second
    let elapsed = 0;

    while (elapsed < duration) {
      if (countEl) countEl.textContent = Math.ceil((duration - elapsed) / 1000);
      await sleep(interval);
      elapsed += interval;
      const f = captureFrame();
      if (f) frames.push(f);
    }

    // Stop recording UI
    if (ring) ring.style.borderColor = '';
    if (icon) icon.textContent = '🎬';
    if (timerEl) timerEl.classList.add('hidden');
    isRecording = false;
    btnCapture.disabled = false;

    if (frames.length === 0) {
      showInAppAlert('⚠️ Gagal merekam', 'Tidak ada frame yang terekam. Coba lagi.');
      return;
    }

    console.log(`[Scanner] Recorded ${frames.length} frames`);
    analyzeScene(frames);
  }

  const btnRescanAI = document.getElementById('btn-rescan-ai');
  if (btnRescanAI) btnRescanAI.addEventListener('click', () => {
    hapticTap();
    document.getElementById('scanner-results').classList.add('hidden');
    document.getElementById('scanner-loading').classList.add('hidden');
  });

  const btnCloseResults = document.getElementById('btn-close-results');
  if (btnCloseResults) btnCloseResults.addEventListener('click', closeSafetyScanner);

  // Disaster type chips
  document.querySelectorAll('#scanner-disaster-types .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      selectedDisasterType = chip.dataset.type;
      updateChipSelection();
    });
  });

  // Auto-scan CTA button
  const btnAutoScan = document.getElementById('btn-auto-scan');
  if (btnAutoScan) btnAutoScan.addEventListener('click', () => {
    hapticTap();
    document.getElementById('scan-cta-banner').classList.add('hidden');
    state.scannerActive = true;
    openSafetyScanner(selectedDisasterType);
  });

  // Rescan
  document.getElementById('btn-rescan').addEventListener('click', () => {
    hapticTap();
    if (state.userPos) fetchNearbyShelters();
  });

  // Refresh earthquakes
  document.getElementById('btn-refresh-disaster').addEventListener('click', () => {
    hapticTap();
    fetchEarthquakes();
  });

  // Shelter filter
  document.getElementById('shelter-type').addEventListener('change', function() {
    renderShelters(state.activeShelters, this.value);
  });

  // Evacuate button (zone card)
  document.getElementById('btn-evacuate').addEventListener('click', () => {
    hapticTap();
    const hospitals = state.activeShelters.filter(s => s.type === 'hospital');
    const target = hospitals[0] || state.activeShelters[0];
    if (target) navigateToShelter(state.activeShelters.indexOf(target), 'all');
  });

  // Modal close
  document.getElementById('btn-close-evac').addEventListener('click', () => {
    document.getElementById('evac-modal').classList.add('hidden');
  });

  // Start nav
  document.getElementById('btn-start-nav').addEventListener('click', startNavigation);

  // End nav
  document.getElementById('btn-end-nav').addEventListener('click', () => {
    hapticTap();
    endNavigation();
  });

  // Keyboard: spacebar to advance nav step
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !document.getElementById('nav-overlay').classList.contains('hidden')) {
      e.preventDefault();
      advanceNavStep();
    }
  });

  // Add family member
  document.getElementById('btn-add-member').addEventListener('click', addFamilyMember);

  // Clear history
  document.getElementById('btn-clear-history').addEventListener('click', clearHistory);

  // Track position while navigating
  if (navigator.geolocation) {
    navigator.geolocation.watchPosition(pos => {
      if (!state.activeRoute) return;
      const cur = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const prev = state.userPos;
      if (prev && haversineKm(prev.lat, prev.lng, cur.lat, cur.lng) > 0.05) {
        advanceNavStep();
        state.userPos = cur;
      }
    }, null, { enableHighAccuracy: true });
  }
}

// ── BOOT ──────────────────────────────────────────────────────
// ── CLEAR OLD CACHES (one-time migration) ─────────────────────
// ── DEMO MODE (for presentations) ────────────────────────────
function demoQuake(mag) {
  const places = ['10km Timur Jakarta', '25km Selatan Bandung', '15km Barat Surabaya', 'Pesisir Lombok'];
  const place = places[Math.floor(Math.random() * places.length)];
  const lat = state.userPos ? state.userPos.lat + (Math.random() - 0.5) * 2 : -6.2;
  const lng = state.userPos ? state.userPos.lng + (Math.random() - 0.5) * 2 : 106.8;

  notifyEarthquake({
    mag: mag,
    lat: parseFloat(lat.toFixed(4)),
    lng: parseFloat(lng.toFixed(4)),
    time: Date.now(),
    place: `[DEMO] ${place}`
  });
}

function demoTsunami() {
  setStatus('danger', '🌊 PERINGATAN TSUNAMI [DEMO]',
    'Gempa M7.8 di dasar laut — potensi tsunami! Evakuasi ke tempat tinggi segera.');
  startAlarm();
  hapticDanger();
  showEmergencyAlert(
    '🌊 PERINGATAN TSUNAMI [DEMO]',
    'Gempa M7.8 terdeteksi di zona subduksi.\nPotensi tsunami dalam 15-30 menit.\n\nYANG HARUS DILAKUKAN:\n1. Segera menjauh dari pantai (min. 30m)\n2. Naik ke tempat tinggi (min. 15m dpl)\n3. Jauhi sungai dan muara\n4. Ikuti jalur evakuasi vertikal\n5. Bawa dokumen penting jika sempat\n\n⚠️ Alarm akan berbunyi hingga Anda menekan TUTUP.',
    true
  );
  setTimeout(() => triggerAutoScan('tsunami'), 3000);
}

async function clearOldCaches() {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    const names = await caches.keys();
    for (const n of names) await caches.delete(n);
  } catch(e) {}
}

// ── BOOT ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await clearOldCaches();
  registerServiceWorker();
  initMap();
  initTabs();
  initEvents();
  initNotifications();
  initPullToRefresh();
  initConnectivity();
  startPeriodicCheck();
  renderFavorites();
  renderHistory();
  renderFamily();
  // New features
  initSettings();
  initHazardChips();
  initChatPanel();
  setTimeout(loadWeather, 3000);
  setInterval(() => { if (state.userPos) loadWeather(); }, 120000);
});

// ════════════════════════════════════════════════════════
// SETTINGS: Dark Mode, Font Size, Toggles
// ════════════════════════════════════════════════════════
function initSettings() {
  const html = document.documentElement;
  const settingsBtn   = document.getElementById('settingsBtn');
  const overlay       = document.getElementById('settings-overlay');
  const closeSettings = document.getElementById('btn-close-settings');
  const toggleDark    = document.getElementById('toggle-dark');
  const togglePush    = document.getElementById('toggle-push');
  const toggleAlarm   = document.getElementById('toggle-alarm');
  const fontOpts      = document.querySelectorAll('.font-opt');
  const btnChangePos  = document.getElementById('btn-settings-change-pos');

  // Restore saved prefs
  const savedTheme = localStorage.getItem('sk_theme') || 'light';
  const savedFont  = localStorage.getItem('sk_font')  || 'normal';
  html.dataset.theme = savedTheme;
  html.dataset.font  = savedFont;
  if (toggleDark) {
    toggleDark.classList.toggle('on', savedTheme === 'dark');
    toggleDark.setAttribute('aria-checked', String(savedTheme === 'dark'));
  }
  fontOpts.forEach(b => b.classList.toggle('active', b.dataset.size === savedFont));

  function openSettings() {
    overlay && overlay.classList.remove('hidden');
    hapticTap();
  }
  function closeSettingsFn() {
    overlay && overlay.classList.add('hidden');
    hapticTap();
  }

  if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
  if (closeSettings) closeSettings.addEventListener('click', closeSettingsFn);
  if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) closeSettingsFn(); });

  if (toggleDark) toggleDark.addEventListener('click', () => {
    const isDark = toggleDark.classList.toggle('on');
    toggleDark.setAttribute('aria-checked', String(isDark));
    html.dataset.theme = isDark ? 'dark' : 'light';
    localStorage.setItem('sk_theme', isDark ? 'dark' : 'light');
    hapticTap();
  });

  if (togglePush) togglePush.addEventListener('click', () => {
    const on = togglePush.classList.toggle('on');
    togglePush.setAttribute('aria-checked', String(on));
    hapticTap();
  });

  if (toggleAlarm) toggleAlarm.addEventListener('click', () => {
    const on = toggleAlarm.classList.toggle('on');
    toggleAlarm.setAttribute('aria-checked', String(on));
    state.soundOn = on;
    const sndBtn = document.getElementById('btn-sound');
    if (sndBtn) sndBtn.textContent = on ? '🔊' : '🔇';
    hapticTap();
  });

  fontOpts.forEach(btn => btn.addEventListener('click', () => {
    fontOpts.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    html.dataset.font = btn.dataset.size;
    localStorage.setItem('sk_font', btn.dataset.size);
    hapticTap();
  }));

  if (btnChangePos) btnChangePos.addEventListener('click', () => {
    closeSettingsFn();
    showManualPosModal('Ubah koordinat posisi Anda:');
  });
}

// ════════════════════════════════════════════════════════
// WEATHER CARD (Open-Meteo — no API key needed)
// ════════════════════════════════════════════════════════
async function loadWeather() {
  const iconEl = document.getElementById('weather-icon');
  const tempEl = document.getElementById('weather-temp');
  const descEl = document.getElementById('weather-desc');
  const locEl  = document.getElementById('weather-loc');
  const windEl = document.getElementById('weather-wind-val');
  if (!iconEl || !tempEl) return;

  const pos = state.userPos;
  if (!pos) {
    descEl.textContent = 'Izinkan lokasi untuk lihat cuaca';
    return;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${pos.lat}&longitude=${pos.lng}` +
      `&current_weather=true&timezone=auto`;
    const res = await fetch(url);
    const data = await res.json();
    const cw = data.current_weather;
    if (!cw) return;

    const WMO = {
      0:['☀️','Cerah'],1:['🌤️','Kebanaran'],2:['⛅','Berawan'],3:['☁️','Mendung'],
      45:['🌫️','Kabut'],48:['🌫️','Kabut Es'],51:['🌦️','Gerimis'],53:['🌦️','Gerimis'],
      55:['🌧️','Hujan Gerimis'],61:['🌧️','Hujan Ringan'],63:['🌧️','Hujan'],
      65:['🌧️','Hujan Lebat'],71:['🌨️','Salju Ringan'],73:['🌨️','Salju'],
      75:['❄️','Salju Lebat'],80:['🌦️','Hujan Ringan'],81:['🌧️','Hujan'],
      82:['⛈️','Hujan Badai'],95:['⛈️','Badai Petir'],96:['⛈️','Badai+Es'],99:['⛈️','Badai+Es']
    };
    const [emoji, label] = WMO[cw.weathercode] || ['🌡️','Cuaca'];
    iconEl.textContent = emoji;
    tempEl.textContent = `${Math.round(cw.temperature)}°C`;
    descEl.textContent = label;
    windEl.textContent = `${Math.round(cw.windspeed)} km/j`;

    // Reverse geocode for location name
    if (locEl) {
      try {
        const geoRes = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${pos.lat}&longitude=${pos.lng}&localityLanguage=id`);
        const geo = await geoRes.json();
        locEl.textContent = geo.city || geo.locality || geo.principalSubdivision || '';
      } catch {}
    }
  } catch(e) {
    descEl.textContent = 'Gagal memuat cuaca';
  }
}

// Call loadWeather after position is acquired
const _origSetUserPos = window._setUserPos;
function patchLoadWeather() {
  const origFetch = window.fetch;
  // Simple approach: call loadWeather when userPos is set
  const observer = new MutationObserver(() => {
    if (state.userPos) loadWeather();
  });
  // Just call it periodically and on tab switch
  setInterval(() => { if (state.userPos) loadWeather(); }, 60000);
}

// ════════════════════════════════════════════════════════
// HAZARD FILTER CHIPS
// ════════════════════════════════════════════════════════
function initHazardChips() {
  const chips = document.querySelectorAll('#hazard-chips .chip');
  let activeFilter = 'all';

  chips.forEach(chip => chip.addEventListener('click', () => {
    hapticTap();
    chips.forEach(c => c.classList.remove('chip-active'));
    chip.classList.add('chip-active');
    activeFilter = chip.dataset.hazard;
    filterDisasters(activeFilter);
  }));
}

function filterDisasters(hazard) {
  const list = document.getElementById('disaster-list');
  if (!list) return;
  const cards = list.querySelectorAll('.card');
  cards.forEach(card => {
    if (hazard === 'all') { card.style.display = ''; return; }
    const text = (card.textContent || '').toLowerCase();
    const match = text.includes(hazard);
    card.style.display = match ? '' : 'none';
  });
}

// ════════════════════════════════════════════════════════
// AI CHAT PANEL
// ════════════════════════════════════════════════════════
const CHAT_RESPONSES = [
  { keywords: ['gempa', 'getar', 'quake'], reply:
    '🌍 Saat gempa terjadi:\n\n1. **Tetap tenang** — jangan panik\n2. **Beri perlindungan di bawah meja** yang kokoh\n3. **Jauhi jendela** dan benda-benda tinggi\n4. Setelah berhenti, **periksa kerusakan** sekitar\n5. Jika di luar, **jauhi bangunan** dan tiang listrik\n\n💡 Tips: Simpan nomor darurat 112 di ponsel Anda.' },
  { keywords: ['tsunami', 'gelombang', 'laut', 'pantai'], reply:
    '🌊 Peringatan Tsunami:\n\n1. **Segera pergi ke tempat tinggi** (min. 30m dari permukaan laut)\n2. **Jangan menunggu** instruksi resmi jika merasakan gempa kuat >20 detik\n3. **Jangan kembali ke pantai** sampai dinyatakan aman\n4. Ikuti jalur evakuasi yang ditandai\n\n⚠️ Waktu tiba: 5–30 menit setelah gempa. Bergerak SEKARANG.' },
  { keywords: ['banjir', 'air', 'flood', 'kebanjiran'], reply:
    '💧 Saat Banjir:\n\n1. **Pergi ke lantai atas** atau atap jika air naik\n2. **Matikan listrik** di panel utama jika aman\n3. **Jangan berjalan** di air mengalir >30cm — bisa terseret\n4. **Siapkan dokumen penting** dalam plastik kedap air\n5. Hubungi 112 jika terjebak\n\n💡 Cek tingkat air melalui aplikasi ini secara berkala.' },
  { keywords: ['tempat aman', 'shelter', 'berlindung', 'aman', 'hospital', 'rs', 'rumah sakit'], reply:
    '🏥 Cara menemukan tempat aman terdekat:\n\n1. Buka tab **"Aman"** di aplikasi ini\n2. Pilih jenis tempat yang Anda butuhkan\n3. Aplikasi akan menampilkan jarak & arah\n4. Tekan **⭐** untuk menyimpan sebagai favorit\n\n💡 Saran: Simpan minimal 2 tempat aman sebagai favorit sebelum bencana terjadi.' },
  { keywords: ['keluarga', 'sharing', 'sms', 'whatsapp', 'hubungi'], reply:
    '👥 Berbagi Posisi dengan Keluarga:\n\n1. Buka tab **"Keluarga"**\n2. Tambahkan anggota beserta nomor HP mereka\n3. Saat darurat, tekan tombol **SMS/WA** pada kartu mereka\n4. Posisi Anda otomatis terlampir\n\n💡 Tips: Lakukan "check-in" keluarga setiap hari saat keadaan normal.' },
  { keywords: ['evakuasi', 'rute', 'jalur', 'route', 'nav'], reply:
    '🚨 Jalur Evakuasi:\n\n1. Ketahui **minimal 2 jalur evakuasi** dari rumah Anda\n2. Ikuti tanda panah hijau di jalan\n3. **Jangan menggunakan lift** saat gempa\n4. Bawa tas siaga: air, obat, dokumen, senter\n5. Titik kumpul keluarga harus ditentukan sebelumnya\n\n💡 Gunakan tab "Peta" → "Mulai Evakuasi" untuk rute optimal via OSRM.' },
  { keywords: ['tas siaga', 'emergency kit', 'persiapan', 'siaga'], reply:
    '🎒 Isi Tas Siaga Darurat:\n\n• Air minum (min. 2L/orang/hari × 3 hari)\n• Makanan kaleng / biskuit\n• Obat-obatan pribadi\n• Senter + baterai cadangan\n• Radio portabel\n• Salinan dokumen (KTP, KK, asuransi)\n• Uang tunai kecil\n• P3K dasar\n• Power bank\n• Peluit (untuk sinyal)' },
  { keywords: ['nomor', 'darurat', '112', 'bpbd', 'telepon', 'call'], reply:
    '📞 Nomor Darurat Indonesia:\n\n• **112** — Layanan Darurat Nasional\n• **110** — Polisi\n• **113** — Pemadam Kebakaran\n• **119** — Ambulans / Kesehatan\n• **BPBD Kota/Kab** — cek website lokal\n\n💡 Simpan semua nomor ini di kontak ponsel Anda sekarang.' },
  { keywords: ['cuaca', 'weather', 'hujan', 'suhu', 'temperature'], reply:
    '🌤️ Informasi Cuaca:\n\nBuka tab **"Bencana"** untuk melihat kartu cuaca real-time di lokasi Anda.\n\nData berasal dari Open-Meteo API — mencakup suhu, kondisi, dan kecepatan angin.\n\n⚠️ Waspadai hujan lebat berkepanjangan yang dapat memicu banjir atau longsor.' },
];

const DEFAULT_CHAT_REPLY =
  'Saya asisten keselamatan SelamatKu. 🛡️\n\nSaya bisa membantu dengan:\n• 🌍 Tips keselamatan gempa\n• 🌊 Peringatan tsunami\n• 💧 Kesiapsiagaan banjir\n• 🏥 Menemukan tempat aman\n• 👥 Berbagi posisi keluarga\n• 🚨 Jalur evakuasi\n• 📞 Nomor darurat\n\nSilakan tanyakan apa saja!';

function initChatPanel() {
  const fab         = document.getElementById('btn-open-chat');
  const panel       = document.getElementById('chat-panel');
  const closeBtn    = document.getElementById('btn-close-chat');
  const input       = document.getElementById('chat-input');
  const sendBtn     = document.getElementById('btn-send-chat');
  const messages    = document.getElementById('chat-messages');
  const suggestions = document.getElementById('chat-suggestions');
  const aiBadge     = document.getElementById('ai-badge');
  const apiKeyRow   = document.getElementById('api-key-row');
  const msKeyInput  = document.getElementById('ms-api-key-input');
  const btnSaveKey  = document.getElementById('btn-save-ms-key');

  if (!fab || !panel) return;

  // Update badge based on API key presence
  function updateAiBadge() {
    const hasKey = !!localStorage.getItem('ms_api_key');
    if (aiBadge) {
      aiBadge.textContent = hasKey ? 'Qwen AI' : 'Offline';
      aiBadge.classList.toggle('local', !hasKey);
    }
    if (apiKeyRow) apiKeyRow.classList.toggle('hidden', hasKey);
  }
  updateAiBadge();

  // Save API key handler
  if (btnSaveKey && msKeyInput) {
    btnSaveKey.addEventListener('click', () => {
      const val = msKeyInput.value.trim();
      if (val) {
        localStorage.setItem('ms_api_key', val);
        msKeyInput.value = '';
        updateAiBadge();
        hapticTap();
      }
    });
    msKeyInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') btnSaveKey.click();
    });
  }

  function openChat() {
    panel.classList.remove('hidden');
    fab.classList.add('hidden');
    updateAiBadge();
    setTimeout(() => input && input.focus(), 300);
    hapticTap();
  }
  function closeChat() {
    panel.classList.add('hidden');
    fab.classList.remove('hidden');
    hapticTap();
  }

  fab.addEventListener('click', openChat);
  if (closeBtn) closeBtn.addEventListener('click', closeChat);

  function addMsg(text, cls) {
    const div = document.createElement('div');
    div.className = `chat-msg ${cls}`;
    div.innerHTML = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  // ── ModelScope / DashScope Qwen integration ──────────────
  const MODELSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const MODELSCOPE_MODEL    = 'qwen-plus';

  const SYSTEM_PROMPT =
    'Kamu adalah SelamatKu Assistant — asisten keselamatan bencana berbahasa Indonesia yang ramah dan ringkas. ' +
    'Jawab dalam Bahasa Indonesia. Fokus pada: tips keselamatan gempa/tsunami/banjir/longsor, jalur evakuasi, ' +
    'nomor darurat Indonesia, persiapan tas siaga, dan penggunaan aplikasi SelamatKu. ' +
    'Jawab maksimal 5-7 baris kecuali diminta lebih detail. Gunakan emoji secukupnya.';

  let chatHistory = [];

  async function fetchModelScope(query) {
    const apiKey = localStorage.getItem('ms_api_key');
    if (!apiKey) return null;
    try {
      chatHistory.push({ role: 'user', content: query });
      // Keep last 10 messages to stay within token limit
      const msgs = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...chatHistory.slice(-10)
      ];
      const res = await fetch(`${MODELSCOPE_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: MODELSCOPE_MODEL,
          messages: msgs,
          max_tokens: 300,
          temperature: 0.7
        })
      });
      if (!res.ok) {
        console.warn('[ModelScope] API error:', res.status);
        return null;
      }
      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content;
      if (reply) {
        chatHistory.push({ role: 'assistant', content: reply });
        return reply;
      }
      return null;
    } catch(e) {
      console.warn('[ModelScope] fetch failed:', e.message);
      return null;
    }
  }

  function localReply(q) {
    const ql = q.toLowerCase();
    for (const r of CHAT_RESPONSES) {
      if (r.keywords.some(k => ql.includes(k))) return r.reply;
    }
    return DEFAULT_CHAT_REPLY;
  }

  async function handleSend() {
    const val = (input.value || '').trim();
    if (!val) return;
    addMsg(val, 'user');
    input.value = '';
    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.5';

    // Show typing indicator
    const typingEl = document.createElement('div');
    typingEl.className = 'chat-msg bot';
    typingEl.id = 'typing-indicator';
    typingEl.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
    messages.appendChild(typingEl);
    messages.scrollTop = messages.scrollHeight;

    const aiReply = await fetchModelScope(val);
    const finalReply = aiReply || localReply(val);

    typingEl.remove();
    addMsg(finalReply, 'bot');
    sendBtn.disabled = false;
    sendBtn.style.opacity = '1';
  }

  if (sendBtn) sendBtn.addEventListener('click', handleSend);
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') handleSend(); });

  if (suggestions) {
    suggestions.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        input.value = chip.dataset.q;
        handleSend();
      });
    });
  }

  // Show FAB after app loads
  setTimeout(() => fab.classList.remove('hidden'), 1500);
}
