/** Deterministic seeded PRNG (mulberry32) — used by the fixture generator and tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian-ish noise via sum of three uniforms, scaled; cheap and smooth enough. */
export function noise(rand: () => number, sigma: number): number {
  return (rand() + rand() + rand() - 1.5) * sigma;
}
