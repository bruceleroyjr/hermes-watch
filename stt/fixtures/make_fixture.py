"""Writes weather.opus: Windows TTS speech encoded in the Zepp OS Recorder's raw Opus layout
([u32 BE length][u32 BE final range][packet] per packet), for the STT worker tests.

Run: stt\.venv\Scripts\python.exe -I stt\fixtures\make_fixture.py
"""

import struct
import subprocess
import tempfile
from pathlib import Path

import av

HERE = Path(__file__).parent
SENTENCE = "What is the weather like in Paris tomorrow?"


def tts_wav(path):
    ps = ("Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
          "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, "
          "[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); "
          f"$s.SetOutputToWaveFile('{path}', $f); $s.Speak('{SENTENCE}'); $s.Dispose()")
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)


def zepp_opus(wav):
    enc = av.CodecContext.create("libopus", "w")
    enc.sample_rate = 16000
    enc.layout = "mono"
    enc.format = "s16"
    enc.bit_rate = 16000
    out = bytearray()
    with av.open(str(wav)) as c:
        frames = list(c.decode(audio=0))
    for frame in frames + [None]:
        for pkt in enc.encode(frame):
            data = bytes(pkt)
            out += struct.pack(">II", len(data), 0) + data
    return bytes(out)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "tts.wav"
        tts_wav(wav)
        (HERE / "weather.opus").write_bytes(zepp_opus(wav))
    print("wrote", HERE / "weather.opus")
