/**
 * Vercel Serverless Function — AI Safety Analysis
 * POST /api/analyze-safety
 * Body: { images: [base64...], disasterType, isVideo?, context? }
 *       or { image: base64, disasterType } (legacy)
 * Returns: { riskLevel, summary, recommendations[], dangerZones[], confidence, source }
 *
 * Backends (priority):
 * 1. Cloudflare Workers AI (if CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID set)
 * 2. Rule-based fallback (always works)
 */

const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CF_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

// Rate limiter
const rateLimits = new Map();
function checkRateLimit(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const now = Date.now();
  if (!rateLimits.has(ip)) rateLimits.set(ip, []);
  const entries = rateLimits.get(ip).filter(t => now - t < 60000);
  if (entries.length >= 15) return false;
  entries.push(now);
  rateLimits.set(ip, entries);
  return true;
}

// ── RULE-BASED FALLBACK (contextual with location) ───────────
function ruleBasedAnalysis(disasterType, hasVisualContext, context) {
  const loc = context ? context.replace('Lokasi: ', '') : '';
  const isVideo = hasVisualContext;

  const rules = {
    gempa: {
      riskLevel: 'danger',
      summary: isVideo
        ? `Dari rekaman lingkungan Anda${loc ? ' (' + loc + ')' : ''}: identifikasi struktur terlindung terdekat dan ambil posisi Drop-Cover-Hold SEKARANG.`
        : `Gempa aktif${loc ? ' di area ' + loc : ''}. Ambil posisi melindungi diri segera.`,
      recommendations: [
        { action: 'DROP: Turunkan tubuh ke posisi merangkak/berlutut — JANGAN berdiri', location: 'Tanpa bergerak dari posisi Anda', priority: 1 },
        { action: 'COVER: Selipkan diri di bawah meja/kursi terkuat yang Anda lihat di depan/samping Anda. Pegang kaki meja erat-erat', location: 'Meja/kursi terdekat (radius 1-2m dari Anda)', priority: 1 },
        { action: 'JAUHI: Pindah minimal 2m menjauh dari jendela kaca, lemari >1.5m, lampu gantung, rak buku', location: 'Ke area dinding dalam (tanpa jendela) atau kolom beton', priority: 1 },
        { action: 'HOLD: Berpegangan pada struktur sampai goncangan berhenti total (bisa 30-90 detik). Jangan keluar selama masih bergoncang', location: 'Posisi berlindung Anda', priority: 2 },
        { action: 'SETELAH AMAN: Matikan gas/listrik jika bisa, keluar via tangga (JANGAN lift), kumpul di area terbuka 50m dari bangunan', location: 'Titik kumpul: lapangan/ruang terbuka terdekat (radius 50km: cari open space)', priority: 3 }
      ],
      dangerZones: [
        'Jendela & partisi kaca — risiko pecah & potong',
        'Lemari/rak >1.5m — risiko roboh menimpa',
        'Lampu gantung & plafon — risiko jatuh',
        'D bata ringan/plafon gypsum — risiko runtuh',
        'Kolom/struktur retak — indikasi kerusakan'
      ],
      nearestSafety: loc
        ? `Cari titik kumpul/open space terdekat dari ${loc}. Dalam radius 50km: lapangan olahraga, alun-alun, parkiran luas tanpa gedung di sekeliling.`
        : 'Area terbuka minimal 50m dari bangunan tertinggi di sekitar Anda.',
      confidence: isVideo ? 0.75 : 0.6
    },
    tsunami: {
      riskLevel: 'danger',
      summary: `ALERT TSUNAMI${loc ? ' — posisi Anda: ' + loc : ''}. Waktu evakuasi: 15-30 menit. Bergerak SEKARANG.`,
      recommendations: [
        { action: 'NAIK: Langsung menuju tempat dengan elevasi >15m dari permukaan laut ATAU jarak >30m horizontal dari pantai. Jika di gedung: naik ke lantai tertinggi', location: 'Bukit/bangunan tinggi/gedung bertingkat TERDEKAT dari posisi Anda', priority: 1 },
        { action: 'JARAK: Jauhi SEMUA area air — pantai, sungai, muara, drainase besar. Air bisa datang dari arah mana saja', location: 'Arah JAUH dari garis pantai/sungai (vertical evacuation preferred)', priority: 1 },
        { action: 'CEPAT: Jalan kaki > kendaraan (lalu lintas pasti macet/panik). Ikuti tanda panah evakuasi tsunami jika ada', location: 'Jalur evakuasi vertikal terdekat (biasanya ke atas/bukit)', priority: 2 },
        { action: 'MINIMAL: Bawa hanya HP + dompet. Jangan buang waktu mengumpulkan barang. Maks 60 detik persiapan', location: 'Ambil dari saku/meja dekat Anda', priority: 3 }
      ],
      dangerZones: [
        'Garis pantai & area <30m dari air',
        'Sungai, muara, kanal (air naik dari hulu)',
        'Area cekungan/rendah (banjir bandang)',
        'Jembatan & jalan dekat air (runtuh/dibawa arus)',
        'Batu karang/tebing pantai (slump saat gelombang)'
      ],
      nearestSafety: loc
        ? `Dari ${loc}, cari: (1) Bukit/gunung terdekat, (2) Gedung >5 lantai, (3) Tangga evakuasi tsunami. Radius 50km: identifikasi elevated road atau perbukitan.`
        : 'Tempat tinggi terdekat: bukit, gedung tinggi (>5 lantai), atau tangga evakuasi bertanda.',
      confidence: 0.8
    },
    banjir: {
      riskLevel: 'caution',
      summary: `Potensi banjir${loc ? ' di area ' + loc : ''}. Ketinggian air bisa naik 30-60cm/jam. Naik sekarang sebelum terlambat.`,
      recommendations: [
        { action: 'NAIK: Pindah ke lantai 2+ atau atap. Jika di ruko: stok barang di lantai atas dulu (10 menit)', location: 'Lantai atas bangunan Anda / tangga ke rooftop', priority: 1 },
        { action: 'MATIKAN: Cabut semua stopkontak, matikan MCB utama. Listrik + air = kematian', location: 'Panel listrik (biasal di dekat pintu masuk/lantai 1)', priority: 1 },
        { action: 'HINDARI: JANGAN lewat genangan >30cm. Arus 15cm sudah bisa membalik motor, 30cm membalik mobil', location: 'Semua jalan/area tergenang — cari rute kering', priority: 2 },
        { action: 'SIAPKAN: Tas berisi obat, air mineral x2, powerbank, dokumen foto di HP, senter', location: 'Letakkan di samping pintu keluar lantai atas', priority: 3 }
      ],
      dangerZones: [
        'Genangan >15cm — arus bawah tidak terlihat',
        'Kolam listrik, trafo, kabel putus',
        'Balkon/terras lantai 1 (air langsung masuk)',
        'Bawah jembatan (air terkonsentrasi)',
        'Area tanah urugan (longsor saat jenuh)'
      ],
      nearestSafety: loc
        ? `Dari ${loc}: cari bangunan >2 lantai dalam radius 200m. Alternatif 50km: area perbukitan atau gedung perkantoran tinggi.`
        : 'Bangunan bertingkat terdekat (minimal 2 lantai) atau area elevated.',
      confidence: 0.7
    },
    angin: {
      riskLevel: 'caution',
      summary: `Angin kencang/badai${loc ? ' di ' + loc : ''}. Risiko: benda terbang, kaca pecah, pohon tumbang. Masuk ke interior sekarang.`,
      recommendations: [
        { action: 'MASUK: Langsung ke ruangan paling dalam (tanpa jendela/pintu kaca). Lorong, kamar mandi, atau ruang tanpa kaca', location: 'Ruangan interior terdalam dari sisi angin', priority: 1 },
        { action: 'TURUNKAN: Tutup semua jendela/pintu. Tarik tirai tebal sebagai lapisan tambahan anti pecah', location: 'Semua jendela yang masih terbuka', priority: 1 },
        { action: 'RENDAH: Jika tidak bisa ke interior: berbaring prone (face down) di parit/turunan, lindungi kepala dengan lengan + tas', location: 'Area rendah terlindung dari arah angin', priority: 2 },
        { action: 'JAUHI: Pohon besar, tiang listrik, reklame, spanduk, bangunan seng/prefab — semua bisa jadi peluru', location: 'Minimal 10m dari objek tersebut', priority: 3 }
      ],
      dangerZones: [
        'Jendela & kaca (pecah → pecahan proyektil)',
        'Papan reklame & spanduk (terbang)',
        'Pohon besar (cabang patah/tumbang)',
        'Atap seng/prefab (terangkat)',
        'Tiang listrik & kabel (jatuh → listrik)'
      ],
      nearestSafety: loc
        ? `Dari ${loc}: basement, bunker, atau ruangan interior gedung terdekat. Outdoor: parit/median jalan sebagai shelter sementara.`
        : 'Interior bangunan tanpa kaca, atau area terlindung (di balik tembok beton).',
      confidence: 0.7
    },
    umum: {
      riskLevel: 'caution',
      summary: `Kondisi darurat terdeteksi${loc ? ' di ' + loc : ''}. Tetap tenang, amati, dan bergerak ke tempat aman.`,
      recommendations: [
        { action: 'AMATI: 5 detik — lihat ke segala arah. Identifikasi: apa bahayanya? Dari arah mana? Ada jalur keluar?', location: 'Posisi Anda sekarang', priority: 1 },
        { action: 'GERAK: Arahkan diri ke pintu keluar/exit TERDEKAT. Jauhi sumber bahaya (jarak >5m)', location: 'Jalur keluar terdekat (bukan lift)', priority: 1 },
        { action: 'LINDUNGI: Kepala selalu dilindungi (tangan, tas, benda keras di atas kepala)', location: 'Selama bergerak', priority: 2 },
        { action: 'KUMPUL: Setelah di area aman, hubungi keluarga/kontak darurat. Laporkan kondisi', location: 'Titik kumpul / area terbuka', priority: 3 }
      ],
      dangerZones: ['Sumber bahaya utama (identifikasi visual)', 'Jalur sempit/sumpek', 'Benda yang bisa jatuh'],
      nearestSafety: 'Area terbuka tanpa struktur overhead, minimal 20m dari sumber bahaya.',
      confidence: 0.5
    }
  };

  const result = { ...(rules[disasterType] || rules.umum) };
  // Add video context if applicable
  if (isVideo) {
    result.summary = `[Analisis video lingkungan] ` + result.summary;
  }
  return result;
}

// ── CLOUDFLARE WORKERS AI VISION ──────────────────────────────
async function cloudflareVision(images, disasterType, context) {
  // Use first image for analysis
  const imageData = images[0];
  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');

  const isVideo = images.length > 1;
  const locationInfo = context || 'Lokasi tidak diketahui';

  const prompt = `Kamu analis keselamatan darurat. Lihat gambar ini PERHATI dan deskripsikan SETIAP objek yang terlihat SEBELUM memberikan rekomendasi.

JENIS BENCANA: ${disasterType.toUpperCase()}
LOKASI PENGGUNA: ${locationInfo}
RADIUS ANALISIS: 50 km dari posisi pengguna
${isVideo ? `MODE: Video ${images.length} detik (lingkungan sekitar pengguna, arahkan kamera ke berbagai arah)` : 'MODE: Foto sekali'}

LANGKAH ANALISIS (ikuti urut):
1. DAFTARKAN semua objek besar yang terlihat (meja, kursi, jendela, pintu, lemari, tiang, dinding, lantai, langit, bangunan, pohon, jalan, dll) — sebutkan POSISI relatifnya (depan, kiri, kanan, atas, jauh dekat)
2. IDENTIFIKASI bahaya spesifik berdasarkan jenis bencana + objek yang ada
3. BERIKAN rekomendasi yang MERUJUK objek spesifik yang kamu lihat (bukan generic)

CONTOH SPESIFIK (bukan template):
- JANGAN: "Cari tempat berlindung"
- TAPI: "Bersembunyi di bawah meja kayu cokelat di depan Anda (sekitar 1m jarak)"
- JANGAN: "Jauhi jendela"
- TAPI: "Pindah 2m ke kanan, menjauh dari jendela kaca besar di sisi kiri ruangan"
- JANGAN: "Cari tempat tinggi"
- TAPI: "Naik ke lantai 2 melalui tangga besi di sudut kanan belakang"

Balas HANYA JSON valid (tanpa markdown):
{
  "objectsSeen": ["objek1 di posisi X", "objek2 di posisi Y", ...],
  "riskLevel": "safe|caution|danger",
  "summary": "Deskripsi 1-2 kalimat: kondisi lingkungan + risiko utama berdasarkan objek spesifik",
  "recommendations": [
    {"action": "Tindakan spesifik merujuk objek di gambar", "location": "Posisi persis relatif terhadap pengguna", "priority": 1},
    {"action": "...", "location": "...", "priority": 2}
  ],
  "dangerZones": ["Bahaya spesifik + posisi: 'Jendela kaca 2x1m di sisi kiri — risiko pecah'", ...],
  "nearestSafety": "Deskripsi tempat aman terdekat dalam radius pandangan atau 50km (misal: 'Gedung 3 lantai di selatan ~2km' atau 'Meja beton di tengah ruangan')",
  "confidence": 0.85
}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${CF_MODEL}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } },
            { type: 'text', text: prompt }
          ]}
        ],
        max_tokens: 1024,
        temperature: 0.3
      }),
      signal: controller.signal
    }
  );

  clearTimeout(timeout);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Cloudflare AI ${resp.status}: ${errText.substring(0, 150)}`);
  }

  const data = await resp.json();
  const text = data.result?.response || data.response || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response: ' + text.substring(0, 100));
  return JSON.parse(jsonMatch[0]);
}

// ── HANDLER ───────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!checkRateLimit(req)) {
    return res.status(429).json({ error: 'Terlalu banyak permintaan. Tunggu 1 menit.' });
  }

  const { images, image, disasterType, isVideo, context } = req.body || {};

  // Support both old (image) and new (images array) format
  let frames = [];
  if (Array.isArray(images)) frames = images;
  else if (image) frames = [image];

  if (!disasterType) return res.status(400).json({ error: 'disasterType is required' });

  let result;
  let usedAI = false;

  // Try Cloudflare Workers AI if configured
  const hasCF = CF_TOKEN && CF_ACCOUNT;

  if (frames.length > 0 && hasCF) {
    try {
      console.log(`[API] Cloudflare Vision: ${frames.length} frame(s), type=${disasterType}`);
      result = await cloudflareVision(frames, disasterType, context);
      usedAI = true;
      console.log('[API] CF success:', result.riskLevel);
    } catch (err) {
      console.warn('[API] CF failed:', err.message);
    }
  }

  // Fallback: rule-based (with location context)
  if (!result) {
    result = ruleBasedAnalysis(disasterType, frames.length > 0, context);
  }

  // Ensure structure
  if (!result.riskLevel) result.riskLevel = 'caution';
  if (!Array.isArray(result.recommendations)) result.recommendations = [];
  if (!Array.isArray(result.dangerZones)) result.dangerZones = [];
  if (result.confidence == null) result.confidence = 0.5;
  result.source = usedAI ? 'cloudflare-ai' : 'rule-based';
  result.framesAnalyzed = frames.length;

  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(result);
}

export const config = { maxDuration: 35 };
