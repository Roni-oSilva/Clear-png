/* ClearCut — lógica do frontend (JavaScript moderno, sem dependências)
 * - 1 imagem  → fluxo com progresso detalhado + comparador antes/depois
 * - 2 a 5     → lote: fila com concorrência, progresso por ficheiro, ZIP no navegador
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ Config & estado
  const CONFIG = {
    apiBase: (window.APP_CONFIG && window.APP_CONFIG.apiBase) || '',
    maxMB: 100,
    maxFiles: 5,
    maxPngMP: 0,  // 0 = sem limite próprio (definido pelo servidor em /api/health)
    maxWebpMP: 0,
    maxOutputMP: 0,
    concurrency: 2, // pedidos em paralelo (o servidor também limita com MAX_CONCURRENT_JOBS)
    accepted: ['image/png', 'image/jpeg', 'image/webp'],
    timeoutMs: 15 * 60 * 1000, // imagens de 100 MB podem demorar
  };

  const state = {
    mode: 'idle',   // 'single' | 'batch'
    items: [],      // itens do lote (ou o item único)
    current: null,  // item mostrado no comparador
    bg: 'transparent',
    bgCustom: false,
    busy: false,
    cancelBatch: false,
    serverReady: false,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const el = {
    dropzone: $('#dropzone'),
    fileInput: $('#file-input'),
    refine: $('#refine-toggle'),
    overlay: $('#drag-overlay'),
    preview: $('#processing-preview'),
    status: $('#status-text'),
    pct: $('#progress-pct'),
    bar: $('#progress-bar'),
    track: $('#progress-track'),
    compare: $('#compare'),
    handle: $('#compare-handle'),
    beforeImg: $('#before-img'),
    afterImg: $('#after-img'),
    sideBefore: $('#side-before'),
    sideAfter: $('#side-after'),
    resultOnly: $('#result-only'),
    resultOnlyImg: $('#result-only-img'),
    meta: $('#result-meta'),
    toasts: $('#toasts'),
    batchList: $('#batch-list'),
    batchCount: $('#batch-count'),
    batchSummary: $('#batch-summary'),
    batchPct: $('#batch-pct'),
    batchBar: $('#batch-bar'),
    batchCancel: $('#batch-cancel'),
    batchNew: $('#batch-new'),
    batchZip: $('#batch-zip'),
    backToBatch: $('#back-to-batch'),
  };

  // ------------------------------------------------------------------ Utilitários
  const formatBytes = (b) =>
    b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`;

  const EXT_TO_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
  const guessType = (file) =>
    file.type || EXT_TO_MIME[(file.name || '').split('.').pop().toLowerCase()] || '';

  const orb = (fn, ...args) => window.Orb && window.Orb[fn](...args);

  function toast(message, type = 'error', ms = 5000) {
    const icons = { error: '⚠️', success: '✅', info: 'ℹ️' };
    const node = document.createElement('div');
    node.className = `toast toast-${type}`;
    node.setAttribute('role', type === 'error' ? 'alert' : 'status');
    node.innerHTML = `<span aria-hidden="true">${icons[type]}</span><p class="flex-1"></p>
      <button type="button" class="text-slate-400 hover:text-slate-700 dark:hover:text-white" aria-label="Fechar">✕</button>`;
    $('p', node).textContent = message;
    const close = () => { node.classList.add('is-leaving'); setTimeout(() => node.remove(), 250); };
    $('button', node).addEventListener('click', close);
    el.toasts.appendChild(node);
    setTimeout(close, ms);
  }

  function showView(name) {
    ['upload', 'processing', 'batch', 'result'].forEach((v) => $(`#view-${v}`).classList.toggle('hidden', v !== name));
    $('#layout').classList.toggle('is-result', name === 'result');
    $('#card').classList.toggle('is-busy', state.busy);
  }
  const isVisible = (view) => !$(`#view-${view}`).classList.contains('hidden');

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ------------------------------------------------------------------ Tema
  $('#theme-toggle').addEventListener('click', () => {
    const dark = document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('clearcut-theme', dark ? 'dark' : 'light'); } catch { /* sem storage */ }
  });

  // ------------------------------------------------------------------ Estado do servidor
  // No plano gratuito do Render o servidor "adormece" após 15 min sem uso e demora ~1 min a acordar.
  // Vamos tentando durante ~3 min e mostramos o estado ao utilizador.
  async function checkServer(attempt = 0) {
    const wrap = $('#server-status'), dot = $('#server-dot'), text = $('#server-text');
    wrap.classList.remove('hidden'); wrap.classList.add('inline-flex');
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(`${CONFIG.apiBase}/api/health`, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error();
      const data = await res.json();
      CONFIG.maxMB = data.max_upload_mb || CONFIG.maxMB;
      CONFIG.maxFiles = data.max_batch_files || CONFIG.maxFiles;
      CONFIG.maxPngMP = data.max_png_megapixels || 0;
      CONFIG.maxWebpMP = data.max_webp_megapixels || 0;
      CONFIG.maxOutputMP = data.max_output_megapixels || 0;
      if (Array.isArray(data.accepted_formats)) CONFIG.accepted = data.accepted_formats;
      $$('[data-max-mb]').forEach((n) => (n.textContent = CONFIG.maxMB));
      $$('[data-max-files]').forEach((n) => (n.textContent = CONFIG.maxFiles));
      dot.className = 'h-2 w-2 rounded-full bg-emerald-500 animate-pulse';
      text.textContent = data.model_ready ? 'IA pronta' : 'IA a iniciar…';
      const MODEL_LABELS = { 'isnet-general-use': 'IS-Net', u2netp: 'U²-Net-P', u2net: 'U²-Net', silueta: 'Silueta' };
      if (data.model) $('#stat-model').textContent = `${MODEL_LABELS[data.model] || data.model} · ONNX`;
      state.serverReady = true;
    } catch {
      state.serverReady = false;
      if (attempt < 18) {
        dot.className = 'h-2 w-2 rounded-full bg-amber-400 animate-pulse';
        text.textContent = 'A acordar o servidor…';
        setTimeout(() => checkServer(attempt + 1), 8000);
      } else {
        dot.className = 'h-2 w-2 rounded-full bg-red-500';
        text.textContent = 'Servidor offline';
      }
    }
  }

  // ------------------------------------------------------------------ Itens (um por ficheiro)
  let nextId = 1;
  function makeItem(file) {
    const baseName = (file.name || 'imagem').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-') || 'imagem';
    return {
      id: nextId++, file, name: file.name || 'imagem', baseName, size: file.size,
      url: null, width: 0, height: 0,
      status: 'queued', progress: 0, error: null,
      resultBlob: null, resultUrl: null, seconds: NaN, refineApplied: true,
      xhr: null, sim: null, dom: null,
    };
  }

  function freeItem(item) {
    item.xhr?.abort();
    item.sim?.stop();
    if (item.url) URL.revokeObjectURL(item.url);
    if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
  }

  function clearAll() {
    state.items.forEach(freeItem);
    state.items = [];
    state.current = null;
    state.mode = 'idle';
    el.batchList.innerHTML = '';
  }

  // ------------------------------------------------------------------ Validação no cliente
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  async function prepare(item) {
    const { file } = item;
    const type = guessType(file);
    if (!CONFIG.accepted.includes(type)) throw new Error('Formato não suportado. Use PNG, JPG ou WebP.');
    if (file.size === 0) throw new Error('O ficheiro está vazio.');
    if (file.size > CONFIG.maxMB * 1048576)
      throw new Error(`Tem ${formatBytes(file.size)}. O máximo é ${CONFIG.maxMB} MB.`);
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      item.url = url; item.width = img.naturalWidth; item.height = img.naturalHeight;
    } catch {
      URL.revokeObjectURL(url);
      throw new Error('Não foi possível ler a imagem. O ficheiro pode estar corrompido.');
    }
    // Limites por formato do servidor (ex.: Render gratuito) — avisa antes de enviar
    const mp = (item.width * item.height) / 1e6;
    const limit = type === 'image/webp' ? CONFIG.maxWebpMP : type === 'image/png' ? CONFIG.maxPngMP : 0;
    if (limit && mp > limit) {
      const fmt = type === 'image/webp' ? 'WebP' : 'PNG';
      throw new Error(`${fmt} de ${Math.round(mp)} MP é grande demais para o servidor (máx. ${limit} MP em ${fmt}). Envie em JPG ou reduza a resolução.`);
    }
  }

  function flagInvalid() {
    el.dropzone.classList.remove('is-invalid');
    void el.dropzone.offsetWidth;
    el.dropzone.classList.add('is-invalid');
  }

  // ------------------------------------------------------------------ Progresso (real no upload, estimado na inferência)
  class Sim {
    constructor(onRender) { this.value = 0; this.timer = null; this.onRender = onRender; }
    set(v) { this.value = Math.min(100, Math.max(this.value, v)); this.onRender(this.value); }
    simulate(ceiling = 94) {
      this.stop();
      this.timer = setInterval(() => this.set(this.value + Math.max((ceiling - this.value) * 0.03, 0.02)), 120);
    }
    stop() { clearInterval(this.timer); this.timer = null; }
    reset() { this.stop(); this.value = 0; this.onRender(0); }
  }

  const MESSAGES = [
    [0, 'A carregar imagem…'],
    [30, 'A IA está a analisar a imagem…'],
    [50, 'A IA está a remover o fundo…'],
    [68, 'A refinar bordas e detalhes…'],
    [85, 'Quase pronto!'],
  ];
  const messageFor = (v) => { let m = MESSAGES[0][1]; for (const [t, msg] of MESSAGES) if (v >= t) m = msg; return m; };

  const mainProgress = new Sim((v) => {
    el.bar.style.width = `${v}%`;
    el.pct.textContent = `${Math.floor(v)}%`;
    el.track.setAttribute('aria-valuenow', Math.floor(v));
    const msg = messageFor(v);
    if (el.status.textContent !== msg) el.status.textContent = msg;
    orb('setProgress', v / 100);
    const active = v < 30 ? 1 : v < 90 ? 2 : 3;
    $$('.step').forEach((s) => {
      const n = +s.dataset.step;
      s.classList.toggle('is-active', n === active);
      s.classList.toggle('is-done', n < active);
    });
  });

  // ------------------------------------------------------------------ Pedido à API (XHR = progresso real de upload)
  async function parseError(blob, status) {
    try {
      const data = JSON.parse(await blob.text());
      if (data?.error?.message) return data.error.message;
    } catch { /* resposta não-JSON */ }
    const fallback = {
      413: 'A imagem é demasiado grande.',
      415: 'Formato não suportado. Use PNG, JPG ou WebP.',
      429: 'Demasiados pedidos. Aguarde um momento.',
      500: 'Erro no servidor. Tente novamente.',
      502: 'Servidor indisponível.', 503: 'Servidor ocupado. Tente novamente.',
    };
    return fallback[status] || `Não foi possível processar a imagem (erro ${status}).`;
  }

  function requestRemoval(item, sim, refine) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      item.xhr = xhr;
      xhr.open('POST', `${CONFIG.apiBase}/api/remove-background`);
      xhr.responseType = 'blob';
      xhr.timeout = CONFIG.timeoutMs;

      xhr.upload.onprogress = (e) => { if (e.lengthComputable) sim.set((e.loaded / e.total) * 28); };
      xhr.upload.onload = () => { sim.set(30); sim.simulate(94); };
      xhr.onprogress = (e) => {
        if (xhr.status >= 200 && xhr.status < 300 && e.lengthComputable) {
          sim.stop();
          sim.set(94 + (e.loaded / e.total) * 6);
        }
      };
      xhr.onload = async () => {
        sim.stop();
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({
            blob: xhr.response,
            seconds: parseFloat(xhr.getResponseHeader('X-Processing-Time')),
            refineApplied: xhr.getResponseHeader('X-Refine-Applied') !== 'false',
            outWidth: parseInt(xhr.getResponseHeader('X-Image-Width'), 10) || 0,
            outHeight: parseInt(xhr.getResponseHeader('X-Image-Height'), 10) || 0,
            downscaled: xhr.getResponseHeader('X-Output-Downscaled') === 'true',
          });
        } else {
          reject(new Error(await parseError(xhr.response, xhr.status)));
        }
      };
      xhr.onerror = () => { sim.stop(); reject(new Error('Não foi possível ligar ao servidor. Verifique se o backend está em execução.')); };
      xhr.ontimeout = () => { sim.stop(); reject(new Error('O processamento demorou demasiado. Tente uma imagem mais pequena.')); };
      xhr.onabort = () => { sim.stop(); reject(Object.assign(new Error('Cancelado'), { cancelled: true })); };

      const fd = new FormData();
      fd.append('file', item.file, item.name || `imagem.${guessType(item.file).split('/')[1] || 'png'}`);
      fd.append('refine_edges', refine ? 'true' : 'false');
      xhr.send(fd);
      // Salvaguarda: alguns ambientes (proxies, extensões) não emitem eventos de upload
      setTimeout(() => {
        if (item.xhr === xhr && sim.value < 1 && !sim.timer) { sim.set(30); sim.simulate(94); }
      }, 700);
    });
  }

  function applyResult(item, res) {
    item.resultBlob = res.blob;
    item.resultUrl = URL.createObjectURL(res.blob);
    item.seconds = res.seconds;
    item.refineApplied = res.refineApplied;
    item.downscaled = res.downscaled;
    item.outWidth = res.outWidth || item.width;
    item.outHeight = res.outHeight || item.height;
    item.status = 'done';
    item.error = null;
    if (Number.isFinite(res.seconds)) $('#stat-latency').textContent = `${res.seconds.toFixed(1)} s`;
  }

  // ------------------------------------------------------------------ Entrada principal
  async function handleFiles(list) {
    const files = [...(list || [])].filter(Boolean);
    if (!files.length) return;
    if (state.busy) return toast('Aguarde: ainda há imagens em processamento.', 'info');
    if (!state.serverReady)
      toast('O servidor gratuito está a acordar — o primeiro pedido pode demorar até 1 minuto.', 'info', 7000);

    let chosen = files;
    if (files.length > CONFIG.maxFiles) {
      chosen = files.slice(0, CONFIG.maxFiles);
      toast(`Pode processar até ${CONFIG.maxFiles} imagens de cada vez. Foram usadas as primeiras ${CONFIG.maxFiles}.`, 'info', 4500);
    }
    clearAll();
    try {
      if (chosen.length === 1) await runSingle(chosen[0]);
      else await runBatch(chosen);
    } finally {
      el.fileInput.value = '';
    }
  }

  // ------------------------------------------------------------------ Fluxo: 1 imagem
  async function runSingle(file) {
    const item = makeItem(file);
    state.items = [item];
    state.mode = 'single';
    try {
      await prepare(item);
    } catch (err) {
      showView('upload'); flagInvalid(); orb('setMode', 'error'); toast(err.message);
      clearAll();
      return;
    }

    state.busy = true;
    el.preview.src = item.url;
    mainProgress.reset();
    showView('processing');
    orb('setMode', 'processing');
    const refine = el.refine.checked;

    try {
      item.status = 'working';
      const res = await requestRemoval(item, mainProgress, refine);
      mainProgress.set(100);
      applyResult(item, res);
      await loadImage(item.resultUrl);
      await sleep(250);
      state.busy = false;
      orb('setMode', 'success');
      openResult(item);
      toast('Fundo removido com sucesso!', 'success', 2500);
      if (res.downscaled)
        toast(`Imagem reduzida para ${item.outWidth}×${item.outHeight}px para caber no servidor gratuito.`, 'info', 5000);
      if (refine && !res.refineApplied)
        toast('O refinamento de bordas foi ignorado porque a imagem é muito grande.', 'info', 5000);
    } catch (err) {
      state.busy = false;
      mainProgress.stop();
      showView('upload');
      orb('setMode', err.cancelled ? 'idle' : 'error');
      toast(err.cancelled ? 'Processamento cancelado.' : err.message, err.cancelled ? 'info' : 'error');
      clearAll();
    } finally {
      state.busy = false;
      item.xhr = null;
      $('#card').classList.remove('is-busy');
    }
  }

  // ------------------------------------------------------------------ Fluxo: lote (2 a 5 imagens)
  const ICONS = {
    eye: '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    down: '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12m0 0 5-5m-5 5-5-5M4 20h16"/></svg>',
    retry: '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  };

  function renderBatchList() {
    el.batchList.innerHTML = '';
    el.batchCount.textContent = state.items.length;
    state.items.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = 'batch-item';
      li.style.setProperty('--i', `${i * 0.06}s`);
      li.innerHTML = `
        <div class="batch-thumb bg-layer checker">
          <img class="thumb-orig" alt="" />
          <img class="thumb-res" alt="" />
          <span class="thumb-scan"></span>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline justify-between gap-2">
            <p class="item-name truncate text-sm font-semibold"></p>
            <span class="item-pct font-mono text-xs tabular-nums text-slate-400"></span>
          </div>
          <p class="item-status truncate"></p>
          <div class="mini-track"><div class="mini-bar"></div></div>
        </div>
        <div class="item-actions flex shrink-0 items-center gap-1.5"></div>`;
      $('.item-name', li).textContent = item.name;
      $('.item-name', li).title = item.name;
      item.dom = {
        li, orig: $('.thumb-orig', li), res: $('.thumb-res', li), status: $('.item-status', li),
        bar: $('.mini-bar', li), pct: $('.item-pct', li), actions: $('.item-actions', li),
      };
      applyBg($('.batch-thumb', li));
      el.batchList.appendChild(li);
      updateItem(item);
    });
  }

  function statusText(item) {
    switch (item.status) {
      case 'queued': return `${formatBytes(item.size)} · Em fila`;
      case 'working': return `${formatBytes(item.size)} · ${messageFor(item.progress)}`;
      case 'done': {
        const t = Number.isFinite(item.seconds) ? ` · ${item.seconds.toFixed(1)} s` : '';
        return `✓ ${item.outWidth}×${item.outHeight}px${item.downscaled ? ' (reduzida)' : ''}${t}`;
      }
      default: return item.error || 'Erro';
    }
  }

  function updateItemProgress(item) {
    if (!item.dom) return;
    const v = item.status === 'queued' ? 0 : item.status === 'working' ? item.progress : 100;
    item.dom.bar.style.width = `${v}%`;
    item.dom.pct.textContent = item.status === 'working' ? `${Math.floor(v)}%` : '';
    item.dom.status.textContent = statusText(item);
  }

  function updateItem(item) {
    if (!item.dom) return;
    const d = item.dom;
    d.li.dataset.status = item.status;
    if (item.url && d.orig.getAttribute('src') !== item.url) d.orig.src = item.url;
    if (item.resultUrl && d.res.getAttribute('src') !== item.resultUrl) d.res.src = item.resultUrl;
    updateItemProgress(item);

    let html = '';
    if (item.status === 'done') {
      html = `<button type="button" class="icon-btn" data-action="view" data-id="${item.id}" title="Ver e comparar" aria-label="Ver ${item.name}">${ICONS.eye}</button>
              <button type="button" class="icon-btn" data-action="download" data-id="${item.id}" title="Descarregar PNG" aria-label="Descarregar ${item.name}">${ICONS.down}</button>`;
    } else if ((item.status === 'error' || item.status === 'cancelled') && item.url && !item.fatal && !state.busy) {
      html = `<button type="button" class="icon-btn" data-action="retry" data-id="${item.id}" title="Tentar de novo">${ICONS.retry}<span class="hidden sm:inline">Repetir</span></button>`;
    }
    if (d.actions.innerHTML.trim() !== html.trim()) d.actions.innerHTML = html;
  }

  function updateBatchTotals() {
    const items = state.items;
    if (!items.length) return;
    const finished = (i) => ['done', 'error', 'cancelled'].includes(i.status);
    const total = items.reduce((s, i) => s + (finished(i) ? 100 : i.status === 'working' ? i.progress : 0), 0) / items.length;
    const done = items.filter((i) => i.status === 'done').length;
    const failed = items.filter((i) => i.status === 'error' || i.status === 'cancelled').length;
    const pending = items.length - done - failed;

    el.batchPct.textContent = `${Math.floor(total)}%`;
    el.batchBar.style.width = `${total}%`;
    const parts = [`${done} concluída${done === 1 ? '' : 's'}`];
    if (pending) parts.push(`${pending} em curso/fila`);
    if (failed) parts.push(`${failed} com erro`);
    el.batchSummary.textContent = parts.join(' · ');
    if (state.busy) orb('setProgress', total / 100);

    el.batchCancel.classList.toggle('hidden', !state.busy);
    el.batchNew.classList.toggle('hidden', state.busy);
    el.batchZip.disabled = state.busy || done === 0;
  }

  async function processItem(item, refine) {
    item.status = 'working';
    item.error = null;
    item.progress = 0;
    item.sim = new Sim((v) => { item.progress = v; updateItemProgress(item); updateBatchTotals(); });
    updateItem(item);
    try {
      const res = await requestRemoval(item, item.sim, refine);
      item.sim.set(100);
      applyResult(item, res);
    } catch (err) {
      item.status = err.cancelled ? 'cancelled' : 'error';
      item.error = err.cancelled ? 'Cancelado' : err.message;
    } finally {
      item.sim.stop();
      item.xhr = null;
      updateItem(item);
      updateBatchTotals();
    }
  }

  function runQueue(refine) {
    return new Promise((resolve) => {
      let active = 0;
      const pump = () => {
        while (!state.cancelBatch && active < CONFIG.concurrency) {
          const item = state.items.find((i) => i.status === 'queued');
          if (!item) break;
          active++;
          processItem(item, refine).finally(() => { active--; pump(); });
        }
        if (active === 0) resolve();
      };
      pump();
    });
  }

  async function runBatch(files) {
    state.mode = 'batch';
    state.busy = true;
    state.cancelBatch = false;
    state.items = files.map(makeItem);
    renderBatchList();
    showView('batch');
    orb('setMode', 'processing');
    updateBatchTotals();

    // Validação local em paralelo: ficheiros inválidos ficam marcados, os restantes seguem
    await Promise.all(state.items.map(async (item) => {
      try { await prepare(item); } catch (err) { item.status = 'error'; item.error = err.message; item.fatal = true; }
      updateItem(item);
    }));
    updateBatchTotals();

    const refine = el.refine.checked;
    const bigSkipped = refine && state.items.some((i) => i.width * i.height > 25e6);
    await runQueue(refine);
    finishBatch(bigSkipped);
  }

  function finishBatch(refineNote = false) {
    state.busy = false;
    $('#card').classList.remove('is-busy');
    state.items.forEach(updateItem);
    updateBatchTotals();
    const done = state.items.filter((i) => i.status === 'done').length;
    const failed = state.items.length - done;
    if (done && !failed) {
      orb('setMode', 'success');
      toast(`${done} imagens prontas! Descarregue todas em ZIP ou uma a uma.`, 'success', 3500);
    } else if (done) {
      orb('setMode', 'success');
      toast(`${done} de ${state.items.length} imagens prontas. ${failed} com erro — pode repetir.`, 'info', 5000);
    } else {
      orb('setMode', state.cancelBatch ? 'idle' : 'error');
      toast(state.cancelBatch ? 'Lote cancelado.' : 'Nenhuma imagem foi processada.', state.cancelBatch ? 'info' : 'error');
    }
    if (refineNote) toast('Em imagens acima de 25 MP o refinamento de bordas é ignorado.', 'info', 4500);
  }

  async function retryItem(item) {
    if (state.busy) return;
    state.busy = true;
    state.cancelBatch = false;
    $('#card').classList.add('is-busy');
    orb('setMode', 'processing');
    item.status = 'queued';
    updateBatchTotals();
    await runQueue(el.refine.checked);
    finishBatch();
  }

  function cancelBatch() {
    state.cancelBatch = true;
    state.items.forEach((i) => {
      if (i.status === 'queued') { i.status = 'cancelled'; i.error = 'Cancelado'; updateItem(i); }
      i.xhr?.abort();
    });
    updateBatchTotals();
  }

  el.batchList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const item = state.items.find((i) => i.id === +btn.dataset.id);
    if (!item) return;
    if (btn.dataset.action === 'view') openResult(item);
    if (btn.dataset.action === 'download') downloadItem(item);
    if (btn.dataset.action === 'retry') retryItem(item);
  });
  el.batchCancel.addEventListener('click', cancelBatch);
  el.batchNew.addEventListener('click', resetAll);
  el.batchZip.addEventListener('click', downloadZip);
  el.backToBatch.addEventListener('click', backToBatch);

  function backToBatch() {
    if (state.mode !== 'batch') return;
    showView('batch');
    updateBatchTotals();
  }

  function resetAll() {
    if (state.busy) return;
    clearAll();
    showView('upload');
    orb('setMode', 'idle');
    el.dropzone.focus();
  }

  // ------------------------------------------------------------------ Vista de resultado (comparador)
  function openResult(item) {
    state.current = item;
    const ratio = item.width / item.height;
    for (const box of [el.compare, el.resultOnly]) {
      box.style.aspectRatio = `${item.width} / ${item.height}`;
      box.style.maxWidth = `min(100%, calc(68vh * ${ratio}))`;
    }
    el.beforeImg.src = el.sideBefore.src = item.url;
    el.afterImg.src = el.sideAfter.src = el.resultOnlyImg.src = item.resultUrl;

    const parts = [item.name, `${item.outWidth}×${item.outHeight}px${item.downscaled ? ' (reduzida)' : ''}`, formatBytes(item.resultBlob.size)];
    if (Number.isFinite(item.seconds)) parts.push(`${item.seconds.toFixed(1)}s`);
    el.meta.textContent = parts.join(' · ');

    el.backToBatch.classList.toggle('hidden', state.mode !== 'batch');
    setViewMode('slider');
    showView('result');
    animateSplit(88, 50, 700);
  }

  function setSplit(pct) {
    const v = Math.min(100, Math.max(0, pct));
    el.compare.style.setProperty('--split', `${v}%`);
    el.handle.setAttribute('aria-valuenow', Math.round(v));
    el.handle.dataset.value = v;
  }

  function animateSplit(from, to, duration) {
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      setSplit(from + (to - from) * ease(t));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  let dragging = false;
  const splitFromEvent = (e) => {
    const r = el.compare.getBoundingClientRect();
    setSplit(((e.clientX - r.left) / r.width) * 100);
  };
  el.compare.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.compare.setPointerCapture(e.pointerId);
    el.compare.classList.add('is-dragging');
    splitFromEvent(e);
  });
  el.compare.addEventListener('pointermove', (e) => dragging && splitFromEvent(e));
  const endDrag = () => { dragging = false; el.compare.classList.remove('is-dragging'); };
  el.compare.addEventListener('pointerup', endDrag);
  el.compare.addEventListener('pointercancel', endDrag);

  el.handle.addEventListener('keydown', (e) => {
    const cur = parseFloat(el.handle.dataset.value || 50);
    const step = e.shiftKey ? 10 : 2;
    const map = { ArrowLeft: cur - step, ArrowRight: cur + step, Home: 0, End: 100 };
    if (e.key in map) { e.preventDefault(); setSplit(map[e.key]); }
  });

  function setViewMode(mode) {
    $$('.seg-btn').forEach((b) => {
      const on = b.dataset.view === mode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on);
    });
    $('#stage-slider').classList.toggle('hidden', mode !== 'slider');
    $('#stage-side').classList.toggle('hidden', mode !== 'side');
    $('#stage-result').classList.toggle('hidden', mode !== 'result');
  }
  $$('.seg-btn').forEach((b) => b.addEventListener('click', () => setViewMode(b.dataset.view)));

  // ------------------------------------------------------------------ Cor de fundo (partilhada entre resultado e lote)
  function applyBg(layer) {
    const solid = state.bg !== 'transparent';
    layer.classList.toggle('bg-solid', solid);
    layer.style.backgroundColor = solid ? state.bg : '';
  }

  function setBackground(bg, custom = false) {
    state.bg = bg;
    state.bgCustom = custom;
    $$('.bg-layer').forEach(applyBg);
    $$('.swatch').forEach((s) => {
      const on = s.classList.contains('swatch-custom') ? custom : !custom && s.dataset.bg === bg;
      s.classList.toggle('is-active', on);
      s.setAttribute('aria-checked', on);
    });
  }
  $$('.swatch[data-bg]').forEach((s) => s.addEventListener('click', () => setBackground(s.dataset.bg)));
  $$('.custom-color').forEach((input) => input.addEventListener('input', (e) => {
    const color = e.target.value;
    $$('.custom-color').forEach((i) => { i.value = color; i.closest('.swatch').style.background = color; });
    setBackground(color, true);
  }));

  // ------------------------------------------------------------------ Exportação (resolução original)
  async function buildOutputBlob(item) {
    if (!item?.resultBlob) return null;
    if (state.bg === 'transparent') return item.resultBlob;
    const bitmap = await createImageBitmap(item.resultBlob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Imagem demasiado grande para aplicar a cor no navegador. Use fundo transparente.');
    ctx.fillStyle = state.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    canvas.width = canvas.height = 0; // liberta memória
    if (!blob) throw new Error('Imagem demasiado grande para aplicar a cor no navegador. Use fundo transparente.');
    return blob;
  }

  async function downloadItem(item) {
    try {
      const blob = await buildOutputBlob(item);
      if (blob) saveBlob(blob, `${item.baseName}-sem-fundo.png`);
    } catch (err) { toast(err.message); }
  }

  async function copyToClipboard() {
    try {
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error();
      const blob = await buildOutputBlob(state.current);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Imagem copiada para a área de transferência.', 'success', 2500);
    } catch {
      toast('O seu navegador não permite copiar esta imagem. Use o botão de download.', 'info');
    }
  }

  // ZIP sem dependências (método STORE: os PNG já estão comprimidos)
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  async function makeZip(entries) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const files = [], central = [];
    let offset = 0;

    for (const { name, blob } of entries) {
      const data = new Uint8Array(await blob.arrayBuffer());
      const fname = enc.encode(name);
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // nomes em UTF-8
      local.setUint16(8, 0, true);      // STORE
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, fname.length, true);
      files.push(local.buffer, fname, data);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(12, dosTime, true);
      cen.setUint16(14, dosDate, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, fname.length, true);
      cen.setUint32(42, offset, true);
      central.push(cen.buffer, fname);

      offset += 30 + fname.length + data.length;
    }
    const centralSize = central.reduce((s, b) => s + b.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...files, ...central, end.buffer], { type: 'application/zip' });
  }

  async function downloadZip() {
    const done = state.items.filter((i) => i.status === 'done');
    if (!done.length) return;
    const label = el.batchZip.innerHTML;
    el.batchZip.disabled = true;
    el.batchZip.textContent = 'A preparar ZIP…';
    try {
      const used = new Set();
      const entries = [];
      for (const item of done) {
        let name = `${item.baseName}-sem-fundo.png`;
        for (let n = 2; used.has(name); n++) name = `${item.baseName}-sem-fundo-${n}.png`;
        used.add(name);
        entries.push({ name, blob: await buildOutputBlob(item) });
      }
      const zip = await makeZip(entries);
      saveBlob(zip, `clearcut-${entries.length}-imagens.zip`);
      toast(`ZIP com ${entries.length} imagens pronto (${formatBytes(zip.size)}).`, 'success', 3000);
    } catch (err) {
      toast(err.message || 'Não foi possível criar o ZIP.');
    } finally {
      el.batchZip.innerHTML = label;
      updateBatchTotals();
    }
  }

  $('#download-btn').addEventListener('click', () => downloadItem(state.current));
  $('#copy-btn').addEventListener('click', copyToClipboard);
  $('#new-btn').addEventListener('click', resetAll);
  $('#cancel-btn').addEventListener('click', () => state.items[0]?.xhr?.abort());

  // ------------------------------------------------------------------ Entrada: clique, teclado, drag & drop, colar
  el.fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
  el.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
  });

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const setDragUI = (on) => {
    el.overlay.classList.toggle('is-visible', on);
    el.dropzone.classList.toggle('is-dragover', on);
    $('.dz-title', el.dropzone).innerHTML = on
      ? 'Solte para começar'
      : `Arraste até <span data-max-files>${CONFIG.maxFiles}</span> imagens para aqui`;
    if (!state.busy) orb('setMode', on ? 'drag' : 'idle');
  };

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (++dragDepth === 1) setDragUI(true);
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) { dragDepth = 0; setDragUI(false); }
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    setDragUI(false);
    handleFiles(e.dataTransfer.files);
  });

  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
      .map((i, n) => {
        const blob = i.getAsFile();
        const ext = i.type.split('/')[1] || 'png';
        return new File([blob], `colada-${Date.now()}-${n + 1}.${ext}`, { type: i.type });
      });
    if (!files.length) return;
    e.preventDefault();
    handleFiles(files);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isVisible('result')) state.mode === 'batch' ? backToBatch() : resetAll();
      else if (isVisible('batch') && !state.busy) resetAll();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      if (isVisible('result') && state.current) { e.preventDefault(); downloadItem(state.current); }
      else if (isVisible('batch') && !el.batchZip.disabled) { e.preventDefault(); downloadZip(); }
    }
  });

  // ------------------------------------------------------------------ Interatividade da caixa: spotlight + tilt 3D
  const card = $('#card');
  card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
  if (window.matchMedia('(pointer: fine)').matches) {
    el.dropzone.addEventListener('pointermove', (e) => {
      const r = el.dropzone.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      el.dropzone.style.setProperty('--rx', `${(-py * 8).toFixed(2)}deg`);
      el.dropzone.style.setProperty('--ry', `${(px * 10).toFixed(2)}deg`);
    });
    el.dropzone.addEventListener('pointerleave', () => {
      el.dropzone.style.setProperty('--rx', '0deg');
      el.dropzone.style.setProperty('--ry', '0deg');
    });
  }

  // ------------------------------------------------------------------ Arranque
  checkServer();
})();
