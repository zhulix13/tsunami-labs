/**
 * controls.js
 * -----------------------------------------------------------------------
 * Custom UI control panel. Binds the HTML DOM elements to the shared state.
 */

export function createControls(state, { onReset, onRandomQuake } = {}) {
  // Playback
  const btnPlay = document.getElementById("btn-play");
  const btnPause = document.getElementById("btn-pause");
  const btnReset = document.getElementById("btn-reset");
  const speedSlider = document.getElementById("sim-speed");
  const speedVal = document.getElementById("val-speed");

  const updatePlayPauseUI = () => {
    if (state.isPlaying) {
      btnPlay.classList.add("active");
      btnPause.classList.remove("active");
    } else {
      btnPlay.classList.remove("active");
      btnPause.classList.add("active");
    }
  };

  btnPlay.addEventListener("click", () => { state.isPlaying = true; updatePlayPauseUI(); });
  btnPause.addEventListener("click", () => { state.isPlaying = false; updatePlayPauseUI(); });
  if (onReset) btnReset.addEventListener("click", onReset);

  speedSlider.addEventListener("input", (e) => {
    state.speed = parseFloat(e.target.value);
    speedVal.textContent = `${state.speed}x`;
  });

  // Visualization
  const exagSlider = document.getElementById("wave-exag");
  const exagVal = document.getElementById("val-exaggeration");
  exagSlider.addEventListener("input", (e) => {
    state.exaggeration = parseFloat(e.target.value);
    exagVal.textContent = `${state.exaggeration}x`;
  });

  const btnHide = document.getElementById("btn-hide-ui");
  let uiHidden = false;
  btnHide.addEventListener("click", () => {
    uiHidden = !uiHidden;
    document.getElementById("left-sidebar").style.display = uiHidden ? "none" : "flex";
    document.getElementById("right-sidebar").style.display = uiHidden ? "none" : "flex";
    document.getElementById("bottom-bar").style.display = uiHidden ? "none" : "flex";
  });

  // Earthquake
  const btnRandom = document.getElementById("btn-random-quake");
  if (onRandomQuake && btnRandom) {
    btnRandom.addEventListener("click", onRandomQuake);
  }

  const magSlider = document.getElementById("mag-slider");
  const magVal = document.getElementById("val-mag");
  magSlider.addEventListener("input", (e) => {
    state.magnitude = parseFloat(e.target.value);
    magVal.textContent = state.magnitude.toFixed(1);
  });

  const depthSlider = document.getElementById("depth-slider");
  const depthVal = document.getElementById("val-depth");
  depthSlider.addEventListener("input", (e) => {
    state.hypocenterDepth = parseFloat(e.target.value);
    depthVal.textContent = state.hypocenterDepth;
  });

  const dirSlider = document.getElementById("dir-slider");
  const dirVal = document.getElementById("val-dir");
  dirSlider.addEventListener("input", (e) => {
    state.faultDirection = parseFloat(e.target.value);
    dirVal.textContent = state.faultDirection;
  });

  // Expose a method to update UI from code (e.g. random quake changes magnitude)
  return {
    syncUI: () => {
      magSlider.value = state.magnitude;
      magVal.textContent = state.magnitude.toFixed(1);
      
      depthSlider.value = state.hypocenterDepth;
      depthVal.textContent = state.hypocenterDepth;

      dirSlider.value = state.faultDirection;
      dirVal.textContent = state.faultDirection;
      
      updatePlayPauseUI();
    }
  };
}
