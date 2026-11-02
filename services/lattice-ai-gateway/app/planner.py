"""Small, reproducible supervised baseline; no generative-model claims.

The model chooses an intent. Grounding, ambiguity and speed limits are explicit
policy. Scores are classifier probabilities, not safety guarantees.
"""
import hashlib
import json
import re
from pathlib import Path

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline

DATA = Path(__file__).resolve().parents[1] / 'data/planner-train.json'
POLICY_VERSION = 'warehouse-grounding-v1'
LOCATIONS = {
    'loading_dock': ('loading dock', 'loading_dock', 'dock'),
    'charging_station': ('charging station', 'charging_station', 'charger'),
    'inspection_bay': ('inspection bay', 'inspection_bay', 'inspection area'),
}


class Planner:
    def __init__(self):
        raw = DATA.read_bytes()
        rows = json.loads(raw)
        self.model_id = 'tfidf-logreg-v1:' + hashlib.sha256(raw).hexdigest()[:16]
        self.model = make_pipeline(TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True),
                                   LogisticRegression(C=8, random_state=41, max_iter=1000))
        self.model.fit([r['text'] for r in rows], [r['label'] for r in rows])

    def propose(self, text):
        normalized = text.lower().strip()
        probabilities = self.model.predict_proba([normalized])[0]
        index = probabilities.argmax()
        label, score = str(self.model.classes_[index]), float(probabilities[index])
        result = dict(decision='clarify', command=None, model_id=self.model_id,
                      policy_version=POLICY_VERSION, confidence=round(score, 6),
                      rationale='Name one warehouse destination and one supported action.')
        locations = [key for key, aliases in LOCATIONS.items()
                     if any(re.search(r'(?<!\w)' + re.escape(alias) + r'(?!\w)', normalized)
                            for alias in aliases)]
        # Refuse instruction overrides and unsupported control operations. This is
        # a conservative demo policy, not a complete prompt-injection defense.
        forbidden = r'\b(ignore|override|bypass|disable|secret|token|password|shell|execute|fly|carry|follow|stairs|delete|kill|ram|crash|fastest|maximum|sprint)\b'
        if re.search(forbidden, normalized) or label == 'unsupported':
            return result | dict(decision='rejected', rationale='Request is outside the supported warehouse skills.')
        if len(locations) != 1 or re.search(r'\b(or|maybe|either|then|after|not|don.t|unless)\b', normalized):
            return result
        if score < .65:
            return result | dict(rationale='Intent is uncertain; use an explicit navigate or inspect request.')
        speed = .3
        numbers = re.findall(r'(?<!\w)(\d+(?:\.\d+)?)\s*(?:m/s|mps|meters? per second|metres? per second)', normalized)
        if re.search(r'\d', normalized) and (len(numbers) != 1 or label != 'navigate'):
            return result | dict(decision='rejected', rationale='Only one explicit navigation speed in m/s is supported.')
        if numbers:
            speed = float(numbers[0])
        if not .05 <= speed <= .4:
            return result | dict(decision='rejected', rationale='Warehouse speed must be between 0.05 and 0.4 m/s.')
        command = ({'type': 'navigate', 'destination': locations[0], 'max_speed_mps': speed}
                   if label == 'navigate' else {'type': 'inspect', 'location': locations[0]})
        return result | dict(decision='ready', command=command,
                             rationale='Grounded to the warehouse map; operator approval is required.')
