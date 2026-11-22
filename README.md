# flower-sea

**FLORA FIELD · 指尖花海** — 全屏写实俯拍花海空间手势交互网站。

内置 4 种 90° 俯拍真花延时视频（**牡丹、山茶、洋牡丹、银莲花**）及 Apple Vision 神经透明抠图序列帧（共 216 张 RGBA WebP）。将手掌移动至屏幕任意角落（如右上角），对应区域的花海便会随指尖唤醒绽放，并留下柔和的花浪拖尾与微风花粉。

---

## 本地快速启动（开箱即用）

MediaPipe WASM 运行时、手部关键点模型（`hand_landmarker.task`）以及全部透明花朵纹理均已打包在 `public/` 目录内，拉下仓库即可离线/本地运行，无需额外下载大模型或配置后端。

### 环境要求
- **Node.js 18+**（自带 `npm`）

### 启动命令

```bash
git clone https://github.com/wonderful-1101/flower-sea.git
cd flower-sea
npm install
npm run dev
```

启动后在浏览器打开 **`http://localhost:5174`** 即可开始体验。

### 生产构建与预览

```bash
npm run build
npm run preview
```

`npm run preview` 默认运行在 `http://localhost:4174`，静态产物输出在 `dist/` 目录。

---

## 怎么玩（交互指南）

### 1. 摄像头双手空间交互
1. 点击页面右上角 **「开启手势」**，允许浏览器访问摄像头（全程在浏览器本地运行 MediaPipe 推理，视频流不会上传任何服务器）。
2. **空间唤醒**：将手掌移动到画面任意位置（例如右上角），该区域的花朵会由花心向外呈梯度波浪盛开。
3. **张合叠加（默认开启）**：
   - **张开手掌**：该区域花海加速绽放，影响半径扩大；
   - **握拳**：主动将附近正在盛开的花朵合拢为花苞；
   - **支持双手同时入镜**：两只手可同时在屏幕不同区域形成两个独立的绽放光环。
4. 点击右上角 **「镜头预览」** 可随时展开或收起右下角镜像摄像头与 21 点绿色手部骨架小窗。

### 2. 无摄像头 / 鼠标与触控体验
- 直接用鼠标或手指在屏幕任意位置划过，即可如春风拂过般唤醒局部花海。
- **按住鼠标右键** 或 **按住 `Shift` 键移动鼠标**，可模拟「握拳收拢」效果。

### 3. 调节面板与快捷键
点击右上角 **「调节面板」** 可实时调整花海手感：
- **余韵模式**：
  - **拖尾余韵**（默认）：手移开后花朵保持盛开约 1.5–2.3 秒再错落合拢，挥手留下花浪尾迹；
  - **实时聚光灯**：仅手掌所在光环内盛放，移开即刻平滑收拢；
  - **花海画笔**：手划过的区域保持常开，适合在画布上“画”出整片盛放花海。
- **手势触发**：可在 **「位置 + 张合」**（默认）与 **「纯位置」**（零门槛，移到即开）之间切换。
- **参数滑块**：支持调节 **绽放半径**（`140px–420px`）、**余韵时长**（`0.4×–2.5×`）与 **花海密度**（`36–100 朵`）。
- **快捷操作**：面板底部提供 **全屏盛放 / 合拢花海 / 重新排布**；键盘快捷键支持：
  - `H`：隐藏 / 显示全部界面元素（纯净画廊模式）
  - `Space`：一键全屏盛放
  - `Esc`：一键合拢花海

---

## 怎么让别人来用（部署与分享）

> **重要提示（浏览器安全限制）**：现代浏览器（Chrome / Safari / Edge 等）仅在 `http://localhost` 或 **`https://` 安全域名**下允许调用摄像头（`getUserMedia`）。如果直接通过局域网 HTTP IP 打开，鼠标交互正常可用，但摄像头按钮会被浏览器拦截。

### 推荐方式：一键部署到 Vercel / Netlify / Cloudflare Pages（自动带 HTTPS）
把本项目推送到 GitHub 后，只需 3 步就能生成任何人可直接在电脑或手机上打开的 `https://` 公开链接：

1. 在 **Vercel** / **Netlify** / **Cloudflare Pages** 导入本仓库（`wonderful-1101/flower-sea`）。
2. 保持以下构建配置：
   - **Framework Preset**: `Vite`
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
3. 点击 Deploy，部署完成后把生成的 `https://...` 链接发给朋友，对方点开即玩（无需安装 Node.js 或任何依赖）。

### 局域网临时体验（同一 Wi-Fi 下演示鼠标/触控）
```bash
npm run dev -- --host
```
可将输出的局域网地址（`http://192.168.x.x:5174`）发给同网络设备预览；若需在局域网测试摄像头手势，建议部署到上述免费 HTTPS 托管平台或为本机 Vite 配置本地 HTTPS 证书。

---

## 目录结构

```text
├── index.html                  # 主页面入口与浮层 HUD 结构
├── package.json                # Vite + @mediapipe/tasks-vision 依赖与启动脚本
├── public/
│   ├── species.json            # 花卉元数据配置（物种、帧数、花粉配色、权重）
│   ├── sprites/<species>/      # 4 种花卉各 54 帧 512×512 RGBA WebP 透明序列帧
│   ├── models/                 # MediaPipe hand_landmarker.task 模型文件
│   └── wasm/                   # MediaPipe Vision WASM 运行时文件
├── src/
│   ├── main.js                 # 应用入口、控制抽屉、键鼠输入与 HUD 绑定
│   ├── fieldEngine.js          # 60 FPS 全屏花海渲染与空间绽放/推拂力场引擎
│   ├── fieldLayout.js          # 三层泊松盘（Poisson Disk）全屏分布与四角密度保障
│   ├── gesture.js              # MediaPipe 本地双手空间坐标映射与尺度无关张合识别
│   ├── filters.js              # 1-Euro 自适应低通滤波器（坐标与张合抗抖）
│   ├── spriteStore.js          # 序列帧并行预加载与 ImageBitmap 帧索引查询
│   ├── particles.js            # 盛放花粉光点粒子系统
│   └── styles.css              # 暖米白画廊视觉、毛玻璃抽屉与响应式样式
├── assets/
│   ├── buds/*.png              # 4 张俯拍花苞参考原图
│   ├── videos/*.mp4            # 4 段 1080P Seedance 2.5 俯拍绽放原始视频
│   └── review/*_alpha_sheet.jpg # 棋盘格 / 画廊底色透明抠图质检拼图
└── scripts/
    ├── matte_frames.swift      # 调用 macOS Vision (VNGenerateForegroundInstanceMaskRequest) 抠图
    └── build_field_assets.py   # 抽帧 → 神经抠图 → 补洞/时间稳定/去白边/质心对齐 → WebP 导出
```

---

## 进阶：如何替换自己的花朵素材（macOS 14+）

如果你想把花海换成自己喜欢的花卉，只需把 **固定俯拍机位、纯色背景** 的花开 MP4 视频放进 `assets/videos/`（对应文件名或同步修改 `scripts/build_field_assets.py` 中的 `SPECIES` 列表），然后重新生成透明序列帧即可：

1. 安装 Python 依赖并确认系统已安装 `ffmpeg` 与 Xcode Command Line Tools：
   ```bash
   pip install numpy opencv-python scipy pillow
   ```
2. 编译 Swift 抠图工具：
   ```bash
   swiftc -O scripts/matte_frames.swift -o scripts/matte_frames
   ```
3. 执行全自动透明序列帧构建：
   ```bash
   python3 scripts/build_field_assets.py
   ```
   脚本会自动更新 `public/sprites/`、`public/species.json`，并在 `assets/review/` 输出棋盘格对比质检图。
