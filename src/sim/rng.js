// Small deterministic PRNG (mulberry32) so a campaign replays identically.
export function mulberry32(seed) {
  let a = seed >>> 0;
  const f = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.state = () => a;
  f.setState = v => { a = v >>> 0; };
  return f;
}

export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
