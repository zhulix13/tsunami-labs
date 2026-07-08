/**
 * main.js
 * -----------------------------------------------------------------------
 * Entry point: builds the scene, wires solver <-> ocean mesh <-> GUI,
 * handles click-to-quake raycasting, and runs the render/physics loop.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { WaveSolver } from "./physics/waveSolver.js";
import {
  createCoastlineDepthFn,
  isValidEpicenter,
  approxCoastlineZ,
} from "./scene/coastline.js";
import { createOceanMesh } from "./scene/ocean.js";
import { setupLights } from "./scene/lights.js";
import { createControls } from "./ui/controls.js";
import { setupSky } from "./scene/sky.js";

// --- Config -------------------------------------------------------------
const GRID_SIZE = 150;
const DOMAIN_SIZE = 200000; // meters (~200km)

// Step size for the wave physics. We use solver.maxDt (the CFL-safe
// maximum) so the propagation coupling factor c²·dt²/dx² ≈ 0.4, which
// gives visible, fast-moving waves. Using a much smaller dt (e.g. 0.05s)
// shrinks that factor to ~0.00005 — essentially zero — and waves stop
// propagating entirely. The old "strobe" was caused by an accumulator
// that only fired once every ~30 frames; we fix that by always running
// at least `state.speed` steps per frame unconditionally instead.
// Defined after solver.setDepthField() below where maxDt is finalised.
let SIM_DT; // assigned after solver is ready

// --- Shared state (read/written by GUI, render loop, and click handler) -
const state = {
  magnitude: 8.0,
  isPlaying: true,
  exaggeration: 600,
  speed: 8,
  hypocenterDepth: 20,
  faultDirection: 90,
};

// --- Physics + bathymetry -------------------------------------------------
const depthFn = createCoastlineDepthFn(GRID_SIZE);
const solver = new WaveSolver(GRID_SIZE, DOMAIN_SIZE);
solver.setDepthField(depthFn);

// Assign after setDepthField() so maxDt reflects the actual bathymetry.
// This is the CFL-safe timestep (~4.3 s for 150-cell / 200 km domain).
// Slightly reduced to 85% of the CFL limit for a comfortable stability margin.
SIM_DT = solver.maxDt * 0.85;

// --- Renderer / scene / camera -------------------------------------------
const canvas = document.querySelector("#app");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.8;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Sky background will be set by setupSky() below; start with a placeholder
// so nothing looks broken while the async load is in flight.
const skyColor = new THREE.Color(0x87ceeb);
scene.background = skyColor;

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  1,
  DOMAIN_SIZE * 3,
);

// Beach/drone framing: camera sits low, just inland of the shoreline,
// looking out across the ocean toward the domain center — matching a
// real drone-at-the-beach shot rather than a top-down survey view.
const coastZ = approxCoastlineZ(DOMAIN_SIZE);
const CAMERA_INLAND_OFFSET = DOMAIN_SIZE * 0.14;
const CAMERA_ALTITUDE = DOMAIN_SIZE * 0.003; // ~600m at default domain size
camera.position.set(0, CAMERA_ALTITUDE, coastZ + CAMERA_INLAND_OFFSET);

const orbitTarget = new THREE.Vector3(0, 0, 0);

// Fog — the outer padding cells on the ocean mesh extend ~53 km beyond
// the physics domain. Setting fogFar to 1.4× the sightline distance
// ensures those cells are at full opacity before their geometric edge.
const farEdgePoint = new THREE.Vector3(0, 0, -DOMAIN_SIZE / 2);
const sightlineDistance = camera.position.distanceTo(farEdgePoint);
const fog = new THREE.Fog(
  skyColor,
  sightlineDistance * 0.50,  // fog starts at 50% of sightline
  sightlineDistance * 1.40,  // fog full at 140% — covers outer ring edges
);
scene.fog = fog;

// --- OrbitControls -------------------------------------------------------
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.copy(orbitTarget);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.minDistance = DOMAIN_SIZE * 0.01;
orbit.maxDistance = sightlineDistance * 0.85;
// Panning moves the target in the XZ ground plane only, never vertically.
// This is the primary safeguard against panning the pivot above sea level.
orbit.screenSpacePanning = false;

// Compute the starting polar angle from the actual camera→target vector
// so our clamps are geometry-accurate rather than guessed fractions of π.
// Polar angle in OrbitControls = angle from +Y axis (0 = straight up, π/2 = horizontal, π = down).
// The camera starts slightly above horizontal (looking slightly downward toward the ocean).
const _camToTarget = new THREE.Vector3().subVectors(
  orbitTarget,
  camera.position,
);
const startPolar = Math.acos(
  THREE.MathUtils.clamp(_camToTarget.normalize().y, -1, 1),
); // angle from +Y to the camera→target direction

// Allow tilting UP by at most ~35° above the starting view — enough headroom
// to pull the drone view up and see more sky + ocean horizon, while the
// absolute floor (30°) still prevents flipping fully overhead.
// DOWN allows ~80° below start (wide ground/coast view).
orbit.minPolarAngle = Math.max(
  startPolar - THREE.MathUtils.degToRad(35),
  THREE.MathUtils.degToRad(30),
);
orbit.maxPolarAngle = Math.min(
  startPolar + THREE.MathUtils.degToRad(80),
  THREE.MathUtils.degToRad(180),
);

// Left/right: allow ±70° from the initial heading — enough to pan along
// the coast but not rotate behind it to see the geometry edges.
orbit.minAzimuthAngle = -THREE.MathUtils.degToRad(70);
orbit.maxAzimuthAngle = THREE.MathUtils.degToRad(70);

// --- Lights + ocean mesh (initial setup with placeholder sun direction) ---
const { sunDirection } = setupLights(scene, DOMAIN_SIZE);

// Pass `fog` so the shader initialises fog uniforms to match scene.fog.
const {
  mesh: oceanMesh,
  update: updateOcean,
  updateFog,
  visualDomainSize,
} = createOceanMesh(
  GRID_SIZE,
  DOMAIN_SIZE,
  depthFn,
  sunDirection,
  skyColor,
  fog,
);
scene.add(oceanMesh);


// --- Sky (async — loads equirectangular texture or falls back to Sky) ----
// setupSky() returns updated sunDirection + skyColor which we apply to the
// ocean shader uniforms so specular glint + fresnel match the real sky.
setupSky(scene, renderer, DOMAIN_SIZE, fog)
  .then(({ sunDirection: skyDir, skyColor: skyCol }) => {
    // Sync ocean shader with sky's sun + color
    oceanMesh.material.uniforms.uSunDirection.value.copy(skyDir);
    oceanMesh.material.uniforms.uSkyColor.value.copy(skyCol);
    // Re-sync fog so the ocean shader edge/depth fades match the sky
    updateFog(fog);
    // Also update the bg ocean plane so its fog-blend colour matches
    // the sky (important when an HDR panorama changes the fog tint)
    // We don't copy the fog colour directly; the bg plane uses scene.fog
    // automatically via MeshBasicMaterial fog:true — no extra work needed.
  })
  .catch((err) => {
    console.warn(
      "[main] Sky setup failed, keeping placeholder sky color.",
      err,
    );
  });

// --- Click-to-quake raycasting --------------------------------------------
// The pickPlane covers the FULL visual mesh (physics domain + outer padding)
// so clicks anywhere on the ocean — including the extended outer ring — are
// detected. worldToGrid then clamps UV to the physics range so outer-ring
// clicks snap to the nearest valid ocean cell rather than returning nothing.
const pickPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(visualDomainSize, visualDomainSize),
  new THREE.MeshBasicMaterial({ visible: false }),
);
pickPlane.rotateX(-Math.PI / 2);
scene.add(pickPlane);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const statusEl = document.querySelector("#status");

function worldToGrid(point) {
  // Normalise world XZ to [0,1] over the PHYSICS domain (not the full visual
  // domain). Clamping to [0,1] maps any outer-ring click to the nearest
  // physics boundary cell — so the user can click anywhere on the ocean.
  const u = Math.max(0, Math.min(1, (point.x + DOMAIN_SIZE / 2) / DOMAIN_SIZE));
  const v = Math.max(0, Math.min(1, (point.z + DOMAIN_SIZE / 2) / DOMAIN_SIZE));
  const i = Math.round(u * (GRID_SIZE - 1));
  const j = Math.round(v * (GRID_SIZE - 1));
  return { i, j };
}

function gridToWorld(i, j) {
  const x = (i / (GRID_SIZE - 1)) * DOMAIN_SIZE - DOMAIN_SIZE / 2;
  const z = (j / (GRID_SIZE - 1)) * DOMAIN_SIZE - DOMAIN_SIZE / 2;
  return new THREE.Vector3(x, 0, z);
}

function showCallout(i, j, mag, depth, dir) {
  const callout = document.getElementById("eq-callout");
  if (!callout) return;
  document.getElementById("callout-mw").textContent = mag.toFixed(1);
  document.getElementById("callout-depth").textContent = `${depth} km`;
  document.getElementById("callout-dir").textContent = `${dir}°`;
  
  const worldPos = gridToWorld(i, j);
  callout.__worldPos = worldPos;
  callout.classList.remove("hidden");
  
  clearTimeout(showCallout._timer);
  showCallout._timer = setTimeout(() => {
    callout.classList.add("hidden");
  }, 4000);
}

function triggerQuakeAt(i, j, magnitude) {
  if (!isValidEpicenter(depthFn, i, j)) {
    if (statusEl) {
      statusEl.textContent =
        "Epicenter must be in deep ocean — try clicking further from shore.";
      clearTimeout(triggerQuakeAt._msgTimer);
      triggerQuakeAt._msgTimer = setTimeout(
        () => (statusEl.textContent = ""),
        2500,
      );
    }
    return;
  }
  solver.triggerEarthquake(i, j, magnitude, state.hypocenterDepth, state.faultDirection);
  showCallout(i, j, magnitude, state.hypocenterDepth, state.faultDirection);
}

function onPointerDown(event) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(pickPlane);
  if (hits.length === 0) return;

  const { i, j } = worldToGrid(hits[0].point);
  triggerQuakeAt(i, j, state.magnitude);
}
renderer.domElement.addEventListener("pointerdown", onPointerDown);

// --- GUI ------------------------------------------------------------------
function resetSimulation() {
  solver.reset();
}

function randomQuake() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const i = Math.floor(Math.random() * GRID_SIZE);
    const j = Math.floor(Math.random() * (GRID_SIZE * 0.6));
    if (isValidEpicenter(depthFn, i, j)) {
      state.magnitude = parseFloat((6.0 + Math.random() * 3.5).toFixed(1));
      state.hypocenterDepth = Math.floor(10 + Math.random() * 40);
      state.faultDirection = Math.floor(Math.random() * 180);
      if (uiControls && uiControls.syncUI) uiControls.syncUI();
      triggerQuakeAt(i, j, state.magnitude);
      return;
    }
  }
}

const uiControls = createControls(state, { onReset: resetSimulation, onRandomQuake: randomQuake });

// --- Render / physics loop --------------------------------------------------
// FIX 1: Use a small fixed substep (SIM_DT = 0.05 s) run `state.speed`
// times per frame. This guarantees the wave field updates EVERY rendered
// frame, eliminating the "pump-pump-pump" strobe that happened because
// the old code used solver.maxDt (~4.8 s) as the step size — so 30+
// frames could pass between physics updates.
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  if (state.isPlaying) {
    // Run exactly `state.speed` steps of SIM_DT every frame.
    // Because SIM_DT ≈ solver.maxDt, the coupling factor c²·dt²/dx² ≈ 0.4
    // — waves propagate visibly. Running one step/frame at speed=1 gives
    // slow-motion; at speed=20 the tsunami crosses the domain in seconds.
    // No accumulator needed: every rendered frame advances the physics.
    const substeps = Math.max(1, Math.round(state.speed));
    for (let s = 0; s < substeps; s++) {
      solver.step(SIM_DT);
    }
  }

  updateOcean(solver.getHeightField(), state.exaggeration, clock.elapsedTime);

  // Lock the orbit pivot to sea level every frame.
  // OrbitControls.enablePan + vertical panning can push the target above
  // y=0, which shifts the polar-angle reference upward and lets the
  // camera creep above the horizon. Resetting it here is the simplest
  // reliable guard — and we WANT the target to stay over the water anyway.
  orbit.target.y = 0;

  // Also ensure the camera never dips below a minimum altitude so it
  // can't clip through the ocean surface when zooming in steeply.
  if (camera.position.y < CAMERA_ALTITUDE * 0.3) {
    camera.position.y = CAMERA_ALTITUDE * 0.3;
  }

  orbit.update();

  // Position Earthquake Callout 
  const callout = document.getElementById("eq-callout");
  if (callout && !callout.classList.contains("hidden") && callout.__worldPos) {
    const pos = callout.__worldPos.clone();
    pos.project(camera);
    if (pos.z < 1) { // Only show if in front of camera
      const x = (pos.x * .5 + .5) * window.innerWidth;
      const y = (pos.y * -.5 + .5) * window.innerHeight;
      callout.style.left = `${x}px`;
      callout.style.top = `${y}px`;
      callout.style.display = "flex";
    } else {
      callout.style.display = "none";
    }
  }

  renderer.render(scene, camera);
}
animate();

// --- Resize -----------------------------------------------------------------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
