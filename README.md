# 🛡️ SelamatKu — Deteksi & Evakuasi Bencana

Aplikasi untuk mendeteksi bencana di sekitar Anda, memberikan jalur evakuasi terbaik, dan menemukan tempat berlindung terdekat. Tersedia sebagai **Web App (PWA)** dan **APK Android**.

## ✨ Fitur

### Core
| Fitur | Keterangan |
|---|---|
| 🌍 Deteksi gempa real-time | BMKG (utama) + USGS (fallback) |
| 🌊 Peringatan tsunami | Otomatis dari data gempa M≥6 |
| 🗺️ Peta interaktif | Leaflet + OpenStreetMap (dark tiles) |
| 🏥 Tempat berlindung terdekat | Overpass API — RS, sekolah, masjid, dll (radius 3 km) |
| 🧭 Jalur evakuasi jalan kaki | OSRM Routing Engine |
| 📍 Tracking posisi live | Geolocation API |
| 🔊 Alarm bunyi + haptic | Web Audio API + navigator.vibrate() |

### Mobile PWA
| Fitur | Keterangan |
|---|---|
| 📲 Installable | Web App Manifest + icons (192/512/maskable) |
| 📡 Offline mode | Service Worker cache app shell + data terakhir |
| 🔔 Push notification | Notifikasi browser saat gempa M≥5 |
| ⭐ Favorit & riwayat | localStorage — simpan shelter favorit + log evakuasi |
| 👥 Family sharing | Bagikan posisi ke keluarga via SMS / WhatsApp |
| 🔒 Screen Wake Lock | Layar tetap menyala saat navigasi aktif |
| 📱 Safe area insets | Support iPhone notch & Android gesture nav |
| 👇 Bottom navigation | Thumb-friendly, 6 tab |
| ↻ Pull to refresh | Tarik ke bawah untuk refresh data |

## 🚀 Cara Menjalankan

### Opsi A — Web App (PWA)
```bash
cd C:\Users\Administrator\disaster-app
npx serve . -p 3000
```
Buka **http://localhost:3000**

### Opsi B — APK Android
```bash
# Jalankan build script (butuh JDK 17 + Android SDK)
build-apk.bat
```
APK hasil build: `SelamatKu-v1.0-debug.apk`

Install di HP: transfer file → buka di HP → izinkan "Install unknown apps" → Install.

> ⚠️ Geolocation & Notification hanya aktif di `https://` atau `localhost` (untuk web app).

## 📲 Install di HP

### Android (Chrome)
1. Buka URL di Chrome
2. Menu ⋮ → **"Install app"** / **"Tambahkan ke layar utama"**
3. Ikon muncul di home screen

### iOS (Safari)
1. Buka URL di Safari
2. Tombol Share (kotak dengan panah) → **"Tambahkan ke Layar Beranda"**
3. Ikon muncul di home screen

## 📁 Struktur File

```
disaster-app/
├── index.html           # UI: 6 tab, bottom nav, modals, overlays
├── style.css            # Styling mobile-first, safe areas, animations
├── app.js               # Logika: map, data, routing, notifications, storage
├── service-worker.js    # Cache strategy: static, API, map tiles
├── manifest.json        # PWA manifest + shortcuts
├── generate-icons.js    # Script generator ikon PWA
├── build-apk.bat        # Build script untuk APK Android
├── SelamatKu-v1.0-debug.apk  # Hasil build APK
├── icons/
│   ├── icon-192.png     # Ikon standar 192x192
│   ├── icon-512.png     # Ikon standar 512x512
│   ├── maskable-192.png # Maskable (Android adaptive)
│   └── maskable-512.png # Maskable (Android adaptive)
├── android/             # Proyek Android (WebView wrapper)
│   ├── build.gradle
│   ├── settings.gradle
│   ├── gradlew.bat
│   ├── do_build.bat
│   └── app/
│       ├── build.gradle
│       └── src/main/
│           ├── AndroidManifest.xml
│           ├── java/com/selamatku/app/
│           │   ├── MainActivity.java   # WebView + permissions
│           │   └── AssetServer.java    # Local HTTP server (NanoHTTPD)
│           ├── res/                    # Icons, styles, layout
│           └── assets/                 # Web app files (auto-synced)
└── README.md
```

## 🔌 API yang Digunakan

Semua API publik & gratis — tidak perlu API key.

| API | Endpoint | Fungsi |
|---|---|---|
| BMKG | `data.bmkg.go.id` | Data gempa Indonesia (real-time) |
| USGS | `earthquake.usgs.gov` | Fallback data gempa global |
| Overpass | `overpass-api.de` | Data OSM: RS, sekolah, masjid, dll |
| OSRM | `router.project-osrm.org` | Routing jalan kaki |
| CARTO | `basemaps.cartocdn.com` | Tile peta dark theme |

## 🏗️ Arsitektur Service Worker

```
Request masuk
     │
     ├─ Static asset (.html/.css/.js/.png)
     │   → CACHE-FIRST: cek cache → fallback network → update cache
     │
     ├─ API call (BMKG/USGS/Overpass/OSRM)
     │   → NETWORK-FIRST: coba network → fallback cached response
     │   → Tambah header x-selamatku-stale jika dari cache
     │
     └─ Map tiles (CARTO/OSM)
         → RUNTIME CACHE: cache-first, limit ~5000 tiles (~50MB)
```

## 📱 Alur Penggunaan

```
1. Izinkan lokasi + notifikasi
2. Tab "Peta" → lihat posisi & tempat aman
3. Tab "Bencana" → cek gempa terkini
4. Tab "Aman" → pilih shelter → ⭐ favorit → 🧭 Rute
5. Tab "Keluarga" → tambah anggota → bagikan posisi via SMS/WA
6. Tab "Riwayat" → lihat favorit & log evakuasi
7. Tab "Info" → tips kesiapsiagaan & cara install
```

## ⚠️ Disclaimer

Aplikasi ini bersifat **informasional**. Selalu ikuti instruksi resmi BPBD dan otoritas setempat.

## 📄 Lisensi

MIT — bebas digunakan untuk keperluan pendidikan dan kemanusiaan.
