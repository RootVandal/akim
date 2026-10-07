"""Download raw OpenStreetMap + terrain data for Almaty into raw/.

    python tools/fetch_osm.py

Everything is cached: re-running only fetches what is missing.
Data: (c) OpenStreetMap contributors, ODbL. Terrain: AWS Terrain Tiles
(Terrarium encoding; SRTM/GMTED/ETOPO, public domain / open licences).
"""
import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from overpass import HEADERS, RAW, query  # noqa: E402

# Bounding box for vector data: the city (43.033..43.404, 76.742..77.167)
# plus a margin so the highways entering the city are kept.
S, W, N, E = 43.02, 76.70, 43.43, 77.21
BB = f"{S},{W},{N},{E}"

# Terrain covers the mountains south of the city as a backdrop.
TERRAIN_Z = 12
T_S, T_W, T_N, T_E = 42.92, 76.50, 43.52, 77.40


def fetch_vectors():
    print("boundaries...", flush=True)
    query('[out:json][timeout:300];rel(2465058);out geom;rel(2465058);map_to_area->.c;'
          'rel(area.c)["boundary"="administrative"]["admin_level"="6"];out geom;', name="boundaries")

    print("major roads (with node ids)...", flush=True)
    query(f'[out:json][timeout:600];'
          f'way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"]({BB})->.w;'
          f'.w out body;.w >;out skel qt;', name="roads_major")

    print("minor roads...", flush=True)
    query(f'[out:json][timeout:600];'
          f'way["highway"~"^(residential|unclassified|living_street)$"]({BB});out tags geom qt;',
          name="roads_minor")

    print("railways...", flush=True)
    query(f'[out:json][timeout:300];way["railway"~"^(rail|tram|light_rail)$"]({BB});out tags geom qt;',
          name="rail")

    print("areas (parks, water, forest, landuse)...", flush=True)
    query(f'[out:json][timeout:900];('
          f'way["leisure"~"^(park|garden|pitch|stadium|playground|golf_course|nature_reserve)$"]({BB});'
          f'rel["leisure"~"^(park|garden|stadium|golf_course|nature_reserve)$"]({BB});'
          f'way["landuse"~"^(forest|grass|meadow|cemetery|industrial|railway|construction|brownfield|'
          f'recreation_ground|allotments|orchard|farmland|residential|commercial|retail|garages|'
          f'village_green|greenfield|military)$"]({BB});'
          f'rel["landuse"~"^(forest|grass|meadow|cemetery|industrial|residential|recreation_ground|'
          f'commercial|retail|allotments|orchard|farmland)$"]({BB});'
          f'way["natural"~"^(wood|water|scrub|grassland|heath|bare_rock|scree|glacier)$"]({BB});'
          f'rel["natural"~"^(wood|water|scrub|grassland|glacier)$"]({BB});'
          f'way["amenity"~"^(school|university|college|hospital|kindergarten)$"]({BB});'
          f');out tags geom qt;', name="areas")

    print("waterways...", flush=True)
    query(f'[out:json][timeout:300];way["waterway"~"^(river|canal|stream)$"]({BB});out tags geom qt;',
          name="waterways")

    print("points of interest...", flush=True)
    query(f'[out:json][timeout:600];('
          f'nwr["amenity"~"^(school|university|college|kindergarten|hospital|marketplace|townhall|'
          f'bus_station|courthouse|theatre)$"]({BB});'
          f'nwr["shop"~"^(mall|supermarket|department_store|wholesale)$"]({BB});'
          f'nwr["office"]({BB});'
          f'nwr["tourism"~"^(attraction|museum|hotel|viewpoint)$"]({BB});'
          f'nwr["railway"~"^(station|halt)$"]({BB});'
          f'nwr["aeroway"="aerodrome"]({BB});'
          f'nwr["man_made"~"^(tower|mast)$"]["height"]({BB});'
          f'nwr["leisure"~"^(stadium|sports_centre|water_park|ice_rink)$"]["name"]({BB});'
          f');out tags center qt;', name="pois")

    # Buildings: 182k ways inside the city, fetched in small tiles to stay
    # under Overpass time/memory limits on a busy server.
    rows, cols = 5, 6
    for r in range(rows):
        for c in range(cols):
            s = S + (N - S) * r / rows
            n = S + (N - S) * (r + 1) / rows
            w = W + (E - W) * c / cols
            e = W + (E - W) * (c + 1) / cols
            name = f"bld2_{r}{c}"
            print(f"buildings tile {name}...", flush=True)
            query(f'[out:json][timeout:120];'
                  f'(way["building"]({s:.5f},{w:.5f},{n:.5f},{e:.5f});'
                  f'rel["building"]({s:.5f},{w:.5f},{n:.5f},{e:.5f}););out tags geom qt;', name=name,
                  attempts=14)
            time.sleep(2)


def lonlat_to_tile(lon, lat, z):
    import math
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def fetch_terrain():
    d = os.path.join(RAW, "terrain")
    os.makedirs(d, exist_ok=True)
    x0, y0 = lonlat_to_tile(T_W, T_N, TERRAIN_Z)
    x1, y1 = lonlat_to_tile(T_E, T_S, TERRAIN_Z)
    xs = range(int(x0), int(x1) + 1)
    ys = range(int(y0), int(y1) + 1)
    total = len(xs) * len(ys)
    done = 0
    for ty in ys:
        for tx in xs:
            p = os.path.join(d, f"{TERRAIN_Z}_{tx}_{ty}.png")
            done += 1
            if os.path.exists(p):
                continue
            url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{TERRAIN_Z}/{tx}/{ty}.png"
            for attempt in range(5):
                try:
                    r = requests.get(url, headers=HEADERS, timeout=60)
                    if r.status_code == 200:
                        with open(p, "wb") as f:
                            f.write(r.content)
                        break
                except Exception as e:  # retry on hiccups
                    print("  terrain retry", e)
                time.sleep(2 + attempt * 3)
            print(f"terrain {done}/{total}", flush=True)


if __name__ == "__main__":
    what = sys.argv[1:] or ["vectors", "terrain"]
    if "terrain" in what:
        fetch_terrain()
    if "vectors" in what:
        fetch_vectors()
    print("done")
