/**
 * coastline.js
 * -----------------------------------------------------------------------
 * Procedural bathymetry (depth map) generator. This is the single source
 * of truth for "where is land vs. ocean, and how deep is the water" —
 * both the physics solver (wave speed depends on depth) and the visual
 * mesh (coastline shape, colors) read from the same depthFn, so they can
 * never disagree with each other.
 *
 * COASTLINE SHAPE
 * A pure sine-based edge would look obviously procedural/repetitive. We
 * layer three sine waves of different frequency + amplitude (basic
 * "Fourier" style terrain trick) so the coastline reads as an irregular,
 * natural bay/headland shape instead of a single clean wave. Cheap to
 * compute, no external heightmap/asset required.
 *
 * DEPTH PROFILE (this is the part that matters for realism)
 * Real bathymetry doesn't jump from 4000m deep ocean straight to a beach.
 * There's a continental shelf: a long, very gradual shallowing, THEN a
 * steeper drop near shore. We reproduce that with a smoothstep-based
 * transition rather than a linear ramp, because:
 *   - Linear depth ramps make waves shoal (slow down, amplify) at a
 *     constant rate the whole approach, which looks/feels mechanical.
 *   - A shelf profile keeps wave speed high and roughly constant across
 *     most of the ocean, then rapidly slows the wave only in the last
 *     stretch before the coast — which is exactly the real-world
 *     shoaling effect that makes tsunamis dramatically grow near shore.
 *
 * Depth convention (matches waveSolver.js): positive = underwater meters,
 * negative = land elevation in meters (used for rendering only; the
 * solver just checks depth <= 0 to treat a cell as dry land).
 */

// Coastline shape controls — tweak these to change bay/headland layout.
const COAST_BASE_ROW = 0.68; // fraction of grid depth (0=top/far edge, 1=coast side) where coastline centers
const COAST_WAVES = [
  { freq: 1.0, amp: 0.05, phase: 0.0 }, // broad bay curvature
  { freq: 3.0, amp: 0.025, phase: 1.3 }, // medium headland bumps
  { freq: 7.0, amp: 0.01, phase: 4.1 }, // small irregular jitter
];

const MAX_OCEAN_DEPTH = 4000; // meters, open ocean abyssal depth
const SHELF_START = 0.35; // fraction of distance-to-coast where continental shelf begins
const MAX_LAND_HEIGHT = 40; // meters, inland elevation for rendering

/**
 * Returns the coastline's row position (0..1, in grid-fraction units) at
 * a given horizontal fraction `u` (0..1) across the grid width. Combines
 * the layered sine waves described above.
 */
function coastlineRowAt(u) {
  let offset = 0;
  for (const w of COAST_WAVES) {
    offset += w.amp * Math.sin(u * Math.PI * 2 * w.freq + w.phase);
  }
  return COAST_BASE_ROW + offset;
}

/**
 * Smoothstep helper: smooth 0->1 transition with zero derivative at both
 * ends, used for the continental-shelf depth profile so wave speed
 * changes gradually (no artificial "kink" that would show up as a
 * spurious partial reflection in the solver).
 */
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Builds the depth function used by both the physics solver and the
 * ocean/terrain mesh.
 *
 * @param {number} gridSize grid cells per side (must match WaveSolver's gridSize)
 * @returns {(i:number, j:number) => number} depth in meters at cell (i,j)
 */
export function createCoastlineDepthFn(gridSize) {
  return function depthFn(i, j) {
    const u = i / (gridSize - 1); // 0..1 across width
    const v = j / (gridSize - 1); // 0..1 across depth (0=far/open ocean, 1=inland edge)

    const coastRow = coastlineRowAt(u);
    // Distance from this cell to the coastline, in grid-fraction units.
    // Positive = ocean side (v < coastRow), negative = inland side.
    const distToCoast = coastRow - v;

    if (distToCoast <= 0) {
      // INLAND: elevation rises the further inland you go, with a touch
      // of the same sine detail so the shoreline doesn't look perfectly
      // smooth where land meets water.
      const inlandT = Math.min(1, -distToCoast / (1 - coastRow + 0.001));
      return -MAX_LAND_HEIGHT * smoothstep(0, 1, inlandT) - 0.5;
    }

    // OCEAN: continental shelf profile. `distToCoast` ranges (0, coastRow].
    // Normalize so 0 = right at shore, 1 = far edge of the shelf region.
    const shelfT = Math.min(1, distToCoast / SHELF_START);
    // smoothstep gives the gentle-then-steep shelf curve described above;
    // clamp the minimum so cells immediately offshore are never 0m deep
    // (avoids a divide-by-zero c=0 cell sitting in open water).
    const depth = 6 + (MAX_OCEAN_DEPTH - 6) * smoothstep(0, 1, shelfT);
    return depth;
  };
}

/**
 * Convenience: finds the nearest deep-water grid cell to a given (i, j),
 * used by main.js to validate/snap earthquake clicks (PRD: epicenter
 * clicks in shallow water should be rejected with a message rather than
 * silently placed).
 *
 * @returns {boolean} true if (i, j) is deep enough to host an earthquake
 */
export function isValidEpicenter(depthFn, i, j, minDepth = 200) {
  const d = depthFn(i, j);
  return d >= minDepth;
}

/**
 * Approximate world-space Z coordinate of the coastline (averaged across
 * the sine jitter), in the domain's centered [-domainSize/2, domainSize/2]
 * coordinate system. Used by main.js to place the camera just inland of
 * the shore for a beach/drone-style framing instead of guessing a fixed
 * fraction of the domain.
 */
export function approxCoastlineZ(domainSize) {
  return (COAST_BASE_ROW - 0.5) * domainSize;
}
