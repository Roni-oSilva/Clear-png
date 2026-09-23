/* ClearCut — editor por pincel (remover / restaurar manualmente).
 *
 * Leve por desenho:
 *  - Os traços são guardados como VETORES normalizados ({mode, r, pts:[x,y,…]} em 0..1),
 *    não como imagens. Um pedido típico tem poucos KB.
 *  - A pré-visualização é feita no navegador, instantânea, à resolução do ecrã (máx. 2048 px).
 *  - Só ao "Aplicar" é que o servidor recebe: imagem original + traços + máscara base da IA
 *    (PNG em tons de cinza, ≤1024 px, ~20–120 KB). Assim o servidor NÃO volta a correr a IA:
 *    faz só o refinamento cirúrgico (bordas alinhadas aos contornos reais) a ~1 MP.
 *  - Os traços acumulam-se desde o recorte da IA, por isso desfazer/refazer é sempre coerente.
 *
 * Comunica com app.js através de window.ClearCutApp (toast, refine, getBaseMask, commit…).
 */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const MAX_CANVAS = 2048;       // lado maior máximo dos canvas de pré-visualização
  const MIN_STEP_PX = 1.5;       // distância mínima (ecrã) entre pontos guardados
  const COLORS = { erase: '#ef4444', restore: '#10b981' };

  const el = {
    stage: $('#stage-edit'),
    wrap: $('#ed-wrap'),
    original: $('#ed-original'),
    preview: $('#ed-preview'),
    marks: $('#ed-marks'),
    cursor: $('#ed-cursor'),
    busy: $('#ed-busy'),
    busyText: $('#ed-busy-text'),
    busyBar: $('#ed-busy-bar'),
    size: $('#brush-size'),
    sizeVal: $('#brush-size-val'),
    undo: $('#ed-undo'),
    redo: $('#ed-redo'),
    clear: $('#ed-clear'),
    showOriginal: $('#ed-show-original'),
    showMarks: $('#ed-show-marks'),
    status: $('#ed-status'),
    reset: $('#ed-reset'),
    cancel: $('#ed-cancel'),
    apply: $('#ed-apply'),
    done: $('#ed-done'),
  };
  if (!el.stage) return;

  const pctx = el.preview.getContext('2d');
  const mctx = el.marks.getContext('2d');
  const tmp = document.createElement('canvas');
  const tctx = tmp.getContext('2d');

  const E = {
    open: false,
    item: null,
    strokes: [],
    redo: [],
    appliedCount: 0,     // quantos traços já estão "cozidos" no resultado do servidor
    appliedRef: [],      // os próprios traços aplicados (para reconhecer um "refazer" que volta ao mesmo ponto)
    tool: 'erase',
    sizePx: 36,
    drawing: null,
    lastScreen: null,
    aiImg: null, aiUrl: null,
    appliedImg: null,
    origImg: null,
    snapshot: null,
    busy: false,
    cw: 0, ch: 0,
    ro: null,
  };

  const app = () => window.ClearCutApp;

  // ------------------------------------------------------------------ utilitários
  function loadImg(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  const pending = () => E.strokes.length - E.appliedCount;

  // O resultado do servidor só serve de base se os traços atuais começarem exatamente pelos aplicados.
  function syncApplied() {
    const ref = E.appliedRef;
    const ok = ref.length > 0 && E.strokes.length >= ref.length && ref.every((st, i) => E.strokes[i] === st);
    E.appliedCount = ok ? ref.length : 0;
  }
  const baseIsApplied = () => E.appliedCount > 0 && E.appliedCount <= E.strokes.length && E.appliedImg;

  function updateUI() {
    el.undo.disabled = E.busy || !E.strokes.length;
    el.redo.disabled = E.busy || !E.redo.length;
    el.clear.disabled = E.busy || !E.strokes.length;
    el.apply.disabled = E.busy || pending() <= 0;
    el.done.disabled = E.busy;
    el.cancel.disabled = E.busy;
    el.reset.disabled = E.busy;
    const n = pending();
    el.status.textContent = n > 0
      ? `${n} traço${n === 1 ? '' : 's'} por aplicar`
      : E.strokes.length ? 'Tudo aplicado' : 'Pinte sobre a imagem';
    el.wrap.classList.toggle('show-original', el.showOriginal.checked);
    el.marks.style.display = el.showMarks.checked ? '' : 'none';
  }

  function setTool(tool) {
    E.tool = tool;
    document.querySelectorAll('.tool-btn').forEach((b) => {
      const on = b.dataset.tool === tool;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on);
    });
    el.cursor.classList.toggle('is-restore', tool === 'restore');
  }

  function setSize(px) {
    E.sizePx = Math.max(4, Math.min(160, Math.round(px)));
    el.size.value = E.sizePx;
    el.sizeVal.textContent = `${E.sizePx} px`;
    el.cursor.style.width = el.cursor.style.height = `${E.sizePx}px`;
  }

  // ------------------------------------------------------------------ geometria
  function layout() {
    const rect = el.wrap.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let cw = Math.round(rect.width * dpr), ch = Math.round(rect.height * dpr);
    const k = Math.min(1, MAX_CANVAS / Math.max(cw, ch));
    cw = Math.max(1, Math.round(cw * k)); ch = Math.max(1, Math.round(ch * k));
    if (cw === E.cw && ch === E.ch) return;
    E.cw = cw; E.ch = ch;
    for (const c of [el.preview, el.marks, tmp]) { c.width = cw; c.height = ch; }
    redraw();
  }

  function tracePath(ctx, st, from = 0) {
    const lw = Math.max(1, 2 * st.r * Math.max(E.cw, E.ch));
    const p = st.pts;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const i0 = Math.max(0, from - 2);
    if (p.length - i0 <= 2) {
      ctx.arc(p[i0] * E.cw, p[i0 + 1] * E.ch, lw / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.moveTo(p[i0] * E.cw, p[i0 + 1] * E.ch);
    for (let i = i0 + 2; i < p.length; i += 2) ctx.lineTo(p[i] * E.cw, p[i + 1] * E.ch);
    ctx.stroke();
  }

  // Pinta um traço (ou só o troço novo a partir de `from`) na pré-visualização e nas marcações.
  function paint(st, from = 0) {
    // pré-visualização
    if (st.mode === 'erase') {
      pctx.globalCompositeOperation = 'destination-out';
      pctx.fillStyle = pctx.strokeStyle = '#000';
      tracePath(pctx, st, from);
      pctx.globalCompositeOperation = 'source-over';
    } else if (E.origImg) {
      tctx.globalCompositeOperation = 'source-over';
      tctx.clearRect(0, 0, E.cw, E.ch);
      tctx.fillStyle = tctx.strokeStyle = '#000';
      tracePath(tctx, st, from);
      tctx.globalCompositeOperation = 'source-in';
      tctx.drawImage(E.origImg, 0, 0, E.cw, E.ch);
      tctx.globalCompositeOperation = 'source-over';
      pctx.drawImage(tmp, 0, 0);
    }
    // marcações coloridas (o canvas inteiro tem opacidade CSS → sobreposições não escurecem)
    mctx.fillStyle = mctx.strokeStyle = COLORS[st.mode];
    tracePath(mctx, st, from);
  }

  function redraw() {
    if (!E.cw) return;
    const applied = baseIsApplied();
    const base = applied ? E.appliedImg : E.aiImg;
    pctx.globalCompositeOperation = 'source-over';
    pctx.clearRect(0, 0, E.cw, E.ch);
    if (base) pctx.drawImage(base, 0, 0, E.cw, E.ch);
    mctx.clearRect(0, 0, E.cw, E.ch);
    const start = applied ? E.appliedCount : 0;
    E.strokes.forEach((st, i) => {
      if (i >= start) paint(st);
      else { mctx.fillStyle = mctx.strokeStyle = COLORS[st.mode]; tracePath(mctx, st); }
    });
  }

  // ------------------------------------------------------------------ desenho com o ponteiro
  function norm(e) {
    const r = el.preview.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      sx: e.clientX - r.left,
      sy: e.clientY - r.top,
      long: Math.max(r.width, r.height),
    };
  }

  function moveCursor(e) {
    const r = el.wrap.getBoundingClientRect();
    el.cursor.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px) translate(-50%, -50%)`;
  }

  el.preview.addEventListener('pointerdown', (e) => {
    if (!E.open || E.busy || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    el.preview.setPointerCapture(e.pointerId);
    const p = norm(e);
    E.drawing = { mode: E.tool, r: E.sizePx / 2 / p.long, pts: [p.x, p.y] };
    E.lastScreen = [p.sx, p.sy];
    paint(E.drawing);
    el.cursor.classList.remove('hidden');
    moveCursor(e);
  });

  el.preview.addEventListener('pointermove', (e) => {
    if (!E.open) return;
    moveCursor(e);
    el.cursor.classList.remove('hidden');
    if (!E.drawing) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const st = E.drawing;
    const from = st.pts.length;
    for (const ev of events.length ? events : [e]) {
      const p = norm(ev);
      const dx = p.sx - E.lastScreen[0], dy = p.sy - E.lastScreen[1];
      if (dx * dx + dy * dy < MIN_STEP_PX * MIN_STEP_PX) continue;
      st.pts.push(p.x, p.y);
      E.lastScreen = [p.sx, p.sy];
    }
    if (st.pts.length > from) paint(st, from); // só o troço novo (rápido)
  });

  function endStroke() {
    if (!E.drawing) return;
    const st = E.drawing;
    st.pts = st.pts.map((v) => Math.round(v * 1e5) / 1e5);
    st.r = Math.round(st.r * 1e5) / 1e5;
    E.strokes.push(st);
    E.redo = [];
    E.drawing = null;
    updateUI();
  }
  el.preview.addEventListener('pointerup', endStroke);
  el.preview.addEventListener('pointercancel', endStroke);
  el.preview.addEventListener('pointerleave', () => { if (!E.drawing) el.cursor.classList.add('hidden'); });

  // ------------------------------------------------------------------ histórico
  function undo() {
    if (E.busy || !E.strokes.length) return;
    E.redo.push(E.strokes.pop());
    syncApplied(); // se desfizer um traço já aplicado, a pré-visualização volta a partir da IA
    redraw(); updateUI();
  }
  function redo() {
    if (E.busy || !E.redo.length) return;
    E.strokes.push(E.redo.pop());
    syncApplied(); // refazer até ao ponto aplicado reaproveita o resultado do servidor (sem novo pedido)
    redraw(); updateUI();
  }
  function clearAllStrokes() {
    if (E.busy || !E.strokes.length) return;
    while (E.strokes.length) E.redo.push(E.strokes.pop()); // "Refazer" devolve-os
    syncApplied();
    redraw(); updateUI();
  }

  // ------------------------------------------------------------------ servidor
  function setBusy(on, text = 'A refinar o recorte…') {
    E.busy = on;
    el.busy.classList.toggle('hidden', !on);
    el.busyText.textContent = text;
    el.busyBar.style.width = '0%';
    updateUI();
  }

  async function apply() {
    if (E.busy) return false;
    const item = E.item;
    if (!E.strokes.length) { // sem traços → volta ao recorte da IA
      await app().restoreResult(item, item.aiBlob);
      E.appliedImg = null; E.appliedCount = 0; E.appliedRef = [];
      redraw(); updateUI();
      return true;
    }
    if (pending() <= 0) return true;
    setBusy(true);
    try {
      const mask = await app().getBaseMask(item);
      const payload = JSON.stringify({ strokes: E.strokes.map(({ mode, r, pts }) => ({ mode, r, pts })) });
      const res = await app().refine(item, payload, mask, (v) => {
        el.busyBar.style.width = `${v}%`;
        el.busyText.textContent = v < 30 ? 'A enviar a imagem…' : v < 94 ? 'A refinar as bordas…' : 'Quase pronto…';
      });
      await app().commitEdit(item, res);
      E.appliedImg = await loadImg(item.resultUrl);
      E.appliedRef = [...E.strokes];
      E.appliedCount = E.strokes.length;
      redraw();
      app().toast(
        Number.isFinite(res.seconds) ? `Recorte refinado em ${res.seconds.toFixed(1)} s.` : 'Recorte refinado.',
        'success', 2500,
      );
      return true;
    } catch (err) {
      if (!err.cancelled) app().toast(err.message || 'Não foi possível aplicar o refinamento.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------ abrir / fechar
  async function open(item) {
    if (!item?.aiBlob || E.open) return;
    E.open = true;
    E.item = item;
    const saved = item.edit || { strokes: [], appliedCount: 0 };
    E.strokes = saved.strokes.map((s) => ({ ...s, pts: [...s.pts] }));
    E.appliedCount = saved.appliedCount;
    E.appliedRef = E.strokes.slice(0, E.appliedCount);
    E.redo = [];
    E.snapshot = { blob: item.resultBlob, strokes: saved.strokes, appliedCount: saved.appliedCount };

    const ratio = (item.outWidth || item.width) / (item.outHeight || item.height);
    el.wrap.style.aspectRatio = `${item.outWidth || item.width} / ${item.outHeight || item.height}`;
    el.wrap.style.maxWidth = `min(100%, calc(62vh * ${ratio}))`;
    app().applyBg(el.wrap);

    $('#view-result').classList.add('is-editing');
    ['#stage-slider', '#stage-side', '#stage-result'].forEach((s) => $(s).classList.add('hidden'));
    el.stage.classList.remove('hidden');
    setBusy(true, 'A preparar o editor…');

    try {
      E.aiUrl = URL.createObjectURL(item.aiBlob);
      const [ai, orig, applied] = await Promise.all([
        loadImg(E.aiUrl),
        loadImg(item.url),
        E.appliedCount > 0 ? loadImg(item.resultUrl) : Promise.resolve(null),
      ]);
      E.aiImg = ai; E.origImg = orig; E.appliedImg = applied;
      el.original.src = item.url;
    } catch {
      app().toast('Não foi possível abrir o editor para esta imagem.');
      close(true);
      return;
    } finally {
      setBusy(false);
    }
    E.cw = E.ch = 0;
    layout();
    E.ro = new ResizeObserver(() => layout());
    E.ro.observe(el.wrap);
    updateUI();
  }

  function close(silent = false) {
    if (!E.open) return;
    E.open = false;
    E.drawing = null;
    E.ro?.disconnect();
    if (E.aiUrl) URL.revokeObjectURL(E.aiUrl);
    E.aiUrl = null; E.aiImg = E.appliedImg = E.origImg = null;
    el.stage.classList.add('hidden');
    el.cursor.classList.add('hidden');
    $('#view-result').classList.remove('is-editing');
    if (!silent) app().onEditorClose(E.item);
    E.item = null;
  }

  async function done() {
    if (E.busy) return;
    const ok = await apply();
    if (!ok) return;
    E.item.edit = { strokes: E.strokes, appliedCount: E.appliedCount };
    close();
  }

  async function cancel() {
    if (E.busy) return;
    const item = E.item;
    if (item.resultBlob !== E.snapshot.blob) await app().restoreResult(item, E.snapshot.blob);
    item.edit = { strokes: E.snapshot.strokes, appliedCount: E.snapshot.appliedCount };
    close();
  }

  async function resetToAI() {
    if (E.busy) return;
    E.strokes = []; E.redo = []; E.appliedCount = 0; E.appliedRef = []; E.appliedImg = null;
    await app().restoreResult(E.item, E.item.aiBlob);
    redraw(); updateUI();
    app().toast('Edições descartadas: voltou ao recorte da IA.', 'info', 2500);
  }

  // ------------------------------------------------------------------ controlos
  document.querySelectorAll('.tool-btn').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  el.size.addEventListener('input', () => setSize(+el.size.value));
  el.undo.addEventListener('click', undo);
  el.redo.addEventListener('click', redo);
  el.clear.addEventListener('click', clearAllStrokes);
  el.showOriginal.addEventListener('change', updateUI);
  el.showMarks.addEventListener('change', updateUI);
  el.apply.addEventListener('click', apply);
  el.done.addEventListener('click', done);
  el.cancel.addEventListener('click', cancel);
  el.reset.addEventListener('click', resetToAI);

  document.addEventListener('keydown', (e) => {
    if (!E.open || e.target.closest?.('input[type="range"], input[type="color"]')) return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (!mod && k === 'e') setTool('erase');
    else if (!mod && k === 'r') setTool('restore');
    else if (!mod && k === '[') setSize(E.sizePx - 4);
    else if (!mod && k === ']') setSize(E.sizePx + 4);
  });

  setTool('erase');
  setSize(36);

  window.Editor = { open, close, isOpen: () => E.open, isBusy: () => E.busy };
})();
