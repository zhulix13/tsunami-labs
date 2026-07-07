/**
 * waveSolver.js
 * -----------------------------------------------------------------------
 * Core tsunami propagation physics. NO Three.js imports here on purpose —
 * this module is pure math on typed arrays, so it can be unit-tested or
 * reused (e.g. in a Web Worker) without dragging in rendering code.
 *
 * PHYSICS MODEL
 * We use the classic 2D linear wave equation on a heightfield, rather than
 * full nonlinear shallow-water equations (which solve coupled height +
 * momentum/velocity vector fields). The wave equation is:
 *
 *      d²h/dt² = c(x,y)² * Laplacian(h) - damping * dh/dt
 *
 * where c(x,y) = sqrt(g * depth(x,y))  <-- shallow water wave speed
 *
 * This single equation still reproduces the real behaviour that matters
 * for a tsunami demo:
 *   - Waves radiate outward from a disturbance in circular fronts
 *   - Waves SLOW DOWN and pile up (shoal) as they enter shallow water,
 *     because c depends on local depth
 *   - Waves reflect off the coastline
 *   - Energy dissipates over time via damping
 *
 * It does NOT model true nonlinear shoaling run-up or mass transport
 * (that needs full shallow-water equations with a velocity field), but
 * visually and behaviourally it reads as a very convincing tsunami for
 * an MVP, and it's ~1/3 the code and complexity.
 *
 * NUMERICAL METHOD: explicit finite-difference time-stepping using THREE
 * height buffers (previous, current, next) — this is the standard
 * "leapfrog" scheme for the wave equation:
 *
 *      h_next[i][j] = 2*h_cur[i][j] - h_prev[i][j]
 *                     + (c² * dt² / dx²) * laplacian(h_cur)[i][j]
 *                     - damping * dt * (h_cur[i][j] - h_prev[i][j])
 *
 * CFL STABILITY CONDITION
 * Explicit wave solvers blow up (NaN city) if the timestep is too large
 * relative to grid spacing and wave speed. The CFL condition requires:
 *
 *      c_max * dt / dx  <=  1 / sqrt(2)   (for a 2D 5-point stencil)
 *
 * We compute the max safe dt from c_max and dx, and the "simulation
 * speed" control (1x-20x) scales the number of SUBSTEPS per frame, never
 * the timestep itself. This keeps the sim stable no matter how fast the
 * user cranks the speed slider.
 */

export class WaveSolver {
  /**
   * @param {number} gridSize   number of cells per side (square grid)
   * @param {number} domainSize physical size of the domain in meters
   */
  constructor(gridSize = 150, domainSize = 200000) {
    this.gridSize = gridSize;
    this.domainSize = domainSize; // meters (~200km domain)
    this.dx = domainSize / gridSize; // meters per cell

    const n = gridSize * gridSize;

    // Three height buffers for the leapfrog scheme.
    this.hPrev = new Float32Array(n);
    this.hCur = new Float32Array(n);
    this.hNext = new Float32Array(n);

    // Depth field (meters, positive = underwater). Land cells are
    // encoded as negative depth. Populated via setDepthField().
    this.depth = new Float32Array(n).fill(4000); // default: deep ocean

    // Precomputed wave-speed-squared field (c² = g * depth), rebuilt
    // whenever depth changes, so step() doesn't recompute sqrt/mult
    // every frame for every cell.
    this.cSquared = new Float32Array(n);

    this.gravity = 9.81;
    this.damping = 0.003; // halved from 0.006 — lets waves retain energy
    // across the full domain before fading

    // Sponge layer absorbs waves at the open ocean edges so they don't
    // reflect back in. Only the coastline should reflect naturally.
    this.spongeWidth = Math.floor(gridSize * 0.08);
    this.spongeStrength = 0.06;

    this._maxCSquared = this.gravity * 4000;
    this._recomputeMaxDt();
  }

  /** Convert (i, j) grid coords to flat array index. */
  idx(i, j) {
    return j * this.gridSize + i;
  }

  /**
   * Supply the bathymetry (depth at every cell). `depthFn(i, j)` should
   * return meters of water depth (positive = ocean, negative = land).
   * Called once at scene setup by coastline.js.
   */
  setDepthField(depthFn) {
    const n = this.gridSize;
    let maxC2 = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const d = depthFn(i, j);
        const idx = this.idx(i, j);
        this.depth[idx] = d;
        // Wave speed only defined for wet cells; land cells get c²=0
        // so the solver simply doesn't propagate waves onto dry land
        // (flooding is out of scope for this MVP).
        const c2 = d > 0 ? this.gravity * d : 0;
        this.cSquared[idx] = c2;
        if (c2 > maxC2) maxC2 = c2;
      }
    }
    this._maxCSquared = maxC2;
    this._recomputeMaxDt();
  }

  /** Recompute the CFL-safe max timestep whenever depth/grid changes. */
  _recomputeMaxDt() {
    const cMax = Math.sqrt(this._maxCSquared) || 1;
    // CFL limit for 2D explicit leapfrog with a 5-point Laplacian stencil.
    this.maxDt = (this.dx / cMax) * (1 / Math.SQRT2) * 0.9; // 0.9 = safety margin
  }

  /**
   * Inject an earthquake as an instantaneous seafloor displacement —
   * a Gaussian bump (uplift), the classic simplified tsunami source
   * model. Magnitude controls both amplitude and radius, matching real
   * earthquakes where bigger Mw ruptures a larger fault area and
   * displaces more water.
   *
   * @param {number} gi        epicenter grid x
   * @param {number} gj        epicenter grid y
   * @param {number} magnitude Mw, expected range 6.0 - 9.5
   */
  triggerEarthquake(gi, gj, magnitude) {
    // Empirical-ish scaling: real tsunami source heights for Mw 6-9.5
    // roughly span tens of cm to several meters. This isn't a seismology
    // model, just a monotonic curve that "feels" right across the range
    // and is documented here so it's easy to retune.
    // Bumped base amplitude and exponent (was 0.15 / 0.35) — the original
    // curve was too conservative at the lower/mid end of the magnitude
    // range and produced barely-visible sources. This still scales
    // monotonically with Mw, just with more punch across the whole range.
    const amplitude = 0.6 * Math.pow(10, (magnitude - 6.0) * 0.4); // meters
    const radiusCells = 4 + (magnitude - 6.0) * 2.5; // grid cells

    const n = this.gridSize;
    const sigma2 = radiusCells * radiusCells;

    // Splat a Gaussian directly into hCur AND hPrev (both equal, zero
    // initial velocity) so the source starts at rest, not already moving —
    // that's what makes concentric rings radiate outward symmetrically
    // rather than the sim producing an initial-velocity artifact.
    const spread = Math.ceil(radiusCells * 3);
    for (let dj = -spread; dj <= spread; dj++) {
      const j = gj + dj;
      if (j < 0 || j >= n) continue;
      for (let di = -spread; di <= spread; di++) {
        const i = gi + di;
        if (i < 0 || i >= n) continue;
        const idx = this.idx(i, j);
        if (this.depth[idx] <= 0) continue; // don't displace land cells
        const r2 = di * di + dj * dj;
        const bump = amplitude * Math.exp(-r2 / (2 * sigma2));
        this.hCur[idx] += bump;
        this.hPrev[idx] += bump;
      }
    }
  }

  /**
   * Advance the simulation by `dt` seconds. Caller (main.js) is
   * responsible for calling this in a substep loop so that
   * substeps * dt = one rendered frame's worth of sim time, and for
   * clamping dt itself to <= this.maxDt for stability.
   */
  step(dt) {
    const n = this.gridSize;
    const dx2 = this.dx * this.dx;
    const { hPrev, hCur, hNext, cSquared, depth } = this;

    const damping = this.damping;
    const spongeWidth = this.spongeWidth;
    const spongeStrength = this.spongeStrength;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;

        if (depth[idx] <= 0) {
          // Land: stays flat. (No flooding physics in this MVP.)
          hNext[idx] = 0;
          continue;
        }

        const idxL = i > 0 ? idx - 1 : idx;
        const idxR = i < n - 1 ? idx + 1 : idx;
        const idxU = j > 0 ? idx - n : idx;
        const idxD = j < n - 1 ? idx + n : idx;

        const hL = hCur[idxL];
        const hR = hCur[idxR];
        const hU = hCur[idxU];
        const hD = hCur[idxD];
        const hC = hCur[idx];

        const laplacian = (hL + hR + hU + hD - 4 * hC) / dx2;

        const c2 = cSquared[idx];
        const accelTerm = c2 * laplacian * dt * dt;
        const velocityTerm = hC - hPrev[idx]; // implicit velocity * dt

        let next = 2 * hC - hPrev[idx] + accelTerm;

        // Damping (bottom friction proxy): bleed off velocity each step
        // so wave energy decays gradually instead of oscillating forever.
        next -= damping * velocityTerm;

        // Sponge layer: absorb outgoing waves at the FAR (j=0),
        // LEFT (i=0), and RIGHT (i=n-1) edges to prevent open-boundary
        // reflections from bouncing back into the domain.
        let dampT = 0;
        if (j < spongeWidth) dampT = Math.max(dampT, 1 - j / spongeWidth);
        if (i < spongeWidth) dampT = Math.max(dampT, 1 - i / spongeWidth);
        if (n - 1 - i < spongeWidth) dampT = Math.max(dampT, 1 - (n - 1 - i) / spongeWidth);
        
        if (dampT > 0) next *= 1 - spongeStrength * dampT;

        hNext[idx] = next;
      }
    }

    // Rotate buffers: next becomes current, current becomes previous.
    // We swap references instead of copying arrays — O(1) instead of
    // O(n), matters at 150x150+ grids running multiple substeps/frame.
    const temp = this.hPrev;
    this.hPrev = this.hCur;
    this.hCur = this.hNext;
    this.hNext = temp;
  }

  /** Zero out all wave state (used by Reset — clears water, physics keeps depth). */
  reset() {
    this.hPrev.fill(0);
    this.hCur.fill(0);
    this.hNext.fill(0);
  }

  /** Current height field, for the renderer to read (do not mutate). */
  getHeightField() {
    return this.hCur;
  }
}
