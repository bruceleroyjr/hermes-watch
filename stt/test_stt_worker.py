"""Tests for the watch speech-to-text worker.

Run: stt\\.venv\\Scripts\\python.exe -m unittest stt/test_stt_worker.py -v
"""

import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import stt_worker  # noqa: E402

FIXTURE = (HERE / "fixtures" / "weather.opus").read_bytes()


class WatchMp3(unittest.TestCase):
    """Spoken answers: small mono MP3s the watch's Player can play (MP3 only; Opus must be recorded on the watch)."""

    def test_encode_round_trip(self):
        pcm = stt_worker.decode(FIXTURE)
        mp3 = stt_worker.encode_mp3(pcm)
        self.assertTrue(mp3[:3] == b"ID3" or (mp3[0] == 0xFF and mp3[1] & 0xE0 == 0xE0), mp3[:4])
        back = stt_worker.decode_audio(mp3)
        self.assertAlmostEqual(len(back) / 16000, len(pcm) / 16000, delta=0.3)

    def test_small_enough_for_bluetooth(self):
        pcm = stt_worker.decode(FIXTURE)
        mp3 = stt_worker.encode_mp3(pcm)
        self.assertLess(len(mp3) / (len(pcm) / 16000), 2400)  # bytes per second of speech (~16 kbps)

    @unittest.skipUnless(__import__("os").environ.get("TTS_LIVE") == "1", "set TTS_LIVE=1 (needs the internet)")
    def test_speak_live(self):
        mp3 = stt_worker.speak("Hello from Hermes.")
        self.assertGreater(len(stt_worker.decode_audio(mp3)) / 16000, 0.5)


class SplitPackets(unittest.TestCase):
    def test_split_packets_fixture(self):
        packets = stt_worker.split_packets(FIXTURE)
        self.assertTrue(packets)
        self.assertEqual(packets[0][0], 0x48)

    def test_split_packets_rejects_garbage(self):
        self.assertIsNone(stt_worker.split_packets(b"hello world!" * 10))


class Decode(unittest.TestCase):
    def test_decode_length(self):
        pcm = stt_worker.decode(FIXTURE)
        self.assertEqual(pcm.dtype, np.int16)
        self.assertTrue(2.5 <= len(pcm) / 16000 <= 4.0, len(pcm) / 16000)

    def test_truncated_last_packet_dropped(self):
        pcm = stt_worker.decode(FIXTURE[:-5])
        self.assertGreater(len(pcm) / 16000, 2.5)


class Transcribe(unittest.TestCase):
    def test_transcribe_fixture(self):
        text = stt_worker.transcribe(stt_worker.decode(FIXTURE)).lower()
        self.assertIn("weather", text)
        self.assertIn("paris", text)

    def test_silence(self):
        self.assertEqual(stt_worker.transcribe(np.zeros(16000, np.int16)), "")


class Log(unittest.TestCase):
    def test_log_without_stdout(self):
        # pythonw (the scheduled task) has no stdout: lines go to stt.log instead.
        import io
        import tempfile
        saved_stdout, saved_file = sys.stdout, stt_worker.LOG_FILE
        with tempfile.TemporaryDirectory() as tmp:
            stt_worker.LOG_FILE = Path(tmp) / "stt.log"
            sys.stdout = None
            try:
                stt_worker.log("hello log")
            finally:
                sys.stdout, stt_worker.LOG_FILE = saved_stdout, saved_file
            self.assertIn("hello log", (Path(tmp) / "stt.log").read_text())
        buf = io.StringIO()
        sys.stdout = buf
        try:
            stt_worker.log("to stdout")
        finally:
            sys.stdout = saved_stdout
        self.assertIn("to stdout", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
