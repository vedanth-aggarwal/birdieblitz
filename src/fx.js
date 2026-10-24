import * as THREE from 'three';

function tex(draw, size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const ringTex = color => tex((ctx, s) => {
  ctx.lineWidth = 14; ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2 - 16, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 4; ctx.strokeStyle = '#1d2340';
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2 - 6, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2 - 26, 0, Math.PI * 2); ctx.stroke();
});
const starTex = () => tex((ctx, s) => {
  ctx.translate(s / 2, s / 2); ctx.beginPath();
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 24 : 58, a = (i / 10) * Math.PI * 2 - Math.PI / 2; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  ctx.closePath(); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 8; ctx.strokeStyle = '#1d2340'; ctx.stroke();
});
const crossTex = () => tex((ctx, s) => {
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#1d2340'; ctx.lineWidth = 26;
  ctx.beginPath(); ctx.moveTo(30, 30); ctx.lineTo(s - 30, s - 30); ctx.moveTo(s - 30, 30); ctx.lineTo(30, s - 30); ctx.stroke();
  ctx.strokeStyle = '#ff4a4a'; ctx.lineWidth = 14;
  ctx.beginPath(); ctx.moveTo(30, 30); ctx.lineTo(s - 30, s - 30); ctx.moveTo(s - 30, 30); ctx.lineTo(30, s - 30); ctx.stroke();
});

export class FX {
  constructor(scene, camera) {
    this.scene = scene; this.camera = camera;
    this.shakeAmt = 0; this.shakeOffset = new THREE.Vector3();

    // Trail
    this.trailN = 22; this.trailPts = [];
    this.trail = new THREE.InstancedMesh(new THREE.SphereGeometry(0.035, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xc6ff00, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }), this.trailN);
    this.trail.frustumCulled = false; scene.add(this.trail);
    this.trailColor = new THREE.Color(0xc6ff00);

    // Glowing ground marker under the shuttle, so its position reads even on the dark court
    this.blob = new THREE.Mesh(new THREE.RingGeometry(0.08, 0.13, 28), new THREE.MeshBasicMaterial({ color: 0xc6ff00, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.blob.rotation.x = -Math.PI / 2; scene.add(this.blob);

    // Timing ring: shrinks onto the contact point; swing when it closes.
    this.timing = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex('#ffd23f'), transparent: true, depthTest: false, opacity: 0 }));
    this.timing.renderOrder = 10; scene.add(this.timing);
    this.timingCore = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex('#3bd16f'), transparent: true, depthTest: false, opacity: 0 }));
    this.timingCore.renderOrder = 11; this.timingCore.scale.setScalar(0.35); scene.add(this.timingCore);

    // Landing marker (player's side) and out-cross
    this.land = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), new THREE.MeshBasicMaterial({ map: ringTex('#ffffff'), transparent: true, depthWrite: false, opacity: 0 }));
    this.land.rotation.x = -Math.PI / 2; scene.add(this.land);
    this.out = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), new THREE.MeshBasicMaterial({ map: crossTex(), transparent: true, depthWrite: false, opacity: 0 }));
    this.out.rotation.x = -Math.PI / 2; scene.add(this.out);

    // Aim marker on the CPU's court
    this.aim = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), new THREE.MeshBasicMaterial({ map: ringTex('#ff4f8b'), transparent: true, depthWrite: false, opacity: 0.0 }));
    this.aim.rotation.x = -Math.PI / 2; this.aim.position.set(0, 0.01, -4.6); scene.add(this.aim);
    this.aimX = 0;

    // Your secret target zone on the opponent's court (only your screen draws it)
    this.zone = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshBasicMaterial({ color: 0x8a5cff, transparent: true, depthWrite: false, opacity: 0, blending: THREE.AdditiveBlending }));
    this.zone.rotation.x = -Math.PI / 2; this.zone.position.y = 0.008; scene.add(this.zone);
    this.zoneRing = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 48), new THREE.MeshBasicMaterial({ color: 0xb48cff, transparent: true, depthWrite: false, opacity: 0 }));
    this.zoneRing.rotation.x = -Math.PI / 2; this.zoneRing.position.y = 0.01; scene.add(this.zoneRing);

    // Stars
    const sTex = starTex(), cols = [0xffd23f, 0xff4f8b, 0x3ec7ff, 0xffffff, 0x9b6bff];
    this.sparks = Array.from({ length: 50 }, (_, i) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: sTex, color: cols[i % cols.length], transparent: true, depthWrite: false }));
      s.visible = false; scene.add(s);
      return { s, v: new THREE.Vector3(), life: 0, max: 1, size: 0.1 };
    });

    // Ground puffs where the shuttle lands
    this.puffs = Array.from({ length: 4 }, () => {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.visible = false; scene.add(m);
      return { m, t: 1 };
    });
  }

  resetTrail() { this.trailPts.length = 0; }
  setTrailColor(hex) { this.trail.material.color.setHex(hex); }

  burst(pos, power = 0.5, n = 16) {
    let k = 0;
    for (const p of this.sparks) {
      if (p.life > 0) continue;
      p.life = p.max = 0.5 + Math.random() * 0.4;
      p.s.position.copy(pos);
      p.v.set(Math.random() - 0.5, Math.random() * 0.8 + 0.1, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 3 * (0.5 + power));
      p.size = 0.12 + Math.random() * 0.12 + power * 0.08;
      p.s.visible = true;
      if (++k >= n) break;
    }
  }

  puff(pos, color = 0xffffff) {
    const p = this.puffs.find(p => p.t >= 1) || this.puffs[0];
    p.t = 0; p.m.visible = true; p.m.position.set(pos.x, 0.012, pos.z); p.m.material.color.setHex(color);
  }

  shake(a) { this.shakeAmt = Math.max(this.shakeAmt, a); }

  // contact: {pos}, timeLeft (s, real time) or null to hide
  setTiming(pos, timeLeft) { this.timingPos = pos; this.timingLeft = timeLeft; }
  setLanding(pos, isIn) { this.landPos = pos; this.landIn = isIn; }
  setAim(x, visible) { this.aimX = x; this.aimVisible = visible; }
  // zone: { x, z, r } in the local frame, or null
  setZone(zone) { this.zoneData = zone; }

  update(dt, t, shuttleMesh, shuttleActive) {
    // trail
    if (shuttleActive) { this.trailPts.unshift(shuttleMesh.position.clone()); if (this.trailPts.length > this.trailN) this.trailPts.pop(); }
    else if (this.trailPts.length) this.trailPts.pop();
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.trailN; i++) {
      const p = this.trailPts[i], s = p ? (1 - i / this.trailN) : 0;
      m.makeScale(s, s, s); if (p) m.setPosition(p); this.trail.setMatrixAt(i, m);
    }
    this.trail.instanceMatrix.needsUpdate = true;

    // blob shadow
    const sp = shuttleMesh.position;
    this.blob.visible = shuttleMesh.visible;
    this.blob.position.set(sp.x, 0.01, sp.z);
    const h = Math.max(0, sp.y);
    this.blob.scale.setScalar(0.6 + h * 0.15);
    this.blob.material.opacity = Math.max(0.25, 0.75 - h * 0.06);

    // timing ring
    const fade = (mat, target) => { mat.opacity += (target - mat.opacity) * Math.min(1, dt * 12); };
    if (this.timingPos && this.timingLeft !== null) {
      const left = Math.max(0, this.timingLeft);
      this.timing.position.copy(this.timingPos); this.timingCore.position.copy(this.timingPos);
      this.timing.scale.setScalar(0.35 + left * 2.2);
      const perfect = Math.abs(this.timingLeft) < 0.07;
      this.timing.material.color.setHex(perfect ? 0x3bd16f : 0xffffff);
      fade(this.timing.material, this.timingLeft < 1.1 ? 1 : 0);
      fade(this.timingCore.material, this.timingLeft < 1.1 ? 0.9 : 0);
      this.timingCore.scale.setScalar(perfect ? 0.45 : 0.35);
    } else { fade(this.timing.material, 0); fade(this.timingCore.material, 0); }

    // landing marker
    if (this.landPos) {
      this.land.position.set(this.landPos.x, 0.015, this.landPos.z); this.out.position.copy(this.land.position);
      fade(this.land.material, this.landIn ? 0.85 : 0); fade(this.out.material, this.landIn ? 0 : 0.9);
      this.land.scale.setScalar(1 + Math.sin(t * 10) * 0.08);
    } else { fade(this.land.material, 0); fade(this.out.material, 0); }

    // aim marker
    this.aim.position.x += (this.aimX - this.aim.position.x) * Math.min(1, dt * 14);
    fade(this.aim.material, this.aimVisible ? 0.75 : 0);
    this.aim.rotation.z += dt * 1.5;

    // secret target zone
    const zd = this.zoneData;
    if (zd) {
      for (const m of [this.zone, this.zoneRing]) { m.position.x = zd.x; m.position.z = zd.z; m.scale.setScalar(zd.r); }
    }
    fade(this.zone.material, zd ? 0.16 + Math.sin(t * 3) * 0.05 : 0);
    fade(this.zoneRing.material, zd ? 0.85 : 0);

    for (const p of this.puffs) {
      if (p.t >= 1) continue;
      p.t = Math.min(1, p.t + dt * 2.2);
      p.m.scale.setScalar(0.05 + p.t * 0.5); p.m.material.opacity = (1 - p.t) * 0.9;
      if (p.t >= 1) p.m.visible = false;
    }
    for (const p of this.sparks) {
      if (p.life <= 0) continue;
      p.life -= dt; p.v.y -= 7 * dt; p.v.multiplyScalar(1 - dt * 1.5);
      p.s.position.addScaledVector(p.v, dt);
      const a = p.life / p.max;
      p.s.material.opacity = Math.min(1, a * 2); p.s.material.rotation += dt * 6;
      p.s.scale.setScalar(p.size * (0.4 + a));
      if (p.life <= 0) p.s.visible = false;
    }

    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 2.5);
    const s = this.shakeAmt * this.shakeAmt;
    this.shakeOffset.set((Math.random() - 0.5) * s * 0.2, (Math.random() - 0.5) * s * 0.2, 0);
  }
}
