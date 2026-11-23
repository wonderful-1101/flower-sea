/**
 * FLORA — Gesture-controlled botanical bloom web app.
 * Connects FrameStore, BloomStabilizer, MediaPipe GestureController,
 * mouse/wheel fallback, and MP4 drag-and-drop import.
 */

import './styles.css';
import { BloomStabilizer } from './filters.js';
import { FrameStore } from './frameStore.js';
import { GestureController } from './gesture.js';
import { importVideoAsSpecimen } from './videoImporter.js';

const dom = {
  shell: document.getElementById('app-shell'),
  tabs: document.getElementById('specimen-tabs'),
  dots: document.getElementById('specimen-dots'),
  canvasWrap: document.getElementById('flower-canvas-wrap'),
  flowerStage: document.getElementById('flower-stage'),
  canvas: document.getElementById('flower-canvas'),
  preloadBadge: document.getElementById('preload-badge'),
  bloomPct: document.getElementById('bloom-pct'),
  slider: document.getElementById('bloom-slider'),
  specimenZh: document.getElementById('specimen-zh'),
  specimenEn: document.getElementById('specimen-en'),
  specimenTagline: document.getElementById('specimen-tagline'),
  cameraBtn: document.getElementById('camera-btn'),
  cameraBtnLabel: document.getElementById('camera-btn-label'),
  splitBtn: document.getElementById('split-btn'),
  importBtn: document.getElementById('import-btn'),
  fileInput: document.getElementById('video-file-input'),
  cameraHud: document.getElementById('camera-hud'),
  webcamVideo: document.getElementById('webcam-video'),
  skeletonCanvas: document.getElementById('skeleton-canvas'),
  hudPrimaryVal: document.getElementById('hud-primary-val'),
  hudPrimaryBar: document.getElementById('hud-primary-bar'),
  hudSecondaryVal: document.getElementById('hud-secondary-val'),
  hudSecondaryBar: document.getElementById('hud-secondary-bar'),
  hudBanner: document.getElementById('hud-status-banner'),
  hudBannerText: document.getElementById('hud-status-text'),
  hudBannerSub: document.getElementById('hud-status-sub'),
  dropOverlay: document.getElementById('drop-overlay'),
};

const ctx = dom.canvas.getContext('2d');
const store = new FrameStore();
const stabilizer = new BloomStabilizer({ deadzone: 0.015, responsiveness: 11.5 });

const state = {
  activeId: null,
  lastRenderedId: null,
  lastRenderedFrameIdx: -1,
  handActive: false,
  splitMode: false,
  cameraRunning: false,
  dragActive: false,
  dragStartX: 0,
  dragStartProgress: 0,
};

let gesture = null;

function setBanner(visible, text = '', sub = '') {
  dom.hudBannerText.textContent = text;
  dom.hudBannerSub.textContent = sub;
  dom.hudBanner.classList.toggle('is-visible', visible);
}

function updatePrimaryHud(progress01) {
  const pct = Math.round(progress01 * 100);
  dom.bloomPct.textContent = `${pct}%`;
  dom.slider.value = String(pct);
  dom.hudPrimaryVal.textContent = `${pct}%`;
  dom.hudPrimaryBar.style.width = `${pct}%`;
}

function renderSpecimenNav() {
  const specimens = store.getSpecimens();
  dom.tabs.innerHTML = '';
  dom.dots.innerHTML = '';

  specimens.forEach((spec) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `specimen-tab${spec.id === state.activeId ? ' is-active' : ''}`;
    tab.textContent = `${spec.index} ${spec.zhName}`;
    tab.addEventListener('click', () => selectSpecimen(spec.id));
    dom.tabs.appendChild(tab);

    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `specimen-dot${spec.id === state.activeId ? ' is-active' : ''}`;
    dot.title = `${spec.zhName} ${spec.enName}`;
    dot.addEventListener('click', () => selectSpecimen(spec.id));
    dom.dots.appendChild(dot);
  });
}

async function selectSpecimen(id) {
  const spec = store.getSpecimen(id);
  if (!spec) return;

  const isSwitching = state.activeId && state.activeId !== id;
  if (isSwitching) {
    dom.canvasWrap.classList.add('is-switching');
  }

  state.activeId = id;
  state.lastRenderedFrameIdx = -1;

  document.documentElement.style.setProperty('--bg-color', spec.bgColor || '#F4F2EC');
  document.documentElement.style.setProperty('--accent', spec.accentColor || '#C47D88');

  dom.specimenZh.textContent = spec.zhName;
  dom.specimenEn.innerHTML = `${spec.enName} · <em>${spec.latinName}</em>`;
  dom.specimenTagline.textContent = spec.tagline;
  renderSpecimenNav();

  if (!store.isLoaded(id)) {
    dom.preloadBadge.classList.add('is-visible');
    await store.preloadSpecimen(id, (ratio) => {
      if (state.activeId === id) {
        dom.preloadBadge.textContent = `加载标本帧 ${Math.round(ratio * 100)}%`;
      }
    });
    if (state.activeId === id) {
      dom.preloadBadge.classList.remove('is-visible');
    }
  } else {
    dom.preloadBadge.classList.remove('is-visible');
  }

  if (isSwitching) {
    requestAnimationFrame(() => dom.canvasWrap.classList.remove('is-switching'));
  }
}

function cycleSpecimen(delta = 1) {
  const list = store.getSpecimens();
  if (list.length <= 1) return;
  const idx = list.findIndex((s) => s.id === state.activeId);
  const nextIdx = (idx + delta + list.length) % list.length;
  selectSpecimen(list[nextIdx].id);
}

function drawActiveFrame(force = false) {
  const spec = store.getSpecimen(state.activeId);
  if (!spec) return;

  const progress = stabilizer.current;
  const frameCount = Math.max(1, spec.frameCount || 90);
  const frameIdx = Math.min(frameCount - 1, Math.round(progress * (frameCount - 1)));

  if (!force && state.lastRenderedId === spec.id && state.lastRenderedFrameIdx === frameIdx) {
    return;
  }

  const bitmap = store.getFrame(spec.id, progress);
  if (!bitmap) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const targetSize = Math.round(Math.max(480, dom.canvasWrap.clientWidth * dpr));
  if (dom.canvas.width !== targetSize || dom.canvas.height !== targetSize) {
    dom.canvas.width = targetSize;
    dom.canvas.height = targetSize;
  }

  ctx.clearRect(0, 0, dom.canvas.width, dom.canvas.height);
  ctx.drawImage(bitmap, 0, 0, dom.canvas.width, dom.canvas.height);

  state.lastRenderedId = spec.id;
  state.lastRenderedFrameIdx = frameIdx;
}

function setLayoutMode(split) {
  state.splitMode = split;
  dom.shell.classList.toggle('is-split', split);
  dom.splitBtn.classList.toggle('is-active', split);
  dom.splitBtn.textContent = split ? '浮窗视图' : '分屏视图';

  if (split || state.cameraRunning) {
    dom.cameraHud.classList.add('is-visible');
  } else {
    dom.cameraHud.classList.remove('is-visible');
  }
  state.lastRenderedFrameIdx = -1;
}

async function toggleCamera() {
  if (!gesture) {
    gesture = new GestureController({
      videoEl: dom.webcamVideo,
      overlayCanvas: dom.skeletonCanvas,
      onPinchSample: (rawProgress, ts) => {
        stabilizer.pushGestureSample(rawProgress, ts);
      },
      onSecondaryProgress: (ratio, label) => {
        dom.hudSecondaryBar.style.width = `${Math.round(ratio * 100)}%`;
        dom.hudSecondaryVal.textContent = label;
      },
      onSwitchSpecimen: () => cycleSpecimen(1),
      onHandPresence: (present) => {
        state.handActive = present;
      },
      onStatusChange: (status, message) => {
        if (status === 'loading' || status === 'requesting') {
          setBanner(true, message, '本地 MediaPipe 推理，视频流不会离开设备');
        } else if (status === 'active') {
          setBanner(false);
        } else if (status === 'idle' && state.splitMode) {
          setBanner(true, '摄像头未开启', '点击右上角「开启手势」开始追踪，或使用鼠标/滚轮预览');
        }
      },
    });
  }

  if (state.cameraRunning) {
    gesture.stop();
    state.cameraRunning = false;
    dom.cameraBtn.classList.remove('is-running');
    dom.cameraBtnLabel.textContent = '开启手势';
    if (!state.splitMode) {
      dom.cameraHud.classList.remove('is-visible');
    }
    return;
  }

  dom.cameraHud.classList.add('is-visible');
  try {
    await gesture.start();
    state.cameraRunning = true;
    dom.cameraBtn.classList.add('is-running');
    dom.cameraBtnLabel.textContent = '关闭摄像头';
  } catch (err) {
    state.cameraRunning = false;
    dom.cameraBtn.classList.remove('is-running');
    dom.cameraBtnLabel.textContent = '开启手势';
    setBanner(
      true,
      '无法访问摄像头',
      `${err?.message || '权限被拒绝或设备无摄像头'} · 可直接用鼠标拖拽、滚轮或底部滑块控制花开`
    );
  }
}

async function handleVideoImport(file) {
  if (!file || !file.type.startsWith('video/')) return;
  dom.preloadBadge.classList.add('is-visible');
  dom.preloadBadge.textContent = '正在抽取自定义视频帧 0%';

  try {
    const nextIdx = store.getSpecimens().length + 1;
    const { specimen, bitmaps } = await importVideoAsSpecimen(file, nextIdx, (ratio) => {
      dom.preloadBadge.textContent = `正在抽取自定义视频帧 ${Math.round(ratio * 100)}%`;
    });
    store.addCustomSpecimen(specimen, bitmaps);
    await selectSpecimen(specimen.id);
    stabilizer.setImmediate(0);
    updatePrimaryHud(0);
    drawActiveFrame(true);
  } catch (err) {
    alert(err?.message || '视频导入失败');
  } finally {
    dom.preloadBadge.classList.remove('is-visible');
  }
}

function bindInteractions() {
  dom.cameraBtn.addEventListener('click', toggleCamera);
  dom.splitBtn.addEventListener('click', () => {
    setLayoutMode(!state.splitMode);
    if (state.splitMode && !state.cameraRunning) {
      setBanner(true, '摄像头未开启', '点击右上角「开启手势」开始追踪，或使用鼠标/滚轮预览');
    } else if (state.cameraRunning) {
      setBanner(false);
    }
  });

  dom.importBtn.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleVideoImport(file);
    e.target.value = '';
  });

  // Scrubber slider
  dom.slider.addEventListener('input', (e) => {
    const p = Number(e.target.value) / 100;
    stabilizer.setTargetImmediate(p);
  });

  // Mouse drag & wheel on flower stage
  dom.flowerStage.addEventListener('pointerdown', (e) => {
    state.dragActive = true;
    state.dragStartX = e.clientX;
    state.dragStartProgress = stabilizer.target;
    dom.flowerStage.setPointerCapture(e.pointerId);
  });

  dom.flowerStage.addEventListener('pointermove', (e) => {
    if (!state.dragActive) return;
    const delta = (e.clientX - state.dragStartX) / 260;
    stabilizer.setTargetImmediate(state.dragStartProgress + delta);
  });

  const endDrag = () => {
    state.dragActive = false;
  };
  dom.flowerStage.addEventListener('pointerup', endDrag);
  dom.flowerStage.addEventListener('pointercancel', endDrag);

  dom.flowerStage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const delta = (-e.deltaY || e.deltaX) * 0.0014;
      stabilizer.setTargetImmediate(stabilizer.target + delta);
    },
    { passive: false }
  );

  // Keyboard shortcuts (skip when user is adjusting an input such as the bloom slider)
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLElement && e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowRight') cycleSpecimen(1);
    if (e.key === 'ArrowLeft') cycleSpecimen(-1);
    if (e.key >= '1' && e.key <= '9') {
      const target = store.getSpecimens()[Number(e.key) - 1];
      if (target) selectSpecimen(target.id);
    }
  });

  // Drag & drop custom MP4 anywhere on window
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth += 1;
    dom.dropOverlay.classList.add('is-visible');
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dom.dropOverlay.classList.remove('is-visible');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dom.dropOverlay.classList.remove('is-visible');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleVideoImport(file);
  });

  window.addEventListener('resize', () => drawActiveFrame(true));
}

function startRenderLoop() {
  let prevTime = performance.now();

  const tick = (now) => {
    const dt = (now - prevTime) / 1000;
    prevTime = now;

    const progress = stabilizer.step(dt);
    updatePrimaryHud(progress);
    drawActiveFrame(false);

    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
}

async function init() {
  bindInteractions();
  const specimens = await store.loadManifest('/flowers.json');
  if (!specimens.length) return;

  await selectSpecimen(specimens[0].id);
  stabilizer.setImmediate(0);
  updatePrimaryHud(0);
  drawActiveFrame(true);
  startRenderLoop();

  // Warm remaining specimens quietly in background after active flower is ready.
  for (let i = 1; i < specimens.length; i += 1) {
    store.preloadSpecimen(specimens[i].id).catch(() => {});
  }
}

// Verification & debugging hook
window.__floraDebug = {
  setProgress(p) {
    const clamped = stabilizer.setImmediate(p);
    updatePrimaryHud(clamped);
    drawActiveFrame(true);
    return clamped;
  },
  async setFlower(id) {
    await selectSpecimen(id);
    drawActiveFrame(true);
    return state.activeId;
  },
  setSplitMode(split) {
    setLayoutMode(Boolean(split));
    if (split && !state.cameraRunning) {
      setBanner(true, '摄像头未开启', '点击右上角「开启手势」开始追踪，或使用鼠标/滚轮预览');
    }
    drawActiveFrame(true);
  },
  getState() {
    return {
      activeId: state.activeId,
      progress: stabilizer.current,
      target: stabilizer.target,
      splitMode: state.splitMode,
      cameraRunning: state.cameraRunning,
      specimens: store.getSpecimens().map((s) => ({
        id: s.id,
        frameCount: s.frameCount,
        loaded: store.isLoaded(s.id),
      })),
    };
  },
};

init().catch((err) => {
  console.error(err);
  dom.preloadBadge.textContent = `初始化失败: ${err.message}`;
  dom.preloadBadge.classList.add('is-visible');
});
