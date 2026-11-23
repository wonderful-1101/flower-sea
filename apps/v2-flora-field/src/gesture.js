/**
 * Dual-hand spatial gesture tracker using browser-local MediaPipe HandLandmarker.
 * Maps each hand's mirrored palm center to viewport coordinates (with comfortable edge padding
 * so corners like top-right are effortless to reach) and computes scale-invariant openness.
 */

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { OneEuroFilter, PointOneEuroFilter } from './filters.js';

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

const FINGER_PAIRS = [
  [8, 5],   // index
  [12, 9],  // middle
  [16, 13], // ring
  [20, 17], // pinky
];

function dist2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mapEdgeAware(norm, margin = 0.08) {
  return Math.max(0, Math.min(1, (norm - margin) / (1 - margin * 2)));
}

export class FieldGestureController {
  constructor({
    videoEl,
    overlayCanvas,
    onHandsUpdate,
    onStatusChange,
  }) {
    this.videoEl = videoEl;
    this.overlayCanvas = overlayCanvas;
    this.overlayCtx = overlayCanvas.getContext('2d');
    this.onHandsUpdate = onHandsUpdate;
    this.onStatusChange = onStatusChange;

    this.handLandmarker = null;
    this.stream = null;
    this.running = false;
    this.rafId = null;
    this.lastVideoTime = -1;

    this.handStates = [
      {
        posFilter: new PointOneEuroFilter(1.8, 0.28, 1.0),
        openFilter: new OneEuroFilter(1.4, 0.08, 1.0),
        prevPos: null,
        prevTime: null,
      },
      {
        posFilter: new PointOneEuroFilter(1.8, 0.28, 1.0),
        openFilter: new OneEuroFilter(1.4, 0.08, 1.0),
        prevPos: null,
        prevTime: null,
      },
    ];
  }

  async ensureModel() {
    if (this.handLandmarker) return this.handLandmarker;

    this.onStatusChange?.('loading', '正在加载本地手势识别模型…');
    const vision = await FilesetResolver.forVisionTasks('/wasm');
    const common = {
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.52,
      minHandPresenceConfidence: 0.52,
      minTrackingConfidence: 0.52,
    };

    try {
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate: 'GPU' },
        ...common,
      });
    } catch {
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate: 'CPU' },
        ...common,
      });
    }
    return this.handLandmarker;
  }

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头（getUserMedia）');
    }

    await this.ensureModel();
    this.onStatusChange?.('requesting', '请允许摄像头权限…');

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    this.videoEl.srcObject = this.stream;
    await new Promise((resolve) => {
      if (this.videoEl.readyState >= 2) {
        resolve();
      } else {
        this.videoEl.onloadeddata = () => resolve();
      }
    });
    await this.videoEl.play();

    this.running = true;
    this.lastVideoTime = -1;
    this.handStates.forEach((s) => {
      s.posFilter.reset();
      s.openFilter.reset();
      s.prevPos = null;
      s.prevTime = null;
    });
    this.onStatusChange?.('active', '双手空间追踪已开启');
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.videoEl.srcObject = null;
    this.clearOverlay();
    this.onHandsUpdate?.([]);
    this.onStatusChange?.('idle', '摄像头未开启');
  }

  clearOverlay() {
    this.overlayCtx?.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  }

  syncOverlaySize() {
    const w = this.videoEl.videoWidth || 640;
    const h = this.videoEl.videoHeight || 480;
    if (this.overlayCanvas.width !== w || this.overlayCanvas.height !== h) {
      this.overlayCanvas.width = w;
      this.overlayCanvas.height = h;
    }
  }

  loop = () => {
    if (!this.running) return;

    const now = performance.now();
    const v = this.videoEl;
    if (v.readyState >= 2 && v.videoWidth > 0 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      this.syncOverlaySize();
      const res = this.handLandmarker.detectForVideo(v, now);
      this.processResults(res, now);
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  processResults(results, nowMs) {
    const hands = results?.landmarks || [];
    this.clearOverlay();

    if (hands.length === 0) {
      this.handStates.forEach((s) => {
        s.posFilter.reset();
        s.openFilter.reset();
        s.prevPos = null;
      });
      this.onHandsUpdate?.([]);
      return;
    }

    const attractors = [];
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    hands.slice(0, 2).forEach((lm, idx) => {
      const slot = this.handStates[idx];
      // Mirrored palm centroid so moving right/up in mirror hits top-right screen naturally.
      const palmXRaw = (lm[0].x + lm[5].x + lm[9].x + lm[17].x) / 4;
      const palmYRaw = (lm[0].y + lm[5].y + lm[9].y + lm[17].y) / 4;

      const normX = mapEdgeAware(1 - palmXRaw, 0.08);
      const normY = mapEdgeAware(palmYRaw, 0.08);
      const smoothed = slot.posFilter.filter(normX * vpW, normY * vpH, nowMs);

      // Scale-invariant finger extension ratio ||tip - wrist|| / ||mcp - wrist||.
      const wrist = lm[0];
      let ratioSum = 0;
      for (const [tipIdx, mcpIdx] of FINGER_PAIRS) {
        const mcpDist = Math.max(dist2D(lm[mcpIdx], wrist), 0.03);
        ratioSum += dist2D(lm[tipIdx], wrist) / mcpDist;
      }
      const meanRatio = ratioSum / FINGER_PAIRS.length;
      const rawOpenness = smoothstep(1.05, 1.85, meanRatio);
      const openness = slot.openFilter.filter(rawOpenness, nowMs);

      let vx = 0;
      let vy = 0;
      if (slot.prevPos && slot.prevTime !== null) {
        const dt = Math.max((nowMs - slot.prevTime) / 1000, 1 / 120);
        vx = (smoothed.x - slot.prevPos.x) / dt;
        vy = (smoothed.y - slot.prevPos.y) / dt;
      }
      slot.prevPos = smoothed;
      slot.prevTime = nowMs;

      attractors.push({
        id: idx,
        label: `手 0${idx + 1}`,
        x: smoothed.x,
        y: smoothed.y,
        openness,
        vx,
        vy,
      });

      this.drawSkeleton(lm, idx === 0, palmXRaw, palmYRaw);
    });

    for (let i = hands.length; i < 2; i += 1) {
      this.handStates[i].posFilter.reset();
      this.handStates[i].openFilter.reset();
      this.handStates[i].prevPos = null;
    }

    this.onHandsUpdate?.(attractors);
  }

  drawSkeleton(lm, isPrimary, palmXRaw, palmYRaw) {
    const ctx = this.overlayCtx;
    const w = this.overlayCanvas.width;
    const h = this.overlayCanvas.height;

    const pt = (idx) => ({
      x: (1 - lm[idx].x) * w,
      y: lm[idx].y * h,
    });

    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = isPrimary ? 'rgba(74, 222, 128, 0.92)' : 'rgba(251, 191, 36, 0.88)';
    ctx.lineWidth = Math.max(2, w * 0.0032);
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      const pa = pt(a);
      const pb = pt(b);
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();

    const r = Math.max(2.6, w * 0.0042);
    ctx.fillStyle = '#ECFDF5';
    for (let i = 0; i < lm.length; i += 1) {
      const p = pt(i);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Palm center dot matching mapped spatial attractor.
    ctx.fillStyle = '#F59E0B';
    ctx.beginPath();
    ctx.arc((1 - palmXRaw) * w, palmYRaw * h, r * 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
