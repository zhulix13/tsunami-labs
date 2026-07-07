/**
 * ocean.js
 * -----------------------------------------------------------------------
 * Single mesh, single material for the entire visible ocean + land.
 *
 * THE "INFINITE OCEAN" TRICK
 * The physics solver runs on a GRID_SIZE×GRID_SIZE grid. The VISUAL mesh
 * is larger: it pads OUTER_PAD extra cells of deep-ocean around all four
 * sides of the physics domain. Those outer cells share the exact same
 * ShaderMaterial — same lighting, same fog, same Fresnel — so there is
 * literally no seam or transition: it's one continuous surface. The outer
 * ring is simply flat (height=0) and deep (depth=4000m), exactly like
 * calm open water far from the earthquake. At OUTER_PAD=40 cells each
 * outer ring is ~53 km wide; the existing depth fog reaches full opacity
 * well before the geometric edge, so users never see it.
 *
 * VERTEX ↔ GRID CELL MAPPING
 * Inner physics cell (pi, pj) where 0 ≤ pi,pj < gridSize maps to visual
 * vertex (vi, vj) = (pi + OUTER_PAD, pj + OUTER_PAD). Flat array index
 * is vj * totalSize + vi where totalSize = gridSize + 2 * OUTER_PAD.
 */

import * as THREE from "three";

// The visual mesh maps exactly 1:1 with the physics grid now.
// The domain is extended to cover the horizon naturally without padding.

// --- GLSL: shared noise (hash-based value noise + fbm) -------------------
const NOISE_GLSL = /* glsl */ `
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }
  float fbm(vec2 p) {
    float v = 0.0; float amp = 0.5;
    for (int i = 0; i < 4; i++) { v += amp * valueNoise(p); p *= 2.0; amp *= 0.5; }
    return v;
  }
`;

const VERTEX_SHADER = /* glsl */ `
  attribute float aStaticDepth;
  attribute float aHeight;

  varying float vStaticDepth;
  varying float vHeight;
  varying vec3  vNormal;
  varying vec3  vWorldPos;
  varying float vViewZ;   // true linear eye-space depth for fog
  
  uniform float uTime;
  
  ${NOISE_GLSL}

  void main() {
    vStaticDepth = aStaticDepth;
    vHeight      = aHeight;
    vNormal      = normalize(normalMatrix * normal);

    vec3 pos = position;
    vec4 worldPos = modelMatrix * vec4(pos, 1.0);

    // Apply displacement in world space for consistent scale
    if (aStaticDepth <= 0.0) {
      float ruggedness = fbm(worldPos.xz * 0.002) * 20.0;
      worldPos.y += ruggedness * clamp(-aStaticDepth / 10.0, 0.0, 1.0);
    } else {
      float ripple = fbm(worldPos.xz * 0.0025 + vec2(uTime * 0.03, uTime * 0.02));
      worldPos.y += (ripple - 0.5) * 3.0; // ambient wave
    }

    vWorldPos = worldPos.xyz;

    // Inverse transform back to model space for mvPos
    vec4 mvPos = viewMatrix * worldPos;
    vViewZ = -mvPos.z;

    gl_Position = projectionMatrix * mvPos;
  }
`;

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

  float horizonFog(float depth) {
    float t = clamp((depth - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
    return t * t;
  }

  void main() {
    vec3  normal  = normalize(vNormal);
    vec3  viewDir = normalize(cameraPosition - vWorldPos);
    float diffuse = max(dot(normal, uSunDirection), 0.15);

    vec3 finalColor;

    if (vStaticDepth <= 0.0) {
      // --- LAND ---
      float elevT = clamp(-vStaticDepth / 40.0, 0.0, 1.0);
      vec3 sand      = vec3(0.86, 0.78, 0.60);
      vec3 grassCol  = vec3(0.36, 0.48, 0.26);
      vec3 rock      = vec3(0.55, 0.52, 0.47);
      
      // Slope calculation using derivatives (needs OES_standard_derivatives implicit)
      vec3 dx = dFdx(vWorldPos);
      vec3 dy = dFdy(vWorldPos);
      vec3 geoNormal = normalize(cross(dx, dy));
      float slope = 1.0 - max(dot(geoNormal, vec3(0.0, 1.0, 0.0)), 0.0);
      
      // Mix normal with geoNormal for some shading texture
      normal = normalize(mix(normal, geoNormal, 0.5));

      vec3 base = mix(sand, grassCol, smoothstep(0.02, 0.35, elevT));
      // Apply rock to steep slopes
      base = mix(base, rock, smoothstep(0.1, 0.5, slope));
      
      float grain = fbm(vWorldPos.xz * 0.004) * 0.14 - 0.07;
      base += grain;
      
      diffuse = max(dot(normal, uSunDirection), 0.15); // Recompute diffuse
      finalColor = base * diffuse;

    } else {
      // --- WATER ---
      float t = clamp(abs(vHeight) / uWaveColorScale, 0.0, 1.0);
      vec3 deep = vec3(0.04, 0.20, 0.34);
      vec3 mid  = vec3(0.10, 0.52, 0.60);
      vec3 foamColor = vec3(0.92, 0.97, 0.99);
      vec3 base = mix(deep, mid,  smoothstep(0.0,  0.55, t));

      // Dynamic foam using fbm
      float foamNoise = fbm(vWorldPos.xz * 0.01 + uTime * 0.05);
      float foamFactor = smoothstep(0.5, 1.0, t + foamNoise * 0.3);
      
      // Shoreline foam
      float shoreFoam = smoothstep(5.0, 0.0, vStaticDepth) * smoothstep(0.3, 0.7, foamNoise);
      foamFactor = max(foamFactor, shoreFoam);

      base = mix(base, foamColor, foamFactor);

      // Perturb normal for specular
      float nScale = 0.005;
      vec3 nPerturb = vec3(fbm(vWorldPos.xz * 0.01) - 0.5, 0.0, fbm(vWorldPos.zx * 0.01) - 0.5) * nScale;
      vec3 waterNormal = normalize(normal + nPerturb);

      float fresnel = pow(1.0 - max(dot(waterNormal, viewDir), 0.0), 4.0);
      vec3 color = mix(base * diffuse, uSkyColor, fresnel * 0.65);

      vec3 halfDir = normalize(uSunDirection + viewDir);
      float spec = pow(max(dot(waterNormal, halfDir), 0.0), 120.0);
      color += spec * 0.55 * (1.0 - t);

      finalColor = color;
    }

    // Depth fog — blends toward sky colour as distance increases.
    // The outer padding cells are far enough away that this reaches
    // full opacity before their geometric edge, hiding it completely.
    float fog = horizonFog(vViewZ);
    finalColor = mix(finalColor, uFogColor, fog);

    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

/**
 * @param {number} gridSize     physics grid size (e.g. 150)
 * @param {number} domainSize   physics domain in metres (e.g. 200 000)
 * @param {Function} depthFn    (i,j) → depth in metres
 * @param {THREE.Vector3} sunDirection
 * @param {THREE.Color}   skyColor
 * @param {THREE.Fog}    [fog]  scene fog for horizon blending
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
  const cellSize         = domainSize / gridSize;          // metres per cell
  const totalSize        = gridSize;      // visual vertex grid exactly matches physics grid
  const visualDomainSize = domainSize;            // world-space size of full mesh

  const geometry = new THREE.PlaneGeometry(
    visualDomainSize,
    visualDomainSize,
    totalSize - 1,
    totalSize - 1,
  );
  geometry.rotateX(-Math.PI / 2);

  const n = totalSize * totalSize;
  const staticDepthAttr = new Float32Array(n);
  const heightAttr      = new Float32Array(n);

  for (let vj = 0; vj < totalSize; vj++) {
    for (let vi = 0; vi < totalSize; vi++) {
      const idx = vj * totalSize + vi;
      staticDepthAttr[idx] = depthFn(vi, vj);
    }
  }

  geometry.setAttribute("aStaticDepth", new THREE.BufferAttribute(staticDepthAttr, 1));
  geometry.setAttribute("aHeight",      new THREE.BufferAttribute(heightAttr,      1));

  const fogColor = fog ? fog.color.clone() : skyColor.clone();
  const fogNear  = fog ? fog.near  : domainSize * 0.4;
  const fogFar   = fog ? fog.far   : domainSize * 1.0;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSunDirection:  { value: sunDirection.clone() },
      uSkyColor:      { value: skyColor.clone() },
      uTime:          { value: 0 },
      uWaveColorScale:{ value: 2.5 },
      uFogColor:      { value: fogColor },
      uFogNear:       { value: fogNear },
      uFogFar:        { value: fogFar },
    },
    vertexShader:   VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });

  const mesh = new THREE.Mesh(geometry, material);

  const posAttr        = geometry.attributes.position;
  const heightBufAttr  = geometry.attributes.aHeight;

  /** Sync fog uniforms when scene.fog changes (e.g. after sky texture loads). */
  function updateFog(sceneFog) {
    if (!sceneFog) return;
    material.uniforms.uFogColor.value.copy(sceneFog.color);
    material.uniforms.uFogNear.value = sceneFog.near;
    material.uniforms.uFogFar.value  = sceneFog.far;
  }

  /**
   * Called every frame. Applies physics heightField to inner cells;
   * outer padding cells stay flat at y=0 (calm deep ocean).
   */
  function update(heightField, exaggeration, elapsedTime) {
    const posArray = posAttr.array;
    const hArray = heightBufAttr.array;
    
    for (let i = 0; i < n; i++) {
      const d = staticDepthAttr[i];
      if (d <= 0) {
        posArray[i * 3 + 1] = -d;
        hArray[i] = 0;
      } else {
        const h = heightField[i];
        posArray[i * 3 + 1] = h * exaggeration;
        hArray[i] = h;
      }
    }

    posAttr.needsUpdate       = true;
    heightBufAttr.needsUpdate = true;
    geometry.computeVertexNormals();
    material.uniforms.uTime.value = elapsedTime;
  }

  return { mesh, update, updateFog, visualDomainSize };
}
