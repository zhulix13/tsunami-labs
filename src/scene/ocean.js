/**
 * ocean.js
 * -----------------------------------------------------------------------
 * Single mesh, single material for the entire visible ocean + land.
 *
 * PERFORMANCE ARCHITECTURE
 *  - Wave height data is uploaded to a DataTexture each frame (O(gridSize²)
 *    typed-array copy), then the vertex shader samples it to displace water
 *    vertices AND compute surface normals via central differences. This
 *    completely eliminates geometry.computeVertexNormals() — which was the
 *    largest single frame-time cost (~3-5ms CPU) on the live site.
 *  - Land vertices are baked into the position buffer ONCE at startup and
 *    never written again. Only the DataTexture changes each frame.
 *  - The fragment shader computes foamNoise with a single FBM evaluation
 *    (shared for wave foam + shoreline foam). The old per-pixel normal
 *    perturbation FBM (2 extra evaluations) is removed — the vertex shader
 *    already provides accurate wave normals from the height texture.
 *
 * THE OUTER PAD TRICK
 *  The physics solver runs on a GRID_SIZE×GRID_SIZE grid. The visual mesh
 *  adds OUTER_PAD cells of ocean on all four sides. These cells sample the
 *  height texture with ClampToEdgeWrapping, so they inherit the nearest
 *  physics edge cell's height — waves propagate visually to the edge rather
 *  than stopping abruptly. Fog reaches full opacity well before the mesh
 *  edge, so the geometric border is never visible.
 */

import * as THREE from "three";

// Padding cells added to all four sides of the physics grid for the visual mesh.
// 40 × (200km/150) ≈ 53 km — fog is fully opaque before the geometric edge.
const OUTER_PAD = 40;

// --- GLSL helpers (shared by both shaders) --------------------------------
const NOISE_GLSL = /* glsl */ `
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i); float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0)); float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }
  float fbm(vec2 p) {
    float v = 0.0; float amp = 0.5;
    for (int i = 0; i < 4; i++) { v += amp * valueNoise(p); p *= 2.0; amp *= 0.5; }
    return v;
  }
`;

// -------------------------------------------------------------------------
// VERTEX SHADER
// Responsibilities:
//  1. Sample the height DataTexture for the correct physics cell
//  2. Displace water vertex Y (CPU never touches water positions again)
//  3. Compute per-vertex wave normals via central differences on the texture
//  4. Apply land elevation + ruggedness noise (land is already baked, this
//     just adds the FBM bump on top)
// -------------------------------------------------------------------------
const VERTEX_SHADER = /* glsl */ `
  attribute float aStaticDepth;

  varying float vStaticDepth;
  varying float vHeight;
  varying vec3  vNormal;
  varying vec3  vWorldPos;
  varying float vViewZ;

  uniform float     uTime;
  uniform sampler2D uHeightTex;   // gridSize × gridSize, R32F, physics heights
  uniform float     uGridSize;    // physics grid dimension (e.g. 150)
  uniform float     uTotalSize;   // full mesh vertex count per side (e.g. 230)
  uniform float     uOuterPad;    // padding cells each side (e.g. 40)
  uniform float     uExaggeration;
  uniform float     uCellSize;    // domainSize / gridSize, world-units per cell

  ${NOISE_GLSL}

  void main() {
    vStaticDepth = aStaticDepth;

    // Map mesh UV → physics texture UV.
    // PlaneGeometry UV: (0,0) = bottom-left, UV.y increases upward.
    // PlaneGeometry is rotated so "up" in UV = "far ocean" in world.
    // UV.x = vi / (totalSize-1), UV.y = 1 - vj / (totalSize-1)  [y is flipped]
    // so: vi = uv.x*(totalSize-1), vj = (1-uv.y)*(totalSize-1)
    // physics cell: pi = vi - outerPad, pj = vj - outerPad
    float vi_f = uv.x * (uTotalSize - 1.0);
    float vj_f = (1.0 - uv.y) * (uTotalSize - 1.0);
    vec2 physUV = vec2(vi_f - uOuterPad, vj_f - uOuterPad) / (uGridSize - 1.0);
    // ClampToEdgeWrapping on uHeightTex automatically handles padding cells:
    // they inherit the nearest edge physics cell's height.

    vec4 worldPos = modelMatrix * vec4(position, 1.0);

    if (aStaticDepth <= 0.0) {
      // --- LAND ---
      // Base elevation already baked into the position buffer; add FBM bump.
      float ruggedness = fbm(worldPos.xz * 0.002) * 20.0;
      worldPos.y += ruggedness * clamp(-aStaticDepth / 10.0, 0.0, 1.0);
      vHeight = 0.0;
      vNormal = vec3(0.0, 1.0, 0.0); // overridden by dFdx/dFdy in fragment

    } else {
      // --- WATER ---
      // Sample physics height from texture (no CPU posAttr.setY needed).
      float hC = texture2D(uHeightTex, physUV).r;
      vHeight = hC;

      // Subtle ambient swell — scales with depth so shallow water stays calm.
      float depthFactor = clamp(aStaticDepth / 500.0, 0.0, 1.0);
      float ripple = fbm(worldPos.xz * 0.0025 + vec2(uTime * 0.03, uTime * 0.02));
      worldPos.y = hC * uExaggeration + (ripple - 0.5) * 3.0 * depthFactor;

      // --- GPU normal via central differences (replaces computeVertexNormals) ---
      // Tangent in X: (2*cellSize, (hR-hL)*exag, 0)
      // Tangent in Z: (0, (hD-hU)*exag, 2*cellSize)
      // Normal = cross(tangentX, tangentZ) simplified:
      float ts = 1.0 / uGridSize;
      float hL = texture2D(uHeightTex, physUV + vec2(-ts, 0.0)).r;
      float hR = texture2D(uHeightTex, physUV + vec2( ts, 0.0)).r;
      float hU = texture2D(uHeightTex, physUV + vec2(0.0, -ts)).r;
      float hD = texture2D(uHeightTex, physUV + vec2(0.0,  ts)).r;

      vNormal = normalize(vec3(
        (hL - hR) * uExaggeration,
        2.0 * uCellSize,
        (hU - hD) * uExaggeration
      ));
    }

    vWorldPos = worldPos.xyz;
    vec4 mvPos = viewMatrix * worldPos;
    vViewZ    = -mvPos.z;
    gl_Position = projectionMatrix * mvPos;
  }
`;

// -------------------------------------------------------------------------
// FRAGMENT SHADER
// Key optimisation: single fbm() call per water pixel (was 3 before).
// Wave normals come from the vertex shader — no FBM normal perturbation.
// -------------------------------------------------------------------------
const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform vec3  uSunDirection;
  uniform vec3  uSkyColor;
  uniform float uTime;
  uniform float uWaveColorScale;
  uniform vec3  uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  varying float vStaticDepth;
  varying float vHeight;
  varying vec3  vNormal;
  varying vec3  vWorldPos;
  varying float vViewZ;

  ${NOISE_GLSL}

  float horizonFog(float d) {
    float t = clamp((d - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
    return t * t;
  }

  void main() {
    vec3  normal  = normalize(vNormal);
    vec3  viewDir = normalize(cameraPosition - vWorldPos);
    float diffuse = max(dot(normal, uSunDirection), 0.15);

    vec3 finalColor;

    if (vStaticDepth <= 0.0) {
      // --- LAND ---
      float elevT   = clamp(-vStaticDepth / 40.0, 0.0, 1.0);
      vec3 sand     = vec3(0.86, 0.78, 0.60);
      vec3 grassCol = vec3(0.36, 0.48, 0.26);
      vec3 rock     = vec3(0.55, 0.52, 0.47);

      // Screen-space derivatives → slope-based rock blending (GPU, free)
      vec3 ddx = dFdx(vWorldPos);
      vec3 ddy = dFdy(vWorldPos);
      vec3 geoNormal = normalize(cross(ddx, ddy));
      float slope = 1.0 - max(dot(geoNormal, vec3(0.0, 1.0, 0.0)), 0.0);

      normal  = normalize(mix(normal, geoNormal, 0.5));
      diffuse = max(dot(normal, uSunDirection), 0.15);

      vec3 base = mix(sand, grassCol, smoothstep(0.02, 0.35, elevT));
      base = mix(base, rock, smoothstep(0.1, 0.5, slope));
      base += fbm(vWorldPos.xz * 0.004) * 0.14 - 0.07; // surface grain
      finalColor = base * diffuse;

    } else {
      // --- WATER ---
      float t        = clamp(abs(vHeight) / uWaveColorScale, 0.0, 1.0);
      vec3 deep      = vec3(0.04, 0.20, 0.34);
      vec3 mid       = vec3(0.10, 0.52, 0.60);
      vec3 foamColor = vec3(0.92, 0.97, 0.99);
      vec3 base      = mix(deep, mid, smoothstep(0.0, 0.55, t));

      // Single FBM call — reused for wave-crest foam AND shoreline foam.
      // (Previously: 3 separate FBM calls per water pixel.)
      float foamNoise  = fbm(vWorldPos.xz * 0.01 + uTime * 0.05);
      float foamFactor = smoothstep(0.5, 1.0, t + foamNoise * 0.3);
      float shoreFoam  = smoothstep(5.0, 0.0, vStaticDepth) * smoothstep(0.3, 0.7, foamNoise);
      foamFactor = max(foamFactor, shoreFoam);
      base = mix(base, foamColor, foamFactor);

      // Wave normals computed in vertex shader via height texture central
      // differences — more accurate than FBM perturbation and much cheaper.
      float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 4.0);
      vec3  color   = mix(base * diffuse, uSkyColor, fresnel * 0.65);

      vec3  halfDir = normalize(uSunDirection + viewDir);
      float spec    = pow(max(dot(normal, halfDir), 0.0), 120.0);
      color += spec * 0.55 * (1.0 - t);
      finalColor = color;
    }

    finalColor = mix(finalColor, uFogColor, horizonFog(vViewZ));
    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

/**
 * @param {number} gridSize     physics grid size (e.g. 150)
 * @param {number} domainSize   physics domain in metres (e.g. 200 000)
 * @param {Function} depthFn    (i,j) → depth in metres
 * @param {THREE.Vector3} sunDirection
 * @param {THREE.Color}   skyColor
 * @param {THREE.Fog}    [fog]
 * @returns {{ mesh, update, updateFog, visualDomainSize }}
 */
export function createOceanMesh(
  gridSize,
  domainSize,
  depthFn,
  sunDirection,
  skyColor,
  fog,
) {
  const cellSize         = domainSize / gridSize;
  const totalSize        = gridSize + 2 * OUTER_PAD;
  const visualDomainSize = cellSize * totalSize;

  const geometry = new THREE.PlaneGeometry(
    visualDomainSize, visualDomainSize,
    totalSize - 1,    totalSize - 1,
  );
  geometry.rotateX(-Math.PI / 2);

  const n = totalSize * totalSize;
  const staticDepthAttr = new Float32Array(n);

  // Fill static depth. Padding cells clamp to the nearest physics edge cell
  // so depthFn is never called out of range.
  for (let vj = 0; vj < totalSize; vj++) {
    for (let vi = 0; vi < totalSize; vi++) {
      const pi  = Math.max(0, Math.min(gridSize - 1, vi - OUTER_PAD));
      const pj  = Math.max(0, Math.min(gridSize - 1, vj - OUTER_PAD));
      staticDepthAttr[vj * totalSize + vi] = depthFn(pi, pj);
    }
  }

  geometry.setAttribute("aStaticDepth", new THREE.BufferAttribute(staticDepthAttr, 1));

  // Bake land elevation into position buffer ONCE — land never moves, so
  // this CPU write happens only at startup. Water vertices stay at y=0;
  // the vertex shader displaces them via the height texture every frame.
  const posAttr  = geometry.attributes.position;
  const posArray = posAttr.array;
  for (let i = 0; i < n; i++) {
    const d = staticDepthAttr[i];
    if (d <= 0) posArray[i * 3 + 1] = -d;
  }
  posAttr.needsUpdate = true; // upload once; never set again

  // --- Height DataTexture ------------------------------------------------
  // Each frame the physics heightField (Float32Array, gridSize²) is copied
  // here and uploaded to the GPU in a single texImage2D call. The vertex
  // shader samples this to displace and compute normals — no per-vertex
  // JS loop, no BufferAttribute writes, no computeVertexNormals().
  const heightTexData = new Float32Array(gridSize * gridSize);
  const heightTex = new THREE.DataTexture(
    heightTexData,
    gridSize, gridSize,
    THREE.RedFormat,
    THREE.FloatType,
  );
  // ClampToEdge: outer padding cells automatically inherit the nearest
  // edge physics cell's height, so waves don't hit an invisible wall.
  heightTex.wrapS       = THREE.ClampToEdgeWrapping;
  heightTex.wrapT       = THREE.ClampToEdgeWrapping;
  heightTex.magFilter   = THREE.NearestFilter;
  heightTex.minFilter   = THREE.NearestFilter;
  heightTex.needsUpdate = true;

  const fogColor = fog ? fog.color.clone() : skyColor.clone();
  const fogNear  = fog ? fog.near : domainSize * 0.4;
  const fogFar   = fog ? fog.far  : domainSize * 1.0;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSunDirection:  { value: sunDirection.clone() },
      uSkyColor:      { value: skyColor.clone() },
      uTime:          { value: 0 },
      uWaveColorScale:{ value: 2.5 },
      uFogColor:      { value: fogColor },
      uFogNear:       { value: fogNear },
      uFogFar:        { value: fogFar },
      // --- performance uniforms ---
      uHeightTex:     { value: heightTex },
      uGridSize:      { value: gridSize },
      uTotalSize:     { value: totalSize },
      uOuterPad:      { value: OUTER_PAD },
      uExaggeration:  { value: 600 },
      uCellSize:      { value: cellSize },
    },
    vertexShader:   VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });

  const mesh = new THREE.Mesh(geometry, material);

  /** Sync fog uniforms after sky texture loads. */
  function updateFog(sceneFog) {
    if (!sceneFog) return;
    material.uniforms.uFogColor.value.copy(sceneFog.color);
    material.uniforms.uFogNear.value = sceneFog.near;
    material.uniforms.uFogFar.value  = sceneFog.far;
  }

  /**
   * Called every frame. Uploads the physics heightField to GPU and updates
   * time/exaggeration uniforms. CPU does NO per-vertex work here.
   *
   * Frame budget comparison:
   *   Before: O(n) JS loop + BufferAttribute write + computeVertexNormals = ~5ms
   *   After:  typed-array copy + texImage2D upload = ~0.3ms
   */
  function update(heightField, exaggeration, elapsedTime) {
    heightTexData.set(heightField);   // O(gridSize²) typed-array copy
    heightTex.needsUpdate = true;     // triggers texImage2D upload

    material.uniforms.uExaggeration.value = exaggeration;
    material.uniforms.uTime.value         = elapsedTime;
  }

  return { mesh, update, updateFog, visualDomainSize };
}
