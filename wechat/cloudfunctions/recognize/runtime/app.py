"""Private, stateless OCR worker. Images stay in memory and are never logged."""
import base64
import hmac
import io
import json
import os
import re
import threading
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image, ImageOps
from rapidocr_onnxruntime import RapidOCR

MAX_BASE64 = 4 * 1024 * 1024
MAX_BODY = MAX_BASE64 + 8192
Image.MAX_IMAGE_PIXELS = 48_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)
_engine = None
_engine_lock = threading.Lock()
_capacity = threading.BoundedSemaphore(1)


def decode_image(data):
    if not isinstance(data, dict) or set(data) != {"image"} or not isinstance(data["image"], str):
        raise ValueError("INVALID_IMAGE")
    match = re.fullmatch(r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})", data["image"])
    if not match or not match.group(2) or len(match.group(2)) > MAX_BASE64:
        raise ValueError("INVALID_IMAGE")
    binary = base64.b64decode(match.group(2), validate=True)
    with Image.open(io.BytesIO(binary)) as original:
        if original.format != {"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}[match.group(1)]:
            raise ValueError("INVALID_IMAGE")
        if original.width > 12000 or original.height > 12000 or original.width * original.height > 48_000_000:
            raise ValueError("INVALID_IMAGE")
        image = ImageOps.exif_transpose(original).convert("RGB")
        image.thumbnail((1800, 1800))
        return image


def load_engine():
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)
    return _engine


def recognize(image):
    engine = load_engine()
    width, height = image.size
    pixels = np.asarray(image)[:, :, ::-1].copy()
    result, _ = engine(pixels, use_cls=False)
    observations = []
    for points, text, confidence in (result or [])[:500]:
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        observations.append({
            "text": str(text)[:300], "confidence": float(confidence),
            "box": {"x": float(min(xs)) / width, "y": 1 - float(max(ys)) / height,
                    "width": float(max(xs) - min(xs)) / width, "height": float(max(ys) - min(ys)) / height},
        })
    return {"observations": observations, "width": width, "height": height}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        # Bound slow header reads too, before authentication/body processing.
        self.connection.settimeout(10)

    def log_message(self, *_args):
        # BaseHTTPRequestHandler normally logs paths. No request/image/user logs here.
        pass

    def reply(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True

    def do_GET(self):
        self.reply(200 if self.path == "/health" else 404, {"ok": self.path == "/health"})

    def do_POST(self):
        expected = "Bearer " + os.environ.get("OCR_TOKEN", "")
        supplied = self.headers.get("Authorization", "")
        if len(os.environ.get("OCR_TOKEN", "")) < 32 or not hmac.compare_digest(supplied.encode("utf8"), expected.encode("utf8")):
            self.reply(401, {"error": "UNAUTHORIZED"})
            return
        if self.path != "/api/ocr":
            self.reply(404, {"error": "NOT_FOUND"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY or self.headers.get("Transfer-Encoding"):
            self.reply(413, {"error": "INVALID_BODY_SIZE"})
            return
        if not _capacity.acquire(blocking=False):
            self.reply(503, {"error": "BUSY"})
            return
        try:
            self.connection.settimeout(10)
            data = json.loads(self.rfile.read(length))
            image = decode_image(data)
            try:
                self.reply(200, recognize(image))
            finally:
                image.close()
        except (ValueError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
            self.reply(400, {"error": "INVALID_IMAGE"})
        except Exception:
            self.reply(503, {"error": "OCR_UNAVAILABLE"})
        finally:
            _capacity.release()


def create_server(host="0.0.0.0", port=None):
    if len(os.environ.get("OCR_TOKEN", "")) < 32:
        raise ValueError("OCR_TOKEN must contain at least 32 characters")
    # A healthy listening worker already has the bundled models loaded. A cold
    # start/model error must not advertise readiness and consume a parent photo.
    load_engine()
    return ThreadingHTTPServer((host, int(os.environ.get("PORT", "8080")) if port is None else port), Handler)


if __name__ == "__main__":
    try:
        server = create_server()
    except Exception:
        raise SystemExit("OCR worker could not initialize; check runtime configuration and bundled models")
    server.serve_forever()
