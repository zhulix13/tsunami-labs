/**
 * controls.js
 * -----------------------------------------------------------------------
 * lil-gui control panel. This file only ever READS/WRITES the shared
 * `state` object and calls callback functions passed in from main.js —
 * it never touches the solver, scene, or grid arrays directly. That
 * separation means the physics and rendering modules don't need to know
 * the GUI exists at all.
 *
 * NOTE ON LEVA: the PRD mentions Leva, but Leva is a React-only library
 * (it's built as a React component/hook). Since this project is plain
 * JS + Vite (no React), we use lil-gui instead — it's the actively
 * maintained successor to dat.GUI, has the same panel-with-folders feel,
 * and needs zero framework.
 */

import GUI from "lil-gui";

/**
 * @param {object} state   shared mutable state, read every frame by main.js:
 *                          { magnitude, isPlaying, exaggeration, speed }
 * @param {object} callbacks
 * @param {() => void} callbacks.onReset        fired when Reset is clicked
 * @param {() => void} callbacks.onRandomQuake   fired when "Random Quake" is clicked
 * @returns {GUI} the lil-gui instance (in case main.js wants to destroy/rebuild it)
 */
export function createControls(state, { onReset, onRandomQuake } = {}) {
  const gui = new GUI({ title: "TsunamiLab Controls" });

  // --- Earthquake -----------------------------------------------------
  const quakeFolder = gui.addFolder("Earthquake");
  quakeFolder
    .add(state, "magnitude", 6.0, 9.5, 0.1)
    .name("Magnitude (Mw)")
    .listen(); // .listen() keeps the slider in sync if we ever update
  // magnitude from code (e.g. a "random quake" button randomizing it).

  if (onRandomQuake) {
    quakeFolder
      .add({ trigger: onRandomQuake }, "trigger")
      .name("Random Quake ⚡");
  }

  quakeFolder.open();

  // --- Playback ---------------------------------------------------------
  const playbackFolder = gui.addFolder("Playback");

  playbackFolder.add(state, "isPlaying").name("Playing").listen();

  playbackFolder.add(state, "speed", 1, 20, 1).name("Sim Speed (x)");

  if (onReset) {
    playbackFolder.add({ reset: onReset }, "reset").name("Reset ↺");
  }

  playbackFolder.open();

  // --- Visualization ----------------------------------------------------
  const visFolder = gui.addFolder("Visualization");
  visFolder.add(state, "exaggeration", 100, 2000, 50).name("Wave Exaggeration");
  // Real tsunami wave heights are meters, spread across a ~200km domain —
  // without exaggerating the vertical scale for rendering, waves would
  // be visually imperceptible bumps. This is a RENDER-ONLY multiplier;
  // it's applied in ocean.js's update() and never touches the physics
  // arrays in waveSolver.js, so measured wave heights stay physically
  // meaningful even while the picture is exaggerated.
  visFolder.open();

  return gui;
}
