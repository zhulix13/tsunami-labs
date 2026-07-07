/**
 * lights.js
 * -----------------------------------------------------------------------
 * Minimal lighting rig. Kept deliberately simple for the MVP — one key
 * light (directional, sun-like, casts the shadows that give the wave
 * geometry visible depth) plus ambient fill so shadowed areas aren't
 * pure black. This is the one file in the project that's pure "make it
 * look nice," no physics or state to keep in sync with anything else.
 */

import * as THREE from "three";

/**
 * @param {THREE.Scene} scene
 * @param {number} domainSize physical domain size in meters, used to size
 *                            the shadow camera frustum so shadows cover
 *                            the whole visible ocean/coastline.
 */
export function setupLights(scene, domainSize) {
  // Ambient: soft fill so nothing is fully black in shadow. Kept dim so
  // the directional light still reads as the dominant light direction —
  // that directionality is what sells the wave crests as 3D geometry
  // rather than a flat colored texture.
  const ambient = new THREE.AmbientLight(0xffffff, 0.45);
  scene.add(ambient);

  // Key light: directional "sun." Angled from above and to the side so
  // wave ridges cast visible shadows on their own troughs.
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.2);
  sun.position.set(domainSize * 0.3, domainSize * 0.5, domainSize * 0.2);
  sun.castShadow = true;

  // Shadow camera must be an orthographic box big enough to cover the
  // whole domain, or you'll see shadows clip/pop at the edges of the
  // visible ocean as the camera orbits.
  const half = domainSize * 0.6;
  sun.shadow.camera.left = -half;
  sun.shadow.camera.right = half;
  sun.shadow.camera.top = half;
  sun.shadow.camera.bottom = -half;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = domainSize * 2;

  // 2048 is a reasonable quality/perf tradeoff for a single directional
  // light over one mesh; bump to 4096 only if shadow edges look blocky
  // on a high-res display and FPS budget allows it.
  sun.shadow.mapSize.set(2048, 2048);

  scene.add(sun);
  scene.add(sun.target); // target defaults to (0,0,0), i.e. domain center

  // A touch of hemisphere light adds a subtle sky-blue / ground-tint
  // bounce, which reads nicely on both the water and the land colors
  // without costing a real-time shadow pass.
  const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x3a2e1e, 0.3);
  scene.add(hemi);

  // Direction FROM the scene TOWARD the sun, normalized — the water
  // shader needs this (not the light object itself) to compute its own
  // manual specular sun-glint term, since a custom ShaderMaterial doesn't
  // automatically receive Three.js's built-in lighting.
  const sunDirection = sun.position.clone().normalize();

  return { ambient, sun, hemi, sunDirection };
}
