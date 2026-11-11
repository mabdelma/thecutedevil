// hero3d.js: "the little devil" hero orb (home page only).
// A glossy horned orb that watches the pointer, blinks slowly and grows its
// horns as the hero scrolls. three.js core only, one canvas, no shadows,
// no post-processing. The caller keeps the inline SVG fallback if mount() throws.
import * as THREE from 'three';

const CREAM = '#FFF4E6';
const NAVY = '#06122B';
const PINK = '#FDA4AF';
const FALLBACK_ACCENT = '#E11D48';

const CFG = {
  fov: 35,
  camZ: 6,
  dprFine: 1.75,
  dprCoarse: 1.25,
  yawMax: 0.35,
  pitchMax: 0.2,
  hornMin: 0.6, // horn length at progress 0 (still reads as horns)
  ampMin: 0.012,
  ampMax: 0.03,
  idleAfter: 3.5, // seconds without pointer movement before the orb looks around by itself
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (cur, target, rate, dt) => lerp(cur, target, 1 - Math.exp(-rate * dt));

function readCssAccent() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim();
    return v || null;
  } catch (e) {
    return null;
  }
}

function toColor(value, into) {
  const c = into || new THREE.Color();
  const prev = c.getHex();
  try {
    c.set(String(value).trim());
    if (Number.isNaN(c.r) || Number.isNaN(c.g) || Number.isNaN(c.b)) c.setHex(prev);
  } catch (e) {
    c.setHex(prev);
  }
  return c;
}

// Small painted "studio" used for reflections: navy room, cream softboxes, pink spot.
function makeEnvCanvas() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 0, 128);
  bg.addColorStop(0, '#31406e');
  bg.addColorStop(0.45, '#101d42');
  bg.addColorStop(1, '#02060f');
  g.fillStyle = bg;
  g.fillRect(0, 0, 256, 128);

  const blob = (x, y, rx, ry, color, alpha) => {
    g.save();
    g.translate(x, y);
    g.scale(rx, ry);
    const r = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    r.addColorStop(0, color);
    r.addColorStop(0.55, color);
    r.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = alpha;
    g.fillStyle = r;
    g.beginPath();
    g.arc(0, 0, 1, 0, Math.PI * 2);
    g.fill();
    g.restore();
  };
  // Blobs are drawn twice (x and x +/- 256) where they cross the seam.
  blob(150, 24, 40, 18, CREAM, 1); // key softbox, upper front-left
  blob(215, 40, 12, 20, CREAM, 0.75); // tall strip, right
  blob(60, 52, 16, 11, PINK, 0.9); // pink kicker
  blob(128, 6, 90, 10, CREAM, 0.35); // ceiling wash
  blob(20, 100, 40, 12, '#27376b', 0.8); // floor bounce
  blob(276, 100, 40, 12, '#27376b', 0.8);
  return c;
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,0.9)');
  r.addColorStop(0.35, 'rgba(255,255,255,0.42)');
  r.addColorStop(0.7, 'rgba(255,255,255,0.1)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeHornGeometry(bend) {
  const geo = new THREE.ConeGeometry(0.25, 0.86, 28, 12);
  geo.translate(0, 0.43, 0); // base on y = 0
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    p.setX(i, p.getX(i) + bend * y * y);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

export function mount(hostEl, { accent } = {}) {
  if (!hostEl) throw new Error('hero3d: host element missing');

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.setAttribute('data-hero3d-canvas', '');
  Object.assign(canvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    pointerEvents: 'none',
  });

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
  } catch (e) {
    throw new Error('hero3d: WebGL unavailable');
  }
  if (!renderer || !renderer.getContext()) throw new Error('hero3d: WebGL unavailable');

  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const dprCap = coarse ? CFG.dprCoarse : CFG.dprFine;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CFG.fov, 1, 0.1, 50);
  camera.position.set(0, 0, CFG.camZ);

  const disposables = [];
  const track = (o) => {
    disposables.push(o);
    return o;
  };

  // Reflections
  const envSrc = track(new THREE.CanvasTexture(makeEnvCanvas()));
  envSrc.mapping = THREE.EquirectangularReflectionMapping;
  envSrc.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromEquirectangular(envSrc);
  scene.environment = envRT.texture;
  pmrem.dispose();

  // Colour state
  const accentColor = toColor(accent || readCssAccent() || FALLBACK_ACCENT, new THREE.Color(FALLBACK_ACCENT));
  const accentTarget = accentColor.clone();
  const hornColor = new THREE.Color();

  // Lights
  const hemi = new THREE.HemisphereLight(CREAM, NAVY, 0.55);
  const key = new THREE.DirectionalLight(CREAM, 2.1);
  key.position.set(-3.2, 4.2, 4.5);
  const fill = new THREE.DirectionalLight(PINK, 0.35);
  fill.position.set(4, -1.5, 3);
  const rim = new THREE.PointLight(accentColor.clone(), 26, 12, 2);
  rim.position.set(1.6, 1.3, -2.6);
  const rim2 = new THREE.PointLight(accentColor.clone(), 12, 12, 2);
  rim2.position.set(-2.4, -1.2, -2.2);
  scene.add(hemi, key, fill);

  // Hierarchy: root (layout, drift) > body (float, squash) > head (look, spin)
  const root = new THREE.Group();
  const body = new THREE.Group();
  const head = new THREE.Group();
  head.rotation.order = 'XYZ';
  root.add(body);
  body.add(head);
  root.add(rim, rim2);
  scene.add(root);

  // Soft glow behind the orb
  const glowTex = track(makeGlowTexture());
  const glowMat = track(
    new THREE.SpriteMaterial({
      map: glowTex,
      color: accentColor.clone(),
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    }),
  );
  const glow = new THREE.Sprite(glowMat);
  glow.scale.setScalar(4.6);
  glow.position.set(0, 0, -1.4);
  glow.renderOrder = -1;
  root.add(glow);

  // Body
  const uniforms = { uTime: { value: 0 }, uAmp: { value: CFG.ampMin } };
  const skinMat = track(
    new THREE.MeshPhysicalMaterial({
      color: accentColor.clone(),
      roughness: 0.2,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      envMapIntensity: 1.15,
      emissive: accentColor.clone(),
      emissiveIntensity: 0.1,
    }),
  );
  skinMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uAmp = uniforms.uAmp;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uAmp;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float tcdW = sin(position.x * 3.1 + uTime * 1.3)
                   + sin(position.y * 4.3 + uTime * 1.7 + 1.3)
                   + sin(position.z * 3.7 + uTime * 1.1 + 2.1);
        float tcdMask = 1.0 - 0.8 * smoothstep(0.15, 0.95, position.z);
        transformed += normalize(position) * tcdW * uAmp * tcdMask;`,
      );
  };
  const orbGeo = track(new THREE.IcosahedronGeometry(1, 32));
  const orb = new THREE.Mesh(orbGeo, skinMat);
  head.add(orb);

  // Horns (a shade deeper than the body so they read as horns)
  const hornMat = track(
    new THREE.MeshPhysicalMaterial({
      color: accentColor.clone(),
      roughness: 0.28,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.1,
      envMapIntensity: 1.0,
    }),
  );
  const horns = [];
  [-1, 1].forEach((side) => {
    const geo = track(makeHornGeometry(-side * 0.42));
    const mesh = new THREE.Mesh(geo, hornMat);
    const pivot = new THREE.Group();
    const ang = side * 0.6; // lean away from the crown
    pivot.position.set(Math.sin(ang) * 0.9, Math.cos(ang) * 0.9, 0.05);
    pivot.rotation.z = -ang;
    pivot.add(mesh);
    head.add(pivot);
    horns.push(pivot);
  });

  // Tail
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.25, -0.7, -0.6),
    new THREE.Vector3(0.85, -0.98, -0.6),
    new THREE.Vector3(1.32, -0.72, -0.45),
    new THREE.Vector3(1.42, -0.2, -0.35),
    new THREE.Vector3(1.22, 0.12, -0.3),
  ]);
  const tailGeo = track(new THREE.TubeGeometry(tailCurve, 40, 0.042, 10, false));
  const tail = new THREE.Mesh(tailGeo, hornMat);
  const tipGeo = track(new THREE.ConeGeometry(0.13, 0.3, 4, 1));
  tipGeo.translate(0, 0.12, 0);
  const tip = new THREE.Mesh(tipGeo, hornMat);
  tip.position.copy(tailCurve.getPoint(1));
  tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tailCurve.getTangent(1).normalize());
  tip.scale.z = 0.45;
  const tailGroup = new THREE.Group();
  tailGroup.add(tail, tip);
  head.add(tailGroup);

  // Eyes
  const eyeGeo = track(new THREE.SphereGeometry(1, 28, 18));
  const eyeMat = track(new THREE.MeshBasicMaterial({ color: CREAM, toneMapped: false }));
  const pupilMat = track(new THREE.MeshBasicMaterial({ color: NAVY, toneMapped: false }));
  const glintMat = track(new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }));
  const eyes = [];
  [-1, 1].forEach((side) => {
    const g = new THREE.Group();
    const white = new THREE.Mesh(eyeGeo, eyeMat);
    white.scale.set(0.15, 0.2, 0.05);
    const pupil = new THREE.Mesh(eyeGeo, pupilMat);
    pupil.scale.set(0.078, 0.105, 0.03);
    pupil.position.z = 0.032;
    const glint = new THREE.Mesh(eyeGeo, glintMat);
    glint.scale.set(0.024, 0.024, 0.012);
    glint.position.z = 0.058;
    g.add(white, pupil, glint);
    head.add(g);
    eyes.push({ side, g, pupil, glint });
  });

  // ---- state ----
  const state = {
    w: 0,
    h: 0,
    needsResize: true,
    visible: true,
    tabVisible: !document.hidden,
    contextLost: false,
    destroyed: false,
    firstFrame: false,
    raf: 0,
    last: 0,
    time: 0,
    progress: 0,
    progressTarget: 0,
    px: 0, // pointer in host NDC
    py: 0,
    hasPointer: false,
    lastMove: -99,
    lookX: 0,
    lookY: 0,
    eyeX: 0,
    eyeY: 0,
    blink: 0, // 0 open .. 1 closed
    blinkT: -1, // time inside the current blink, -1 = none
    nextBlink: 2.2,
    squash: 0,
    squashV: 0,
    baseX: 0,
    baseScale: 1,
    halfW: 1,
    halfH: 1,
    colorDirty: true,
  };

  const v3 = new THREE.Vector3();
  const zAxis = new THREE.Vector3(0, 0, 1);

  function layout() {
    const w = hostEl.clientWidth;
    const h = hostEl.clientHeight;
    state.needsResize = false;
    if (!w || !h) return false;
    state.w = w;
    state.h = h;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    state.halfH = Math.tan(THREE.MathUtils.degToRad(CFG.fov / 2)) * CFG.camZ;
    state.halfW = state.halfH * camera.aspect;
    // The CSS puts the headline on the left from 768px up (also on portrait tablets), so the orb
    // sits right of centre there and never covers the copy. Narrower hosts: centred.
    const wide = w >= 768;
    state.baseX = wide ? state.halfW * 0.42 : 0;
    const room = wide ? state.halfW - state.baseX : state.halfW;
    state.baseScale = clamp(Math.min(room / 1.7, state.halfH / 1.75), 0.3, 0.94);
    return true;
  }

  function applyColor(dt) {
    accentColor.lerp(accentTarget, dt === 0 ? 1 : 1 - Math.exp(-6 * dt));
    if (Math.abs(accentColor.r - accentTarget.r) + Math.abs(accentColor.g - accentTarget.g) + Math.abs(accentColor.b - accentTarget.b) < 0.002) {
      accentColor.copy(accentTarget);
      state.colorDirty = false;
    }
    skinMat.color.copy(accentColor);
    skinMat.emissive.copy(accentColor);
    hornColor.copy(accentColor).multiplyScalar(0.62);
    hornMat.color.copy(hornColor);
    rim.color.copy(accentColor);
    rim2.color.copy(accentColor);
    glowMat.color.copy(accentColor);
  }

  function placeEye(eye, yaw, pitch) {
    // direction on the unit sphere, in head space
    const cy = Math.cos(pitch);
    v3.set(Math.sin(yaw) * cy, Math.sin(pitch), Math.cos(yaw) * cy);
    eye.g.quaternion.setFromUnitVectors(zAxis, v3);
    eye.g.position.copy(v3).multiplyScalar(0.985);
  }

  function update(dt) {
    state.time += dt;
    const t = state.time;
    uniforms.uTime.value = t;

    state.progress = damp(state.progress, state.progressTarget, 7, dt);
    const p = state.progress;

    // Where is the pointer relative to the orb?
    let tx;
    let ty;
    const idle = !state.hasPointer || t - state.lastMove > CFG.idleAfter;
    if (idle) {
      // calm, curious glances
      tx = Math.sin(t * 0.37) * 0.55 + Math.sin(t * 0.83 + 1.7) * 0.2;
      ty = Math.sin(t * 0.29 + 0.6) * 0.3;
    } else {
      v3.copy(root.position).project(camera);
      tx = clamp((state.px - v3.x) * 1.1, -1, 1);
      ty = clamp((state.py - v3.y) * 1.1, -1, 1);
    }
    state.eyeX = damp(state.eyeX, tx, idle ? 2.2 : 9, dt); // eyes lead
    state.eyeY = damp(state.eyeY, ty, idle ? 2.2 : 9, dt);
    state.lookX = damp(state.lookX, tx, idle ? 1.4 : 3.6, dt); // head follows
    state.lookY = damp(state.lookY, ty, idle ? 1.4 : 3.6, dt);

    // Root: layout + scroll drift
    const s = state.baseScale * lerp(1, 0.84, p);
    root.position.x = state.baseX + p * state.halfW * 0.08 * (state.baseX ? 1 : 0);
    root.position.y = p * 0.1;
    root.scale.setScalar(s);

    // Body: float + squash spring
    const k = 120;
    const c = 11;
    state.squashV += (-k * state.squash - c * state.squashV) * dt;
    state.squash += state.squashV * dt;
    const sq = clamp(state.squash, -0.3, 0.3);
    body.position.y = Math.sin(t * 0.9) * 0.05 - sq * 0.35;
    body.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);

    // Head: look + spin + a little life
    const spin = p * Math.PI * 2;
    head.rotation.x = -state.lookY * CFG.pitchMax + Math.sin(t * 0.7) * 0.02;
    head.rotation.y = state.lookX * CFG.yawMax + spin;
    head.rotation.z = -state.lookX * 0.06 + Math.sin(t * 0.5 + 1) * 0.025 * (1 + p);

    // Horns grow with scroll
    const hl = lerp(CFG.hornMin, 1, p);
    const hw = lerp(0.85, 1, p);
    horns[0].scale.set(hw, hl, hw);
    horns[1].scale.set(hw, hl, hw);

    // Tail sways
    tailGroup.rotation.z = Math.sin(t * 1.1) * 0.05 * (1 + p);
    tailGroup.rotation.y = Math.sin(t * 0.8 + 0.5) * 0.08;

    // Wobble
    uniforms.uAmp.value = lerp(CFG.ampMin, CFG.ampMax, p);

    // Blink: slow and knowing
    if (state.blinkT < 0 && t > state.nextBlink) state.blinkT = 0;
    if (state.blinkT >= 0) {
      state.blinkT += dt;
      const d = 0.52;
      const x = state.blinkT / d;
      if (x >= 1) {
        state.blinkT = -1;
        state.blink = 0;
        state.nextBlink = t + (Math.random() < 0.18 ? 0.35 : 3 + Math.random() * 3.5);
      } else {
        // close quickly, hold a breath, open slowly
        state.blink = x < 0.3 ? x / 0.3 : x < 0.45 ? 1 : 1 - (x - 0.45) / 0.55;
        state.blink = state.blink * state.blink * (3 - 2 * state.blink);
      }
    }
    const lid = Math.max(0.16, state.blink, clamp(sq * 2.2, 0, 0.85)); // resting lid: a knowing look
    for (let i = 0; i < eyes.length; i++) {
      const e = eyes[i];
      placeEye(e, e.side * 0.34 + state.eyeX * 0.1, 0.1 + state.eyeY * 0.07);
      e.g.scale.set(1 + lid * 0.08, Math.max(0.06, 1 - lid), 1);
      e.pupil.position.x = state.eyeX * 0.052;
      e.pupil.position.y = state.eyeY * 0.062;
      e.glint.position.x = e.pupil.position.x - 0.026;
      e.glint.position.y = e.pupil.position.y + 0.04;
    }

    // Glow breathes
    glowMat.opacity = 0.5 + Math.sin(t * 0.8) * 0.05 + p * 0.08;
    glow.scale.setScalar(4.6 + Math.sin(t * 0.8) * 0.12);

    if (state.colorDirty) applyColor(dt);
  }

  function frame(now) {
    state.raf = 0;
    if (state.destroyed || state.contextLost) return;
    if (!state.visible || !state.tabVisible) return;
    state.raf = requestAnimationFrame(frame);
    const dt = state.last ? Math.min((now - state.last) / 1000, 0.05) : 0.016;
    state.last = now;
    if (state.needsResize && !layout()) return;
    if (!state.w) return;
    update(dt);
    renderer.render(scene, camera);
    if (!state.firstFrame) {
      state.firstFrame = true;
      hostEl.classList.add('is-3d');
    }
  }

  function start() {
    if (state.raf || state.destroyed || state.contextLost) return;
    if (!state.visible || !state.tabVisible) return;
    state.last = 0;
    state.raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  // ---- events ----
  function onPointerMove(e) {
    const r = hostEl.getBoundingClientRect();
    if (!r.width || !r.height) return;
    state.px = ((e.clientX - r.left) / r.width) * 2 - 1;
    state.py = -(((e.clientY - r.top) / r.height) * 2 - 1);
    state.hasPointer = true;
    state.lastMove = state.time;
  }

  function onPointerDown(e) {
    onPointerMove(e);
    if (!state.w) return;
    // soft squash only when the press lands on (or right next to) the orb
    v3.copy(root.position).project(camera);
    const dx = (state.px - v3.x) * state.halfW;
    const dy = (state.py - v3.y) * state.halfH;
    const rad = root.scale.x * 1.25;
    if (dx * dx + dy * dy < rad * rad) state.squashV += 2.6;
  }

  function onVisibility() {
    state.tabVisible = !document.hidden;
    if (state.tabVisible) start();
    else stop();
  }

  function onTheme() {
    // the switcher may dispatch before the attribute lands in computed style
    requestAnimationFrame(() => {
      if (state.destroyed) return;
      const v = readCssAccent();
      if (v) api.setAccent(v);
    });
  }

  function onContextLost(e) {
    e.preventDefault();
    state.contextLost = true;
    stop();
    hostEl.classList.remove('is-3d'); // SVG fallback shows again
  }

  function onContextRestored() {
    state.contextLost = false;
    state.firstFrame = false;
    state.needsResize = true;
    start();
  }

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('tcd:theme', onTheme);
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      state.needsResize = true;
    });
    ro.observe(hostEl);
  } else {
    window.addEventListener('resize', onWindowResize);
  }
  function onWindowResize() {
    state.needsResize = true;
  }

  let io = null;
  if (typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver(
      (entries) => {
        state.visible = entries[entries.length - 1].isIntersecting;
        if (state.visible) start();
        else stop();
      },
      { threshold: 0 },
    );
    io.observe(hostEl);
  }

  const api = {
    setAccent(hex) {
      if (state.destroyed || hex == null) return;
      toColor(hex, accentTarget);
      state.colorDirty = true;
    },
    setProgress(p) {
      const n = Number(p);
      state.progressTarget = Number.isFinite(n) ? clamp(n, 0, 1) : 0;
    },
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      stop();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onWindowResize);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('tcd:theme', onTheme);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      scene.environment = null;
      envRT.dispose();
      disposables.forEach((d) => d.dispose && d.dispose());
      renderer.dispose();
      hostEl.classList.remove('is-3d');
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    },
  };

  applyColor(0);
  hostEl.appendChild(canvas);
  layout();
  start();
  return api;
}

export default mount;
