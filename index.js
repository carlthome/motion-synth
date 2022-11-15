/* Play synth pad sounds by filtering webcam pixels through bandpass filters,
with frequencies corresponding to 12-TET notes across the 2D canvas. (loudness
up and down, pitch left and right).
*/
"use strict";

// Draw filled circles (just like fillRect).
CanvasRenderingContext2D.prototype.fillCircle = function (x, y, r) {
  this.beginPath();
  this.arc(x, y, r, 0, 2 * Math.PI);
  this.fill();
}

// Populate audio buffer with image data.
AudioBufferSourceNode.prototype.setImage = function (image) {
  const samples = 320*240
  const channels = 1
  console.log(this)
  const data = this.context.createBuffer(channels, samples, this.context.sampleRate);
  for (var i = 0; i < data.length; ++i) {
    const pixel = i * 4;
    const r = image.data[pixel];
    const g = image.data[pixel + 1];
    const b = image.data[pixel + 2];
    const a = image.data[pixel + 3];
    const avg = (r + g + b + a) / 4;
    data[i] = 2 * avg / 255 - 1;
  }
  this.buffer = data;
};

window.onload = () => {
  checkBrowserSupport();
  window.addEventListener("click", start);
  window.addEventListener("load", scaleVisuals);
  window.addEventListener("resize", scaleVisuals);
}

window.addEventListener("load", onload);

function start() {
  const audioContext = new AudioContext();
  const masterBuss = createMasterBuss(audioContext);
  const bufferSource = createAudioSource(audioContext);
  const notes = createScale(audioContext, bufferSource, masterBuss);
  createWebcamCapture(bufferSource, notes);
}

// Require browser functionality.
function checkBrowserSupport() {
  if (navigator.mediaDevices === undefined) {
    alert("Please switch browser to the latest desktop version of Google Chrome.");
  }
  if (AudioContext === 'undefined') {
    alert("Please make sure your browser supports Web Audio.");
  }
}

// Scale canvas to viewport.
function scaleVisuals() {
  visuals.width = window.innerWidth;
  visuals.height = window.innerHeight;
}

// Setup motion detection with a webcam to create and trigger sounds.
function createWebcamCapture(bufferSource, notes) {
  navigator.mediaDevices.getUserMedia({ video: true }).then(function (stream) {
    video.srcObject = stream;
    video.onloadedmetadata = function (e) {
      video.play();

      // Motion detection parameters.
      const threshold = 0.25; // Percentage of changed pixels required in a motion detect region for the region to trigger a motion event.
      const rows = 10; // Amplitudes
      const columns = notes.filters.length; // Pitches

      function onMotionDetected(e) {
        const noteId = e.x;
        const amplitude = 1 - (e.y / rows);
        notes.filters[noteId].play(amplitude);
      }

      // Create canvas to blit video frames to.
      const c = document.createElement('canvas');
      c.width = video.width;
      c.height = video.height;
      const frames = c.getContext('2d');
      frames.translate(c.width, 0);
      frames.scale(-1, 1);

      // Perform motion detection to trigger notes, analyse and visualize audio continously.
      const ctx = visuals.getContext('2d');
      var previousFrame = null
      function loop() {

        // Blit video to canvas.
        frames.drawImage(video, 0, 0, video.width, video.height);
        const currentFrame = frames.getImageData(0, 0, video.width, video.height);

        // Playback video frame as audio.
        bufferSource.setImage(currentFrame);

        // Motion detect and trigger audio filters in callback.
        previousFrame = detectMotion(previousFrame, currentFrame, threshold, rows, columns, onMotionDetected);

        // Render graphics on top of video frame.
        visualize(ctx, notes);

        // Call continuously.
        requestAnimationFrame(loop);
      }
      loop();
    };
  }).catch(function (e) {
    console.error(e);
    alert(`Motion detection not working (${e.name}). This website requires a webcam.`);
  });
}

// Create master buss with gain controls, a limiter, and some EQ:ing.
function createMasterBuss(audioContext) {
  const masterIn = audioContext.createGain();
  const masterOut = audioContext.createGain();
  masterIn.gain.value = 0.9;
  masterOut.gain.value = 0.9;

  const compressor = audioContext.createDynamicsCompressor();
  compressor.ratio.value = 20;
  compressor.threshold.value = -30;

  const filter = audioContext.createBiquadFilter();
  filter.type = 'highshelf';
  filter.frequency.value = 1000;
  filter.gain.value = -24;

  //masterIn.connect(filter);
  //filter.connect(compressor);
  //compressor.connect(masterOut);
  //masterOut.connect(audioContext.destination);
  masterIn.connect(audioContext.destination);

  return masterIn;
}

// Source audio is noise generated from the latest webcam frame.
function createAudioSource(audioContext) {
  const width = 320;
  const height = 240;
  const channels = 1;
  const samples = width * height;
  const buffer = audioContext.createBuffer(channels, samples, audioContext.sampleRate);
  const bufferSource = audioContext.createBufferSource();
  bufferSource.buffer = buffer;
  bufferSource.loop = true;
  bufferSource.start();
  return bufferSource;
}

// Setup notes like a piano, but with only a diatonic scale.
function createScale(audioContext, audioInput, audioOutput) {
  const lowestNote = 21;
  const highestNote = 107;
  const scale = [0, 2, 4, 5, 7, 9, 11];

  const filters = [];
  for (var i = 0; i < (scale.length / 12) * (highestNote - lowestNote); ++i) {
    const octave = Math.floor(i / scale.length);
    const midiNote = lowestNote + octave * 12 + scale[i % scale.length];
    const note = new Note(midiNote, audioContext, audioInput, audioOutput);
    filters.push(note);
  }

  const notes = { filters, lowestNote, highestNote };
  return notes;
}

// A note consists of several resonance peaks filtering the buffer source at the corresponding harmonic series.
class Note {
  constructor(midiNote, audioContext, audioInput, audioOutput) {
    this.note = midiNote;
    this.resonances = [];
    this.audioContext = audioContext;

    // Create resonance peaks.
    const peaks = 2;
    for (var harmonic = 1; harmonic <= peaks; ++harmonic) {
      const frequency = harmonic * mtof(midiNote);
      const resonancePeak = createResonancePeak(frequency, harmonic, audioContext, audioInput, audioOutput);
      console.debug(resonancePeak);
      this.resonances.push(resonancePeak);
    }

    // Register interval functions.
    for (var i = 0; i < this.resonances.length; ++i) {
      const update = this.resonances[i].update;
      setInterval(update, 33);
    }
  }

  // Play sound from generator by an ADSR envelope.
  play(velocity) {
    const now = this.audioContext.currentTime;
    for (var i = 0; i < this.resonances.length; ++i) {
      const r = this.resonances[i];

      const peakWidth = Math.min(1000, velocity * 1000);
      const amplitude = Math.min(1, velocity / (i + 1)); // Reduce amplitude for higher partials.

      r.filter.Q.cancelScheduledValues(now);
      r.filter.Q.setValueAtTime(r.filter.Q.value, now);
      r.filter.Q.linearRampToValueAtTime(peakWidth, now + r.attackTime);
      r.filter.Q.linearRampToValueAtTime(0, now + r.attackTime + r.releaseTime);

      r.volume.gain.cancelScheduledValues(now);
      r.volume.gain.setValueAtTime(r.volume.gain.value, now);
      r.volume.gain.linearRampToValueAtTime(amplitude, now + r.attackTime);
      r.volume.gain.linearRampToValueAtTime(0, now + r.attackTime + r.releaseTime);
    }
  }
}

// Create white noise filter at given note's chosen harmonic.
function createResonancePeak(frequency, harmonic, audioContext, audioInput, audioOutput) {

  // Determine attack and release time.
  const baseAttack = 0.5;
  const baseRelease = 1.0;
  const attack = baseAttack * harmonic;
  const release = baseRelease / harmonic;
  const detuneCents = 25;
  const panScale = 0.2;

  // Filter out the desired frequency from the buffer source.
  const filter = audioContext.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = frequency;
  filter.Q.value = 1000.0;

  // Create pan control.
  const panner = audioContext.createPanner();
  panner.panningModel = "equalpower";

  // Create volume control
  const volume = audioContext.createGain();
  volume.gain.value = 0.0;

  // Connect components.
  volume.connect(audioOutput);
  panner.connect(volume);
  filter.connect(panner);
  audioInput.connect(filter);

  // Continously change position of resonance peak.
  var x = random(-1, 1);
  var y = 0;
  var z = 0;
  const tick = function () {
    x *= random(1 - panScale, 1 + panScale);
    y *= random(1 - panScale, 1 + panScale);
    z *= random(1 - panScale, 1 + panScale);
    panner.setPosition(x, y, z);
    filter.detune.value = random(-detuneCents, detuneCents);
  }

  return {
    filter: filter,
    panner: panner,
    volume: volume,
    attackTime: attack,
    releaseTime: release,
    update: tick,
  };
}

// Visualize sound on canvas.
function visualize(ctx, notes) {

  // Clear background (with ghosting).
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(0,0,0,0.1)';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Draw stars
  ctx.globalCompositeOperation = 'screen';
  const w = ctx.canvas.width / notes.filters.length;
  const h = ctx.canvas.height;
  for (var i = 0; i < notes.filters.length; ++i) {
    for (var j = 0; j < notes.filters[i].resonances.length; ++j) {
      const v = notes.filters[i].resonances[j].volume.gain.value;
      const f = Math.max(0, Math.min(1, (notes.filters[i].resonances[j].filter.frequency.value - mtof(notes.lowestNote)) / mtof(notes.highestNote - notes.lowestNote)));
      const n = (notes.filters[i].note - notes.lowestNote) / (notes.highestNote - notes.lowestNote);
      const x = i * w;
      const y = ctx.canvas.height - v * ctx.canvas.height;
      ctx.shadowBlur = w * v;
      ctx.shadowColor = ctx.fillStyle = 'hsl(' + 360 * (1 - f) + ', ' + 100 * v + '%, ' + 100 * n + '%)';
      ctx.fillCircle(w / 2 + random(x - w * n * v, x + w * n * v), random(y - w * n * v, y + w * n * v), w * (1 - n) * v);
    }
  }
}

// Perform video motion detection by calculating the pixel difference between
// previous and current frame and counting changed pixels over a grid.
function detectMotion(previousFrame, currentFrame, threshold, rows, columns, onMotionDetectedCallback) {

  // Initialize grid with motion detection state.
  const activePixels = new Array(currentFrame.height);
  for (var y = 0; y < currentFrame.height; ++y) {
    activePixels[y] = new Array(currentFrame.width);
    for (var x = 0; x < currentFrame.width; ++x) {
      activePixels[y][x] = false;
    }
  }

  // Go through RGBA data and calculate pixel-per-pixel difference between current and previous frame.
  if (previousFrame == null) previousFrame = currentFrame;
  var n = 0;
  for (var i = 0; i < currentFrame.data.length / 4; ++i) {
    const avg1 = (currentFrame.data[4 * i] + currentFrame.data[4 * i + 1] + currentFrame.data[4 * i + 2] + currentFrame.data[4 * i + 3]) / 4;
    const avg2 = (previousFrame.data[4 * i] + previousFrame.data[4 * i + 1] + previousFrame.data[4 * i + 2] + previousFrame.data[4 * i + 3]) / 4;
    const x = i % currentFrame.width;
    const y = Math.floor(i / currentFrame.width);
    activePixels[y][x] = Math.abs(avg1 - avg2) > 25 ? true : false;
    if (activePixels[y][x]) {
      ++n;
    }
  }

  // If too many pixels changed: do nothing.
  if (n > threshold * currentFrame.data.length / 4) return;

  // Look for enough changed pixels in each image area.
  const w = Math.floor(currentFrame.width / columns);
  const h = Math.floor(currentFrame.height / rows);
  const changedPixelsNeeded = threshold * w * h;
  for (var i = 0; i < columns; ++i) {
    for (var j = 0; j < rows; ++j) {

      // Count active pixels per area.
      var c = 0;
      for (var y = j * h; y < (j + 1) * h; ++y) {
        for (var x = i * w; x < (i + 1) * w; ++x) {
          if (activePixels[y][x]) {
            ++c;
          }
        }
      }

      // If enough active pixels: trigger motion detected event for column at row.
      if (c > changedPixelsNeeded) {
        const e = { x: i, y: j };
        onMotionDetectedCallback(e);
        break;
      }
    }
  }
  return currentFrame;
}

// Convert a MIDI note number to a frequency.
function mtof(n) {
  return Math.pow(2, (n - 69) / 12) * 440;
}

// Convert a frequency to a MIDI note number.
function ftom(f) {
  return Math.floor(12 * Math.log(f / 440) / Math.log(2) + 49)
}

// Get a random float between the input range.
function random(min, max) {
  return Math.random() * (max - min) + min
}

// Shuffle an array (Fisher-Yates method).
function shuffle(array) {
  var counter = array.length, temp, index;
  while (counter > 0) {
    index = Math.floor(Math.random() * counter);
    counter--;
    temp = array[counter];
    array[counter] = array[index];
    array[index] = temp;
  }
  return array;
}
