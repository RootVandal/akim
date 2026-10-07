"""Geometry helpers for the data build: projection, rings, simplification, rasters."""
import math

import numpy as np

# Local tangent plane centred on Republic Square (Площадь Республики).
LAT0, LON0 = 43.2383, 76.9453
_phi = math.radians(LAT0)
KZ = 111132.954 - 559.822 * math.cos(2 * _phi) + 1.175 * math.cos(4 * _phi)  # m per deg lat
KX = 111412.84 * math.cos(_phi) - 93.5 * math.cos(3 * _phi) + 0.118 * math.cos(5 * _phi)  # m per deg lon


def proj(lat, lon):
    """lat/lon -> (x east, z south) in metres."""
    return (lon - LON0) * KX, (LAT0 - lat) * KZ


def unproj(x, z):
    return LAT0 - z / KZ, LON0 + x / KX


def proj_pts(geom):
    return [proj(p["lat"], p["lon"]) for p in geom]


def signed_area(pts):
    a = 0.0
    n = len(pts)
    for i in range(n):
        x1, z1 = pts[i]
        x2, z2 = pts[(i + 1) % n]
        a += x1 * z2 - x2 * z1
    return a / 2.0


def centroid(pts):
    a = signed_area(pts)
    if abs(a) < 1e-6:
        xs = [p[0] for p in pts]
        zs = [p[1] for p in pts]
        return sum(xs) / len(xs), sum(zs) / len(zs)
    cx = cz = 0.0
    n = len(pts)
    for i in range(n):
        x1, z1 = pts[i]
        x2, z2 = pts[(i + 1) % n]
        f = x1 * z2 - x2 * z1
        cx += (x1 + x2) * f
        cz += (z1 + z2) * f
    return cx / (6 * a), cz / (6 * a)


def dp_simplify(pts, tol):
    """Douglas-Peucker for an open polyline (list of (x, z))."""
    n = len(pts)
    if n < 3:
        return list(pts)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        ax, az = pts[a]
        bx, bz = pts[b]
        dx, dz = bx - ax, bz - az
        L2 = dx * dx + dz * dz
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, pz = pts[i]
            if L2 < 1e-12:
                d = (px - ax) ** 2 + (pz - az) ** 2
            else:
                t = ((px - ax) * dx + (pz - az) * dz) / L2
                t = 0.0 if t < 0 else 1.0 if t > 1 else t
                qx, qz = ax + t * dx, az + t * dz
                d = (px - qx) ** 2 + (pz - qz) ** 2
            if d > best:
                best, bi = d, i
        if bi >= 0 and best > tol * tol:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, k in zip(pts, keep) if k]


def simplify_ring(pts, tol):
    """Simplify a closed ring given without the repeated closing point."""
    if len(pts) <= 4:
        return list(pts)
    # split at the vertex farthest from the first one so both halves are open lines
    x0, z0 = pts[0]
    far = max(range(len(pts)), key=lambda i: (pts[i][0] - x0) ** 2 + (pts[i][1] - z0) ** 2)
    a = dp_simplify(pts[: far + 1], tol)
    b = dp_simplify(pts[far:] + [pts[0]], tol)
    out = a[:-1] + b[:-1]
    return out if len(out) >= 3 else list(pts)


def open_ring(pts):
    """Drop the closing duplicate and consecutive duplicates."""
    out = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) > 1e-3 or abs(p[1] - out[-1][1]) > 1e-3:
            out.append(p)
    if len(out) > 1 and abs(out[0][0] - out[-1][0]) < 1e-3 and abs(out[0][1] - out[-1][1]) < 1e-3:
        out.pop()
    return out


def assemble_rings(member_ways):
    """Join way geometries (lists of (x, z)) end-to-end into closed rings."""
    def key(p):
        return (round(p[0], 2), round(p[1], 2))

    pending = [list(w) for w in member_ways if len(w) >= 2]
    rings = []
    while pending:
        cur = pending.pop()
        changed = True
        while key(cur[0]) != key(cur[-1]) and changed:
            changed = False
            for i, w in enumerate(pending):
                if key(w[0]) == key(cur[-1]):
                    cur += w[1:]
                elif key(w[-1]) == key(cur[-1]):
                    cur += w[::-1][1:]
                elif key(w[-1]) == key(cur[0]):
                    cur = w[:-1] + cur
                elif key(w[0]) == key(cur[0]):
                    cur = w[::-1][:-1] + cur
                else:
                    continue
                pending.pop(i)
                changed = True
                break
        ring = open_ring(cur)
        if len(ring) >= 3:
            rings.append(ring)
    return rings


def relation_rings(rel, role="outer"):
    ways = []
    for m in rel.get("members", []):
        if m["type"] == "way" and m.get("role", "outer") in (role, "") and "geometry" in m:
            g = [p for p in m["geometry"] if p]
            ways.append(proj_pts(g))
    return assemble_rings(ways)


class Raster:
    """Axis-aligned raster over the local plane: cell (i, j) covers x0+i*cs .. x0+(i+1)*cs."""

    def __init__(self, x0, z0, x1, z1, cs):
        self.x0, self.z0, self.cs = x0, z0, cs
        self.w = int(math.ceil((x1 - x0) / cs))
        self.h = int(math.ceil((z1 - z0) / cs))

    def to_px(self, pts):
        return [((x - self.x0) / self.cs, (z - self.z0) / self.cs) for x, z in pts]

    def cell(self, x, z):
        i = int((x - self.x0) / self.cs)
        j = int((z - self.z0) / self.cs)
        if 0 <= i < self.w and 0 <= j < self.h:
            return i, j
        return None

    def fill_polys(self, polys_with_values, dtype=np.uint8, background=0):
        """Rasterize polygons; later polygons overwrite earlier ones."""
        from PIL import Image, ImageDraw
        mode = "L" if dtype == np.uint8 else "I"
        img = Image.new(mode, (self.w, self.h), background)
        d = ImageDraw.Draw(img)
        for pts, val in polys_with_values:
            if len(pts) >= 3:
                d.polygon(self.to_px(pts), fill=int(val))
        return np.array(img, dtype=dtype)


def point_in_poly(x, z, pts):
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, zi = pts[i]
        xj, zj = pts[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def polyline_length(pts):
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))
