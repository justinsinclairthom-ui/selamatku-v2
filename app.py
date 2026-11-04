"""
SelamatKu — Disaster Detection & Evacuation App
Entry point for ModelScope Studio deployment.

ModelScope Spaces run a Gradio app (app.py -> demo.launch()). The whole PWA is
rendered inside a single gr.HTML() block.

IMPORTANT — how Gradio 6.x executes HTML/JS (verified empirically):
  * A <script> tag placed INSIDE gr.HTML content is inserted via innerHTML and
    therefore is NEVER executed by the browser. This was the root cause of
    "everything errors / map missing". CSS in an inline <style> DOES work.
  * External libraries must be loaded through the `head=` parameter.
  * Application code must go through the `js_on_load=` parameter, which runs
    when the component renders (after the DOM exists).
  * Custom API routes registered on `demo.app` BEFORE launch are discarded,
    because Gradio swaps the FastAPI app object during launch(). They MUST be
    registered AFTER launch().

So the split is:
  - Leaflet CSS/JS ....... -> head=   (external CDN)
  - style.css ............ -> inline <style> in the HTML body
  - index.html markup .... -> gr.HTML value
  - app.js ............... -> js_on_load=
  - POST /api/analyze-safety -> registered on demo.app after launch()

AI safety scanning works three ways, in priority order (all client-side first):
  1. Qwen-VL-Plus called straight from the browser when the user saves an API
     key in Settings (localStorage 'ms_api_key').
  2. POST /api/analyze-safety (registered below) when reachable — uses the
     DASHSCOPE_API_KEY / MS_API_KEY env vars or a key sent by the client.
  3. A built-in rule-based analysis that always works offline.
"""

import os
import re
import json
import urllib.request
from fastapi import Request
from fastapi.responses import JSONResponse

import gradio as gr

# ── Paths ──────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _read(filename: str, default: str = "") -> str:
    path = os.path.join(BASE_DIR, filename)
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    return default


# ── Load the PWA assets once at import time ────────────────────
HTML_TEMPLATE = _read("index.html")
CSS_CONTENT   = _read("style.css")
JS_CONTENT    = _read("app.js")


# Strip Gradio's own page chrome so our full-screen app fills the viewport.
# Appended to the inline <style> by build_page_html() so it is guaranteed to load.
#
# .sk-pwa must be a FLEX COLUMN root with full viewport height: style.css lays
# out the app as body(flex column) > #main-content(flex:1) > .tab-panel(100%)
# > #map(100%). In the standalone PWA that root is <body>; here it is .sk-pwa.
# If .sk-pwa were display:block, #main-content{flex:1} has no flex parent and
# the whole height chain collapses -> the Leaflet map renders at 0px (invisible).
FULLSCREEN_CSS = """
    html, body { height: 100%; margin: 0; background: var(--clr-bg, #f4f6fb); }
    .gradio-container { max-width: 100% !important; width: 100% !important; }
    #component-0 { width: 100%; margin: 0; padding: 0; }
    .sk-pwa {
        width: 100vw;
        height: 100vh;
        overflow: hidden;
        border: none;
        display: flex;
        flex-direction: column;
        position: relative;
    }
    /* Map tab needs an explicit height since it is not scrollable like others */
    .sk-pwa #tab-map.active { height: 100%; overflow: hidden; }
"""


def build_page_html() -> str:
    """Return ONLY the fragment that belongs inside gr.HTML.

    CRITICAL: gr.HTML injects its value via innerHTML into Gradio's own page.
    If we hand it a FULL document (<!DOCTYPE><html><head>…</head><body>…), the
    browser sees nested <html>/<head> tags and DROPS the inner <head> — so the
    inline <style> never applies (UI looks broken) and structure collapses
    (map disappears). We must return just:  <style>…css…</style> + body markup.
    """
    html = HTML_TEMPLATE

    # Inline style.css into a <style> block where the <link> was.
    for tag in ('<link rel="stylesheet" href="style.css?v=5" />',
                '<link rel="stylesheet" href="style.css" />'):
        html = html.replace(tag, "<style>\n" + CSS_CONTENT + "\n</style>")

    # Remove external <script src> tags — not executed in gr.HTML body.
    # Leaflet JS comes via head=; app.js via js_on_load=.
    html = re.sub(r'<script[^>]*src="[^"]*"\s*></script>', "", html)

    # Hide the manifest link (not served on ModelScope; avoids a 404).
    html = re.sub(r'<link[^>]*rel="manifest"[^>]*/?>', "", html)

    # Extract the inline <style> block(s) so we can place them at the top of the
    # fragment (they currently sit where the <head> used to be), and add our
    # Gradio fullscreen overrides so they are guaranteed to load.
    styles = re.findall(r"<style>[\s\S]*?</style>", html)
    css_block = "\n".join(styles) if styles else ""
    css_block += "\n<style>\n" + FULLSCREEN_CSS + "\n</style>"

    # Keep only the contents between <body ...> and </body>.
    m = re.search(r"<body[^>]*>([\s\S]*?)</body>", html)
    body_inner = m.group(1) if m else html

    return css_block + "\n" + body_inner.strip()


PAGE_HTML = build_page_html() if HTML_TEMPLATE else (
    "<h1>SelamatKu</h1><p>index.html tidak ditemukan.</p>"
)


def build_js_on_load() -> str:
    """Make app.js boot correctly under Gradio WITHOUT modifying its body.

    app.js starts up inside `document.addEventListener('DOMContentLoaded', ...)`.
    When injected via js_on_load the document has usually ALREADY finished
    loading, so that event never fires and nothing initialises.

    Rather than surgically edit the 97 KB file (fragile), we prepend a tiny
    shim that patches Document.prototype.addEventListener: any
    'DOMContentLoaded' listener registered after the doc is already loaded is
    invoked immediately. app.js itself stays byte-for-byte unchanged.
    """
    shim = (
        "(function(){\n"
        "  try{\n"
        "    var origAdd = Document.prototype.addEventListener;\n"
        "    Document.prototype.addEventListener = function(type, fn, opts){\n"
        "      if (type === 'DOMContentLoaded' && this === document &&\n"
        "          document.readyState !== 'loading') {\n"
        "        // Doc already loaded: fire the handler now (next tick).\n"
        "        Promise.resolve().then(function(){ fn({ type: type }); });\n"
        "        return;\n"
        "      }\n"
        "      return origAdd.call(this, type, fn, opts);\n"
        "    };\n"
        "  }catch(e){}\n"
        "})();"
    )
    return shim + "\n\n" + JS_CONTENT


JS_ON_LOAD = build_js_on_load() if JS_CONTENT else ""

# Leaflet from CDN. Loaded (and parsed) before js_on_load runs.
HEAD_HTML = (
    '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css" />'
    '<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"></script>'
)

# ── Rule-based analysis (mirrors the frontend fallback logic) ──
def rule_based_analysis(disaster_type: str, has_visual_context: bool, context: str) -> dict:
    loc = context.replace("Lokasi: ", "") if context else ""
    is_video = has_visual_context

    rules = {
        "gempa": {
            "riskLevel": "danger",
            "summary": (f"Dari rekaman lingkungan Anda ({loc}): identifikasi struktur terlindung terdekat dan ambil posisi Drop-Cover-Hold SEKARANG."
                        if is_video else
                        f"Gempa aktif{' di area ' + loc if loc else ''}. Ambil posisi melindungi diri segera."),
            "recommendations": [
                {"action": "DROP: Turunkan tubuh ke posisi merangkak/berlutut — JANGAN berdiri", "location": "Tanpa bergerak dari posisi Anda", "priority": 1},
                {"action": "COVER: Selipkan diri di bawah meja/kursi terkuat yang Anda lihat di depan/samping Anda. Pegang kaki meja erat-erat", "location": "Meja/kursi terdekat (radius 1-2m dari Anda)", "priority": 1},
                {"action": "JAUHI: Pindah minimal 2m menjauh dari jendela kaca, lemari >1.5m, lampu gantung, rak buku", "location": "Ke area dinding dalam (tanpa jendela) atau kolom beton", "priority": 1},
                {"action": "HOLD: Berpegangan pada struktur sampai goncangan berhenti total (bisa 30-90 detik). Jangan keluar selama masih bergoncang", "location": "Posisi berlindung Anda", "priority": 2},
                {"action": "SETELAH AMAN: Matikan gas/listrik jika bisa, keluar via tangga (JANGAN lift), kumpul di area terbuka 50m dari bangunan", "location": "Titik kumpul: lapangan/ruang terbuka terdekat", "priority": 3},
            ],
            "dangerZones": [
                "Jendela & partisi kaca — risiko pecah & potong",
                "Lemari/rak >1.5m — risiko roboh menimpa",
                "Lampu gantung & plafon — risiko jatuh",
                "D bata ringan/plafon gypsum — risiko runtuh",
                "Kolom/struktur retak — indikasi kerusakan",
            ],
            "nearestSafety": (f"Cari titik kumpul/open space terdekat dari {loc}. Dalam radius 50km: lapangan olahraga, alun-alun, parkiran luas tanpa gedung di sekeliling."
                              if loc else "Area terbuka minimal 50m dari bangunan tertinggi di sekitar Anda."),
            "confidence": 0.75 if is_video else 0.6,
        },
        "tsunami": {
            "riskLevel": "danger",
            "summary": f"ALERT TSUNAMI{' — posisi Anda: ' + loc if loc else ''}. Waktu evakuasi: 15-30 menit. Bergerak SEKARANG.",
            "recommendations": [
                {"action": "NAIK: Langsung menuju tempat dengan elevasi >15m dari permukaan laut ATAU jarak >30m horizontal dari pantai. Jika di gedung: naik ke lantai tertinggi", "location": "Bukit/bangunan tinggi/gedung bertingkat TERDEKAT dari posisi Anda", "priority": 1},
                {"action": "JARAK: Jauhi SEMUA area air — pantai, sungai, muara, drainase besar. Air bisa datang dari arah mana saja", "location": "Arah JAUH dari garis pantai/sungai (vertical evacuation preferred)", "priority": 1},
                {"action": "CEPAT: Jalan kaki > kendaraan (lalu lintas pasti macet/panik). Ikuti tanda panah evakuasi tsunami jika ada", "location": "Jalur evakuasi vertikal terdekat (biasanya ke atas/bukit)", "priority": 2},
                {"action": "MINIMAL: Bawa hanya HP + dompet. Jangan buang waktu mengumpulkan barang. Maks 60 detik persiapan", "location": "Ambil dari saku/meja dekat Anda", "priority": 3},
            ],
            "dangerZones": [
                "Garis pantai & area <30m dari air",
                "Sungai, muara, kanal (air naik dari hulu)",
                "Area cekungan/rendah (banjir bandang)",
                "Jembatan & jalan dekat air (runtuh/dibawa arus)",
                "Batu karang/tebing pantai (slump saat gelombang)",
            ],
            "nearestSafety": (f"Dari {loc}, cari: (1) Bukit/gunung terdekat, (2) Gedung >5 lantai, (3) Tangga evakuasi tsunami. Radius 50km: identifikasi elevated road atau perbukitan."
                              if loc else "Tempat tinggi terdekat: bukit, gedung tinggi (>5 lantai), atau tangga evakuasi bertanda."),
            "confidence": 0.8,
        },
        "banjir": {
            "riskLevel": "caution",
            "summary": f"Potensi banjir{' di area ' + loc if loc else ''}. Ketinggian air bisa naik 30-60cm/jam. Naik sekarang sebelum terlambat.",
            "recommendations": [
                {"action": "NAIK: Pindah ke lantai 2+ atau atap. Jika di ruko: stok barang di lantai atas dulu (10 menit)", "location": "Lantai atas bangunan Anda / tangga ke rooftop", "priority": 1},
                {"action": "MATIKAN: Cabut semua stopkontak, matikan MCB utama. Listrik + air = kematian", "location": "Panel listrik (biasanya di dekat pintu masuk/lantai 1)", "priority": 1},
                {"action": "HINDARI: JANGAN lewat genangan >30cm. Arus 15cm sudah bisa membalik motor, 30cm membalik mobil", "location": "Semua jalan/area tergenang — cari rute kering", "priority": 2},
                {"action": "SIAPKAN: Tas berisi obat, air mineral x2, powerbank, dokumen foto di HP, senter", "location": "Letakkan di samping pintu keluar lantai atas", "priority": 3},
            ],
            "dangerZones": [
                "Genangan >15cm — arus bawah tidak terlihat",
                "Kolam listrik, trafo, kabel putus",
                "Balkon/terras lantai 1 (air langsung masuk)",
                "Bawah jembatan (air terkonsentrasi)",
                "Area tanah urugan (longsor saat jenuh)",
            ],
            "nearestSafety": (f"Dari {loc}: cari bangunan >2 lantai dalam radius 200m. Alternatif 50km: area perbukitan atau gedung perkantoran tinggi."
                              if loc else "Bangunan bertingkat terdekat (minimal 2 lantai) atau area elevated."),
            "confidence": 0.7,
        },
        "angin": {
            "riskLevel": "caution",
            "summary": f"Angin kencang/badai{' di ' + loc if loc else ''}. Risiko: benda terbang, kaca pecah, pohon tumbang. Masuk ke interior sekarang.",
            "recommendations": [
                {"action": "MASUK: Langsung ke ruangan paling dalam (tanpa jendela/pintu kaca). Lorong, kamar mandi, atau ruang tanpa kaca", "location": "Ruangan interior terdalam dari sisi angin", "priority": 1},
                {"action": "TURUNKAN: Tutup semua jendela/pintu. Tarik tirai tebal sebagai lapisan tambahan anti pecah", "location": "Semua jendela yang masih terbuka", "priority": 1},
                {"action": "RENDAH: Jika tidak bisa ke interior: berbaring prone (face down) di parit/turunan, lindungi kepala dengan lengan + tas", "location": "Area rendah terlindung dari arah angin", "priority": 2},
                {"action": "JAUHI: Pohon besar, tiang listrik, reklame, spanduk, bangunan seng/prefab — semua bisa jadi peluru", "location": "Minimal 10m dari objek tersebut", "priority": 3},
            ],
            "dangerZones": [
                "Jendela & kaca (pecah → pecahan proyektil)",
                "Papan reklame & spanduk (terbang)",
                "Pohon besar (cabang patah/tumbang)",
                "Atap seng/prefab (terangkat)",
                "Tiang listrik & kabel (jatuh → listrik)",
            ],
            "nearestSafety": (f"Dari {loc}: basement, bunker, atau ruangan interior gedung terdekat. Outdoor: parit/median jalan sebagai shelter sementara."
                              if loc else "Interior bangunan tanpa kaca, atau area terlindung (di balik tembok beton)."),
            "confidence": 0.7,
        },
        "umum": {
            "riskLevel": "caution",
            "summary": f"Kondisi darurat terdeteksi{' di ' + loc if loc else ''}. Tetap tenang, amati, dan bergerak ke tempat aman.",
            "recommendations": [
                {"action": "AMATI: 5 detik — lihat ke segala arah. Identifikasi: apa bahayanya? Dari arah mana? Ada jalur keluar?", "location": "Posisi Anda sekarang", "priority": 1},
                {"action": "GERAK: Arahkan diri ke pintu keluar/exit TERDEKAT. Jauhi sumber bahaya (jarak >5m)", "location": "Jalur keluar terdekat (bukan lift)", "priority": 1},
                {"action": "LINDUNGI: Kepala selalu dilindungi (tangan, tas, benda keras di atas kepala)", "location": "Selama bergerak", "priority": 2},
                {"action": "KUMPUL: Setelah di area aman, hubungi keluarga/kontak darurat. Laporkan kondisi", "location": "Titik kumpul / area terbuka", "priority": 3},
            ],
            "dangerZones": ["Sumber bahaya utama (identifikasi visual)", "Jalur sempit/sumpek", "Benda yang bisa jatuh"],
            "nearestSafety": "Area terbuka tanpa struktur overhead, minimal 20m dari sumber bahaya.",
            "confidence": 0.5,
        },
    }

    result = dict(rules.get(disaster_type, rules["umum"]))
    if is_video:
        result["summary"] = "[Analisis video lingkungan] " + result["summary"]
    result["source"] = "rule-based"
    return result


# ── Qwen Vision via DashScope (optional) ───────────────────────
async def qwen_vision_analysis(image_b64: str, disaster_type: str, context: str, api_key: str):
    """Call Qwen-VL-Plus via DashScope API. Returns None on any failure."""
    if not api_key or not image_b64:
        return None

    if image_b64.startswith("data:image"):
        image_b64 = image_b64.split(",", 1)[1]

    prompt = (
        f"Kamu analis keselamatan darurat Indonesia. Lihat gambar ini PERHATI.\n\n"
        f"JENIS BENCANA: {disaster_type.upper()}\n"
        f"LOKASI PENGGUNA: {context or 'Lokasi tidak diketahui'}\n\n"
        f"LANGKAH:\n"
        f"1. DAFTARKAN semua objek besar yang terlihat — sebutkan POSISI relatifnya\n"
        f"2. IDENTIFIKASI bahaya spesifik berdasarkan jenis bencana + objek\n"
        f"3. BERIKAN rekomendasi SPESIFIK merujuk objek yang kamu lihat\n\n"
        f'Balas HANYA JSON valid:\n'
        f'{{"objectsSeen":["objek1 di posisi X"],"riskLevel":"safe|caution|danger",'
        f'"summary":"1-2 kalimat kondisi + risiko",'
        f'"recommendations":[{{"action":"...","location":"...","priority":1}}],'
        f'"dangerZones":["Bahaya + posisi"],"nearestSafety":"Tempat aman terdekat","confidence":0.85}}'
    )

    url = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    payload = {
        "model": "qwen-vl-plus",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                {"type": "text", "text": prompt},
            ],
        }],
        "max_tokens": 1024,
        "temperature": 0.3,
    }

    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            result = json.loads(m.group())
            result["source"] = "qwen-vision"
            return result
    except Exception as e:
        print(f"[Qwen Vision] Error: {e}")
    return None


# ── Build the Gradio UI ────────────────────────────────────────
with gr.Blocks(title="SelamatKu — AI Safety Scanner") as demo:
    gr.HTML(
        PAGE_HTML,
        elem_classes=["sk-pwa"],
        head=HEAD_HTML,
        js_on_load=JS_ON_LOAD,
    )


# ── Register custom API routes ─────────────────────────────────
# CRITICAL for Gradio 6.x: the FastAPI app object is REPLACED during launch(),
# so routes added to demo.app before launch are lost. register_routes() is
# called AFTER launch() (see main below) and also exposed for platforms that
# drive their own server lifecycle.

def register_routes(app):
    @app.post("/api/analyze-safety")
    async def analyze_safety(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        images = body.get("images", [])
        image = body.get("image")
        disaster_type = body.get("disasterType", "umum")
        is_video = body.get("isVideo", False)
        context = body.get("context", "")

        frames = images if isinstance(images, list) else ([image] if image else [])

        api_key = (
            body.get("msApiKey")
            or os.environ.get("DASHSCOPE_API_KEY")
            or os.environ.get("MS_API_KEY")
            or ""
        )

        result = None
        if frames:
            first_frame = frames[0]
            if first_frame.startswith("data:image"):
                first_frame = first_frame.split(",", 1)[1]
            result = await qwen_vision_analysis(first_frame, disaster_type, context, api_key)

        if not result:
            result = rule_based_analysis(disaster_type, len(frames) > 0, context)

        result["framesAnalyzed"] = len(frames)
        return JSONResponse(result)


# Expose a bare ASGI/FastAPI object too, for platforms that look for `app`.
app = demo.app


# ── Launch ─────────────────────────────────────────────────────
if __name__ == "__main__":
    demo.queue().launch(server_name="0.0.0.0", server_port=7860)
    # Attach routes to the (post-launch) app instance that is actually served.
    register_routes(demo.app)
