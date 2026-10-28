"""Real Linux-container HTTP checks. Uses only the supplied synthetic meter fixture."""
import base64
import http.client
import io
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import time
import unittest

sys.path.insert(0, "/app")
import app
from PIL import Image


class RuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.token = secrets.token_urlsafe(40)
        os.environ["OCR_TOKEN"] = cls.token
        started = time.monotonic()
        cls.server = app.create_server("127.0.0.1", 0)
        cls.startup_seconds = round(time.monotonic() - started, 3)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        raw = Path("/fixtures/demo-meter.png").read_bytes()
        cls.mime = "image/png" if raw.startswith(b"\x89PNG\r\n\x1a\n") else "image/jpeg"
        cls.fixture = "data:" + cls.mime + ";base64," + base64.b64encode(raw).decode()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def request(self, method, path, body=None, token=True, headers=None):
        values = {"Content-Type": "application/json"}
        if token:
            values["Authorization"] = "Bearer " + self.token
        values.update(headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            connection.request(method, path, body=body, headers=values)
            result = connection.getresponse()
            return result.status, json.loads(result.read()), dict(result.getheaders())
        finally:
            connection.close()

    def test_health_only_after_models_loaded_and_responses_not_cached(self):
        self.assertIsNotNone(app._engine)
        status, payload, headers = self.request("GET", "/health", token=False)
        self.assertEqual((status, payload), (200, {"ok": True}))
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.request("GET", "/unknown", token=False)[0], 404)

    def test_missing_or_wrong_token_cannot_process_a_photo(self):
        body = json.dumps({"image": self.fixture})
        self.assertEqual(self.request("POST", "/api/ocr", body, token=False)[0], 401)
        self.assertEqual(self.request("POST", "/api/ocr", body, headers={"Authorization": "Bearer wrong"})[0], 401)

    def test_invalid_json_inputs_and_images_are_rejected(self):
        for body in ["{", "[]", "null", "{}", '{"image":42}', '{"image":"data:image/png;base64,AAAA"}', '{"image":"not an image","owner":"untrusted"}']:
            with self.subTest(body=body):
                status, payload, _ = self.request("POST", "/api/ocr", body)
                self.assertEqual((status, payload), (400, {"error": "INVALID_IMAGE"}))

    def test_mime_mismatch_is_rejected_by_worker_itself(self):
        body = json.dumps({"image": self.fixture.replace(self.mime, "image/jpeg" if self.mime == "image/png" else "image/png", 1)})
        self.assertEqual(self.request("POST", "/api/ocr", body)[0], 400)

    def test_body_size_chunking_and_unknown_routes_do_not_reach_ocr(self):
        self.assertEqual(self.request("POST", "/api/ocr", "", headers={"Content-Length": "0"})[0], 413)
        self.assertEqual(self.request("POST", "/api/ocr", "{}", headers={"Content-Length": str(app.MAX_BODY + 1)})[0], 413)
        self.assertEqual(self.request("POST", "/api/ocr", "{}", headers={"Transfer-Encoding": "chunked"})[0], 413)
        self.assertEqual(self.request("POST", "/another-route", "{}")[0], 404)

    def test_busy_worker_returns_retryable_error_without_waiting_for_capacity(self):
        self.assertTrue(app._capacity.acquire(blocking=False))
        try:
            self.assertEqual(self.request("POST", "/api/ocr", json.dumps({"image": self.fixture}))[:2], (503, {"error": "BUSY"}))
        finally:
            app._capacity.release()

    def test_image_pixels_exif_and_format_limits(self):
        for kind in ["PNG", "WEBP"]:
            image = Image.new("RGB", (48, 32), "white")
            stream = io.BytesIO()
            image.save(stream, kind)
            value = "data:image/" + kind.lower() + ";base64," + base64.b64encode(stream.getvalue()).decode()
            decoded = app.decode_image({"image": value})
            self.assertEqual(decoded.size, (48, 32)); decoded.close(); image.close()
        image = Image.new("RGB", (12001, 1), "white")
        stream = io.BytesIO(); image.save(stream, "PNG"); image.close()
        with self.assertRaises(ValueError):
            app.decode_image({"image": "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode()})
        image = Image.new("RGB", (48, 32), "white")
        exif = Image.Exif(); exif[274] = 6
        stream = io.BytesIO(); image.save(stream, "JPEG", exif=exif); image.close()
        decoded = app.decode_image({"image": "data:image/jpeg;base64," + base64.b64encode(stream.getvalue()).decode()})
        self.assertEqual(decoded.size, (32, 48)); decoded.close()

    def test_real_meter_photo_returns_observations_from_actual_inference(self):
        started = time.monotonic()
        status, payload, _ = self.request("POST", "/api/ocr", json.dumps({"image": self.fixture}))
        elapsed = round(time.monotonic() - started, 3)
        self.assertEqual(status, 200)
        texts = [row["text"] for row in payload["observations"]]
        self.assertIn("6.1", texts); self.assertIn("mmol/L", texts)
        self.assertGreater(payload["width"], 0); self.assertGreater(payload["height"], 0)
        for row in payload["observations"]:
            self.assertTrue(0 <= row["confidence"] <= 1)
            self.assertEqual(set(row["box"]), {"x", "y", "width", "height"})
        print("OCR_RUNTIME_RESULT=" + json.dumps({"fixture": "synthetic-demo-meter", "recognized": texts, "startupSeconds": self.startup_seconds, "inferenceSeconds": elapsed, "payload": payload}), flush=True)

    def test_short_token_prevents_startup(self):
        os.environ["OCR_TOKEN"] = "too-short"
        try:
            with self.assertRaises(ValueError): app.create_server("127.0.0.1", 0)
        finally:
            os.environ["OCR_TOKEN"] = self.token


if __name__ == "__main__":
    unittest.main(verbosity=2)
