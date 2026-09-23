/* ClearCut — esfera neural 3D interativa (Canvas 2D, sem dependências)
 * - Arraste para rodar (inércia), o cursor repele as partículas
 * - Reage ao estado da app: drag / processing (o "fundo" da esfera dissolve-se) / success / error
 * API global: window.Orb.setMode(mode), window.Orb.setProgress(0..1)
 */
(() => {
  'use strict';
  const canvas = document.getElementById('orb');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Geometria: esfera de Fibonacci + ligações entre vizinhos
  const N = 1000;
  const pts = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r, seed: Math.random(), sx: 0, sy: 0, sz: 0, a: 0 });
  }
  const links = [];
  for (let i = 0; i < N; i += 2) {
    let b1 = -1, b2 = -1, d1 = 1e9, d2 = 1e9;
    const p = pts[i];
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      const q = pts[j];
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2;
      if (d < d1) { d2 = d1; b2 = b1; d1 = d; b1 = j; } else if (d < d2) { d2 = d; b2 = j; }
    }
    links.push([i, b1], [i, b2]);
  }

  // ---------- Estado
  const S = {
    yaw: 0.6, pitch: -0.3, vy: 0.004, vp: 0,
    dragging: false, lx: 0, ly: 0,
    mouse: { x: -1e4, y: -1e4 },
    mode: 'idle', progress: 0, shown: 0, // shown = progresso suavizado
    burst: 0, shake: 0, scan: -1.2,
    w: 0, h: 0, dpr: 1, running: false, visible: true, last: 0,
  };

  const lerp = (a, b, t) => a + (b - a) * t;

  function resize() {
    const r = canvas.getBoundingClientRect();
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    S.w = r.width; S.h = r.height;
    canvas.width = Math.round(r.width * S.dpr);
    canvas.height = Math.round(r.height * S.dpr);
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  }

  // ---------- Interação
  canvas.addEventListener('pointerdown', (e) => {
    S.dragging = true; S.lx = e.clientX; S.ly = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    document.getElementById('orb-hint')?.classList.add('opacity-0');
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    S.mouse.x = e.clientX - r.left; S.mouse.y = e.clientY - r.top;
    if (!S.dragging) return;
    S.vy = (e.clientX - S.lx) * 0.006;
    S.vp = (e.clientY - S.ly) * 0.006;
    S.lx = e.clientX; S.ly = e.clientY;
  });
  const release = () => { S.dragging = false; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => { S.mouse.x = S.mouse.y = -1e4; });

  // ---------- Render
  function frame(now) {
    if (!S.running) return;
    const dt = Math.min(0.05, (now - (S.last || now)) / 1000) || 0.016;
    S.last = now;
    const k = dt * 60; // normaliza para 60 fps

    const dark = document.documentElement.classList.contains('dark');
    const { w, h } = S;
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * 0.33;

    // Velocidade alvo por modo
    const spin = reduced ? 0.001 : { idle: 0.004, drag: 0.012, processing: 0.03, success: 0.008, error: 0.002 }[S.mode];
    if (!S.dragging) {
      S.vy = lerp(S.vy, spin, 0.03 * k);
      S.vp = lerp(S.vp, 0, 0.06 * k);
      S.pitch = lerp(S.pitch, -0.3, 0.01 * k);
    }
    S.yaw += S.vy * k;
    S.pitch = Math.max(-1.2, Math.min(1.2, S.pitch + S.vp * k));
    S.shown = lerp(S.shown, S.progress, 0.08 * k);
    S.burst = lerp(S.burst, 0, 0.05 * k);
    S.shake = lerp(S.shake, 0, 0.08 * k);
    S.scan += (S.mode === 'processing' ? 0.035 : 0.009) * k;
    if (S.scan > 1.3) S.scan = -1.3;

    const ox = S.shake ? (Math.random() - 0.5) * S.shake * 10 : 0;
    ctx.clearRect(0, 0, w, h);

    // Halo
    const halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.6);
    const glowCol = S.mode === 'error' ? '239,68,68' : S.mode === 'success' ? '16,185,129' : '99,102,241';
    halo.addColorStop(0, `rgba(${glowCol},${dark ? 0.28 : 0.16})`);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);

    // Anéis orbitais (metade de trás)
    const rings = [
      { rx: 1.5, ry: 0.36, rot: -0.38, speed: 0.6, col: '129,140,248' },
      { rx: 1.3, ry: 0.5, rot: 0.55, speed: -0.42, col: '34,211,238' },
    ];
    const t = now / 1000;
    const drawRing = (ring, front) => {
      ctx.save();
      ctx.translate(cx + ox, cy);
      ctx.rotate(ring.rot);
      ctx.beginPath();
      ctx.ellipse(0, 0, R * ring.rx, R * ring.ry, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2);
      ctx.strokeStyle = `rgba(${ring.col},${front ? 0.45 : 0.18})`;
      ctx.lineWidth = 1;
      ctx.setLineDash(front ? [] : [3, 5]);
      ctx.stroke();
      const a = (t * ring.speed * (S.mode === 'processing' ? 3 : 1)) % (Math.PI * 2);
      const inFront = Math.sin(a) > 0;
      if (inFront === front) {
        const sx = Math.cos(a) * R * ring.rx, sy = Math.sin(a) * R * ring.ry;
        ctx.beginPath();
        ctx.arc(sx, sy, front ? 3.5 : 2.2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${ring.col},${front ? 1 : 0.5})`;
        ctx.shadowColor = `rgb(${ring.col})`;
        ctx.shadowBlur = front ? 12 : 0;
        ctx.fill();
      }
      ctx.restore();
    };
    rings.forEach((r) => drawRing(r, false));

    // Projeção das partículas
    const cyw = Math.cos(S.yaw), syw = Math.sin(S.yaw);
    const cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    const cut = S.mode === 'processing' || S.mode === 'success' ? -1 + S.shown * 1.05 : -2;
    const mx = S.mouse.x, my = S.mouse.y;

    for (const p of pts) {
      const x1 = p.x * cyw - p.z * syw;
      const z1 = p.x * syw + p.z * cyw;
      const y1 = p.y * cp - z1 * sp;
      const z2 = p.y * sp + z1 * cp;
      const b = 1 + S.burst * (0.3 + p.seed * 0.5);
      const persp = (1 + z2 * 0.22) * b;
      let sx = cx + ox + x1 * R * persp;
      let sy = cy + y1 * R * persp;
      // Repulsão do cursor
      const dx = sx - mx, dy = sy - my;
      const d2 = dx * dx + dy * dy;
      if (d2 < 8100 && d2 > 0.01) {
        const d = Math.sqrt(d2), f = (1 - d / 90) * 22;
        sx += (dx / d) * f; sy += (dy / d) * f;
      }
      let a = 0.18 + 0.82 * ((z2 + 1) / 2);
      if (z2 < cut) a *= 0.06; // "fundo" removido
      p.sx = sx; p.sy = sy; p.sz = z2; p.a = a; p.sc = y1;
    }

    // Ligações (malha neural)
    ctx.lineWidth = 0.6;
    for (const [i, j] of links) {
      const p = pts[i], q = pts[j];
      if (p.sz < -0.15 || q.sz < -0.15) continue;
      const a = Math.min(p.a, q.a) * (dark ? 0.22 : 0.18);
      if (a < 0.02) continue;
      ctx.strokeStyle = `rgba(129,140,248,${a})`;
      ctx.beginPath(); ctx.moveTo(p.sx, p.sy); ctx.lineTo(q.sx, q.sy); ctx.stroke();
    }

    // Partículas
    for (const p of pts) {
      const band = Math.exp(-(((p.sc - S.scan) / 0.07) ** 2)); // linha de varrimento
      const tt = (p.y + 1) / 2;
      let r = lerp(99, 34, tt), g = lerp(102, 211, tt), bl = lerp(241, 238, tt);
      if (S.mode === 'success') { r = lerp(r, 16, 0.6); g = lerp(g, 185, 0.6); bl = lerp(bl, 129, 0.6); }
      if (S.mode === 'error') { r = lerp(r, 239, 0.7); g = lerp(g, 68, 0.7); bl = lerp(bl, 68, 0.7); }
      r = lerp(r, 255, band * 0.8); g = lerp(g, 255, band * 0.8); bl = lerp(bl, 255, band * 0.8);
      const size = (0.6 + 1.5 * ((p.sz + 1) / 2)) * (1 + band * 0.9);
      ctx.fillStyle = `rgba(${r | 0},${g | 0},${bl | 0},${Math.min(1, p.a + band * 0.5 * p.a)})`;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, size, 0, Math.PI * 2); ctx.fill();
    }

    rings.forEach((r) => drawRing(r, true));

    // Anel de progresso durante o processamento
    if (S.mode === 'processing' || S.shown > 0.01) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * S.shown);
      ctx.strokeStyle = S.mode === 'success' ? 'rgba(16,185,129,.9)' : 'rgba(99,102,241,.85)';
      ctx.lineWidth = 2.5; ctx.lineCap = 'round';
      ctx.stroke();
    }

    requestAnimationFrame(frame);
  }

  function start() {
    if (S.running || !S.visible || document.hidden) return;
    S.running = true; S.last = 0;
    requestAnimationFrame(frame);
  }
  function stop() { S.running = false; }

  new ResizeObserver(resize).observe(canvas);
  resize();
  new IntersectionObserver(([e]) => { S.visible = e.isIntersecting; S.visible ? start() : stop(); }).observe(canvas);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

  let resetTimer = null;
  window.Orb = {
    setMode(mode) {
      clearTimeout(resetTimer);
      S.mode = mode;
      if (mode === 'processing') S.progress = 0;
      if (mode === 'success') { S.progress = 1; S.burst = 1; resetTimer = setTimeout(() => window.Orb.setMode('idle'), 2500); }
      if (mode === 'error') { S.shake = 1; S.progress = 0; resetTimer = setTimeout(() => window.Orb.setMode('idle'), 1400); }
      if (mode === 'idle' || mode === 'drag') S.progress = 0;
      if (mode === 'drag') S.burst = 0.35;
    },
    setProgress(v) { S.progress = Math.max(0, Math.min(1, v)); },
  };
  start();
})();
