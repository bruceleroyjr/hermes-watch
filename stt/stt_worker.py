"""Speech-to-text worker for the Hermes watch relay (relay.js).

POST /stt with the watch recorder's bytes -> {"text", "seconds", "level_db", "ms"}.
GET /health -> {"ok": true} once Whisper is loaded. POST /tts {"text"} -> MP3 for the watch speaker.
Listens on 127.0.0.1:8797 only.

The Zepp OS Recorder (codec.OPUS) writes no container: each packet is
[u32 BE length][u32 BE encoder final range][packet] (libopus opus_demo layout), so the
packets are wrapped in Ogg before PyAV decodes them. Ogg input is accepted as is.
Set STT_KEEP=1 to save each clip under captures/ for listening checks.
"""

import io
import json
import os
import struct
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import av
import numpy as np

PORT = int(os.environ.get("STT_PORT", "8797"))
RATE = 16000
HERE = Path(__file__).parent
CAPTURES = HERE / "captures"
MAX_BYTES = 2_000_000  # ~15 min at the watch's bitrate; the watch caps clips at 15 s

_model = None
_model_lock = threading.Lock()


LOG_FILE = HERE / "stt.log"


def log(line):
    stamped = f"{datetime.now():%Y-%m-%d %H:%M:%S} {line}"
    if sys.stdout is None:  # pythonw, as run by the HermesWatchStt task
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(stamped + "\n")
    else:
        print(stamped, flush=True)


# --- Zepp Recorder file -> Ogg Opus -------------------------------------------------

def split_packets(data):
    """Packets of the opus_demo layout, or None if the data isn't that layout.
    An incomplete last packet (recording cut off mid-write) is dropped."""
    packets, pos = [], 0
    while pos + 8 <= len(data):
        (n,) = struct.unpack_from(">I", data, pos)
        if not 1 <= n <= 1275:
            return None
        if pos + 8 + n > len(data):
            break
        packets.append(data[pos + 8:pos + 8 + n])
        pos += 8 + n
    return packets or None


def packet_samples(p):
    """Samples at 48 kHz in one Opus packet (RFC 6716 3.1)."""
    cfg = p[0] >> 3
    if cfg < 12:
        frame = (480, 960, 1920, 2880)[cfg % 4]
    elif cfg < 16:
        frame = (480, 960)[cfg % 2]
    else:
        frame = (120, 240, 480, 960)[cfg % 4]
    code = p[0] & 3
    frames = 1 if code == 0 else 2 if code in (1, 2) else (p[1] & 0x3F if len(p) > 1 else 0)
    return frame * frames


_CRC = []
for _i in range(256):
    _r = _i << 24
    for _ in range(8):
        _r = ((_r << 1) ^ 0x04C11DB7) if _r & 0x80000000 else (_r << 1)
    _CRC.append(_r & 0xFFFFFFFF)


def _ogg_page(payload, granule, seq, flags):
    lacing = bytes([255] * (len(payload) // 255) + [len(payload) % 255])
    page = bytearray(struct.pack("<4sBBqIIIB", b"OggS", 0, flags, granule, 0x48574154, seq, 0,
                                 len(lacing)) + lacing + payload)
    crc = 0
    for b in page:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ _CRC[((crc >> 24) ^ b) & 0xFF]
    struct.pack_into("<I", page, 22, crc)
    return bytes(page)


def to_ogg(packets):
    """Wrap Opus packets in an Ogg Opus stream (RFC 7845), one packet per page."""
    ch = 2 if packets[0][0] & 0x04 else 1
    head = struct.pack("<8sBBHIhB", b"OpusHead", 1, ch, 0, RATE, 0, 0)
    tags = b"OpusTags" + struct.pack("<I", 5) + b"watch" + struct.pack("<I", 0)
    out = [_ogg_page(head, 0, 0, 0x02), _ogg_page(tags, 0, 1, 0)]
    granule = 0
    for i, p in enumerate(packets):
        granule += packet_samples(p)
        out.append(_ogg_page(p, granule, i + 2, 0x04 if i == len(packets) - 1 else 0))
    return b"".join(out)


def decode(data):
    """16 kHz mono int16 samples from Zepp Recorder bytes or Ogg Opus."""
    if not data.startswith(b"OggS"):
        packets = split_packets(data)
        if not packets:
            raise ValueError("not Opus audio from the watch")
        data = to_ogg(packets)
    resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE)
    chunks = []
    with av.open(io.BytesIO(data)) as c:
        for frame in c.decode(audio=0):
            chunks.extend(f.to_ndarray().reshape(-1) for f in resampler.resample(frame))
    chunks.extend(f.to_ndarray().reshape(-1) for f in resampler.resample(None))
    return np.concatenate(chunks).astype(np.int16) if chunks else np.zeros(0, np.int16)


# --- Whisper ------------------------------------------------------------------------

def model():
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel
            _model = WhisperModel("base.en", device="cpu", compute_type="int8")
        return _model


def transcribe(pcm):
    if not len(pcm):
        return ""
    m = model()
    with _model_lock:
        segments, _ = m.transcribe(pcm.astype(np.float32) / 32768.0, language="en", beam_size=1,
                                   vad_filter=True)
        return " ".join(s.text.strip() for s in segments).strip()


def level_db(pcm):
    if not len(pcm):
        return -99.0
    rms = float(np.sqrt(np.mean((pcm.astype(np.float32) / 32768) ** 2)))
    return round(20 * np.log10(rms), 1) if rms > 0 else -99.0


# --- Spoken answers: text -> small MP3 for the watch ---------------------------------
# Microsoft's neural voices via edge-tts (free, cloud), re-encoded to 16 kHz mono ~16 kbps so a
# 15 s answer is ~30 KB over Bluetooth. The watch's Player plays MP3 (Opus only if recorded on it).
VOICE = os.environ.get("TTS_VOICE", "en-US-AriaNeural")
MP3_BITRATE = 16000


def decode_audio(data):
    """Any audio file (MP3, WAV, Ogg) -> 16 kHz mono int16 samples."""
    out = []
    resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE)
    with av.open(io.BytesIO(data)) as c:
        for frame in c.decode(audio=0):
            for f in resampler.resample(frame):
                out.append(f.to_ndarray().reshape(-1))
    for f in resampler.resample(None):
        out.append(f.to_ndarray().reshape(-1))
    return np.concatenate(out).astype(np.int16) if out else np.zeros(0, np.int16)


def encode_mp3(pcm):
    """16 kHz mono int16 samples -> MP3 bytes."""
    buf = io.BytesIO()
    with av.open(buf, "w", format="mp3") as c:
        s = c.add_stream("libmp3lame", rate=RATE)
        s.layout = "mono"
        s.bit_rate = MP3_BITRATE
        frame = av.AudioFrame.from_ndarray(pcm.reshape(1, -1).astype(np.int16), format="s16", layout="mono")
        frame.sample_rate = RATE
        for pkt in s.encode(frame):
            c.mux(pkt)
        for pkt in s.encode(None):
            c.mux(pkt)
    return buf.getvalue()


def speak(text):
    import asyncio
    import edge_tts

    async def run():
        chunks = []
        async for part in edge_tts.Communicate(text, VOICE).stream():
            if part["type"] == "audio":
                chunks.append(part["data"])
        return b"".join(chunks)

    return encode_mp3(decode_audio(asyncio.run(run())))


# --- HTTP ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200 if _model is not None else 503, {"ok": _model is not None})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/tts":
            return self.tts()
        if self.path != "/stt":
            return self.reply(404, {"error": "not found"})
        size = int(self.headers.get("Content-Length") or 0)
        if not 0 < size <= MAX_BYTES:
            return self.reply(400, {"error": "no audio" if not size else "audio too long"})
        data = self.rfile.read(size)
        t0 = time.time()
        try:
            pcm = decode(data)
        except Exception as e:  # PyAV raises several types for bad input
            log(f"decode failed ({size} B): {e!r}")
            return self.reply(400, {"error": f"could not decode the audio: {e}"})
        text = transcribe(pcm)
        result = {"text": text, "seconds": round(len(pcm) / RATE, 1), "level_db": level_db(pcm),
                  "ms": int((time.time() - t0) * 1000)}
        if os.environ.get("STT_KEEP") == "1":
            CAPTURES.mkdir(exist_ok=True)
            (CAPTURES / f"{datetime.now():%Y%m%d-%H%M%S}.opus").write_bytes(data)
        log(f"stt {result['seconds']}s {result['level_db']}dB {result['ms']}ms: {len(text)} chars")
        self.reply(200, result)

    # POST /tts {"text"} -> audio/mpeg
    def tts(self):
        size = int(self.headers.get("Content-Length") or 0)
        try:
            text = str(json.loads(self.rfile.read(size))["text"]).strip()[:2000]
        except Exception:
            return self.reply(400, {"error": "send {\"text\": ...}"})
        if not text:
            return self.reply(400, {"error": "empty text"})
        t0 = time.time()
        try:
            mp3 = speak(text)
        except Exception as e:  # network or voice service trouble
            log(f"tts failed: {e!r}")
            return self.reply(502, {"error": f"speech failed: {e}"})
        log(f"tts {len(text)} chars -> {len(mp3)} B in {int((time.time() - t0) * 1000)}ms")
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(mp3)))
        self.end_headers()
        self.wfile.write(mp3)

    def log_message(self, *args):
        pass


def main():
    log("loading Whisper base.en ...")
    model()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"stt worker listening on 127.0.0.1:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
