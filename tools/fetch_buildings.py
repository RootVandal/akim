"""Parallel, small-tile building download (Overpass is often overloaded).

    python tools/fetch_buildings.py

Writes raw/osm_bld3_RRCC.json; build_data.py merges every raw/osm_bld*.json.
"""
import concurrent.futures as cf
import json
import os
import sys
import threading
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from overpass import HEADERS, RAW  # noqa: E402
from fetch_osm import S, W, N, E  # noqa: E402

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
ROWS, COLS = 9, 9
lock = threading.Lock()


def fetch_tile(r, c, worker):
    name = f"bld3_{r:02d}{c:02d}"
    path = os.path.join(RAW, f"osm_{name}.json")
    if os.path.exists(path):
        return name, "cached"
    s = S + (N - S) * r / ROWS
    n = S + (N - S) * (r + 1) / ROWS
    w = W + (E - W) * c / COLS
    e = W + (E - W) * (c + 1) / COLS
    ql = (f'[out:json][timeout:60];(way["building"]({s:.5f},{w:.5f},{n:.5f},{e:.5f});'
          f'rel["building"]({s:.5f},{w:.5f},{n:.5f},{e:.5f}););out tags geom qt;')
    for attempt in range(60):
        url = ENDPOINTS[(worker + attempt) % len(ENDPOINTS)]
        try:
            resp = requests.post(url, data={"data": ql}, headers=HEADERS, timeout=120)
            if resp.status_code == 200 and resp.text.lstrip().startswith("{"):
                data = resp.json()
                rem = str(data.get("remark", ""))
                if "error" in rem.lower():
                    raise RuntimeError(rem[:120])
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False)
                return name, f"{len(data['elements'])} el"
            err = f"HTTP {resp.status_code}"
        except Exception as ex:  # noqa: BLE001
            err = repr(ex)[:80]
        time.sleep(4 + min(20, attempt * 2) + (15 if "429" in err else 0))
    return name, "FAILED"


def main():
    tiles = [(r, c) for r in range(ROWS) for c in range(COLS)]
    done = 0
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        futs = [ex.submit(fetch_tile, r, c, i % 2) for i, (r, c) in enumerate(tiles)]
        for f in cf.as_completed(futs):
            name, status = f.result()
            done += 1
            with lock:
                print(f"[{done}/{len(tiles)}] {name}: {status}", flush=True)


if __name__ == "__main__":
    main()
