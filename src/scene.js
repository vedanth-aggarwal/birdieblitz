import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { HALF_L, HALF_W, HALF_W_DOUBLES, SHORT_LINE, NET_H } from './physics.js';

const INK = 0x1d2340;
const PALETTE = [0xff4f8b, 0xffd23f, 0x3ec7ff, 0x9b6bff, 0x3bd16f, 0xff8a3d];
export const SHUTTLE_SCALE = 3.6; // shuttle drawn larger than real so it reads at distance

// ---------- helpers ----------
const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0, envMapIntensity: 0.35, ...o });
const glow = (color, intensity = 1.6, o = {}) => std(color, { emissive: color, emissiveIntensity: intensity, ...o });
const NEON = { cyan: 0x00e5ff, magenta: 0xff2bd6, lime: 0xc6ff00, violet: 0x8a5cff };

const outlineMats = new Map();
function outlineMat(thick) {
  if (!outlineMats.has(thick)) {
    outlineMats.set(thick, new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(INK) }, thick: { value: thick } },
      vertexShader: `uniform float thick;
        void main(){ vec3 p = position + normal * thick;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
      fragmentShader: `uniform vec3 color; void main(){ gl_FragColor = vec4(color, 1.0); }`,
      side: THREE.BackSide,
    }));
  }
  return outlineMats.get(thick);
}
function withOutline(mesh, thick = 0.012) {
  const o = new THREE.Mesh(mesh.geometry, outlineMat(thick));
  mesh.add(o);
  return mesh;
}
function shadowy(obj, cast = true, receive = true) {
  obj.traverse(o => { if (o.isMesh && !(o.material instanceof THREE.ShaderMaterial)) { o.castShadow = cast; o.receiveShadow = receive; } });
  return obj;
}
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

// ---------- environment ----------
function makeSky() {
  return new THREE.Mesh(new THREE.SphereGeometry(150, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: new THREE.Color(0x020309) }, mid: { value: new THREE.Color(0x0a0820) }, bottom: { value: new THREE.Color(0x1a0f3a) } },
    vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP;
      void main(){ float h = vP.y; vec3 c = mix(bottom, mid, smoothstep(-0.05, 0.18, h)); c = mix(c, top, smoothstep(0.18, 0.75, h)); gl_FragColor = vec4(c, 1.0); }`,
  }));
}

function makeStars() {
  const pts = [];
  for (let i = 0; i < 700; i++) {
    const a = Math.random() * Math.PI * 2, e = 0.08 + Math.random() * 1.3, r = 120;
    pts.push(Math.cos(a) * Math.cos(e) * r, Math.sin(e) * r, Math.sin(a) * Math.cos(e) * r);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xb9c4ff, size: 0.35, sizeAttenuation: true, fog: false, transparent: true, opacity: 0.7 }));
}

function makeGround() {
  const g = new THREE.Group();
  const grass = new THREE.Mesh(new THREE.CircleGeometry(140, 64), std(0x05060d, { roughness: 0.95 }));
  grass.rotation.x = -Math.PI / 2; grass.position.y = -0.02; grass.receiveShadow = true; g.add(grass);

  const plazaTex = canvasTex(512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#0a0b16'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#141833'; ctx.lineWidth = 6;
    for (let i = 0; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(i * 128, 0); ctx.lineTo(i * 128, h); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i * 128); ctx.lineTo(w, i * 128); ctx.stroke(); }
  }, [20, 20]);
  const plaza = new THREE.Mesh(new THREE.CircleGeometry(22, 64), std(0xffffff, { map: plazaTex, roughness: 0.8 }));
  plaza.rotation.x = -Math.PI / 2; plaza.position.y = -0.01; plaza.receiveShadow = true; g.add(plaza);

  // Badminton court: surround + green playing surface + regulation lines (doubles + singles)
  const W = 9, L = 17.4, ppm = 80; // canvas pixels per meter
  const drawCourt = lines => (ctx, w, h) => {
    ctx.fillStyle = '#0b0c1a'; ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, m = v => v * ppm;
    ctx.fillStyle = '#0e1330'; ctx.fillRect(cx - m(HALF_W_DOUBLES), cy - m(HALF_L), m(HALF_W_DOUBLES * 2), m(HALF_L * 2));
    ctx.fillStyle = '#10163a';
    for (let y = cy - m(HALF_L); y < cy + m(HALF_L); y += m(1.2)) ctx.fillRect(cx - m(HALF_W_DOUBLES), y, m(HALF_W_DOUBLES * 2), m(0.6));
    ctx.fillStyle = '#000'; if (lines) ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = m(0.05);
    const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(cx + m(x1), cy + m(y1)); ctx.lineTo(cx + m(x2), cy + m(y2)); ctx.stroke(); };
    ctx.strokeRect(cx - m(HALF_W_DOUBLES), cy - m(HALF_L), m(HALF_W_DOUBLES * 2), m(HALF_L * 2));
    for (const s of [-1, 1]) {
      line(s * HALF_W, -HALF_L, s * HALF_W, HALF_L);                       // singles sidelines
      line(-HALF_W_DOUBLES, s * SHORT_LINE, HALF_W_DOUBLES, s * SHORT_LINE); // short service lines
      line(-HALF_W_DOUBLES, s * (HALF_L - 0.76), HALF_W_DOUBLES, s * (HALF_L - 0.76)); // doubles long service
      line(0, s * SHORT_LINE, 0, s * HALF_L);                              // center lines
    }
  };
  const courtTex = canvasTex(W * ppm, L * ppm, drawCourt(false));
  const lineTex = canvasTex(W * ppm, L * ppm, drawCourt(true));
  const court = new THREE.Mesh(new THREE.PlaneGeometry(W, L), std(0xffffff, { map: courtTex, roughness: 0.6, emissive: 0xffffff, emissiveMap: lineTex, emissiveIntensity: 1.1 }));
  court.rotation.x = -Math.PI / 2; court.position.y = 0.002; court.receiveShadow = true; g.add(court);
  return g;
}

function makeNet() {
  const g = new THREE.Group();
  const span = HALF_W_DOUBLES + 0.1;
  const netTex = canvasTex(512, 64, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h); ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 2;
    for (let x = 0; x <= w; x += 8) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y <= h; y += 8) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }, [6, 1]);
  const netH = 0.76;
  const net = new THREE.Mesh(new THREE.PlaneGeometry(span * 2, netH),
    new THREE.MeshStandardMaterial({ map: netTex, color: 0x6a5cff, emissive: 0x3a2cff, emissiveMap: netTex, emissiveIntensity: 0.6, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide }));
  net.position.set(0, NET_H - netH / 2, 0); g.add(net);
  const tape = withOutline(new THREE.Mesh(new RoundedBoxGeometry(span * 2, 0.05, 0.03, 2, 0.01), glow(0xffffff, 1.4)), 0.006);
  tape.position.set(0, NET_H - 0.02, 0); g.add(tape);
  for (const sx of [-1, 1]) {
    const post = withOutline(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, NET_H + 0.04, 16), glow(NEON.magenta, 1.2)), 0.01);
    post.position.set(sx * span, (NET_H + 0.04) / 2, 0); g.add(post);
    const base = withOutline(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.1, 24), std(0x1a1c33)), 0.01);
    base.position.set(sx * span, 0.05, 0); g.add(base);
    const cap = withOutline(new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), glow(NEON.magenta, 1.6)), 0.008);
    cap.position.set(sx * span, NET_H + 0.06, 0); g.add(cap);
  }
  return shadowy(g);
}

function makeStandsAndCrowd() {
  const g = new THREE.Group();
  const tierMats = [std(0x12142a), std(0x15183a), std(0x191d45)];
  const seats = [];
  for (let r = 0; r < 3; r++) {
    const tier = new THREE.Mesh(new RoundedBoxGeometry(14, 0.5 * (r + 1), 1, 2, 0.06), tierMats[r]);
    tier.position.set(0, 0.25 * (r + 1), -10.6 - r); g.add(tier);
    for (let x = -6.6; x <= 6.6; x += 0.62) seats.push(new THREE.Vector3(x + (Math.random() - 0.5) * 0.15, 0.5 * (r + 1), -10.6 - r));
  }
  for (const sx of [-1, 1]) {
    for (let r = 0; r < 3; r++) {
      const tier = new THREE.Mesh(new RoundedBoxGeometry(1, 0.5 * (r + 1), 15, 2, 0.06), tierMats[r]);
      tier.position.set(sx * (6.4 + r), 0.25 * (r + 1), -1.5); g.add(tier);
      for (let z = -8.6; z <= 5.6; z += 0.62) seats.push(new THREE.Vector3(sx * (6.4 + r), 0.5 * (r + 1), z + (Math.random() - 0.5) * 0.15));
    }
  }
  shadowy(g);
  const n = seats.length;
  const bodies = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.17, 0.26, 4, 12), std(0xffffff, { roughness: 0.6 }), n);
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.15, 16, 12), std(0xffffff, { roughness: 0.6 }), n);
  const skins = [0xffdbb5, 0xf2c39b, 0xd99c6c, 0xa86d43, 0x7a4a2a];
  const col = new THREE.Color();
  const fans = seats.map((seat, i) => {
    bodies.setColorAt(i, col.setHex(PALETTE[(i * 7) % PALETTE.length]).multiplyScalar(0.35));
    heads.setColorAt(i, col.setHex(skins[(i * 3) % skins.length]).multiplyScalar(0.4));
    return { seat, phase: Math.random() * Math.PI * 2, speed: 1.5 + Math.random() * 1.5 };
  });
  bodies.castShadow = heads.castShadow = true;
  g.add(bodies, heads);
  const m = new THREE.Matrix4();
  const update = (t, excite) => {
    fans.forEach((f, i) => {
      const y = f.seat.y + 0.3 + Math.abs(Math.sin(t * (f.speed + excite * 4) + f.phase)) * (0.02 + excite * 0.22);
      m.makeTranslation(f.seat.x, y, f.seat.z); bodies.setMatrixAt(i, m);
      m.makeTranslation(f.seat.x, y + 0.36, f.seat.z); heads.setMatrixAt(i, m);
    });
    bodies.instanceMatrix.needsUpdate = true; heads.instanceMatrix.needsUpdate = true;
  };
  update(0, 0);
  return { group: g, update };
}

function makeBunting() {
  const g = new THREE.Group();
  const flagGeo = new THREE.BufferGeometry();
  flagGeo.setAttribute('position', new THREE.Float32BufferAttribute([-0.15, 0, 0, 0.15, 0, 0, 0, -0.3, 0], 3));
  flagGeo.computeVertexNormals();
  const corners = [[-5.6, -9.6], [5.6, -9.6], [-5.6, 6.5], [5.6, 6.5]];
  for (const [x, z] of corners) {
    const p = withOutline(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 4.4, 12), std(0x1a1c33)), 0.012);
    p.position.set(x, 2.2, z); g.add(p);
    const top = withOutline(new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), glow(NEON.violet, 1.4)), 0.012);
    top.position.set(x, 4.45, z); g.add(top);
  }
  const strings = [[corners[0], corners[1]], [corners[0], corners[2]], [corners[1], corners[3]]];
  const flags = [];
  let count = 0;
  for (const [[ax, az], [bx, bz]] of strings) {
    const a = new THREE.Vector3(ax, 4.3, az), b = new THREE.Vector3(bx, 4.3, bz);
    const n = Math.round(a.distanceTo(b) / 0.5), pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, p = a.clone().lerp(b, t); p.y -= Math.sin(t * Math.PI) * 0.7; pts.push(p);
      if (i > 0 && i < n) flags.push({ p, dir: b.clone().sub(a).normalize(), c: PALETTE[count++ % PALETTE.length] });
    }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: INK })));
  }
  const inst = new THREE.InstancedMesh(flagGeo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.7, color: 0x555555, envMapIntensity: 0.3 }), flags.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), col = new THREE.Color();
  flags.forEach((f, i) => { q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), f.dir); m.compose(f.p, q, s); inst.setMatrixAt(i, m); inst.setColorAt(i, col.setHex(f.c)); });
  g.add(inst);
  return g;
}

function makeTrees() {
  const g = new THREE.Group();
  const leafMats = [std(0x0b1020, { roughness: 0.8 }), std(0x0d1328, { roughness: 0.8 }), std(0x101830, { roughness: 0.8 })];
  const trunkMat = std(0x0a0c18);
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    if (Math.cos(a) > 0.55) continue; // keep the view behind the player clear
    const d = 19 + Math.random() * 8, h = 1.4 + Math.random() * 0.8;
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, h, 8), trunkMat); trunk.position.y = h / 2; tree.add(trunk);
    for (let k = 0; k < 3; k++) {
      const s = withOutline(new THREE.Mesh(new THREE.IcosahedronGeometry(1.05 - k * 0.15, 1), leafMats[(i + k) % 3]), 0.035);
      s.position.set((k - 1) * 0.5, h + 0.6 + (k === 1 ? 0.5 : 0), (k % 2) * 0.2); tree.add(s);
    }
    tree.position.set(Math.sin(a) * d, 0, -Math.cos(a) * d - 3);
    tree.scale.setScalar(1 + Math.random() * 0.6);
    g.add(tree);
  }
  for (let i = 0; i < 7; i++) {
    const a = -1.4 + i * 0.47;
    const hill = new THREE.Mesh(new THREE.SphereGeometry(18 + Math.random() * 10, 24, 12), std(i % 2 ? 0x080a16 : 0x0a0d1c, { roughness: 1 }));
    hill.scale.y = 0.35; hill.position.set(Math.sin(a) * 80, -2, -Math.cos(a) * 80); g.add(hill);
  }
  return shadowy(g, true, false);
}

// ---------- characters ----------
function makeRacket(frameColor) {
  // Glowing frame so the racket reads against the dark arena.
  const r = new THREE.Group();
  const handle = withOutline(new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, 0.2, 10), std(0xffffff)), 0.006);
  handle.position.y = 0.1; r.add(handle);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.26, 8), std(0xdfe4f2, { metalness: 0.5, roughness: 0.3 }));
  shaft.position.y = 0.33; r.add(shaft);
  const frame = withOutline(new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.012, 10, 40), glow(frameColor, 2.2, { roughness: 0.35 })), 0.006);
  frame.scale.set(0.82, 1.05, 1); frame.position.y = 0.58; r.add(frame);
  const stringsTex = canvasTex(128, 128, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h); ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2;
    for (let i = 0; i <= w; i += 10) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, h); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(w, i); ctx.stroke(); }
  });
  const strings = new THREE.Mesh(new THREE.CircleGeometry(0.112, 32),
    new THREE.MeshBasicMaterial({ map: stringsTex, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  strings.scale.set(0.82, 1.05, 1); strings.position.y = 0.58; r.add(strings);
  r.scale.setScalar(1.35); // chunky, readable
  return r;
}

function makeCharacter({ shirt, shorts, hair, skin, racketColor }) {
  const c = new THREE.Group();
  const body = new THREE.Group(); c.add(body);
  const skinM = std(skin, { roughness: 0.6 });
  const legs = [];
  for (const sx of [-1, 1]) {
    const leg = withOutline(new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.42, 4, 10), std(shorts)), 0.012);
    leg.position.set(sx * 0.11, 0.33, 0); body.add(leg); legs.push(leg);
    const shoe = withOutline(new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 10), std(0xffffff)), 0.012);
    shoe.scale.set(1, 0.6, 1.5); shoe.position.set(0, -0.28, -0.04); leg.add(shoe);
  }
  const torso = withOutline(new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.34, 6, 16), glow(shirt, 0.45)), 0.014);
  torso.position.y = 0.92; body.add(torso);
  const head = withOutline(new THREE.Mesh(new THREE.SphereGeometry(0.21, 24, 18), skinM), 0.014);
  head.position.y = 1.47; body.add(head);
  const hairM = withOutline(new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), std(hair, { roughness: 0.7 })), 0.01);
  hairM.position.y = 0.02; hairM.rotation.x = 0.25; head.add(hairM);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), std(INK, { roughness: 0.2 }));
    eye.scale.set(0.8, 1.3, 0.5); eye.position.set(sx * 0.075, 0.0, -0.195); head.add(eye);
  }
  // Off arm
  const offArm = withOutline(new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.34, 4, 10), skinM), 0.01);
  offArm.position.set(-0.3, 0.98, -0.05); offArm.rotation.z = -0.5; body.add(offArm);
  // Racket arm: pivot at the shoulder so swings rotate naturally
  const shoulder = new THREE.Group(); shoulder.position.set(0.27, 1.14, 0); body.add(shoulder);
  const arm = withOutline(new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.36, 4, 10), skinM), 0.01);
  arm.position.y = 0.2; shoulder.add(arm);
  const racket = makeRacket(racketColor);
  racket.position.y = 0.36; shoulder.add(racket);
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.35, 24), new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.18, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.006; c.add(shadow);
  shadowy(c, true, false);
  c.scale.setScalar(1.15);
  return { group: c, body, shoulder, legs, racket, head };
}

function makeShuttle() {
  const s = new THREE.Group();
  const cork = withOutline(new THREE.Mesh(new THREE.SphereGeometry(0.0135, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), glow(NEON.lime, 2.5, { roughness: 0.5 })), 0.003);
  s.add(cork);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.008, 16), glow(NEON.magenta, 2));
  band.position.y = -0.004; s.add(band);
  const featherTex = canvasTex(128, 64, (ctx, w, h) => {
    ctx.fillStyle = '#e6ff7a'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#9fd400'; ctx.lineWidth = 2;
    for (let x = 0; x < w; x += 8) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    ctx.fillStyle = '#ff2bd6'; ctx.fillRect(0, h * 0.75, w, 5);
  });
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.013, 0.055, 16, 1, true),
    new THREE.MeshStandardMaterial({ map: featherTex, side: THREE.DoubleSide, roughness: 0.7, emissive: NEON.lime, emissiveMap: featherTex, emissiveIntensity: 2.2 }));
  skirt.position.y = -0.035; s.add(skirt);
  const rim = withOutline(new THREE.Mesh(new THREE.TorusGeometry(0.033, 0.0025, 6, 24), glow(NEON.lime, 2.5)), 0.002);
  rim.rotation.x = Math.PI / 2; rim.position.y = -0.062; s.add(rim);
  s.scale.setScalar(SHUTTLE_SCALE);
  shadowy(s, true, false);
  return s;
}

// ---------- main factory ----------
export function createWorld(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x05060d, 30, 120);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);

  scene.add(new THREE.HemisphereLight(0x4a4f9a, 0x0a0a14, 0.55));
  const sun = new THREE.DirectionalLight(0xdfe6ff, 1.5); // arena floodlight
  sun.position.set(6, 14, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 12, bottom: -12, near: 1, far: 40 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun);
  const rim = new THREE.DirectionalLight(NEON.magenta, 0.7); rim.position.set(-6, 5, -9); scene.add(rim);

  scene.add(makeSky());
  const stars = makeStars(); scene.add(stars);
  scene.add(makeGround());
  scene.add(makeNet());
  const crowd = makeStandsAndCrowd(); scene.add(crowd.group);
  scene.add(makeBunting());
  scene.add(makeTrees());

  const player = makeCharacter({ shirt: NEON.cyan, shorts: 0x10132a, hair: 0x4a2c1a, skin: 0xffdbb5, racketColor: NEON.cyan });
  player.group.position.set(0.5, 0, 4.5);
  scene.add(player.group);
  const cpu = makeCharacter({ shirt: NEON.magenta, shorts: 0x10132a, hair: 0x1d2340, skin: 0xd99c6c, racketColor: NEON.magenta });
  cpu.group.position.set(-0.5, 0, -4.5); cpu.group.rotation.y = Math.PI;
  scene.add(cpu.group);

  const shuttle = makeShuttle(); scene.add(shuttle);

  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.45, 0.85));
  composer.addPass(new OutputPass());
  composer.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null }, sat: { value: 1.35 }, contrast: { value: 1.08 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform sampler2D tDiffuse; uniform float sat; uniform float contrast; varying vec2 vUv;
      void main(){ vec4 c = texture2D(tDiffuse, vUv); float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
        vec3 col = mix(vec3(l), c.rgb, sat); col = (col - 0.5) * contrast + 0.5;
        col *= mix(0.7, 1.0, smoothstep(1.15, 0.35, length(vUv - 0.5)));
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a); }`,
  }));

  let pixelRatio = Math.min(window.devicePixelRatio, 1.5);
  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.fov = w / h < 0.9 ? 70 : 48;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  return {
    renderer, scene, camera, player, cpu, shuttle, crowd,
    update(t, dt, excite) {
      stars.rotation.y += dt * 0.004;
      crowd.update(t, excite);
    },
    render() { composer.render(); },
    setPixelRatio(pr) { pixelRatio = pr; resize(); },
  };
}
