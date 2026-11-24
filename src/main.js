import './styles.css';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';

const $ = (id) => document.getElementById(id);

const els = {
  canvas: $('canvas'),
  empty: $('empty'),
  zoomBadge: $('zoom-badge'),
  toast: $('toast'),
  counter: $('counter'),
  zoomLabel: $('zoom-label'),
  fileStats: $('file-stats'),
  imageList: $('image-list'),
  listSpacer: $('list-spacer'),
  listItems: $('list-items'),
  scanProgress: $('scan-progress'),
  statsHint: $('stats-hint'),
  classList: $('class-list'),
  annotationList: $('annotation-list'),
  fileInfo: $('file-info'),
  boxCount: $('box-count'),
  statusRoot: $('status-root'),
  statusExtra: $('status-extra'),
  search: $('search'),
  btnPrev: $('btn-prev'),
  btnNext: $('btn-next'),
  btnToggleLabels: $('btn-toggle-labels'),
};

const ITEM_HEIGHT = 38;
const META_CACHE_MAX = 500;
const ANNOTATION_CACHE_MAX = 40;
const IMAGE_CACHE_MAX = 12;

const state = {
  root: '',
  classes: [],
  classSource: '',
  hasNames: false,
  total: 0,
  listReady: false,
  scanDone: false,
  scanPhase: '',
  currentIndex: -1,
  currentAnnotations: [],
  metaCache: new Map(),
  annotationCache: new Map(),
  imageCache: new Map(),
  viewIndices: null,
  query: '',
  stats: { totalBoxes: 0, classCounts: [], progress: 0, done: false },
  currentImg: null,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  showLabels: true,
  hiddenClasses: new Set(),
  selectedBox: -1,
};

let toastTimer = null;
let drag = null;
let renderToken = 0;
let selectionToken = 0;
let scrollScheduled = false;
let searchTimer = null;
let listenersReady = null;

/* ---------------- helpers ---------------- */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function fmt(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function classColor(id) {
  const hue = Math.round((id * 137.508) % 360);
  return `hsl(${hue}, 76%, 56%)`;
}

function softColor(hsl, alpha) {
  return hsl.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
}

function className(id) {
  return state.classes?.[id] ?? `类别 ${id}`;
}

function annotationName(annotation) {
  return annotation.label || className(annotation.classId);
}

function viewLength() {
  return state.viewIndices ? state.viewIndices.length : state.total;
}

function viewToReal(position) {
  return state.viewIndices ? state.viewIndices[position] : position;
}

function realToView(real) {
  return state.viewIndices ? state.viewIndices.indexOf(real) : real;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4200);
}

function putWithLimit(map, key, value, limit) {
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function normalizedBox(annotation, img) {
  const { cx, cy, w, h } = annotation;
  if (w > 1.5 || h > 1.5 || cx > 1.5 || cy > 1.5) {
    return {
      cx: cx / img.naturalWidth,
      cy: cy / img.naturalHeight,
      w: w / img.naturalWidth,
      h: h / img.naturalHeight,
    };
  }
  return { cx, cy, w, h };
}

function baseScale() {
  if (!state.currentImg || !state.currentImg.naturalWidth) return 1;
  const rect = els.canvas.getBoundingClientRect();
  return Math.min(rect.width / state.currentImg.naturalWidth, rect.height / state.currentImg.naturalHeight) * 0.94;
}

function boxScreenRect(annotation) {
  const img = state.currentImg;
  if (!img) return null;
  const scale = baseScale() * state.zoom;
  const rect = els.canvas.getBoundingClientRect();
  const ox = (rect.width - img.naturalWidth * scale) / 2 + state.offsetX;
  const oy = (rect.height - img.naturalHeight * scale) / 2 + state.offsetY;
  const nb = normalizedBox(annotation, img);
  return {
    x1: ox + (nb.cx - nb.w / 2) * img.naturalWidth * scale,
    y1: oy + (nb.cy - nb.h / 2) * img.naturalHeight * scale,
    x2: ox + (nb.cx + nb.w / 2) * img.naturalWidth * scale,
    y2: oy + (nb.cy + nb.h / 2) * img.naturalHeight * scale,
  };
}

/* ---------------- canvas drawing ---------------- */

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function draw() {
  const canvas = els.canvas;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  if (!width || !height) return;

  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#171b24';
  ctx.fillRect(0, 0, width, height);

  const img = state.currentImg;
  if (!img || !img.naturalWidth) {
    if (state.currentIndex >= 0) {
      ctx.fillStyle = '#98a2b6';
      ctx.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('图片加载中...', width / 2, height / 2);
      ctx.textAlign = 'left';
    }
    return;
  }

  const scale = baseScale() * state.zoom;
  const drawWidth = img.naturalWidth * scale;
  const drawHeight = img.naturalHeight * scale;
  const ox = (width - drawWidth) / 2 + state.offsetX;
  const oy = (height - drawHeight) / 2 + state.offsetY;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, ox, oy, drawWidth, drawHeight);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
  ctx.lineWidth = 1;
  ctx.strokeRect(ox - 0.5, oy - 0.5, drawWidth + 1, drawHeight + 1);

  state.currentAnnotations.forEach((annotation, index) => {
    if (state.hiddenClasses.has(annotation.classId)) return;
    const box = boxScreenRect(annotation);
    if (!box) return;
    const bw = box.x2 - box.x1;
    const bh = box.y2 - box.y1;
    if (bw < 1 || bh < 1) return;

    const color = classColor(annotation.classId);
    const selected = index === state.selectedBox;

    ctx.fillStyle = softColor(color, selected ? 0.22 : 0.12);
    ctx.fillRect(box.x1, box.y1, bw, bh);
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeRect(box.x1, box.y1, bw, bh);

    if (selected) {
      const size = 6;
      ctx.fillStyle = '#ffffff';
      for (const [hx, hy] of [[box.x1, box.y1], [box.x2, box.y1], [box.x1, box.y2], [box.x2, box.y2]]) {
        ctx.fillRect(hx - size / 2, hy - size / 2, size, size);
      }
    }

    if (!state.showLabels) return;
    let text = annotationName(annotation);
    if (annotation.confidence != null) text += ` ${Math.round(annotation.confidence * 100)}%`;
    ctx.font = '600 12px "Segoe UI", "Microsoft YaHei", sans-serif';
    const textWidth = ctx.measureText(text).width;
    const pillWidth = Math.min(textWidth + 14, Math.max(bw, 40));
    const pillHeight = 21;
    const pillX = Math.max(2, Math.min(box.x1, width - pillWidth - 2));
    const pillY = box.y1 > pillHeight + 4 ? box.y1 - pillHeight - 2 : box.y1 + 2;
    ctx.fillStyle = color;
    roundRect(ctx, pillX, pillY, pillWidth, pillHeight, 5);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.beginPath();
    ctx.rect(pillX, pillY, pillWidth, pillHeight);
    ctx.clip();
    ctx.fillText(text, pillX + 7, pillY + pillHeight / 2 + 0.5);
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
  });
}

/* ---------------- zoom / selection ---------------- */

function updateZoomUI() {
  const percent = `${Math.round(state.zoom * 100)}%`;
  els.zoomLabel.textContent = percent;
  els.zoomBadge.textContent = percent;
  els.zoomBadge.hidden = state.currentIndex < 0;
}

function zoomAt(factor, clientX, clientY) {
  const img = state.currentImg;
  if (!img || !img.naturalWidth) return;
  const rect = els.canvas.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const oldScale = baseScale() * state.zoom;
  const newZoom = Math.max(0.08, Math.min(40, state.zoom * factor));
  const newScale = baseScale() * newZoom;
  const oldOx = (rect.width - img.naturalWidth * oldScale) / 2 + state.offsetX;
  const oldOy = (rect.height - img.naturalHeight * oldScale) / 2 + state.offsetY;
  const imageX = (mx - oldOx) / oldScale;
  const imageY = (my - oldOy) / oldScale;
  state.offsetX = (mx - imageX * newScale) - (rect.width - img.naturalWidth * newScale) / 2;
  state.offsetY = (my - imageY * newScale) - (rect.height - img.naturalHeight * newScale) / 2;
  state.zoom = newZoom;
  updateZoomUI();
  draw();
}

function zoomCenter(factor) {
  const rect = els.canvas.getBoundingClientRect();
  zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function fitView() {
  state.zoom = 1;
  state.offsetX = 0;
  state.offsetY = 0;
  updateZoomUI();
  draw();
}

function hitTest(mx, my) {
  if (!state.currentImg) return -1;
  for (let i = state.currentAnnotations.length - 1; i >= 0; i -= 1) {
    const annotation = state.currentAnnotations[i];
    if (state.hiddenClasses.has(annotation.classId)) continue;
    const box = boxScreenRect(annotation);
    if (box && mx >= box.x1 && mx <= box.x2 && my >= box.y1 && my <= box.y2) return i;
  }
  return -1;
}

/* ---------------- virtual list ---------------- */

function updateScanUI(visible, text = '') {
  els.scanProgress.hidden = !visible;
  if (!visible) return;
  els.scanProgress.innerHTML = `<div>${escapeHtml(text)}</div>`;
}

function setStatsHint(text) {
  els.statsHint.hidden = !text;
  els.statsHint.textContent = text;
}

function paintRows(positions, start, token) {
  if (token !== renderToken) return;
  const html = positions.map((position) => {
    const real = viewToReal(position);
    const meta = state.metaCache.get(real);
    const name = meta ? meta.name : '加载中…';
    let badge = '—';
    let badgeClass = 'no-label';
    if (state.annotationCache.has(real)) {
      const count = state.annotationCache.get(real).length;
      badge = String(count);
      badgeClass = count > 0 ? 'has-boxes' : '';
    } else if (meta && meta.labelPath) {
      badge = '•';
      badgeClass = 'has-boxes';
    }
    return `<div class="image-item ${real === state.currentIndex ? 'active' : ''}" data-pos="${position}" title="${escapeHtml(name)}">
      <span class="image-index">${fmt(position + 1)}</span>
      <span class="image-name">${escapeHtml(name)}</span>
      <span class="box-badge ${badgeClass}">${badge}</span>
    </div>`;
  }).join('');
  els.listItems.innerHTML = html;
  els.listItems.style.transform = `translateY(${start * ITEM_HEIGHT}px)`;
}

function renderVisible() {
  const length = viewLength();
  els.listSpacer.style.height = `${Math.max(length * ITEM_HEIGHT, 1)}px`;
  if (!state.listReady || length === 0) {
    els.listItems.innerHTML = '';
    return;
  }
  const top = els.imageList.scrollTop;
  const viewport = els.imageList.clientHeight || 400;
  const start = Math.max(0, Math.floor(top / ITEM_HEIGHT) - 6);
  const end = Math.min(length, Math.ceil((top + viewport) / ITEM_HEIGHT) + 6);
  const positions = [];
  const missing = [];
  for (let position = start; position < end; position += 1) {
    positions.push(position);
    const real = viewToReal(position);
    if (!state.metaCache.has(real)) missing.push(real);
  }
  const token = ++renderToken;
  if (missing.length) {
    invoke('get_image_batch', { indices: missing })
      .then((metas) => {
        if (token !== renderToken) return;
        metas.forEach((meta, i) => {
          if (meta) putWithLimit(state.metaCache, missing[i], meta, META_CACHE_MAX);
        });
        paintRows(positions, start, token);
      })
      .catch(() => {});
    return;
  }
  paintRows(positions, start, token);
}

function ensureVisible(real) {
  const position = realToView(real);
  if (position < 0) return;
  const top = els.imageList.scrollTop;
  const viewport = els.imageList.clientHeight || 400;
  const y = position * ITEM_HEIGHT;
  if (y < top || y + ITEM_HEIGHT > top + viewport) {
    els.imageList.scrollTop = Math.max(0, y - viewport / 2 + ITEM_HEIGHT / 2);
  }
}

/* ---------------- panels ---------------- */

function renderClassList() {
  if (!state.classes.length) {
    els.classList.innerHTML = '<div class="empty-text">暂无类别</div>';
    return;
  }
  els.classList.innerHTML = state.classes.map((name, id) => {
    const disabled = state.hiddenClasses.has(id);
    const count = state.stats.classCounts[id];
    return `<div class="class-row ${disabled ? 'disabled' : ''}" data-id="${id}" title="${escapeHtml(name)}">
      <span class="class-dot" style="background:${classColor(id)}"></span>
      <span class="class-name">${escapeHtml(name)}</span>
      <span class="class-count">${count != null ? fmt(count) : '…'}</span>
    </div>`;
  }).join('');
}

function renderAnnotationList() {
  const annotations = state.currentAnnotations;
  if (!annotations || !annotations.length) {
    els.annotationList.innerHTML = '<div class="empty-text">当前图片没有标注框</div>';
    els.boxCount.textContent = '';
    return;
  }
  els.boxCount.textContent = `${annotations.length} 个`;
  els.annotationList.innerHTML = annotations.map((annotation, index) => {
    const color = classColor(annotation.classId);
    const confidence = annotation.confidence != null
      ? `<span class="confidence">${(annotation.confidence * 100).toFixed(1)}%</span>` : '';
    const nb = normalizedBox(annotation, state.currentImg || { naturalWidth: 1, naturalHeight: 1 });
    const coords = `x ${nb.cx.toFixed(3)} &nbsp; y ${nb.cy.toFixed(3)} &nbsp; w ${nb.w.toFixed(3)} &nbsp; h ${nb.h.toFixed(3)}`;
    const sub = `类别 ${annotation.classId}${annotation.objectId ? `　·　ID ${escapeHtml(String(annotation.objectId))}` : ''}`;
    return `<div class="annotation-item ${index === state.selectedBox ? 'selected' : ''}" data-index="${index}">
      <span class="annotation-no" style="background:${color}">${index + 1}</span>
      <div class="annotation-body">
        <div class="annotation-title"><span>${escapeHtml(annotationName(annotation))}</span>${confidence}</div>
        <div class="annotation-sub">${sub}</div>
        <div class="annotation-coords">${coords}</div>
      </div>
    </div>`;
  }).join('');
}

function renderFileInfo(meta) {
  if (!meta) {
    els.fileInfo.innerHTML = '<div class="empty-text">加载中…</div>';
    return;
  }
  const img = state.currentImg;
  const dimensions = img && img.naturalWidth
    ? `${img.naturalWidth} × ${img.naturalHeight}` : '加载中';
  const labelName = meta.labelPath
    ? escapeHtml(meta.labelPath.split(/[\\/]/).pop())
    : '<span style="color:#d9483f">无标注文件</span>';
  els.fileInfo.innerHTML = `
    <div class="file-name" title="${escapeHtml(meta.path)}">${escapeHtml(meta.name)}</div>
    <div class="file-path" title="${escapeHtml(meta.path)}">${escapeHtml(meta.path)}</div>
    <div class="info-grid">
      <div class="info-cell"><span>图像尺寸</span><strong>${dimensions}</strong></div>
      <div class="info-cell"><span>标注框</span><strong>${state.currentAnnotations.length}</strong></div>
      <div class="info-cell"><span>标注文件</span><strong>${labelName}</strong></div>
      <div class="info-cell"><span>类别来源</span><strong>${escapeHtml(state.classSource)}</strong></div>
    </div>`;
}

function renderToolbar() {
  const length = viewLength();
  const position = state.currentIndex < 0 ? 0 : Math.max(0, realToView(state.currentIndex) + 1);
  els.counter.textContent = state.listReady ? `${fmt(position)} / ${fmt(length)}` : '0 / 0';
  els.fileStats.textContent = state.listReady
    ? `${fmt(length)} 张图片`
    : (state.scanPhase === 'scanning' || state.scanPhase === 'sorting' ? '索引中…' : '');
  els.btnPrev.disabled = !state.listReady || position <= 1;
  els.btnNext.disabled = !state.listReady || position >= length;
  els.btnToggleLabels.classList.toggle('active', state.showLabels);
  const statsText = state.stats.done
    ? `${fmt(state.stats.totalBoxes)} 个标注框`
    : `统计中 ${Math.round(state.stats.progress * 100)}%`;
  els.statusRoot.textContent = state.root
    ? `${state.root}　·　${fmt(state.total)} 张图片　·　${statsText}　·　${state.classes.length} 个类别${state.hasNames ? '　·　含物体名称' : ''}`
    : '未打开文件夹';
  els.statusExtra.textContent = state.query ? `筛选：${state.query}` : '';
  els.empty.hidden = state.currentIndex >= 0;
  updateZoomUI();
}

/* ---------------- image + annotation loading ---------------- */

function loadImageElement(meta, realIndex) {
  let img = state.imageCache.get(meta.path);
  if (img) return img;
  img = new Image();
  img.onload = () => {
    if (state.currentIndex === realIndex) {
      state.currentImg = img;
      renderFileInfo(meta);
      renderAnnotationList();
      fitView();
      draw();
    }
  };
  img.onerror = () => {
    if (state.currentIndex === realIndex) toast(`无法加载图片：${meta.name}`);
  };
  img.src = convertFileSrc(meta.path);
  putWithLimit(state.imageCache, meta.path, img, IMAGE_CACHE_MAX);
  return img;
}

async function selectImage(realIndex) {
  if (realIndex < 0 || (state.listReady && realIndex >= state.total)) return;
  const token = ++selectionToken;
  state.currentIndex = realIndex;
  state.selectedBox = -1;
  state.currentAnnotations = [];
  state.currentImg = null;
  renderVisible();
  renderAnnotationList();
  renderToolbar();
  renderFileInfo(null);
  draw();

  let meta = state.metaCache.get(realIndex);
  if (!meta) {
    try {
      const metas = await invoke('get_image_batch', { indices: [realIndex] });
      if (token !== selectionToken) return;
      if (metas[0]) {
        meta = metas[0];
        putWithLimit(state.metaCache, realIndex, meta, META_CACHE_MAX);
      }
    } catch (error) {
      toast(`读取图片信息失败：${error}`);
      return;
    }
  }
  if (!meta || token !== selectionToken) return;

  let annotations = state.annotationCache.get(realIndex);
  if (!annotations) {
    try {
      annotations = await invoke('get_annotations', { index: realIndex });
    } catch (error) {
      annotations = [];
    }
    if (token !== selectionToken) return;
    putWithLimit(state.annotationCache, realIndex, annotations, ANNOTATION_CACHE_MAX);
  }
  state.currentAnnotations = annotations || [];

  const img = loadImageElement(meta, realIndex);
  state.currentImg = img.complete && img.naturalWidth ? img : null;
  renderFileInfo(meta);
  renderAnnotationList();
  renderToolbar();
  fitView();
  draw();
  ensureVisible(realIndex);
  renderVisible();
}

function stepImage(delta) {
  if (!state.listReady || state.total === 0) return;
  const length = viewLength();
  const current = state.currentIndex < 0 ? -1 : realToView(state.currentIndex);
  const next = current < 0 ? 0 : current + delta;
  if (next < 0 || next >= length) return;
  selectImage(viewToReal(next));
}

/* ---------------- scan pipeline ---------------- */

function resetState() {
  renderToken += 1;
  selectionToken += 1;
  state.total = 0;
  state.listReady = false;
  state.scanDone = false;
  state.scanPhase = '';
  state.currentIndex = -1;
  state.currentAnnotations = [];
  state.currentImg = null;
  state.selectedBox = -1;
  state.hasNames = false;
  state.query = '';
  state.viewIndices = null;
  state.stats = { totalBoxes: 0, classCounts: [], progress: 0, done: false };
  state.metaCache.clear();
  state.annotationCache.clear();
  state.imageCache.clear();
  state.hiddenClasses.clear();
  els.search.value = '';
  els.imageList.scrollTop = 0;
  els.listItems.innerHTML = '';
  setStatsHint('');
}

async function startScan(path, persist) {
  await ensureListeners();
  resetState();
  state.root = path;
  updateScanUI(true, '正在扫描目录…');
  try {
    const init = await invoke('scan_folder', { path });
    state.classes = init.classes || ['类别 0'];
    state.classSource = init.classSource || '自动生成';
    if (persist) localStorage.setItem('yolo-viewer-last-path', path);
    renderClassList();
    renderToolbar();
    draw();
  } catch (error) {
    toast(`扫描失败：${error}`);
    if (!persist) localStorage.removeItem('yolo-viewer-last-path');
    state.root = '';
    updateScanUI(false);
    renderToolbar();
  }
}

function onScanProgress(payload) {
  state.scanPhase = payload.phase;
  if (payload.phase === 'images-ready') {
    state.total = payload.indexed;
    state.listReady = true;
    updateScanUI(true, `已索引 ${fmt(payload.indexed)} 张图片，正在后台准备标注名称…`);
    renderToolbar();
    renderVisible();
    if (state.currentIndex < 0 && state.total > 0) selectImage(0);
  } else if (payload.phase === 'scanning' || payload.phase === 'sorting') {
    updateScanUI(true, `正在扫描目录… 已发现 ${fmt(payload.indexed)} 张图片`);
    renderToolbar();
  } else if (payload.phase === 'jsonl') {
    updateScanUI(true, `正在建立标注名称索引… ${fmt(payload.indexed)} 行`);
  } else if (payload.phase === 'stats') {
    updateScanUI(true, '正在后台统计标注框…（界面可正常使用）');
  }
}

function onScanDone(payload) {
  state.total = payload.total;
  state.listReady = true;
  state.scanDone = true;
  state.hasNames = payload.hasNames;
  state.classes = payload.classes || state.classes;
  state.classSource = payload.classSource || state.classSource;
  updateScanUI(false);
  renderClassList();
  renderToolbar();
  renderVisible();
  if (state.query) refreshSearch();
  if (state.currentIndex < 0 && state.total > 0) selectImage(0);
}

function onStats(payload) {
  state.stats = {
    totalBoxes: payload.totalBoxes,
    classCounts: payload.classCounts || [],
    progress: payload.progress,
    done: payload.done,
  };
  if (payload.classes && payload.classes.length) state.classes = payload.classes;
  renderClassList();
  setStatsHint(payload.done ? '' : `正在统计标注框… ${Math.round(payload.progress * 100)}%`);
  renderToolbar();
}

function ensureListeners() {
  if (listenersReady) return listenersReady;
  listenersReady = (async () => {
    await listen('scan://progress', (event) => onScanProgress(event.payload));
    await listen('scan://done', (event) => onScanDone(event.payload));
    await listen('stats://update', (event) => onStats(event.payload));
  })();
  return listenersReady;
}

async function refreshSearch() {
  const query = state.query;
  if (!query.trim()) {
    state.viewIndices = null;
  } else {
    try {
      state.viewIndices = await invoke('search_images', { query });
    } catch (error) {
      toast(`搜索失败：${error}`);
    }
  }
  renderVisible();
  renderToolbar();
}

async function openFolder() {
  await ensureListeners();
  try {
    const selected = await open({ directory: true, multiple: false, title: '选择图片或数据集文件夹' });
    if (!selected) return;
    await startScan(selected, true);
  } catch (error) {
    toast(`打开文件夹失败：${error}`);
  }
}

function toggleLabels() {
  state.showLabels = !state.showLabels;
  els.btnToggleLabels.classList.toggle('active', state.showLabels);
  draw();
}

function setAllClasses(visible) {
  state.hiddenClasses.clear();
  if (!visible) state.classes.forEach((_, id) => state.hiddenClasses.add(id));
  renderClassList();
  draw();
}

/* ---------------- events ---------------- */

$('btn-open').addEventListener('click', openFolder);
$('btn-open-empty').addEventListener('click', openFolder);
els.btnPrev.addEventListener('click', () => stepImage(-1));
els.btnNext.addEventListener('click', () => stepImage(1));
$('btn-zoom-in').addEventListener('click', () => zoomCenter(1.25));
$('btn-zoom-out').addEventListener('click', () => zoomCenter(0.8));
$('btn-fit').addEventListener('click', fitView);
els.btnToggleLabels.addEventListener('click', toggleLabels);
$('btn-all-classes').addEventListener('click', () => setAllClasses(true));
$('btn-no-classes').addEventListener('click', () => setAllClasses(false));
$('btn-reveal').addEventListener('click', async () => {
  const meta = state.metaCache.get(state.currentIndex);
  if (!meta) return;
  try {
    await invoke('reveal_in_explorer', { path: meta.path });
  } catch (error) {
    toast(`打开资源管理器失败：${error}`);
  }
});

els.imageList.addEventListener('scroll', () => {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    renderVisible();
  });
});

els.imageList.addEventListener('click', (event) => {
  const row = event.target.closest('.image-item');
  if (row) selectImage(viewToReal(Number(row.dataset.pos)));
});

els.search.addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value;
  searchTimer = setTimeout(async () => {
    state.query = value;
    await refreshSearch();
    els.imageList.scrollTop = 0;
    renderVisible();
  }, 220);
});

els.classList.addEventListener('click', (event) => {
  const row = event.target.closest('.class-row');
  if (!row) return;
  const id = Number(row.dataset.id);
  if (state.hiddenClasses.has(id)) state.hiddenClasses.delete(id);
  else state.hiddenClasses.add(id);
  renderClassList();
  draw();
});

els.annotationList.addEventListener('click', (event) => {
  const row = event.target.closest('.annotation-item');
  if (!row) return;
  state.selectedBox = Number(row.dataset.index);
  renderAnnotationList();
  draw();
});

els.canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
}, { passive: false });

els.canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  drag = { x: event.clientX, y: event.clientY, ox: state.offsetX, oy: state.offsetY, moved: false };
  els.canvas.setPointerCapture(event.pointerId);
});

els.canvas.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
  if (!drag.moved) return;
  state.offsetX = drag.ox + dx;
  state.offsetY = drag.oy + dy;
  els.canvas.classList.add('dragging');
  draw();
});

els.canvas.addEventListener('pointerup', (event) => {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  els.canvas.classList.remove('dragging');
  try { els.canvas.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
  if (!moved) {
    const rect = els.canvas.getBoundingClientRect();
    state.selectedBox = hitTest(event.clientX - rect.left, event.clientY - rect.top);
    renderAnnotationList();
    draw();
  }
});

els.canvas.addEventListener('pointercancel', () => {
  drag = null;
  els.canvas.classList.remove('dragging');
});

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  switch (event.key) {
    case 'ArrowLeft': case 'a': case 'A': stepImage(-1); break;
    case 'ArrowRight': case 'd': case 'D': stepImage(1); break;
    case '+': case '=': zoomCenter(1.25); break;
    case '-': case '_': zoomCenter(0.8); break;
    case '0': fitView(); break;
    case 'l': case 'L': toggleLabels(); break;
    case 'Escape':
      state.selectedBox = -1;
      renderAnnotationList();
      draw();
      break;
    default: return;
  }
  event.preventDefault();
});

const resizeObserver = new ResizeObserver(() => draw());
resizeObserver.observe($('stage'));

/* ---------------- startup ---------------- */

async function bootstrap() {
  await ensureListeners();
  let startupPath = null;
  try {
    startupPath = await invoke('startup_path');
  } catch { /* older builds */ }
  const lastPath = startupPath || localStorage.getItem('yolo-viewer-last-path');
  if (lastPath) {
    await startScan(lastPath, Boolean(startupPath));
    return;
  }
  renderClassList();
  renderToolbar();
  draw();
}

bootstrap();
