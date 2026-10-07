"""Tiny Overpass API client used by the data build (stdlib + requests).

Caches every answer in raw/ so the build can be re-run offline.
"""
import hashlib
import json
import os
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
HEADERS = {
    "User-Agent": "AkimAlmatySim/0.1 (educational city-sim data build)",
    "Accept": "application/json",
}


def query(ql, name=None, timeout=900, attempts=6):
    os.makedirs(RAW, exist_ok=True)
    key = name or hashlib.sha1(ql.encode("utf-8")).hexdigest()[:16]
    path = os.path.join(RAW, f"osm_{key}.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    last = None
    for attempt in range(attempts):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            r = requests.post(url, data={"data": ql}, headers=HEADERS, timeout=timeout)
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                data = r.json()
                if "remark" in data and "error" in str(data["remark"]).lower():
                    raise RuntimeError(data["remark"])
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False)
                return data
            last = f"HTTP {r.status_code}: {r.text[:200]!r}"
        except Exception as e:  # network hiccups, timeouts
            last = repr(e)
        print(f"  overpass retry {attempt + 1} ({url}): {last}", flush=True)
        time.sleep(min(90, 10 + 12 * attempt) + (30 if '429' in str(last) else 0))
    raise RuntimeError(f"Overpass failed: {last}")
