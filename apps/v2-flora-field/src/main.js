/**
 * FLORA FIELD — Main bootstrap connecting SpriteStore, FieldEngine,
 * MediaPipe FieldGestureController, mouse/touch fallback, and frosted HUD controls.
 */

import './styles.css';
import { FieldEngine } from './fieldEngine.js';
import { FieldGestureController } from './gesture.js';
import { SpriteStore } from './spriteStore.js';

const dom = {
  canvas: document.getElementById('field-canvas'),
  loadingOverlay: document.getElementById('loading-overlay'),
  loadingBar: document.getElementById('loading-bar'),
  loadingSub: document.getElementById('loading-sub'),
  hudChrome: document.getElementById('hud-chrome'),
  counterPill: document.getElementById('counter-pill'),
  cameraBtn: document.getElementById('camera-btn'),
  cameraBtnLabel: document.getElementById('camera-btn-label'),
  drawerBtn: document.getElementById('drawer-btn'),
  pipBtn: document.getElementById('pip-btn'),
  hideUiBtn: document.getElementById('hide-ui-btn'),
  drawer: document.getElementById('control-drawer'),
  hoverModeGroup: document.getElementById('hover-mode-group'),
  gestureModeGroup: document.getElementById('gesture-mode-group'),
  radiusRange: document.getElementById('radius-range'),
  radiusVal: document.getElementById('radius-val'),
  lingerRange: document.getElementById('linger-range'),
  lingerVal: document.getElementById('linger-val'),
  densityRange: document.getElementById('density-range'),
  densityVal: document.getElementById('density-val'),
  bloomAllBtn: document.getElementById('bloom-all-btn'),
  closeAllBtn: document.getElementById('close-all-btn'),
  relayoutBtn: document.getElementById('relayout-btn'),
  cameraPip: document.getElementById('camera-pip'),
  webcamVideo: document.getElementById('webcam-video'),
  skeletonCanvas: document.getElementById('skeleton-canvas'),
  hand1Val: document.getElementById('hand1-val'),
  hand1Bar: document.getElementById('hand1-bar'),
  hand2Val: document.getElementById('hand2-val'),
  hand2Bar: document.getElementById('hand2-bar'),
  pipBanner: document.getElementById('pip-banner'),
  pipBannerTitle: document.getElementById('pip-banner-title'),
  pipBannerSub: document.getElementById('pip-banner-sub'),
};

const spriteStore = new SpriteStore();
const engine = new FieldEngine({
  canvas: dom.canvas,
  spriteStore,
  onStats: ({ bloomedCount, totalCount }) => {
    dom.counterPill.textContent = `${bloomedCount} / ${totalCount} 盛放`;
  },
});

const uiState = {
  cameraRunning: false,
  pipVisible: false,
  drawerOpen: false,
  minimalUi: false,
};

let gesture = null;

function setPipBanner(visible, title = '', sub = '') {
  dom.pipBannerTitle.textContent = title;
  dom.pipBannerSub.textContent = sub;
  dom.pipBanner.classList.toggle('is-visible', visible);
}

function updateHandTelemetry(attractors) {
  const h1 = attractors[0];
  const h2 = attractors[1];

  dom.hand1Val.textContent = h1 ? `${Math.round(h1.openness * 100)}%` : '未检测';
  dom.hand1Bar.style.width = h1 ? `${Math.round(h1.openness * 100)}%` : '0%';

  dom.hand2Val.textContent = h2 ? `${Math.round(h2.openness * 100)}%` : '未检测';
  dom.hand2Bar.style.width = h2 ? `${Math.round(h2.openness * 100)}%` : '0%';
}

function setPipVisible(visible) {
  uiState.pipVisible = visible;
  dom.cameraPip.classList.toggle('is-visible', visible);
  dom.pipBtn.classList.toggle('is-active', visible);
  if (visible && !uiState.cameraRunning) {
    setPipBanner(true, '摄像头未开启', '点击「开启手势」启用双手空间感应');
  }
}

async function toggleCamera() {
  if (!gesture) {
    gesture = new FieldGestureController({
      videoEl: dom.webcamVideo,
      overlayCanvas: dom.skeletonCanvas,
      onHandsUpdate: (attractors) => {
        engine.setHandAttractors(attractors);
        updateHandTelemetry(attractors);
      },
      onStatusChange: (status, message) => {
        if (status === 'loading' || status === 'requesting') {
          setPipBanner(true, message, '纯本地 MediaPipe 推理');
        } else if (status === 'active') {
          setPipBanner(false);
        } else if (status === 'idle') {
          setPipBanner(true, '摄像头未开启', '点击「开启手势」启用双手空间感应');
        }
      },
    });
  }

  if (uiState.cameraRunning) {
    gesture.stop();
    uiState.cameraRunning = false;
    dom.cameraBtn.classList.remove('is-running');
    dom.cameraBtnLabel.textContent = '开启手势';
    updateHandTelemetry([]);
    return;
  }

  setPipVisible(true);
  try {
    await gesture.start();
    uiState.cameraRunning = true;
    dom.cameraBtn.classList.add('is-running');
    dom.cameraBtnLabel.textContent = '关闭手势';
  } catch (err) {
    uiState.cameraRunning = false;
    dom.cameraBtn.classList.remove('is-running');
    dom.cameraBtnLabel.textContent = '开启手势';
    setPipBanner(
      true,
      '无法访问摄像头',
      `${err?.message || '权限未开启'} · 可直接用鼠标滑过任意区域唤醒花海`
    );
  }
}

function bindSegmented(containerEl, onSelect) {
  containerEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    for (const child of containerEl.querySelectorAll('.seg-btn')) {
      child.classList.toggle('is-active', child === btn);
    }
    onSelect(btn.dataset.value);
  });
}

function bindEvents() {
  dom.cameraBtn.addEventListener('click', toggleCamera);

  dom.drawerBtn.addEventListener('click', () => {
    uiState.drawerOpen = !uiState.drawerOpen;
    dom.drawer.classList.toggle('is-open', uiState.drawerOpen);
    dom.drawerBtn.classList.toggle('is-active', uiState.drawerOpen);
  });

  dom.pipBtn.addEventListener('click', () => {
    setPipVisible(!uiState.pipVisible);
  });

  dom.hideUiBtn.addEventListener('click', () => {
    uiState.minimalUi = !uiState.minimalUi;
    dom.hudChrome.classList.toggle('is-minimal', uiState.minimalUi);
    dom.hideUiBtn.textContent = uiState.minimalUi ? '显示界面' : '隐藏界面';
    if (uiState.minimalUi) {
      uiState.drawerOpen = false;
      dom.drawer.classList.remove('is-open');
      dom.drawerBtn.classList.remove('is-active');
    }
  });

  bindSegmented(dom.hoverModeGroup, (val) => engine.setHoverMode(val));
  bindSegmented(dom.gestureModeGroup, (val) => engine.setGestureMode(val));

  dom.radiusRange.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.radiusVal.textContent = `${v}px`;
    engine.setRadius(v);
  });

  dom.lingerRange.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.lingerVal.textContent = `${v.toFixed(1)}×`;
    engine.setLingerScale(v);
  });

  dom.densityRange.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.densityVal.textContent = `${v} 朵`;
    engine.setDensity(v);
  });

  dom.bloomAllBtn.addEventListener('click', () => engine.bloomAll());
  dom.closeAllBtn.addEventListener('click', () => engine.closeAll());
  dom.relayoutBtn.addEventListener('click', () => engine.relayout(true));

  // Mouse / Touch pointer fallback on the full-screen flower field canvas.
  const updatePointer = (e) => {
    const isFolding = e.shiftKey || (e.buttons & 2) === 2;
    engine.setPointerAttractor({
      x: e.clientX,
      y: e.clientY,
      openness: isFolding ? 0.0 : 1.0,
    });
  };

  dom.canvas.addEventListener('pointermove', updatePointer);
  dom.canvas.addEventListener('pointerdown', updatePointer);
  dom.canvas.addEventListener('pointerleave', () => engine.setPointerAttractor(null));
  dom.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLElement && e.target.tagName === 'INPUT') return;
    if (e.key === 'h' || e.key === 'H') dom.hideUiBtn.click();
    if (e.key === ' ') {
      e.preventDefault();
      engine.bloomAll();
    }
    if (e.key === 'Escape') engine.closeAll();
  });

  window.addEventListener('resize', () => engine.resize());
}

async function init() {
  bindEvents();
  await spriteStore.loadAll('/species.json', (ratio) => {
    const pct = Math.round(ratio * 100);
    dom.loadingBar.style.width = `${pct}%`;
    dom.loadingSub.textContent = `正在唤醒花海纹理 ${pct}%`;
  });

  engine.resize();
  engine.start();
  dom.loadingOverlay.classList.add('is-hidden');
}

// Deterministic verification hook
window.__floraFieldDebug = {
  setPointer(xNorm, yNorm, openness = 1.0) {
    engine.setPointerAttractor({
      x: xNorm * window.innerWidth,
      y: yNorm * window.innerHeight,
      openness,
    });
  },
  clearPointer() {
    engine.setPointerAttractor(null);
  },
  setMode(mode) {
    engine.setHoverMode(mode);
  },
  bloomAll() {
    engine.bloomAll();
  },
  closeAll() {
    engine.closeAll();
  },
  getState() {
    let bloomed = 0;
    for (const f of engine.flowers) {
      if (f.bloom >= 0.45) bloomed += 1;
    }
    return {
      totalFlowers: engine.flowers.length,
      bloomedFlowers: bloomed,
      hoverMode: engine.hoverMode,
      gestureMode: engine.gestureMode,
      ready: spriteStore.ready,
    };
  },
};

init().catch((err) => {
  console.error(err);
  dom.loadingSub.textContent = `加载失败: ${err.message}`;
});
