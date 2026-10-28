/* live2d.js — Live2D 式参数化网格变形渲染器（零外部模型，纯 WebGL）。
 *
 * 真 Live2D 需要 Cubism .moc3 骨骼模型（手工分层 + 变形器绑定），无法从 AI
 * 平图生成。本模块实现的是 Live2D 的底层核心技术：把一张精灵贴在二维三角
 * 网格上，每帧用连续参数（时间正弦 + 物理惯性）驱动网格顶点形变 —— 这正是
 * Live2D「呼吸/摇摆/惯性/挤压」顺滑的根源，全程 60fps 连续，不跳帧。
 *
 * 网格形变（deformers）：
 *   breathe     呼吸：绕脚底锚点的纵向缩放 + 体积守恒横向补偿
 *   sway        摇摆：横向正弦波，越靠近头部摆幅越大（脚钉住不动）
 *   tilt        倾斜：跟随拖拽/抛物线速度绕脚底旋转（来自物理）
 *   squash      挤压拉伸：落地/起跳的压扁回弹（来自物理）
 *   headFollow  头部跟随鼠标：头部区域顶点朝光标微偏
 *   blink       眨眼：眼部条带顶点纵向压扁，周期性触发
 *
 * 设计原则：init() 失败（无 WebGL）时 this.ok=false，上层退回 <img> 渲染，
 * 保证 app 永远能启动（铁律）。
 */
"use strict";
(function () {
  // 网格精度：角色显示尺寸只有 ~48pt，但翅膀扇动是**局部**形变，网格太粗时
  // 变形会沿整块三角形拉伸（翅膀被撕开）。16x20 让单侧翅膀覆盖 4 列网格，
  // 扇动曲线足够平滑；357 个顶点每帧的计算量可以忽略。
  const GW = 16, GH = 20;           // 网格横向/纵向分段 -> (GW+1)x(GH+1) 顶点
  const NV = (GW + 1) * (GH + 1);

  const VERT = `
    attribute vec2 aPos;   // 形变后的裁剪坐标
    attribute vec2 aUV;
    varying vec2 vUV;
    void main(){ vUV = aUV; gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const FRAG = `
    precision mediump float;
    varying vec2 vUV;
    uniform sampler2D uTex;
    // 纹理已预乘 alpha 上传（见 setFrame），这里直接用，不要再乘一次，否则边缘变暗。
    void main(){ vec4 c = texture2D(uTex, vUV); gl_FragColor = vec4(c.rgb, c.a); }`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error("shader: " + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  class Live2DPet {
    constructor(canvas) {
      this.canvas = canvas;        // 屏幕上显示用的 2D canvas
      this.ctx2d = null;
      this.glCanvas = null;        // 离屏 WebGL canvas（不进 DOM）
      this.ok = false;
      this.gl = null;
      this.texCache = new Map();   // img.src -> texture
      this.curTex = null;
      this.curImg = null;
      // 形变参数（每帧由外部喂入 / 内部推进）
      this.t = 0;
      this.tilt = 0;               // deg
      this.squash = 0;             // 落地压扁量 0..1
      this.vx = 0;                 // 物理速度，用于摇摆激励
      this.headDX = 0; this.headDY = 0;
      this.blink = 0;              // 0..1
      this._nextBlink = 0;
      this._blinkUntil = 0;
      this.energy = 1;             // 状态活跃度系数（idle 低、fly 高）
      this.flap = 0;               // 0..1 翅膀扇动强度（float 时拉满）
      this.align = "left";         // 角色在窗口内的水平对齐：left / center
      // 内部缓冲
      this.baseUV = new Float32Array(NV * 2);
      this.posArr = new Float32Array(NV * 2);
      this.indices = null;
    }

    init() {
      try {
        // 关键架构决策：WebGL 画在**离屏** canvas 上，再把结果 drawImage 到屏幕上
        // 那张 2D canvas。原因：透明置顶窗口（WS_EX_NOREDIRECTIONBITMAP）里的硬件
        // 加速 canvas 会被 Chromium 提升成 DirectComposition 的 overlay 平面，而
        // overlay 做不到与桌面做 alpha 混合 —— 表现为角色身上随机出现块状透明缺口。
        // 2D canvas 走常规合成路径，没有这个问题。
        this.glCanvas = document.createElement("canvas");
        this.ctx2d = this.canvas.getContext("2d", { alpha: true });
        if (!this.ctx2d) return false;

        const gl = this.glCanvas.getContext("webgl", {
          alpha: true, premultipliedAlpha: true,
          // antialias=false：精灵是平图纹理，缩放到 128pt 后 MSAA 没有收益，
          // 却要多一次 resolve blit —— 透明置顶窗上这是纯开销。
          antialias: false,
          preserveDrawingBuffer: true,   // 离屏要留着内容给 drawImage 拷贝
        });
        if (!gl) return false;
        this.gl = gl;
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          throw new Error("link: " + gl.getProgramInfoLog(prog));
        }
        gl.useProgram(prog);
        this.aPos = gl.getAttribLocation(prog, "aPos");
        this.aUV = gl.getAttribLocation(prog, "aUV");
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(0, 0, 0, 0);
        this._buildMesh();
        this.ok = true;
      } catch (e) {
        this.ok = false;
        try { console.warn("[live2d] init failed, fallback to <img>:", e); } catch (_) {}
      }
      return this.ok;
    }

    _buildMesh() {
      // 基准 UV 网格
      let k = 0;
      for (let j = 0; j <= GH; j++) {
        for (let i = 0; i <= GW; i++) {
          this.baseUV[k++] = i / GW;         // u
          this.baseUV[k++] = j / GH;         // v (0=顶,1=底)
        }
      }
      // 三角索引
      const idx = [];
      for (let j = 0; j < GH; j++) {
        for (let i = 0; i < GW; i++) {
          const a = j * (GW + 1) + i, b = a + 1, c = a + GW + 1, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
      this.indices = new Uint16Array(idx);
      const gl = this.gl;
      this.vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, (NV * 4) * 4, gl.DYNAMIC_DRAW); // pos+uv 交错
      this.ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indices, gl.STATIC_DRAW);
    }

    resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(this.canvas.clientWidth * dpr);
      const h = Math.round(this.canvas.clientHeight * dpr);
      if (w <= 0 || h <= 0) return;          // 窗口隐藏时 clientWidth 为 0，跳过
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w; this.canvas.height = h;
      }
      if (this.glCanvas && (this.glCanvas.width !== w || this.glCanvas.height !== h)) {
        this.glCanvas.width = w; this.glCanvas.height = h;
      }
      if (this.gl) this.gl.viewport(0, 0, w, h);
    }

    setFrame(img) {
      if (!this.ok || !img) return;
      this.curImg = img;
      let tex = this.texCache.get(img.src);
      if (!tex) {
        const gl = this.gl;
        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        // 预乘 alpha 上传：mipmap 在预乘空间做平均，透明区的纯黑背景不再渗出成黑边。
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // mipmap：512 的帧要缩到 ~96 物理像素显示（5 倍以上），单级 LINEAR 会产生
        // 明显锯齿和闪烁的摩尔纹。mip 链让缩小时取到预先降采样的层级。
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.generateMipmap(gl.TEXTURE_2D);
        } catch (e) { /* 忽略坏帧 */ }
        this.texCache.set(img.src, tex);
      }
      this.curTex = tex;
    }

    // 由物理层喂入
    feed(opts) {
      if (!opts) return;
      if (typeof opts.tilt === "number") this.tilt = opts.tilt;
      if (typeof opts.squash === "number") this.squash = opts.squash;
      if (typeof opts.vx === "number") this.vx = opts.vx;
      if (typeof opts.energy === "number") this.energy = opts.energy;
      if (typeof opts.flap === "number") this.flap = opts.flap;
      if (typeof opts.headDX === "number") this.headDX = opts.headDX;
      if (typeof opts.headDY === "number") this.headDY = opts.headDY;
    }

    _updateBlink(now) {
      if (now >= this._nextBlink) {
        this._blinkUntil = now + 150;
        this._nextBlink = now + 2200 + Math.random() * 3200;
      }
      if (now < this._blinkUntil) {
        const k = (this._blinkUntil - now) / 150;   // 1 -> 0
        this.blink = Math.sin(k * Math.PI);          // 0->1->0
      } else this.blink = 0;
    }

    render(now) {
      if (!this.ok || !this.curTex || !this.curImg || !this.glCanvas) return;
      const gl = this.gl;
      const W = this.curImg.naturalWidth || this.glCanvas.width;
      const H = this.curImg.naturalHeight || this.glCanvas.height;
      const cw = Math.max(1, this.glCanvas.width), ch = Math.max(1, this.glCanvas.height);
      this.t = now / 1000;
      this._updateBlink(now);

      const cx = W / 2, feetY = H;                 // 脚底锚点
      const e = this.energy;
      const breatheAmp = 0.016 * e;
      const breatheFreq = 2 * Math.PI / 3.2;        // ~3.2s 一次呼吸
      const swayAmp = (2.2 + Math.min(6, Math.abs(this.vx) / 40)) * e;
      const swayFreq = 2 * Math.PI / 2.1;
      const tiltRad = (this.tilt * Math.PI) / 180;
      const cosT = Math.cos(tiltRad), sinT = Math.sin(tiltRad);
      const sq = 1 - this.squash * 0.20;            // 纵向压扁
      const sqx = 1 + this.squash * 0.16;           // 横向补偿
      const blink = this.blink;
      const eb0 = 0.30, eb1 = 0.43, ebMidV = (eb0 + eb1) / 2;
      const eyeY = ebMidV * H;
      // 翅膀扇动：幅度随 flap 增长，频率也随之上调（待机轻扇 → 漂浮快扇）。
      // 漂浮时 1.8Hz，与 float 帧序列的往复周期（4 帧 @10fps 往复 ≈ 1.67Hz）
      // 接近同步，这样"翅膀在扇"和"身体在升"看起来是同一件事。
      // 幅度按精灵坐标（512 基准）给：58px ≈ 精灵高度的 11%，落到 48pt 的桌宠上
      // 约 6 个屏幕像素 —— 之前 26px 只有 2.6px，肉眼几乎看不出翅膀在动，
      // 所以"往上飞"看起来还是整体升降。
      const flapAmp = this.flap * 66;                        // 精灵坐标像素（512 基准）
      const flapFreq = 2 * Math.PI * (0.9 + this.flap * 0.9); // Hz

      const pos = this.posArr, uv = this.baseUV;
      // 宽高比校正 + 水平对齐：精灵按高度 contain，然后贴到窗口左侧。
      // 角色占画布宽度的比例 vw = ch/cw；靠左时把左边界钉在 -1（裁剪空间）。
      const vw = ch / cw;
      const xShift = this.align === "center" ? -vw : -1;
      for (let n = 0, vi = 0; n < NV; n++, vi += 2) {
        const u = uv[vi], v = uv[vi + 1];
        let x = u * W, y = v * H;

        // breathe：绕脚底纵向缩放
        const br = 1 + breatheAmp * Math.sin(this.t * breatheFreq);
        y = feetY - (feetY - y) * br;
        x = cx + (x - cx) * (1 + (br - 1) * 0.6);

        // sway：横向波，越靠头摆越大（脚 v=1 钉住）
        const swayW = Math.pow(1 - v, 1.3);
        x += swayAmp * swayW * Math.sin(this.t * swayFreq + v * 2.2);

        // tilt：绕脚底旋转
        {
          const dx = x - cx, dy = y - feetY;
          x = cx + dx * cosT - dy * sinT;
          y = feetY + dx * sinT + dy * cosT;
        }

        // squash/stretch：绕脚底
        y = feetY - (feetY - y) * sq;
        x = cx + (x - cx) * sqx;

        // head follow：头部顶点朝鼠标偏
        const hw = Math.max(0, 0.46 - v) / 0.46;
        x += this.headDX * hw;
        y += this.headDY * hw;

        // blink：眼部条带纵向压扁
        if (blink > 0.01 && v > eb0 && v < eb1) {
          const k = 1 - blink * 0.85;
          y = eyeY + (y - eyeY) * k;
        }

        // wingFlap：扇动翅膀。范围按素材实测取：翅膀横向在画布 u≈0.11~0.38
        // （镜像同理），纵向 v≈0.45~0.66。以肩部为铰链（sideU=0.34 处不动）、
        // 越靠翼尖摆动越大，同时外缘做一点横向开合 —— 这样看起来是"翅膀在扇"，
        // 而不是整张图在飘。
        if (flapAmp > 0.2) {
          const sideU = u < 0.5 ? u : 1 - u;              // 0=中轴, 越大越靠外
          const wH = (0.34 - sideU) / (0.34 - 0.12);      // 翼根 0 → 翼尖 1
          if (wH > 0) {
            const wV = 1 - Math.abs(v - 0.555) / 0.13;    // 只在翅膀高度带
            if (wV > 0) {
              const w = Math.min(1, wH) * wV;
              const phase = this.t * flapFreq;
              y += flapAmp * w * Math.sin(phase);
              x += flapAmp * 0.35 * w * Math.cos(phase) * (u < 0.5 ? 1 : -1);
            }
          }
        }

        // 转裁剪坐标（含宽高比校正 + 水平对齐）
        pos[vi] = (x / W) * vw * 2 + xShift;
        pos[vi + 1] = 1 - (y / H) * 2;
      }

      // 交错 pos+uv 上传
      const inter = this._inter || (this._inter = new Float32Array(NV * 4));
      for (let n = 0, vi = 0; n < NV; n++, vi += 2) {
        inter[n * 4] = pos[vi]; inter[n * 4 + 1] = pos[vi + 1];
        inter[n * 4 + 2] = uv[vi]; inter[n * 4 + 3] = uv[vi + 1];
      }

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, inter);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(this.aUV);
      gl.vertexAttribPointer(this.aUV, 2, gl.FLOAT, false, 16, 8);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.curTex);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.drawElements(gl.TRIANGLES, this.indices.length, gl.UNSIGNED_SHORT, 0);

      // 把离屏结果拷到屏幕上的 2D canvas（普通合成路径，避免 overlay 的 alpha 缺失）
      this.ctx2d.clearRect(0, 0, cw, ch);
      this.ctx2d.drawImage(this.glCanvas, 0, 0, cw, ch);
    }
  }

  window.Live2DPet = Live2DPet;
})();
