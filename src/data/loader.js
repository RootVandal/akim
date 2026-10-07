// Loads the gzipped data files produced by tools/build_data.py.
// Works on the main thread and inside workers (fetch + DecompressionStream).

const TYPED = {
  uint8: Uint8Array, int8: Int8Array, uint16: Uint16Array, int16: Int16Array,
  uint32: Uint32Array, int32: Int32Array, float32: Float32Array, float64: Float64Array,
};

export const DATA_URL = new URL('../../data/', import.meta.url);

async function gunzip(response, onBytes) {
  if (!response.ok) throw new Error(`${response.url}: HTTP ${response.status}`);
  let body = response.body;
  if (onBytes) {
    let n = 0;
    body = body.pipeThrough(new TransformStream({
      transform(chunk, ctl) { n += chunk.byteLength; onBytes(n); ctl.enqueue(chunk); },
    }));
  }
  const stream = body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export async function fetchBin(name, onBytes) {
  const res = await fetch(new URL(name, DATA_URL));
  return gunzip(res, onBytes);
}

export async function fetchMeta() {
  const buf = await fetchBin('meta.json.gz');
  return JSON.parse(new TextDecoder().decode(buf));
}

/** Typed views over the named sections of a blob. */
export function sections(buf, secs) {
  const out = {};
  for (const [k, s] of Object.entries(secs)) out[k] = new TYPED[s.type](buf, s.offset, s.length);
  return out;
}

/**
 * Decode polylines/rings stored as origin (int32 dm) + int16 deltas (dm).
 * Returns { count, kind, start: Uint32Array(count+1), xz: Float32Array(2*points) } in metres.
 */
export function decodeLines(sec, prefix = '') {
  const count = sec[prefix + 'count'];
  const kind = sec[prefix + 'kind'];
  const origin = sec[prefix + 'origin'];
  const delta = sec[prefix + 'delta'];
  const n = count.length;
  const start = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + count[i];
  const xz = new Float32Array(start[n] * 2);
  let d = 0;
  for (let i = 0; i < n; i++) {
    let x = origin[2 * i], z = origin[2 * i + 1];
    let o = start[i] * 2;
    xz[o++] = x * 0.1; xz[o++] = z * 0.1;
    for (let k = 1; k < count[i]; k++) {
      x += delta[d++]; z += delta[d++];
      xz[o++] = x * 0.1; xz[o++] = z * 0.1;
    }
  }
  return { count: n, kind, start, xz };
}

export async function loadRoads(meta, onBytes) {
  const buf = await fetchBin('roads.bin.gz', onBytes);
  return sections(buf, meta.roads.sections);
}

/** Everything the renderer needs. */
export async function loadAll(onProgress) {
  const prog = {};
  const report = (k, n) => { prog[k] = n; onProgress && onProgress(prog); };
  const meta = await fetchMeta();
  const [roads, minor, buildings, areas, terrain, districts] = await Promise.all([
    fetchBin('roads.bin.gz', n => report('roads', n)),
    fetchBin('minor.bin.gz', n => report('minor', n)),
    fetchBin('buildings.bin.gz', n => report('buildings', n)),
    fetchBin('areas.bin.gz', n => report('areas', n)),
    fetchBin('terrain.bin.gz', n => report('terrain', n)),
    fetchBin('districts.bin.gz', n => report('districts', n)),
  ]);
  return {
    meta,
    roads: sections(roads, meta.roads.sections),
    minor: sections(minor, meta.minor.sections),
    buildings: sections(buildings, meta.buildings.sections),
    areas: sections(areas, meta.areas.sections),
    terrain: sections(terrain, meta.terrain.sections),
    districts: sections(districts, meta.districtRaster.sections),
  };
}
