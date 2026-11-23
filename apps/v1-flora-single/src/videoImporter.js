/**
 * In-browser MP4/WebM frame extractor for drag-and-drop or file-picker custom flowers.
 */

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 244;
}

function sampleCornerHex(ctx, size) {
  const patch = 24;
  const corners = [
    [0, 0],
    [size - patch, 0],
    [0, size - patch],
    [size - patch, size - patch],
  ];
  const rs = [];
  const gs = [];
  const bs = [];

  for (const [cx, cy] of corners) {
    const data = ctx.getImageData(cx, cy, patch, patch).data;
    for (let i = 0; i < data.length; i += 4) {
      rs.push(data[i]);
      gs.push(data[i + 1]);
      bs.push(data[i + 2]);
    }
  }

  const toHex = (v) => Math.round(median(v)).toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(rs)}${toHex(gs)}${toHex(bs)}`;
}

export async function importVideoAsSpecimen(file, indexNumber, onProgress) {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = objectUrl;

  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('无法解码该视频文件，请确认是标准 MP4 或 WebM'));
    });

    const duration = Math.max(0.2, video.duration || 5);
    const frameCount = 72;
    const canvasSize = 960;
    const canvas = document.createElement('canvas');
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const vw = video.videoWidth || canvasSize;
    const vh = video.videoHeight || canvasSize;
    const scale = Math.min(canvasSize / vw, canvasSize / vh);
    const drawW = vw * scale;
    const drawH = vh * scale;
    const offsetX = (canvasSize - drawW) / 2;
    const offsetY = (canvasSize - drawH) / 2;

    const bitmaps = [];
    let bgHex = '#F4F2EC';

    for (let i = 0; i < frameCount; i += 1) {
      const targetTime = Math.min(duration - 0.02, (i / (frameCount - 1)) * duration);
      video.currentTime = Math.max(0, targetTime);

      await new Promise((resolve) => {
        const handler = () => {
          video.removeEventListener('seeked', handler);
          resolve();
        };
        video.addEventListener('seeked', handler);
      });

      ctx.fillStyle = bgHex;
      ctx.fillRect(0, 0, canvasSize, canvasSize);
      ctx.drawImage(video, offsetX, offsetY, drawW, drawH);

      if (i === 0) {
        bgHex = sampleCornerHex(ctx, canvasSize);
      }

      bitmaps.push(await createImageBitmap(canvas));
      onProgress?.((i + 1) / frameCount);
    }

    const baseName = file.name.replace(/\.[^.]+$/, '').slice(0, 20) || '自定义花朵';
    const id = `custom-${Date.now()}`;
    const indexStr = String(indexNumber).padStart(2, '0');

    return {
      specimen: {
        id,
        index: indexStr,
        zhName: baseName,
        enName: 'Custom Specimen',
        latinName: 'Imported botanical timelapse',
        tagline: '自定义导入 · 本地序列帧',
        frameDir: '',
        frameCount: bitmaps.length,
        videoUrl: '',
        bgColor: bgHex,
        accentColor: '#9D7B6C',
      },
      bitmaps,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
