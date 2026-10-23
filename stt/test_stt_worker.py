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
