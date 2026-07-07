/**
 * sky.js
 * -----------------------------------------------------------------------
 * Sets up the scene sky. Primary mode: equirectangular panorama loaded
 * from /textures/sky.jpg (or sky.png / sky.hdr). Fallback: Three.js
 * built-in atmospheric Sky shader so the sim always looks good even if
 * you haven't dropped an image in yet.
 */

import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";

// Ordered list of candidate sky texture paths. The loader tries each in
// sequence and uses the first one that returns HTTP 200. Supports JPEG,
// PNG, and HDR equirectangular panoramas.
const SKY_TEXTURE_CANDIDATES = [
  "/textures/sky.hdr",
  "/textures/sky.jpg",
  "/textures/sky.jpeg",
  "/textures/sky.png",
];

/**
 * Check (via a HEAD request) whether a given URL exists on the dev server.
 * Returns a promise that resolves to true/false.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function fileExists(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Load an equirectangular texture from the given path.
 * Handles both JPEG/PNG (TextureLoader) and .hdr (RGBELoader).
 *
 * @param {string} path
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @returns {Promise<THREE.Texture>}
 */
function loadEquirectTexture(path, renderer, scene) {
  return new Promise((resolve, reject) => {
    if (path.endsWith(".hdr")) {
      const loader = new HDRLoader();
      loader.load(
        path,
        (texture) => {
          texture.mapping = THREE.EquirectangularReflectionMapping;
          // Convert the raw HDR texture to a usable env/background map.
          const pmrem = new THREE.PMREMGenerator(renderer);
          pmrem.compileEquirectangularShader();
          const envMap = pmrem.fromEquirectangular(texture).texture;
          texture.dispose();
          pmrem.dispose();
          resolve(envMap);
        },
        () => {
          if (scene) scene.background = new THREE.Color(0x87ceeb);
        },
        reject,
      );
    } else {
      const loader = new THREE.TextureLoader();
      loader.load(
        path,
        (texture) => {
          texture.mapping = THREE.EquirectangularReflectionMapping;
          texture.colorSpace = THREE.SRGBColorSpace;
          resolve(texture);
        },
        () => {
          if (scene) scene.background = new THREE.Color(0x87ceeb);
        },
        reject,
      );
    }
  });
}

/**
 * Install the procedural Three.js atmospheric Sky as a fallback.
 * Returns the sun direction so lights.js / the ocean shader can stay in sync.
 *
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @param {number} domainSize  used to scale the Sky mesh large enough
 * @returns {{ sunDirection: THREE.Vector3 }}
 */
function setupProceduralSky(scene, renderer, domainSize) {
  const sky = new Sky();
  sky.scale.setScalar(domainSize * 10);
  scene.add(sky);

  const sunPosition = new THREE.Vector3();
  const phi = THREE.MathUtils.degToRad(75); // sun elevation above horizon
  const theta = THREE.MathUtils.degToRad(180); // azimuth (north)
  sunPosition.setFromSphericalCoords(1, phi, theta);

  const skyUniforms = sky.material.uniforms;
  skyUniforms["turbidity"].value = 3.5;
  skyUniforms["rayleigh"].value = 1.2;
  skyUniforms["mieCoefficient"].value = 0.005;
  skyUniforms["mieDirectionalG"].value = 0.8;
  skyUniforms["sunPosition"].value.copy(sunPosition);

  // Bake the sky into an env map so water fresnel reflects the real sky color.
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  // We need to render the sky to a cube target to bake the env map.
  // Three.js Sky uses a shader on a big sphere — bake via scene render.
  const rt = pmrem.fromScene(new THREE.RoomEnvironment());
  scene.environment = rt.texture;
  pmrem.dispose();

  // Sun direction for the ocean specular shader (normalized, pointing toward sun)
  const sunDir = sunPosition.clone().normalize();

  return { sunDirection: sunDir };
}

/**
 * Main entry point. Call this once after the scene and renderer exist.
 *
 * Behaviour:
 *  1. Check for a sky panorama in /textures/ (tries .hdr, .jpg, .jpeg, .png)
 *  2. If found → set it as scene.background and scene.environment
 *  3. If not found → install the Three.js procedural Sky as fallback
 *  4. Update scene.fog color to match the horizon tint
 *
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @param {number} domainSize
 * @param {THREE.Fog} fog  existing fog object to retint to match horizon
 * @returns {Promise<{ sunDirection: THREE.Vector3, skyColor: THREE.Color }>}
 */
export async function setupSky(scene, renderer, domainSize, fog) {
  // Clear the old flat background color — Sky or texture replaces it.
  scene.background = null;

  // Try to find an equirectangular sky texture.
  let foundPath = null;
  for (const candidate of SKY_TEXTURE_CANDIDATES) {
    if (await fileExists(candidate)) {
      foundPath = candidate;
      break;
    }
  }

  if (foundPath) {
    console.log(`[sky] Loading equirectangular panorama: ${foundPath}`);
    try {
      const texture = await loadEquirectTexture(foundPath, renderer, scene);
      scene.background = texture;
      scene.environment = texture; // makes water fresnel reflect real sky

      // Derive a representative sky-horizon color for the fog tint.
      // (We can't sample the panorama pixel-perfectly here, so we use a
      //  reasonable overcast-sky blue that fits most cloudy panoramas.)
      const skyColor = new THREE.Color(0x9db8d0);
      if (fog) {
        fog.color.copy(skyColor);
      }

      // Sun direction: with a texture we can't auto-detect the sun position,
      // so we use a fixed "mid-morning" direction that looks natural.
      const sunDirection = new THREE.Vector3(0.5, 0.8, -0.3).normalize();

      console.log("[sky] Equirectangular sky loaded successfully.");
      return { sunDirection, skyColor };
    } catch (err) {
      console.warn(
        "[sky] Failed to load sky texture, falling back to procedural Sky.",
        err,
      );
    }
  } else {
    console.log(
      "[sky] No sky texture found at /textures/sky.(hdr|jpg|jpeg|png). " +
        "Using procedural Sky. To add a panorama, place an equirectangular " +
        "image at public/textures/sky.jpg and refresh.",
    );
  }

  // Fallback: Three.js atmospheric Sky.
  const { sunDirection } = setupProceduralSky(scene, renderer, domainSize);
  const skyColor = new THREE.Color(0x87ceeb);
  if (fog) fog.color.copy(skyColor);
  return { sunDirection, skyColor };
}
