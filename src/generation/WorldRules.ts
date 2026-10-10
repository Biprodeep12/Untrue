// World-scale rules layered over local generation (spec 3.5).

/** Hardcoded difficulty bands by distance from the origin, in tiles. */
export const DIFFICULTY_BANDS = [
  { name: 'Easy', maxDistance: 1000 },
  { name: 'Medium', maxDistance: 5000 },
  { name: 'Hard', maxDistance: 10000 },
  { name: 'Extreme', maxDistance: Infinity },
] as const;

export function distanceFromOrigin(gx: number, gy: number): number {
  return Math.hypot(gx, gy);
}

export function difficultyBand(gx: number, gy: number): number {
  const d = distanceFromOrigin(gx, gy);
  return DIFFICULTY_BANDS.findIndex((b) => d < b.maxDistance);
}
