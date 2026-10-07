"""Build the game data for ӘКІМ from the raw downloads (see fetch_osm.py).

    python tools/build_data.py

Outputs (data/):
  meta.json.gz       districts, city outline, zones, gates, POIs, names, section tables
  roads.bin.gz       routable + visual major road network (graph, polylines)
  minor.bin.gz       residential streets (visual only)
  buildings.bin.gz   182k footprints with heights and types
  areas.bin.gz       landuse polygons, rivers, railways
  terrain.bin.gz     60 m height grid (decimetres, uint16)
  districts.bin.gz   100 m raster of district ids (picking, statistics)

Data (c) OpenStreetMap contributors (ODbL); terrain: AWS Terrain Tiles.
"""
import collections
import glob
import gzip
import hashlib
import io
import json
import math
import os
import re
import struct
import sys
import time

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo  # noqa: E402
from geo import Raster, proj, proj_pts  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
OUT = os.path.join(ROOT, "data")

# Canonical district order (index = district id used everywhere in the game).
DISTRICTS = [
    # key, name ru, name kk, osm relation, population estimate 2025
    ("alatau", "Алатауский", "Алатау", 3072216, 424_000),
    ("almaly", "Алмалинский", "Алмалы", 3072807, 247_000),
    ("auezov", "Ауэзовский", "Әуезов", 3072808, 339_000),
    ("bostandyk", "Бостандыкский", "Бостандық", 3390291, 394_000),
    ("zhetysu", "Жетысуский", "Жетісу", 3072130, 190_000),
    ("medeu", "Медеуский", "Медеу", 3072217, 240_000),
    ("nauryzbay", "Наурызбайский", "Наурызбай", 5460063, 239_000),
    ("turksib", "Турксибский", "Түрксіб", 3072001, 269_000),
]
# Population: official 2019 district figures (stat.gov.kz via Wikipedia) scaled
# to the city total of 2 341.9k (1 Nov 2025); Nauryzbay set to its reported 239k.

TOTAL_JOBS = 1_200_000
GOV_JOB_SHARE = 0.12
PUPILS_PER_RESIDENT = 0.165
UNI_STUDENTS = 140_000
ZONE_CELL = 1500.0

CLASS = {"motorway": 0, "trunk": 1, "primary": 2, "secondary": 3, "tertiary": 4}
CLASS_NAMES = ["motorway", "trunk", "primary", "secondary", "tertiary"]
DEF_LANES_ONEWAY = [3, 3, 2, 2, 1]
DEF_LANES_TWOWAY = [3, 3, 2, 2, 1]  # per direction
DEF_SPEED = [90, 70, 60, 60, 50]


def load(name):
    with open(os.path.join(RAW, f"osm_{name}.json"), encoding="utf-8") as f:
        return json.load(f)


def num(s, default=None):
    if s is None:
        return default
    m = re.search(r"-?\d+(\.\d+)?", str(s).replace(",", "."))
    return float(m.group(0)) if m else default


def h32(*parts):
    """Deterministic pseudo-random [0,1) from ids (stable across runs)."""
    d = hashlib.md5(("/".join(map(str, parts))).encode()).digest()
    return struct.unpack("<I", d[:4])[0] / 2 ** 32


class Blob:
    """Little-endian binary with named, 4-byte aligned typed sections."""

    def __init__(self):
        self.buf = io.BytesIO()
        self.sections = {}

    def add(self, name, arr):
        arr = np.ascontiguousarray(arr)
        pad = (-self.buf.tell()) % 8
        self.buf.write(b"\0" * pad)
        off = self.buf.tell()
        self.buf.write(arr.astype(arr.dtype.newbyteorder("<"), copy=False).tobytes())
        self.sections[name] = {"offset": off, "length": int(arr.size), "type": arr.dtype.name}

    def save(self, path):
        data = self.buf.getvalue()
        with gzip.open(path, "wb", compresslevel=9) as f:
            f.write(data)
        return len(data), os.path.getsize(path)


# --------------------------------------------------------------------------- boundaries

def build_boundaries():
    d = load("boundaries")
    rels = {e["id"]: e for e in d["elements"] if e["type"] == "relation"}
    city_rings = geo.relation_rings(rels[2465058])
    city_rings.sort(key=lambda r: -abs(geo.signed_area(r)))
    districts = []
    for i, (key, ru, kk, rid, pop) in enumerate(DISTRICTS):
        rings = geo.relation_rings(rels[rid])
        rings.sort(key=lambda r: -abs(geo.signed_area(r)))
        districts.append({"id": i, "key": key, "name": ru, "nameKk": kk, "rings": rings, "pop": pop})
    return city_rings, districts


# --------------------------------------------------------------------------- terrain

def build_terrain():
    files = glob.glob(os.path.join(RAW, "terrain", "12_*_*.png"))
    tiles = {}
    for p in files:
        _, tx, ty = os.path.basename(p)[:-4].split("_")
        tiles[(int(tx), int(ty))] = p
    xs = sorted({k[0] for k in tiles})
    ys = sorted({k[1] for k in tiles})
    W, H = len(xs) * 256, len(ys) * 256
    mosaic = np.zeros((H, W), np.float32)
    for (tx, ty), p in tiles.items():
        a = np.asarray(Image.open(p).convert("RGB"), dtype=np.float32)
        h = a[:, :, 0] * 256 + a[:, :, 1] + a[:, :, 2] / 256 - 32768
        oy, ox = (ty - ys[0]) * 256, (tx - xs[0]) * 256
        mosaic[oy:oy + 256, ox:ox + 256] = h
    z = 12
    n = 2 ** z
    # output grid in the local plane
    cs = 60.0
    x0, x1 = -35000.0, 36000.0
    z0, z1 = -29000.0, 34000.0
    gw = int((x1 - x0) / cs) + 1
    gh = int((z1 - z0) / cs) + 1
    gx = x0 + np.arange(gw) * cs
    gz = z0 + np.arange(gh) * cs
    GX, GZ = np.meshgrid(gx, gz)
    lat = geo.LAT0 - GZ / geo.KZ
    lon = geo.LON0 + GX / geo.KX
    px = (lon + 180.0) / 360.0 * n * 256 - xs[0] * 256
    py = (1.0 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2.0 * n * 256 - ys[0] * 256
    hgt = ndimage.map_coordinates(mosaic, [py - 0.5, px - 0.5], order=1, mode="nearest")
    hgt = ndimage.gaussian_filter(hgt, 0.6)
    print(f"  terrain grid {gw}x{gh} @ {cs} m, height {hgt.min():.0f}..{hgt.max():.0f} m")
    return {"x0": x0, "z0": z0, "cs": cs, "w": gw, "h": gh}, np.clip(np.round(hgt * 10), 0, 65535).astype(np.uint16)


# --------------------------------------------------------------------------- roads

def parse_road_tags(t):
    hw = t.get("highway", "")
    link = hw.endswith("_link")
    base = hw[:-5] if link else hw
    cls = CLASS.get(base)
    if cls is None:
        return None
    ow = t.get("oneway")
    if ow in ("yes", "true", "1"):
        oneway = 1
    elif ow in ("-1", "reverse"):
        oneway = -1
    elif ow == "no":
        oneway = 0
    else:
        oneway = 1 if (base == "motorway" or t.get("junction") in ("roundabout", "circular")) else 0
    lanes = num(t.get("lanes"))
    if lanes is not None and (lanes <= 0 or lanes > 12):
        lanes = None
    if oneway:
        lf = int(lanes) if lanes else (1 if link else DEF_LANES_ONEWAY[cls])
        lb = 0
    else:
        f = num(t.get("lanes:forward"))
        b = num(t.get("lanes:backward"))
        if f and b:
            lf, lb = int(f), int(b)
        elif lanes:
            lf = int(math.ceil(lanes / 2))
            lb = max(1, int(lanes) - lf)
        else:
            lf = lb = 1 if link else DEF_LANES_TWOWAY[cls]
    lf, lb = min(lf, 6), min(lb, 6)
    # bus lanes (right-hand traffic: busway:right belongs to the forward direction)
    bf = bb = 0
    bw = t.get("busway")
    if bw == "lane":
        bf, bb = 1, (0 if oneway else 1)
    if t.get("busway:both") == "lane":
        bf, bb = 1, (0 if oneway else 1)
    if t.get("busway:right") == "lane":
        bf = 1
    if t.get("busway:left") == "lane":
        if oneway:
            bf = min(2, bf + 1)
        else:
            bb = 1
    speed = num(t.get("maxspeed"))
    if t.get("maxspeed") == "RU:urban" or speed is None or speed < 20 or speed > 130:
        speed = DEF_SPEED[cls] if not link else 40
    name = t.get("name:ru") or t.get("name") or ""
    layer = int(num(t.get("layer"), 0) or 0)
    bridge = 1 if t.get("bridge") not in (None, "no") else 0
    tunnel = 1 if t.get("tunnel") not in (None, "no") else 0
    return {
        "cls": cls, "link": int(link), "oneway": oneway, "lf": lf, "lb": lb, "bf": min(bf, lf - 1 if lf > 1 else 0),
        "bb": min(bb, lb - 1 if lb > 1 else 0), "speed": int(speed), "name": name.strip(),
        "bridge": bridge, "tunnel": tunnel, "layer": layer,
        "roundabout": int(t.get("junction") in ("roundabout", "circular")),
    }


def build_roads(city_mask, mask_r, district_r):
    d = load("roads_major")
    nodes = {e["id"]: proj(e["lat"], e["lon"]) for e in d["elements"] if e["type"] == "node"}
    ways = [e for e in d["elements"] if e["type"] == "way"]
    ref = collections.Counter()
    for w in ways:
        ns = w["nodes"]
        for nid in ns:
            ref[nid] += 1
        ref[ns[0]] += 1
        ref[ns[-1]] += 1

    def inside(nid, mask):
        x, z = nodes[nid]
        c = mask_r.cell(x, z)
        return c is not None and mask[c[1], c[0]]

    segs = []
    for w in ways:
        a = parse_road_tags(w.get("tags", {}))
        if a is None:
            continue
        ns = [n for n in w["nodes"] if n in nodes]
        if len(ns) < 2:
            continue
        if a["oneway"] == -1:
            ns = ns[::-1]
            a["oneway"] = 1
        # clip to the region: every run of consecutive inside nodes is kept, its
        # ends become graph nodes (dead ends at the region edge become gates)
        runs, cur = [], []
        for n in ns:
            if inside(n, city_mask):
                cur.append(n)
            else:
                if len(cur) >= 2:
                    runs.append(cur)
                cur = []
        if len(cur) >= 2:
            runs.append(cur)
        for run in runs:
            start = 0
            for i in range(1, len(run)):
                if ref[run[i]] >= 2 or i == len(run) - 1:
                    piece = run[start:i + 1]
                    if len(piece) >= 2 and piece[0] != piece[-1]:
                        segs.append(dict(a, nodes=piece, a=piece[0], b=piece[-1], wid=w["id"]))
                    start = i
    print(f"  segments in region {len(segs)}")

    # ---- contract degree-2 nodes between compatible segments
    def flip(s):
        if s["oneway"]:
            return None
        r = dict(s)
        r["nodes"] = s["nodes"][::-1]
        r["a"], r["b"] = s["b"], s["a"]
        r["lf"], r["lb"] = s["lb"], s["lf"]
        r["bf"], r["bb"] = s["bb"], s["bf"]
        return r

    KEYS = ("cls", "link", "oneway", "lf", "lb", "bf", "bb", "name", "bridge", "tunnel", "roundabout")
    inc = collections.defaultdict(list)
    for i, s in enumerate(segs):
        inc[s["a"]].append(i)
        inc[s["b"]].append(i)
    alive = [True] * len(segs)
    merged = 0
    for v in list(inc.keys()):
        lst = [i for i in inc[v] if alive[i]]
        if len(lst) != 2 or lst[0] == lst[1]:
            continue
        i, j = lst
        A, B = segs[i], segs[j]
        if A["a"] == B["a"] and A["b"] == B["b"] or A["a"] == B["b"] and A["b"] == B["a"]:
            continue
        cand = []
        A1 = A if A["b"] == v else flip(A)
        B1 = B if B["a"] == v else flip(B)
        if A1 and B1:
            cand.append((A1, B1))
        B2 = B if B["b"] == v else flip(B)
        A2 = A if A["a"] == v else flip(A)
        if A2 and B2:
            cand.append((B2, A2))
        for X, Y in cand:
            if all(X[k] == Y[k] for k in KEYS):
                m = dict(X)
                m["nodes"] = X["nodes"] + Y["nodes"][1:]
                m["a"], m["b"] = X["a"], Y["b"]
                if m["a"] == m["b"]:
                    break
                segs[i] = m
                alive[j] = False
                other = Y["b"]
                inc[other] = [i if k == j else k for k in inc[other]]
                inc[v] = []
                merged += 1
                break
    segs = [s for s, al in zip(segs, alive) if al]
    print(f"  after contraction {len(segs)} (merged {merged})")

    # ---- graph nodes
    gnodes = sorted({s["a"] for s in segs} | {s["b"] for s in segs})
    gidx = {n: i for i, n in enumerate(gnodes)}
    N = len(gnodes)

    # ---- gates: dead ends outside the city (cut by the region mask)
    deg = collections.Counter()
    for s in segs:
        deg[s["a"]] += 1
        deg[s["b"]] += 1

    def in_city(nid):
        x, z = nodes[nid]
        c = district_r.cell(x, z)
        return c is not None and district_r.data[c[1], c[0]] > 0

    dead = [n for n in gnodes if deg[n] == 1 and not in_city(n)]
    # cluster dead ends within 400 m
    clusters = []
    for n in dead:
        x, z = nodes[n]
        for c in clusters:
            if math.hypot(c["x"] - x, c["z"] - z) < 400:
                c["nodes"].append(n)
                break
        else:
            clusters.append({"x": x, "z": z, "nodes": [n]})

    # directed links for SCC (including virtual gate nodes)
    rows, cols = [], []
    for s in segs:
        a, b = gidx[s["a"]], gidx[s["b"]]
        if s["lf"] > 0:
            rows.append(a); cols.append(b)
        if s["lb"] > 0:
            rows.append(b); cols.append(a)
    for gi, c in enumerate(clusters):
        g = N + gi
        for n in c["nodes"]:
            rows += [g, gidx[n]]
            cols += [gidx[n], g]
    M = N + len(clusters)
    mat = csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(M, M))
    ncomp, labels = connected_components(mat, directed=True, connection="strong")
    big = np.bincount(labels).argmax()
    routable_node = labels[:N] == big
    print(f"  graph nodes {N}, SCC main {routable_node.sum()} ({ncomp} comps)")

    # gates that ended up in the main component
    gates = []
    for gi, c in enumerate(clusters):
        if labels[N + gi] != big:
            continue
        nds = [gidx[n] for n in c["nodes"] if routable_node[gidx[n]]]
        if not nds:
            continue
        # pick the approach road name / capacity
        names = collections.Counter()
        cap = 0
        for s in segs:
            if s["a"] in c["nodes"] or s["b"] in c["nodes"]:
                names[s["name"]] += 1 + (4 - s["cls"])
                cap += (s["lf"] + s["lb"]) * [3.0, 3.0, 2.0, 1.0, 0.35][s["cls"]]
        gates.append({"x": round(c["x"], 1), "z": round(c["z"], 1), "nodes": nds,
                      "name": (names.most_common(1)[0][0] if names else ""), "w": cap})

    # ---- bridges that cross other roads get lifted (interchanges)
    def seg_bbox(pts):
        xs = [p[0] for p in pts]
        zs = [p[1] for p in pts]
        return min(xs), min(zs), max(xs), max(zs)

    pts_of = [[nodes[n] for n in s["nodes"]] for s in segs]
    grid = collections.defaultdict(list)
    GC = 200.0
    for i, pts in enumerate(pts_of):
        x0, z0, x1, z1 = seg_bbox(pts)
        for gx in range(int(x0 // GC), int(x1 // GC) + 1):
            for gz in range(int(z0 // GC), int(z1 // GC) + 1):
                grid[(gx, gz)].append(i)

    def crosses(p1, p2, q1, q2):
        def o(a, b, c):
            return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        d1, d2 = o(q1, q2, p1), o(q1, q2, p2)
        d3, d4 = o(p1, p2, q1), o(p1, p2, q2)
        return (d1 > 0) != (d2 > 0) and (d3 > 0) != (d4 > 0)

    lifted = [0.0] * len(segs)
    for i, s in enumerate(segs):
        if not s["bridge"] or s["layer"] < 1:
            continue
        pts = pts_of[i]
        x0, z0, x1, z1 = seg_bbox(pts)
        near = set()
        for gx in range(int(x0 // GC), int(x1 // GC) + 1):
            for gz in range(int(z0 // GC), int(z1 // GC) + 1):
                near.update(grid[(gx, gz)])
        hit = False
        mine = set(s["nodes"])
        for j in near:
            if j == i or segs[j]["layer"] >= s["layer"] or mine & set(segs[j]["nodes"]):
                continue
            q = pts_of[j]
            for k in range(len(pts) - 1):
                for m in range(len(q) - 1):
                    if crosses(pts[k], pts[k + 1], q[m], q[m + 1]):
                        hit = True
                        break
                if hit:
                    break
            if hit:
                break
        if hit:
            lifted[i] = 6.5 * min(s["layer"], 2)
    node_lift = collections.defaultdict(float)
    for i, s in enumerate(segs):
        if lifted[i] > 0:
            for n in s["nodes"]:
                node_lift[n] = max(node_lift[n], lifted[i])
    print(f"  lifted bridges {sum(1 for v in lifted if v > 0)}")

    # ---- per-point elevation offsets with ramps
    RAMP = 140.0
    elev = []
    for i, s in enumerate(segs):
        pts = pts_of[i]
        if lifted[i] > 0:
            elev.append([lifted[i]] * len(pts))
            continue
        ea, eb = node_lift.get(s["a"], 0.0), node_lift.get(s["b"], 0.0)
        cum = [0.0]
        for k in range(1, len(pts)):
            cum.append(cum[-1] + math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]))
        L = cum[-1]
        e = []
        for k in range(len(pts)):
            v = 0.0
            if ea > 0:
                v = max(v, ea * max(0.0, 1 - cum[k] / RAMP))
            if eb > 0:
                v = max(v, eb * max(0.0, 1 - (L - cum[k]) / RAMP))
            e.append(v)
        elev.append(e)

    # ---- pack
    names = sorted({s["name"] for s in segs if s["name"]})
    name_idx = {n: i + 1 for i, n in enumerate(names)}  # 0 = unnamed
    S = len(segs)
    arr = {k: np.zeros(S, t) for k, t in [
        ("a", np.uint32), ("b", np.uint32), ("cls", np.uint8), ("flags", np.uint8), ("lf", np.uint8),
        ("lb", np.uint8), ("bf", np.uint8), ("bb", np.uint8), ("speed", np.uint8), ("district", np.uint8),
        ("name", np.uint16), ("p0", np.uint32), ("pn", np.uint16), ("len", np.float32)]}
    px, pe = [], []
    for i, s in enumerate(segs):
        pts = geo.dp_simplify(pts_of[i], 0.6) if lifted[i] == 0 and not any(elev[i]) else pts_of[i]
        if pts is not pts_of[i]:
            e = [0.0] * len(pts)
        else:
            e = elev[i]
        arr["a"][i] = gidx[s["a"]]
        arr["b"][i] = gidx[s["b"]]
        arr["cls"][i] = s["cls"]
        fl = 0
        if routable_node[gidx[s["a"]]] and routable_node[gidx[s["b"]]]:
            fl |= 1
        fl |= s["link"] << 1
        fl |= s["bridge"] << 2
        fl |= s["tunnel"] << 3
        fl |= s["roundabout"] << 4
        fl |= (1 if s["oneway"] else 0) << 5
        arr["flags"][i] = fl
        for k in ("lf", "lb", "bf", "bb", "speed"):
            arr[k][i] = s[k]
        L = geo.polyline_length(pts)
        mx, mz = pts[len(pts) // 2] if len(pts) > 2 else ((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2)
        c = district_r.cell(mx, mz)
        arr["district"][i] = (district_r.data[c[1], c[0]] - 1) if c and district_r.data[c[1], c[0]] > 0 else 255
        arr["name"][i] = name_idx.get(s["name"], 0)
        arr["p0"][i] = len(px)
        arr["pn"][i] = len(pts)
        arr["len"][i] = L
        px.extend(pts)
        pe.extend(e)
    gx = np.array([nodes[n] for n in gnodes], np.float32)
    blob = Blob()
    blob.add("nodes", gx.reshape(-1))
    for k, v in arr.items():
        blob.add("seg_" + k, v)
    blob.add("pts", np.array(px, np.float32).reshape(-1))
    blob.add("elev", np.clip(np.round(np.array(pe) * 4), 0, 255).astype(np.uint8))
    raw, gz = blob.save(os.path.join(OUT, "roads.bin.gz"))
    print(f"  roads.bin: {S} segments, {len(px)} pts, {raw/1e6:.2f} MB -> {gz/1e6:.2f} MB gz")
    routable_nodes = [i for i in range(N) if routable_node[i]]
    return {
        "sections": blob.sections, "nodeCount": N, "segCount": S, "names": names,
        "gates": gates, "classes": CLASS_NAMES,
    }, gx, routable_node, segs, arr


def build_minor(region_mask, mask_r):
    d = load("roads_minor")
    lines, kinds = [], []
    for w in d["elements"]:
        g = w.get("geometry")
        if not g:
            continue
        pts = [p for p in proj_pts([q for q in g if q])]
        if len(pts) < 2:
            continue
        mx, mz = pts[len(pts) // 2]
        c = mask_r.cell(mx, mz)
        if c is None or not region_mask[c[1], c[0]]:
            continue
        pts = geo.dp_simplify(pts, 0.8)
        hw = w["tags"].get("highway")
        lines.append(pts)
        kinds.append({"residential": 0, "unclassified": 1, "living_street": 2}.get(hw, 0))
    blob, n = encode_lines(lines, kinds)
    raw, gz = blob.save(os.path.join(OUT, "minor.bin.gz"))
    print(f"  minor.bin: {len(lines)} lines, {n} pts, {raw/1e6:.2f} MB -> {gz/1e6:.2f} MB gz")
    return {"sections": blob.sections, "count": len(lines)}


def encode_lines(lines, kinds, closed=False):
    """Encode polylines/rings as origin (int32 dm) + int16 deltas (dm)."""
    counts = np.array([len(l) for l in lines], np.uint32)
    origin = np.zeros(len(lines) * 2, np.int32)
    deltas = []
    for i, l in enumerate(lines):
        q = np.round(np.array(l, np.float64) * 10).astype(np.int64)
        origin[2 * i] = q[0, 0]
        origin[2 * i + 1] = q[0, 1]
        dq = np.diff(q, axis=0)
        # split long steps (> 3.2 km) can't happen for our features, but clamp defensively
        dq = np.clip(dq, -32767, 32767)
        deltas.append(dq.astype(np.int16).reshape(-1))
    blob = Blob()
    blob.add("count", counts)
    blob.add("kind", np.array(kinds, np.uint8))
    blob.add("origin", origin)
    blob.add("delta", np.concatenate(deltas) if deltas else np.zeros(0, np.int16))
    return blob, int(counts.sum())


# --------------------------------------------------------------------------- buildings

HOUSE = {"house", "detached", "semidetached_house", "terrace", "bungalow", "cabin", "farm", "static_caravan", "hut"}
APART = {"apartments", "residential", "dormitory", "flats", "construction"}
COMM = {"commercial", "office", "retail", "supermarket", "hotel", "mall", "bank", "kiosk_mall"}
IND = {"industrial", "warehouse", "factory", "manufacture", "depot", "hangar", "storage_tank", "service",
       "transformer_tower", "boiler_house", "power", "substation"}
PUBLIC = {"school", "university", "college", "kindergarten", "hospital", "public", "government", "civic",
          "train_station", "transportation", "sports_hall", "stadium", "sports_centre", "museum", "theatre",
          "clinic", "fire_station", "police", "library"}
SMALL = {"garage", "garages", "shed", "roof", "carport", "kiosk", "toilets", "greenhouse", "ruins", "hut", "gazebo"}
RELIG = {"mosque", "church", "cathedral", "chapel", "temple", "synagogue", "religious", "shrine"}

# type codes
T_HOUSE, T_APART, T_COMM, T_IND, T_PUBLIC, T_SMALL, T_RELIG, T_TOWER = range(8)


def min_rect_dims(pts):
    """Width/length of the minimum-area bounding rectangle (rotating calipers, brute force)."""
    best = None
    n = len(pts)
    for i in range(n):
        x1, z1 = pts[i]
        x2, z2 = pts[(i + 1) % n]
        dx, dz = x2 - x1, z2 - z1
        L = math.hypot(dx, dz)
        if L < 1e-6:
            continue
        ux, uz = dx / L, dz / L
        us = [(p[0] - x1) * ux + (p[1] - z1) * uz for p in pts]
        vs = [-(p[0] - x1) * uz + (p[1] - z1) * ux for p in pts]
        a, b = max(us) - min(us), max(vs) - min(vs)
        if best is None or a * b < best[0] * best[1]:
            best = (a, b)
    if best is None:
        return 1, 1
    return min(best), max(best)


def building_props(bid, t, pts, area, dist_center):
    b = t.get("building", "yes")
    levels = num(t.get("building:levels"))
    height = num(t.get("height"))
    if height is not None and (height <= 0 or height > 400):
        height = None
    if levels is not None and (levels <= 0 or levels > 90):
        levels = None
    r = h32(bid)
    amen = t.get("amenity", "")
    if b in RELIG or amen == "place_of_worship":
        typ = T_RELIG
    elif b in HOUSE:
        typ = T_HOUSE
    elif b in APART:
        typ = T_APART
    elif b in COMM or t.get("shop") or t.get("office"):
        typ = T_COMM
    elif b in IND:
        typ = T_IND
    elif b in PUBLIC or amen in ("school", "university", "college", "hospital", "kindergarten", "clinic"):
        typ = T_PUBLIC
    elif b in SMALL:
        typ = T_SMALL
    else:
        typ = -1  # unknown ("yes"), decided below
    w, L = min_rect_dims(pts)
    if typ == -1:
        if area < 140:
            typ = T_HOUSE if area > 35 else T_SMALL
        elif area < 380:
            typ = T_HOUSE if (dist_center > 6000 and r < 0.75) else T_APART if r < 0.55 else T_COMM
        elif area < 3000:
            typ = T_APART if (r < 0.8 or L / max(w, 1) > 3) else T_COMM
        else:
            typ = T_APART if (L / max(w, 1) > 3.5 and w < 20) else (T_COMM if r < 0.5 else T_IND)
    if levels is None and height is None:
        if typ == T_HOUSE:
            levels = 1 if r < 0.72 else 2
        elif typ == T_SMALL:
            levels = 1
        elif typ == T_APART:
            if area < 380:
                levels = 2 + int(r * 3) if dist_center > 5000 else 3 + int(r * 3)
            elif area < 900:
                levels = 5 if r < 0.55 else 9 if r < 0.85 else 4
            else:
                levels = 9 if r < 0.5 else 5 if r < 0.78 else 12 if r < 0.94 else 16
        elif typ == T_COMM:
            levels = 2 if area > 3000 else 2 + int(r * 4)
        elif typ == T_IND:
            levels = 1 if r < 0.6 else 2
        elif typ == T_PUBLIC:
            levels = 3 if r < 0.6 else 4
        elif typ == T_RELIG:
            levels = 2
    if height is None:
        per = {T_COMM: 3.6, T_IND: 5.0, T_PUBLIC: 3.8, T_RELIG: 5.0}.get(typ, 3.0)
        height = levels * per + (1.2 if typ in (T_APART, T_COMM, T_PUBLIC) else 0.6)
    if height > 55 and typ in (T_APART, T_COMM, T_PUBLIC):
        typ = T_TOWER
    levels = levels if levels is not None else max(1, round(height / 3.2))
    res_fa = area * levels if typ in (T_HOUSE, T_APART) or (typ == T_TOWER and r < 0.5) else 0.0
    nonres_fa = area * levels if typ in (T_COMM, T_IND, T_PUBLIC, T_TOWER) and res_fa == 0 else 0.0
    return typ, height, res_fa, nonres_fa


def build_buildings(region_mask, mask_r, district_r):
    seen = set()
    out = []
    t0 = time.time()
    for p in sorted(glob.glob(os.path.join(RAW, "osm_bld*.json"))):
        d = json.load(open(p, encoding="utf-8"))
        for e in d["elements"]:
            key = (e["type"], e["id"])
            if key in seen:
                continue
            seen.add(key)
            t = e.get("tags", {})
            if e["type"] == "way":
                g = e.get("geometry")
                if not g:
                    continue
                rings = [geo.open_ring(proj_pts([q for q in g if q]))]
            else:
                rings = geo.relation_rings(e)
            for ri, ring in enumerate(rings):
                if len(ring) < 3:
                    continue
                area = abs(geo.signed_area(ring))
                if area < 12:
                    continue
                cx, cz = geo.centroid(ring)
                c = mask_r.cell(cx, cz)
                if c is None or not region_mask[c[1], c[0]]:
                    continue
                ring = geo.simplify_ring(ring, 0.35)
                if len(ring) < 3:
                    continue
                if geo.signed_area(ring) < 0:
                    ring = ring[::-1]
                dc = math.hypot(cx, cz)
                typ, height, res_fa, nonres_fa = building_props(f"{e['type']}{e['id']}/{ri}", t, ring, area, dc)
                dc_ = district_r.cell(cx, cz)
                dist = (district_r.data[dc_[1], dc_[0]] - 1) if dc_ and district_r.data[dc_[1], dc_[0]] > 0 else 255
                out.append((ring, typ, height, res_fa, nonres_fa, cx, cz, dist, t.get("name", ""),
                            f"{e['type']}{e['id']}"))
    print(f"  buildings parsed {len(out)} in {time.time() - t0:.1f}s")
    # sort spatially (tiles of 1 km) so the client can chunk cheaply
    out.sort(key=lambda b: (int((b[6] + 40000) // 1000), int((b[5] + 40000) // 1000)))
    rings = [b[0] for b in out]
    blob, npts = encode_lines(rings, [b[1] for b in out], closed=True)
    blob.add("height", np.clip(np.round(np.array([b[2] for b in out]) * 10), 0, 65535).astype(np.uint16))
    raw, gz = blob.save(os.path.join(OUT, "buildings.bin.gz"))
    print(f"  buildings.bin: {len(out)} footprints, {npts} pts, {raw/1e6:.2f} MB -> {gz/1e6:.2f} MB gz")
    tc = collections.Counter(b[1] for b in out)
    print("  types", dict(sorted(tc.items())))
    return {"sections": blob.sections, "count": len(out)}, out


# --------------------------------------------------------------------------- areas

AREA_CLASSES = ["park", "forest", "grass", "water", "cemetery", "industrial", "residential", "commercial",
                "construction", "farmland", "sport", "education", "hospital", "rock", "glacier"]


def area_class(t):
    le, lu, na, am = t.get("leisure"), t.get("landuse"), t.get("natural"), t.get("amenity")
    if na == "water" or lu in ("reservoir", "basin"):
        return 3
    if le in ("park", "garden", "nature_reserve") or lu in ("recreation_ground", "village_green"):
        return 0
    if lu == "forest" or na == "wood":
        return 1
    if lu in ("grass", "meadow", "greenfield") or na in ("grassland", "heath", "scrub"):
        return 2
    if lu == "cemetery":
        return 4
    if lu in ("industrial", "railway", "garages", "military"):
        return 5
    if lu == "residential":
        return 6
    if lu in ("commercial", "retail"):
        return 7
    if lu in ("construction", "brownfield"):
        return 8
    if lu in ("farmland", "orchard", "allotments"):
        return 9
    if le in ("pitch", "stadium", "playground", "golf_course"):
        return 10
    if am in ("school", "university", "college", "kindergarten"):
        return 11
    if am == "hospital":
        return 12
    if na in ("bare_rock", "scree"):
        return 13
    if na == "glacier":
        return 14
    return None


def build_areas(region_mask, mask_r, district_r, city_ring):
    d = load("areas")
    polys, kinds, parks = [], [], []
    seen = set()
    for e in d["elements"]:
        if (e["type"], e["id"]) in seen:
            continue
        seen.add((e["type"], e["id"]))
        t = e.get("tags", {})
        k = area_class(t)
        if k is None:
            continue
        if e["type"] == "way":
            g = e.get("geometry")
            if not g:
                continue
            rings = [geo.open_ring(proj_pts([q for q in g if q]))]
        else:
            rings = geo.relation_rings(e)
        for ring in rings:
            if len(ring) < 3:
                continue
            area = abs(geo.signed_area(ring))
            if area < 150 and k not in (10,):
                continue
            ring = geo.simplify_ring(ring, 1.5)
            if len(ring) < 3:
                continue
            polys.append(ring)
            kinds.append(k)
            if k == 0 and area > 3000:
                cx, cz = geo.centroid(ring)
                c = district_r.cell(cx, cz)
                dist = (district_r.data[c[1], c[0]] - 1) if c and district_r.data[c[1], c[0]] > 0 else 255
                if dist != 255:
                    parks.append({"name": t.get("name:ru") or t.get("name") or "", "area": round(area),
                                  "x": round(cx, 1), "z": round(cz, 1), "d": int(dist), "i": len(polys) - 1})
    # drawing order: big first so small features stay visible
    order = sorted(range(len(polys)), key=lambda i: -abs(geo.signed_area(polys[i])))
    remap = {o: n for n, o in enumerate(order)}
    polys = [polys[i] for i in order]
    kinds = [kinds[i] for i in order]
    for p in parks:
        p["i"] = remap[p["i"]]
    blob, npts = encode_lines(polys, kinds, closed=True)
    # waterways & rail as extra line sections
    wl, wk = [], []
    for e in load("waterways")["elements"]:
        g = e.get("geometry")
        if not g:
            continue
        pts = geo.dp_simplify(proj_pts([q for q in g if q]), 1.5)
        if len(pts) < 2:
            continue
        wl.append(pts)
        wk.append({"river": 0, "canal": 1, "stream": 2}.get(e["tags"].get("waterway"), 2))
    rl, rk = [], []
    for e in load("rail")["elements"]:
        g = e.get("geometry")
        if not g:
            continue
        pts = geo.dp_simplify(proj_pts([q for q in g if q]), 1.0)
        if len(pts) < 2:
            continue
        rl.append(pts)
        rk.append({"rail": 0, "tram": 1, "light_rail": 1}.get(e["tags"].get("railway"), 0))
    wb, _ = encode_lines(wl, wk)
    rb, _ = encode_lines(rl, rk)
    for name, b in (("water", wb), ("rail", rb)):
        raw_bytes = b.buf.getvalue()
        for sec, info in b.sections.items():
            arr = np.frombuffer(raw_bytes, dtype=np.dtype(info["type"]).newbyteorder("<"),
                                count=info["length"], offset=info["offset"])
            blob.add(f"{name}_{sec}", arr)
    raw, gz = blob.save(os.path.join(OUT, "areas.bin.gz"))
    print(f"  areas.bin: {len(polys)} polygons ({npts} pts), {len(wl)} waterways, {len(rl)} rails, "
          f"{raw/1e6:.2f} MB -> {gz/1e6:.2f} MB gz")
    print("  area kinds", dict(collections.Counter(AREA_CLASSES[k] for k in kinds)))
    parks.sort(key=lambda p: -p["area"])
    return {"sections": blob.sections, "count": len(polys), "classes": AREA_CLASSES}, parks


# --------------------------------------------------------------------------- POIs

def build_pois(district_r):
    d = load("pois")
    pois = []
    for e in d["elements"]:
        t = e.get("tags", {})
        if e["type"] == "node":
            lat, lon = e["lat"], e["lon"]
        else:
            c = e.get("center")
            if not c:
                continue
            lat, lon = c["lat"], c["lon"]
        x, z = proj(lat, lon)
        am, sh, off, tour = t.get("amenity"), t.get("shop"), t.get("office"), t.get("tourism")
        if am == "school":
            k = "school"
        elif am == "kindergarten":
            k = "kindergarten"
        elif am in ("university", "college"):
            k = "university"
        elif am == "hospital":
            k = "hospital"
        elif am == "marketplace":
            k = "market"
        elif sh in ("mall", "department_store"):
            k = "mall"
        elif sh in ("supermarket", "wholesale"):
            k = "supermarket"
        elif am in ("townhall", "courthouse") or off == "government":
            k = "gov"
        elif off:
            k = "office"
        elif t.get("railway") in ("station", "halt"):
            if t.get("station") == "subway" or t.get("subway") == "yes":
                k = "metro"
            else:
                k = "station"
        elif t.get("aeroway") == "aerodrome":
            k = "airport"
        elif am == "bus_station":
            k = "busstation"
        elif t.get("man_made") in ("tower", "mast"):
            k = "tower"
        elif t.get("leisure") in ("stadium", "sports_centre", "ice_rink", "water_park"):
            k = "sport"
        elif tour in ("attraction", "museum", "viewpoint") or am == "theatre":
            k = "attraction"
        elif tour == "hotel":
            k = "hotel"
        else:
            continue
        c = district_r.cell(x, z)
        dist = (district_r.data[c[1], c[0]] - 1) if c and district_r.data[c[1], c[0]] > 0 else 255
        pois.append({"k": k, "x": round(x, 1), "z": round(z, 1), "d": int(dist),
                     "n": t.get("name:ru") or t.get("name") or "", "h": num(t.get("height"))})
    print("  pois", dict(collections.Counter(p["k"] for p in pois)))
    return pois


# --------------------------------------------------------------------------- zones

def build_zones(buildings, pois, districts, district_r, gnodes_xy, routable_node, segs_arr):
    xs = [b[5] for b in buildings]
    zs = [b[6] for b in buildings]
    gx0 = math.floor(min(xs) / ZONE_CELL) * ZONE_CELL
    gz0 = math.floor(min(zs) / ZONE_CELL) * ZONE_CELL

    def cell_of(x, z):
        return int((x - gx0) // ZONE_CELL), int((z - gz0) // ZONE_CELL)

    nd = len(districts)
    res = collections.defaultdict(lambda: np.zeros(nd))
    nonres = collections.defaultdict(float)
    wsum = collections.defaultdict(lambda: np.zeros(3))  # weighted centroid (x, z, w)
    dist_res = np.zeros(nd)
    for b in buildings:
        ring, typ, height, rfa, nfa, cx, cz, dist = b[:8]
        if dist == 255:
            continue
        c = cell_of(cx, cz)
        res[c][dist] += rfa
        dist_res[dist] += rfa
        jw = nfa * {T_COMM: 1 / 28, T_IND: 1 / 70, T_PUBLIC: 1 / 45, T_TOWER: 1 / 22}.get(typ, 0) + rfa / 420
        nonres[c] += jw
        w = rfa + nfa
        wsum[c] += (cx * w, cz * w, w)
    pop = collections.defaultdict(float)
    zone_dist = {}
    for c, v in res.items():
        p = 0.0
        for di in range(nd):
            if dist_res[di] > 0:
                p += districts[di]["pop"] * v[di] / dist_res[di]
        pop[c] = p
        zone_dist[c] = int(np.argmax(v)) if v.sum() > 0 else None
    jobs = collections.defaultdict(float, nonres)
    gov = collections.defaultdict(float)
    school = collections.defaultdict(float)
    uni = collections.defaultdict(float)
    retail = collections.defaultdict(float)
    for p in pois:
        if p["d"] == 255:
            continue
        c = cell_of(p["x"], p["z"])
        k = p["k"]
        if k == "school":
            school[c] += 1
            jobs[c] += 60
        elif k == "kindergarten":
            jobs[c] += 15
        elif k == "university":
            uni[c] += 1
            jobs[c] += 400
        elif k == "hospital":
            jobs[c] += 450
        elif k == "market":
            retail[c] += 6
            jobs[c] += 900
        elif k == "mall":
            retail[c] += 5
            jobs[c] += 700
        elif k == "supermarket":
            retail[c] += 0.6
            jobs[c] += 40
        elif k == "gov":
            gov[c] += 1
            jobs[c] += 160
        elif k == "office":
            jobs[c] += 45
        elif k in ("station", "airport", "busstation"):
            jobs[c] += 300
            retail[c] += 1
        elif k in ("attraction", "hotel", "sport"):
            retail[c] += 0.4
            jobs[c] += 40
        if zone_dist.get(c) is None:
            zone_dist[c] = p["d"]
    for c, v in nonres.items():
        retail[c] += v / 2500.0
    cells = set(pop) | set(jobs)
    tot_jobs = sum(jobs[c] for c in cells)
    tot_school = sum(school.values()) or 1
    tot_uni = sum(uni.values()) or 1
    tot_retail = sum(retail[c] for c in cells) or 1
    tot_gov = sum(gov.values()) or 1
    total_pop = sum(d["pop"] for d in districts)

    # routable graph nodes for connectors
    rn = np.where(routable_node)[0]
    rxy = gnodes_xy.reshape(-1, 2)[rn]
    zones = []
    for c in sorted(cells):
        P = pop[c]
        J = jobs[c] / tot_jobs * TOTAL_JOBS
        if P < 400 and J < 400:
            continue
        if zone_dist.get(c) is None:
            continue
        w = wsum[c]
        if w[2] > 0:
            cx, cz = w[0] / w[2], w[1] / w[2]
        else:
            cx, cz = gx0 + (c[0] + 0.5) * ZONE_CELL, gz0 + (c[1] + 0.5) * ZONE_CELL
        dd = np.hypot(rxy[:, 0] - cx, rxy[:, 1] - cz)
        order = np.argsort(dd)
        conn = []
        for k in order[:40]:
            if dd[k] > 2500 and conn:
                break
            if all(math.hypot(rxy[k, 0] - rxy[j, 0], rxy[k, 1] - rxy[j, 1]) > 250 for j in conn):
                conn.append(int(k))
            if len(conn) == 3:
                break
        zones.append({
            "x": round(cx, 1), "z": round(cz, 1), "d": zone_dist[c],
            "pop": round(P), "jobs": round(J),
            "gov": round(TOTAL_JOBS * GOV_JOB_SHARE * (0.5 * gov[c] / tot_gov + 0.5 * jobs[c] / tot_jobs)),
            "school": round(total_pop * PUPILS_PER_RESIDENT * school[c] / tot_school),
            "uni": round(UNI_STUDENTS * uni[c] / tot_uni),
            "retail": round(retail[c] / tot_retail * 10000, 2),
            "conn": [int(rn[k]) for k in conn],
            "connD": [round(float(dd[k]), 1) for k in conn],
        })
    print(f"  zones {len(zones)}; pop {sum(z['pop'] for z in zones):,.0f}; jobs {sum(z['jobs'] for z in zones):,.0f}; "
          f"pupils {sum(z['school'] for z in zones):,.0f}")
    return zones, {"x0": gx0, "z0": gz0, "cell": ZONE_CELL}


# --------------------------------------------------------------------------- main

def main():
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    print("boundaries")
    city_rings, districts = build_boundaries()
    city = city_rings[0]
    xs = [p[0] for p in city]
    zs = [p[1] for p in city]
    print(f"  city extent x {min(xs):.0f}..{max(xs):.0f}, z {min(zs):.0f}..{max(zs):.0f}")

    # 50 m rasters over the city with a margin
    M = 6000
    mask_r = Raster(min(xs) - M, min(zs) - M, max(xs) + M, max(zs) + M, 50.0)
    city_px = mask_r.fill_polys([(r, 1) for r in city_rings])
    dist_px = mask_r.fill_polys([(r, d["id"] + 1) for d in districts for r in d["rings"][:1]])
    dist_px[city_px == 0] = 0
    # pixels inside the city but in no district polygon -> nearest district
    holes = (city_px > 0) & (dist_px == 0)
    if holes.any():
        idx = ndimage.distance_transform_edt(dist_px == 0, return_distances=False, return_indices=True)
        dist_px[holes] = dist_px[idx[0][holes], idx[1][holes]]
    mask_r.data = dist_px
    dist_edt = ndimage.distance_transform_edt(city_px == 0) * mask_r.cs
    region_roads = dist_edt <= 3000
    region_bld = dist_edt <= 1200
    region_minor = dist_edt <= 1500

    print("terrain")
    tmeta, terr = build_terrain()
    blob = Blob()
    blob.add("h", terr.reshape(-1))
    raw, gz = blob.save(os.path.join(OUT, "terrain.bin.gz"))
    print(f"  terrain.bin {raw/1e6:.2f} MB -> {gz/1e6:.2f} MB gz")
    tmeta["sections"] = blob.sections

    print("roads")
    rmeta, gnodes_xy, routable_node, segs, segarr = build_roads(region_roads, mask_r, mask_r)
    print("minor roads")
    mmeta = build_minor(region_minor, mask_r)
    print("buildings")
    bmeta, buildings = build_buildings(region_bld, mask_r, mask_r)
    print("areas")
    ameta, parks = build_areas(region_minor, mask_r, mask_r, city)
    print("pois")
    pois = build_pois(mask_r)
    print("zones")
    zones, zgrid = build_zones(buildings, pois, districts, mask_r, gnodes_xy, routable_node, segarr)

    # district raster for the client at 100 m
    dr = dist_px[::2, ::2].astype(np.uint8)
    blob = Blob()
    blob.add("d", dr.reshape(-1))
    blob.save(os.path.join(OUT, "districts.bin.gz"))
    draster = {"x0": mask_r.x0, "z0": mask_r.z0, "cs": mask_r.cs * 2, "w": dr.shape[1], "h": dr.shape[0],
               "sections": blob.sections}

    # per-district statistics
    for d in districts:
        di = d["id"]
        d["areaKm2"] = round(float((dist_px == di + 1).sum()) * mask_r.cs ** 2 / 1e6, 1)
        d["schools"] = sum(1 for p in pois if p["k"] == "school" and p["d"] == di)
        d["parksM2"] = sum(p["area"] for p in parks if p["d"] == di)
        ring = d["rings"][0]
        d["cx"], d["cz"] = [round(v, 1) for v in geo.centroid(ring)]
        d["outline"] = [[round(x, 1), round(z, 1)] for x, z in geo.simplify_ring(ring, 12.0)]
        del d["rings"]
    # label anchors: pole of inaccessibility approximation = point deepest inside the district raster
    for d in districts:
        m = dist_px == d["id"] + 1
        edt = ndimage.distance_transform_edt(m)
        j, i = np.unravel_index(np.argmax(edt), edt.shape)
        d["lx"] = round(mask_r.x0 + (i + 0.5) * mask_r.cs, 1)
        d["lz"] = round(mask_r.z0 + (j + 0.5) * mask_r.cs, 1)

    landmarks = pick_landmarks(pois, parks)
    meta = {
        "version": 1,
        "built": time.strftime("%Y-%m-%d"),
        "origin": {"lat": geo.LAT0, "lon": geo.LON0, "kx": geo.KX, "kz": geo.KZ},
        "attribution": "© OpenStreetMap contributors (ODbL) · Terrain: AWS Terrain Tiles (SRTM)",
        "city": [[round(x, 1), round(z, 1)] for x, z in geo.simplify_ring(city, 12.0)],
        "districts": districts,
        "terrain": tmeta,
        "roads": rmeta,
        "minor": mmeta,
        "buildings": bmeta,
        "areas": ameta,
        "districtRaster": draster,
        "zones": zones,
        "zoneGrid": zgrid,
        "parks": parks,
        "pois": [p for p in pois if p["k"] in ("school", "university", "mall", "market", "gov", "hospital",
                                                 "station", "airport", "metro", "busstation", "tower",
                                                 "attraction", "sport")],
        "landmarks": landmarks,
    }
    with gzip.open(os.path.join(OUT, "meta.json.gz"), "wt", encoding="utf-8", compresslevel=9) as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))
    sizes = {os.path.basename(p): os.path.getsize(p) for p in glob.glob(os.path.join(OUT, "*.gz"))}
    print("outputs:", {k: f"{v/1e6:.2f} MB" for k, v in sizes.items()}, f"total {sum(sizes.values())/1e6:.2f} MB")
    print(f"done in {time.time() - t0:.0f}s")


LANDMARK_NAMES = [
    # (substring to match in POI name, label, kind)
    ("Кок-Тобе", "Кок-Тобе", "tower"),
    ("Көктөбе", "Кок-Тобе", "tower"),
    ("Медеу", "Медеу", "sport"),
    ("Шымбулак", "Шымбулак", "sport"),
    ("Esentai", "Esentai Mall", "mall"),
    ("Dostyk Plaza", "Dostyk Plaza", "mall"),
    ("MEGA", "MEGA Alma-Ata", "mall"),
    ("Алматы-1", "Вокзал Алматы-1", "station"),
    ("Алматы-2", "Вокзал Алматы-2", "station"),
    ("Международный аэропорт", "Аэропорт", "airport"),
    ("Аэропорт", "Аэропорт", "airport"),
    ("Зелёный базар", "Зелёный базар", "market"),
    ("Зеленый базар", "Зелёный базар", "market"),
    ("Барахолка", "Барахолка", "market"),
    ("Центральный стадион", "Центральный стадион", "sport"),
    ("Алматы Арена", "Алматы Арена", "sport"),
    ("Вознесенский", "Вознесенский собор", "attraction"),
]


def pick_landmarks(pois, parks):
    out = []
    used = set()
    for sub, label, kind in LANDMARK_NAMES:
        if label in used:
            continue
        for p in pois:
            if sub.lower() in (p["n"] or "").lower() and (p["k"] == kind or kind in ("attraction",)):
                out.append({"name": label, "x": p["x"], "z": p["z"], "k": kind, "h": p.get("h")})
                used.add(label)
                break
    for p in parks[:12]:
        if p["name"] and p["name"] not in used:
            out.append({"name": p["name"], "x": p["x"], "z": p["z"], "k": "park"})
            used.add(p["name"])
    # Republic Square is the origin
    out.append({"name": "Площадь Республики", "x": 0, "z": 0, "k": "square"})
    return out


if __name__ == "__main__":
    main()
