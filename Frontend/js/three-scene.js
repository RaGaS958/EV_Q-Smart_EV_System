/* ═══════════════════════════════════════════════════════════════════════════
   EV_Q:? — Three.js Scenes  v5
   White-flash fix: setClearColor(0x020c12, 1) + inline style before init
   No double-init guard here — app.js S._homeThreeInit / S._vehicleThreeInit
   handle that. destroy() cleans up fully so re-init always works.
   Resize: debounced ResizeObserver on canvas parent only.
════════════════════════════════════════════════════════════════════════════ */

/* ── shared: wireframe EV car ────────────────────────────────────────────── */
function _buildEVCar(bodyC, wheelC, accentC) {
  bodyC   = bodyC   || 0x00e5ff;
  wheelC  = wheelC  || 0x00ff9d;
  accentC = accentC || 0xff6b35;

  var g = new THREE.Group();
  var H = Math.PI / 2;

  function lm(c, o) {
    return new THREE.LineBasicMaterial({
      color: c, transparent: true, opacity: o || 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
  }
  function add(geo, m, x, y, z, rx, ry, rz) {
    var ls = new THREE.LineSegments(new THREE.EdgesGeometry(geo), m);
    ls.position.set(x||0, y||0, z||0);
    if (rx||ry||rz) ls.rotation.set(rx||0, ry||0, rz||0);
    g.add(ls);
  }

  var B = lm(bodyC, 0.9), W = lm(wheelC, 0.75), A = lm(accentC, 0.65);

  add(new THREE.BoxGeometry(4.4,  0.9,  2.1),  B);
  add(new THREE.BoxGeometry(2.9,  0.75, 1.85), B,  0.15, 0.82, 0);
  add(new THREE.BoxGeometry(0.25, 0.55, 1.9),  B,  2.3, -0.15, 0);
  add(new THREE.BoxGeometry(0.25, 0.55, 1.9),  B, -2.3, -0.15, 0);
  add(new THREE.BoxGeometry(3.8,  0.12, 1.8),  W,  0,  -0.5, 0);

  var wg = new THREE.CylinderGeometry(0.47, 0.47, 0.28, 16);
  add(wg, W,  1.35, -0.52,  1.1,  0, 0, H);
  add(wg, W,  1.35, -0.52, -1.1,  0, 0, H);
  add(wg, W, -1.35, -0.52,  1.1,  0, 0, H);
  add(wg, W, -1.35, -0.52, -1.1,  0, 0, H);

  add(new THREE.BoxGeometry(0.12, 0.18, 0.35), A,  2.2, 0.1,  0.72);
  add(new THREE.BoxGeometry(0.12, 0.18, 0.35), A,  2.2, 0.1, -0.72);
  add(new THREE.BoxGeometry(0.12, 0.20, 0.50), A, -2.2, 0.1,  0.65);
  add(new THREE.BoxGeometry(0.12, 0.20, 0.50), A, -2.2, 0.1, -0.65);
  add(new THREE.BoxGeometry(1.2,  0.55, 0.05), B,  0.5, 0.9,  0.93);
  add(new THREE.BoxGeometry(1.2,  0.55, 0.05), B,  0.5, 0.9, -0.93);

  return g;
}

/* ── shared: safe canvas dimensions ─────────────────────────────────────── */
function _canvasSize(canvas) {
  // Walk up to find first ancestor with real dimensions
  var el = canvas.parentElement;
  while (el) {
    var w = el.clientWidth, h = el.clientHeight;
    if (w > 10 && h > 10) return { w: w, h: h };
    el = el.parentElement;
  }
  return { w: window.innerWidth, h: window.innerHeight };
}

/* ── shared: debounced ResizeObserver ────────────────────────────────────── */
function _makeResizer(getState, par) {
  var tid = null;
  function resize() {
    var s = getState();
    if (!s.ren || !s.cam) return;
    var w = par.clientWidth, h = par.clientHeight;
    if (!w || !h) return;
    s.ren.setSize(w, h, false);
    s.cam.aspect = w / h;
    s.cam.updateProjectionMatrix();
  }
  resize();  // run immediately
  var obs = new ResizeObserver(function() {
    clearTimeout(tid);
    tid = setTimeout(resize, 80);
  });
  obs.observe(par);
  return { obs: obs, dispose: function() { clearTimeout(tid); obs.disconnect(); } };
}

/* ═══════════════════════════════════════════════════════════════════════════
   HERO SCENE
════════════════════════════════════════════════════════════════════════════ */
var HeroScene = (function() {
  var state = { ren: null, cam: null };
  var sc = null, clk = null, car = null, pts = null;
  var afId = null, robs = null;

  function init(canvasId) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) { console.warn('HeroScene: canvas not found'); return; }

    // Destroy any previous instance first
    _cleanup();

    // Paint dark before WebGL touches the canvas
    canvas.style.cssText += ';background:#020c12!important;display:block!important;';

    clk = new THREE.Clock();
    sc  = new THREE.Scene();

    try {
      state.ren = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    } catch(e) { console.warn('HeroScene WebGL error:', e); return; }

    state.ren.setPixelRatio(Math.min(devicePixelRatio, 2));
    state.ren.setClearColor(0x020c12, 1);

    var sz = _canvasSize(canvas);
    state.ren.setSize(sz.w, sz.h, false);

    state.cam = new THREE.PerspectiveCamera(50, sz.w / sz.h, 0.1, 100);
    state.cam.position.set(5, 2.5, 7);
    state.cam.lookAt(0, 0, 0);

    // Lights
    var pA = new THREE.PointLight(0x00e5ff, 2.0, 18); pA.position.set(4, 4, 4);   sc.add(pA);
    var pB = new THREE.PointLight(0x00ff9d, 0.8, 14); pB.position.set(-4, 2, -4); sc.add(pB);

    // Grid
    var grid = new THREE.GridHelper(30, 30, 0x00e5ff, 0x001520);
    grid.material.opacity = 0.12; grid.material.transparent = true;
    grid.position.y = -0.98; sc.add(grid);

    // Car
    car = _buildEVCar(); sc.add(car);

    // Particles
    var ppos = new Float32Array(300 * 3);
    for (var i = 0; i < ppos.length; i++) ppos[i] = (Math.random() - 0.5) * 22;
    var pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(ppos, 3));
    pts = new THREE.Points(pg, new THREE.PointsMaterial({
      color: 0x00e5ff, size: 0.07, transparent: true, opacity: 0.45,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    sc.add(pts);

    // Resize watcher on the actual canvas parent
    robs = _makeResizer(function() { return state; }, canvas.parentElement);

    // Start loop
    _loop();
  }

  function _loop() {
    if (!state.ren) return;
    afId = requestAnimationFrame(_loop);
    try {
      var t = clk.getElapsedTime();
      if (car) { car.rotation.y = t * 0.18; car.position.y = Math.sin(t * 0.5) * 0.15; }
      if (pts) { pts.rotation.y = t * 0.025; pts.rotation.x = t * 0.012; }
      state.ren.render(sc, state.cam);
    } catch(e) { /* GPU context lost — next frame will try again */ }
  }

  function _cleanup() {
    if (afId)      { cancelAnimationFrame(afId); afId = null; }
    if (robs)      { robs.dispose(); robs = null; }
    if (state.ren) { state.ren.dispose(); state.ren = null; }
    state.cam = null; sc = null; clk = null; car = null; pts = null;
  }

  return { init: init, destroy: _cleanup };
}());


/* ═══════════════════════════════════════════════════════════════════════════
   VEHICLE HOLOGRAM SCENE
════════════════════════════════════════════════════════════════════════════ */
var VehicleScene = (function() {
  var state = { ren: null, cam: null };
  var sc = null, ctrl = null, clk = null;
  var carGrp = null, batRing = null, spdRing = null, orbPts = null;
  var afId = null, robs = null;
  var curBat = 75, curSpd = 60;

  function _ring(r, hex, op) {
    return new THREE.Mesh(
      new THREE.TorusGeometry(r, 0.025, 4, 80),
      new THREE.MeshBasicMaterial({
        color: hex, transparent: true, opacity: op || 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
  }

  function _orbitPts(n, r) {
    n = n || 80; r = r || 4.2;
    var p = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2, rr = r + (Math.random() - 0.5) * 1.2;
      p[i*3] = Math.cos(a)*rr; p[i*3+1] = (Math.random()-0.5)*1.8; p[i*3+2] = Math.sin(a)*rr;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({
      color: 0x00e5ff, size: 0.07, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
  }

  function init(canvasId) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) { console.warn('VehicleScene: canvas not found'); return; }

    _cleanup();

    // Paint canvas dark before WebGL
    canvas.style.cssText += ';background:#020c12!important;display:block!important;';

    clk = new THREE.Clock();
    sc  = new THREE.Scene();

    try {
      state.ren = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    } catch(e) { console.warn('VehicleScene WebGL error:', e); return; }

    state.ren.setPixelRatio(Math.min(devicePixelRatio, 2));
    state.ren.setClearColor(0x020c12, 1);

    var par = canvas.parentElement;
    var sz  = _canvasSize(canvas);
    state.ren.setSize(sz.w, sz.h, false);

    state.cam = new THREE.PerspectiveCamera(45, sz.w / sz.h, 0.1, 100);
    state.cam.position.set(0, 2.2, 8.5);

    // OrbitControls
    if (typeof THREE.OrbitControls !== 'undefined') {
      ctrl = new THREE.OrbitControls(state.cam, state.ren.domElement);
      ctrl.enableDamping = true;  ctrl.dampingFactor = 0.06;
      ctrl.minDistance = 4;       ctrl.maxDistance = 14;
      ctrl.autoRotate = true;     ctrl.autoRotateSpeed = 1.0;
      ctrl.enablePan = false;     ctrl.enableZoom = false;
    }

    // Lights
    sc.add(new THREE.AmbientLight(0x001e2e, 1.2));
    var p1 = new THREE.PointLight(0x00e5ff, 2.5, 20); p1.position.set(0, 5, 0);   sc.add(p1);
    var p2 = new THREE.PointLight(0x00ff9d, 1.2, 14); p2.position.set(-5, 0, 3);  sc.add(p2);
    var p3 = new THREE.PointLight(0xff6b35, 0.5, 10); p3.position.set(5, -1, -3); sc.add(p3);

    // Grid
    var grid = new THREE.GridHelper(16, 16, 0x00e5ff, 0x001828);
    grid.material.opacity = 0.18; grid.material.transparent = true;
    grid.position.y = -0.99; sc.add(grid);

    // Ground glow
    var glow = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 8),
      new THREE.MeshBasicMaterial({
        color: 0x00e5ff, transparent: true, opacity: 0.04,
        blending: THREE.AdditiveBlending
      })
    );
    glow.rotation.x = -Math.PI / 2; glow.position.y = -0.98; sc.add(glow);

    // Car
    carGrp = _buildEVCar(); sc.add(carGrp);

    // Orbit rings
    batRing = _ring(3.2, 0x00ff9d, 0.55); batRing.rotation.x = Math.PI / 2; sc.add(batRing);
    spdRing = _ring(4.0, 0x00e5ff, 0.3);  spdRing.rotation.x = Math.PI / 2; sc.add(spdRing);

    // Particles
    orbPts = _orbitPts(); sc.add(orbPts);

    robs = _makeResizer(function() { return state; }, par);

    _loop();
  }

  function update(data) {
    if (!data || !batRing || !spdRing) return;
    curBat = data.battery_level != null ? data.battery_level : curBat;
    curSpd = data.speed         != null ? data.speed         : curSpd;
    batRing.material.opacity = Math.max(0.12, (curBat / 100) * 0.75);
    batRing.material.color.setHex(
      curBat < 20 ? 0xff4040 : curBat < 40 ? 0xff6b35 : curBat < 60 ? 0xffb800 : 0x00ff9d
    );
    spdRing.material.opacity = 0.1 + Math.min(1, curSpd / 180) * 0.5;
  }

  function _loop() {
    if (!state.ren) return;
    afId = requestAnimationFrame(_loop);
    try {
      var t = clk.getElapsedTime();
      if (carGrp)  carGrp.position.y    = Math.sin(t * 0.6) * 0.12;
      if (batRing) batRing.rotation.z   = t * 0.4;
      if (spdRing) spdRing.rotation.z   = -t * 0.22;
      if (orbPts)  orbPts.rotation.y    = t * 0.06;
      if (ctrl)    ctrl.update();
      state.ren.render(sc, state.cam);
    } catch(e) { /* context lost — retries next frame */ }
  }

  function _cleanup() {
    if (afId)      { cancelAnimationFrame(afId); afId = null; }
    if (robs)      { robs.dispose(); robs = null; }
    if (ctrl)      { ctrl.dispose(); ctrl = null; }
    if (state.ren) { state.ren.dispose(); state.ren = null; }
    state.cam = null; sc = null; clk = null;
    carGrp = null; batRing = null; spdRing = null; orbPts = null;
  }

  return { init: init, update: update, destroy: _cleanup };
}());