"""Red-region proposals + learned silhouette classifier for simulated markers.

Training, calibration and test seeds are disjoint. Confidence is calibrated on
synthetic crops only; this does not establish calibration on physical cameras.
"""
import base64
import hashlib
import time

import cv2
import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.frozen import FrozenEstimator
from sklearn.linear_model import LogisticRegression

MODEL_ID = 'red-marker-silhouette-logreg-v1-seed41'


def mask(image):
    b, g, r = cv2.split(image.astype(np.float32))
    return ((r > 65) & (r > g * 1.45) & (r > b * 1.45)).astype(np.uint8) * 255


def feature(region):
    # Tight bounding boxes make silhouette features scale and translation invariant.
    points = cv2.findNonZero(region)
    if points is None:
        return np.zeros(576, dtype=np.float32)
    x, y, w, h = cv2.boundingRect(points)
    return cv2.resize(region[y:y+h, x:x+w], (24, 24), interpolation=cv2.INTER_AREA).ravel() / 255.


def samples(seed, count):
    rng = np.random.default_rng(seed)
    features, labels = [], []
    for i in range(count):
        label = i % 2
        canvas = np.zeros((96, 96), dtype=np.uint8)
        sides = 8 if label else int(rng.choice([3, 4, 5, 20]))
        angle = np.pi / 8 if sides == 8 else rng.uniform(0, np.pi)
        angle += rng.uniform(-.18, .18)
        points = np.array([(48 + 34*np.cos(a), 48 + 34*np.sin(a))
                           for a in angle + np.arange(sides)*2*np.pi/sides], dtype=np.float32)
        points[:, 0] = 48 + (points[:, 0]-48)*rng.uniform(.65, 1.05)
        points += rng.normal(0, .65, points.shape)
        cv2.fillPoly(canvas, [points.astype(np.int32)], 255)
        if rng.random() < .4:
            canvas = cv2.GaussianBlur(canvas, (3, 3), .8)
        features.append(feature(canvas))
        labels.append(label)
    return np.array(features), np.array(labels)


class Detector:
    def __init__(self):
        x, y = samples(41, 1200)
        base = LogisticRegression(C=.5, max_iter=1000, random_state=41).fit(x, y)
        self.model = CalibratedClassifierCV(FrozenEstimator(base), method='sigmoid')
        x, y = samples(42, 400)
        self.model.fit(x, y)

    def detect(self, image):
        foreground = mask(image)
        contours, _ = cv2.findContours(foreground, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        detections = []
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            if w < 12 or h < 12 or cv2.contourArea(contour) < 100:
                continue
            score = float(self.model.predict_proba([feature(foreground[y:y+h, x:x+w])])[0, 1])
            if score >= .8:
                detections.append(dict(label='octagonal_safety_marker', confidence=round(score, 6),
                                       box=[x, y, w, h]))
        return detections

    def inspect(self, encoded, captured_at_ms):
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > 300_000:
            raise ValueError('camera frame exceeds byte limit')
        # The body sends a fixed-size PPM; reject before decoding arbitrary formats.
        header = b'P6\n320 240\n255\n'
        if not raw.startswith(header) or len(raw) != len(header) + 320*240*3:
            raise ValueError('expected a 320x240 RGB PPM camera frame')
        image = np.frombuffer(raw[len(header):], np.uint8).reshape(240,320,3)[:,:,::-1].copy()
        detections = self.detect(image)
        for d in detections:
            x, y, w, h = d['box']
            cv2.rectangle(image, (x,y), (x+w,y+h), (50,255,50), 2)
            cv2.putText(image, f"marker {d['confidence']:.2f}", (x,max(12,y-5)),
                        cv2.FONT_HERSHEY_SIMPLEX, .4, (50,255,50), 1)
        ok, jpeg = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok or len(jpeg) > 40_000:
            raise ValueError('evidence encoding failed')
        return dict(model_id=MODEL_ID, captured_at_ms=captured_at_ms,
                    frame_sha256=hashlib.sha256(raw).hexdigest(),
                    image_sha256=hashlib.sha256(jpeg.tobytes()).hexdigest(),
                    image_base64=base64.b64encode(jpeg).decode(), detections=detections,
                    confidence_domain='synthetic calibration; not calibrated on real cameras')
