/**
 * Browser-local MediaPipe HandLandmarker controller.
 * - Hand 0: scale-normalized thumb (#4) to index (#8) pinch distance -> bloom progress [0, 1].
 * - Hand 1 (optional second open palm held ~550ms): cycles to next specimen.
 * - Renders bright green 21-point skeleton + amber pinch measurement line onto HUD canvas.
 */

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

const FINGERTIP_INDICES = [8, 12, 16, 20];

function dist2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export class GestureController {
  constructor({
    videoEl,
    overlayCanvas,
    onPinchSample,
    onSecondaryProgress,
    onSwitchSpecimen,
    onHandPresence,
    onStatusChange,
  }) {
    this.videoEl = videoEl;
    this.overlayCanvas = overlayCanvas;
    this.overlayCtx = overlayCanvas.getContext('2d');
    this.onPinchSample = onPinchSample;
    this.onSecondaryProgress = onSecondaryProgress;
    this.onSwitchSpecimen = onSwitchSpecimen;
    this.onHandPresence = onHandPresence;
    this.onStatusChange = onStatusChange;

    this.handLandmarker = null;
    this.stream = null;
    this.running = false;
    this.rafId = null;
    this.lastVideoTime = -1;

    this.secondaryHoldStart = null;
    this.lastSwitchAt = 0;
    this.holdDurationMs = 550;
    this.cooldownMs = 1500;
  }

  async ensureModel() {
    if (this.handLandmarker) return this.handLandmarker;

    this.onStatusChange?.('loading', '正在加载本地手势模型…');
    const vision = await FilesetResolver.forVisionTasks('/wasm');
    const baseOptions = {
      modelAssetPath: '/models/hand_landmarker.task',
    };
    const commonConfig = {
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
    };

    try {
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { ...baseOptions, delegate: 'GPU' },
        ...commonConfig,
      });
    } catch {
      // Fall back cleanly to CPU delegate if WebGL/GPU delegate is unavailable.
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { ...baseOptions, delegate: 'CPU' },
        ...commonConfig,
      });
    }

    return this.handLandmarker;
  }

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头访问（getUserMedia）');
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
    this.onStatusChange?.('active', '手势追踪已开启');
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    this.videoEl.srcObject = null;
    this.secondaryHoldStart = null;
    this.onSecondaryProgress?.(0, '待机');
    this.onHandPresence?.(false);
    this.clearOverlay();
    this.onStatusChange?.('idle', '摄像头已关闭');
  }

  clearOverlay() {
    if (!this.overlayCtx) return;
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  }

  loop = () => {
    if (!this.running) return;

    const now = performance.now();
    const video = this.videoEl;

    if (video.readyState >= 2 && video.videoWidth > 0 && video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = video.currentTime;
      this.syncOverlayResolution();

      const results = this.handLandmarker.detectForVideo(video, now);
      this.processResults(results, now);
    }

    this.rafId = requestAnimationFrame(this.loop);
  };

  syncOverlayResolution() {
    const w = this.videoEl.videoWidth || 640;
    const h = this.videoEl.videoHeight || 480;
    if (this.overlayCanvas.width !== w || this.overlayCanvas.height !== h) {
      this.overlayCanvas.width = w;
      this.overlayCanvas.height = h;
    }
  }

  processResults(results, nowMs) {
    const hands = results?.landmarks || [];
    this.clearOverlay();

    if (hands.length === 0) {
      this.onHandPresence?.(false);
      this.secondaryHoldStart = null;
      this.onSecondaryProgress?.(0, '待机');
      return;
    }

    this.onHandPresence?.(true);

    // Hand 0 controls bloom progress via scale-normalized thumb-index distance.
    const primary = hands[0];
    const palmScale = Math.max(dist2D(primary[0], primary[9]), 0.05);
    const pinchDist = dist2D(primary[4], primary[8]);
    const ratio = pinchDist / palmScale;
    const normalizedPinch = Math.max(0, Math.min(1, (ratio - 0.22) / (1.15 - 0.22)));
    this.onPinchSample?.(normalizedPinch, nowMs);

    // Draw primary skeleton + amber distance line.
    this.drawHandSkeleton(primary, true);

    // Hand 1 (if present and held open) triggers switching to the next flower specimen.
    if (hands.length >= 2) {
      const secondary = hands[1];
      this.drawHandSkeleton(secondary, false);

      const secPalm = Math.max(dist2D(secondary[0], secondary[9]), 0.05);
      const avgReach =
        FINGERTIP_INDICES.reduce((sum, idx) => sum + dist2D(secondary[0], secondary[idx]), 0) /
        (FINGERTIP_INDICES.length * secPalm);

      const inCooldown = nowMs - this.lastSwitchAt < this.cooldownMs;
      if (inCooldown) {
        this.secondaryHoldStart = null;
        this.onSecondaryProgress?.(0, '已切换');
      } else if (avgReach > 1.45) {
        if (this.secondaryHoldStart === null) {
          this.secondaryHoldStart = nowMs;
        }
        const elapsed = nowMs - this.secondaryHoldStart;
        const ratioHold = Math.min(1, elapsed / this.holdDurationMs);
        this.onSecondaryProgress?.(ratioHold, '切换中…');

        if (elapsed >= this.holdDurationMs) {
          this.lastSwitchAt = nowMs;
          this.secondaryHoldStart = null;
          this.onSecondaryProgress?.(1, '已切换');
          this.onSwitchSpecimen?.();
        }
      } else {
        this.secondaryHoldStart = null;
        this.onSecondaryProgress?.(0, '张开手掌切换');
      }
    } else {
      this.secondaryHoldStart = null;
      const inCooldown = nowMs - this.lastSwitchAt < this.cooldownMs;
      this.onSecondaryProgress?.(0, inCooldown ? '已切换' : '待机');
    }
  }

  drawHandSkeleton(landmarks, isPrimary) {
    const ctx = this.overlayCtx;
    const w = this.overlayCanvas.width;
    const h = this.overlayCanvas.height;

    // Mirror X coordinate to match the CSS-mirrored self-view webcam feed.
    const pt = (idx) => ({
      x: (1 - landmarks[idx].x) * w,
      y: landmarks[idx].y * h,
    });

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 21-point green skeleton lines.
    ctx.strokeStyle = isPrimary ? 'rgba(74, 222, 128, 0.92)' : 'rgba(134, 239, 172, 0.72)';
    ctx.lineWidth = Math.max(2, w * 0.003);
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      const pa = pt(a);
      const pb = pt(b);
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();

    // Joint dots.
    const radius = Math.max(3, w * 0.0045);
    for (let i = 0; i < landmarks.length; i += 1) {
      const p = pt(i);
      const isPinchTip = isPrimary && (i === 4 || i === 8);
      ctx.fillStyle = isPinchTip ? '#F59E0B' : '#DCFCE7';
      ctx.beginPath();
      ctx.arc(p.x, p.y, isPinchTip ? radius * 1.45 : radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Yellow/amber thumb-to-index distance line on primary hand.
    if (isPrimary) {
      const thumb = pt(4);
      const index = pt(8);
      ctx.strokeStyle = '#F59E0B';
      ctx.lineWidth = Math.max(3, w * 0.0045);
      ctx.beginPath();
      ctx.moveTo(thumb.x, thumb.y);
      ctx.lineTo(index.x, index.y);
      ctx.stroke();
    }

    ctx.restore();
  }
}
