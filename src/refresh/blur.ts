import Root from '../node/Root';
import { boxesForGauss, kernelSize, outerSizeByD } from '../math/blur';
import TextureCache from './TextureCache';
import config from '../config';
import {
  createTexture,
  drawBox,
  drawDual,
  drawMotion,
  drawRadial,
  drawTextureCache, texture2Blob,
} from '../gl/webgl';
import { genFrameBufferWithTexture, releaseFrameBuffer } from './fb';
import { checkInRect } from './check';
import { d2r } from '../math/geom';
import CacheProgram from '../gl/CacheProgram';

// 因为blur原因，原本内容先绘入一个更大尺寸的fbo中
function drawInSpreadBbox(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  cacheProgram: CacheProgram,
  textureTarget: TextureCache,
  temp: TextureCache,
  x: number, y: number,
  w2: number, h2: number,
) {
  const UNIT = config.maxTextureSize;
  const listS = textureTarget.list;
  const listT = temp.list;
  let frameBuffer: WebGLFramebuffer | undefined;
  for (let i = 0, len = Math.ceil(h2 / UNIT); i < len; i++) {
    for (let j = 0, len2 = Math.ceil(w2 / UNIT); j < len2; j++) {
      const width = j === len2 - 1 ? (w2 - j * UNIT) : UNIT;
      const height = i === len - 1 ? (h2 - i * UNIT) : UNIT;
      const t = createTexture(gl, 0, undefined, width, height);
      const x0 = x + j * UNIT,
        y0 = y + i * UNIT;
      const w0 = width,
        h0 = height;
      const bbox = new Float32Array([
        x0,
        y0,
        x0 + w0,
        y0 + h0,
      ]);
      const area = {
        bbox,
        w: width,
        h: height,
        t,
      };
      listT.push(area);
      if (frameBuffer) {
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          t,
          0,
        );
        gl.viewport(0, 0, width, height);
      }
      else {
        frameBuffer = genFrameBufferWithTexture(gl, t, width, height);
      }
      const cx = width * 0.5,
        cy = height * 0.5;
      for (let i = 0, len = listS.length; i < len; i++) {
        const { bbox: bbox2, t: t2 } = listS[i];
        if (t2 && checkInRect(bbox2, undefined, x0, y0, w0, h0)) { console.log(i)
          drawTextureCache(
            gl,
            cx,
            cy,
            cacheProgram,
            {
              opacity: 1,
              bbox: bbox2,
              t: t2,
              dx: -x0,
              dy: -y0,
            },
          );
          texture2Blob(gl, w0, h0);
        }
      }
    }
  }
  return frameBuffer!;
}

// 因blur原因，生成扩展好的尺寸后，交界处根据spread扩展因子，求出交界处的一块范围重叠区域，重新blur并覆盖交界处
function createInOverlay(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  res: TextureCache,
  x: number,
  y: number,
  w: number,
  h: number,
  spread: number, // 不考虑scale
) {
  const UNIT = config.maxTextureSize;
  const unit = UNIT - spread * 2; // 去除spread的单位
  const listO: {
    bbox: Float32Array,
    w: number, h: number,
    x1: number, y1: number, x2: number, y2: number, // 中间覆盖渲染的部分
    t: WebGLTexture,
  }[] = [];
  const bboxR = res.bbox;
  const w2 = w,
    h2 = h;
  // 左右2个之间的交界处需要重新blur的，宽度是spread*4，中间一半是需要的，上下则UNIT各缩spread到unit
  for (let i = 0, len = Math.ceil(h2 / unit); i < len; i++) {
    for (let j = 1, len2 = Math.ceil(w2 / UNIT); j < len2; j++) {
      let x1 = Math.max(bboxR[0], x + j * UNIT - spread * 2),
        y1 = Math.max(bboxR[1], y + i * unit - spread);
      let x2 = Math.min(bboxR[2], x1 + spread * 4),
        y2 = Math.min(bboxR[3], y1 + unit + spread * 2);
      const bbox = new Float32Array([x1, y1, x2, y2]);
      if (x1 > bboxR[2] - spread * 2) {
        x1 = bbox[0] = Math.max(bboxR[0], bboxR[2] - spread * 2);
        x2 = bbox[2] = bboxR[2];
      }
      if (y1 > bboxR[3] - spread * 2) {
        y1 = bbox[1] = Math.max(bboxR[1], bboxR[3] - spread * 2);
        y2 = bbox[3] = bboxR[3];
      }
      // 边界处假如尺寸不够，要往回（左上）收缩，避免比如最下方很细的长条（高度不足spread）
      const w = (bbox[2] - bbox[0]),
        h = (bbox[3] - bbox[1]);
      listO.push({
        bbox,
        w,
        h,
        t: createTexture(gl, 0, undefined, w, h),
        x1: Math.max(bboxR[0], x1 + spread),
        y1: Math.max(bboxR[1], i ? (y1 + spread) : y1),
        x2: Math.min(bboxR[2], x2 - spread),
        y2: Math.min(bboxR[3], (i === len - 1) ? y2 : (y1 + unit + spread)),
      });
    }
  }
  // 上下2个之间的交界处需要重新blur的，高度是spread*4，中间一半是需要的，左右则UNIT各缩spread到unit
  for (let i = 1, len = Math.ceil(h2 / UNIT); i < len; i++) {
    for (let j = 0, len2 = Math.ceil(w2 / unit); j < len2; j++) {
      let x1 = Math.max(bboxR[0], x + j * unit - spread),
        y1 = Math.max(bboxR[1], y + i * UNIT - spread * 2);
      let x2 = Math.min(bboxR[2], x1 + unit + spread * 2),
        y2 = Math.min(bboxR[3], y1 + spread * 4);
      const bbox = new Float32Array([x1, y1, x2, y2]);
      if (x1 > bboxR[2] - spread * 2) {
        x1 = bbox[0] = Math.max(bboxR[0], bboxR[2] - spread * 2);
        x2 = bbox[2] = bboxR[2];
      }
      if (y1 > bboxR[3] - spread * 2) {
        y1 = bbox[1] = Math.max(bboxR[1], bboxR[3] - spread * 2);
        y2 = bbox[3] = bboxR[3];
      }
      const w = (bbox[2] - bbox[0]),
        h = (bbox[3] - bbox[1]);
      listO.push({
        bbox,
        w,
        h,
        t: createTexture(gl, 0, undefined, w, h),
        x1: Math.max(bboxR[0], j ? (x1 + spread) : x1),
        y1: Math.max(bboxR[1], y1 + spread),
        x2: Math.min(bboxR[2], (j === len2 - 1) ? x2 : (x1 + unit + spread)),
        y2: Math.min(bboxR[3], y2 - spread),
      });
    }
  }
  return listO;
}

// 将交界处单独生成的模糊覆盖掉原本区块模糊的边界
function drawInOverlay(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  cacheProgram: CacheProgram,
  res: TextureCache,
  listO: {
    bbox: Float32Array,
    w: number, h: number,
    x1: number, y1: number, x2: number, y2: number,
    t: WebGLTexture,
  }[],
  bboxR: Float32Array,
  spread: number,
) {
  CacheProgram.useProgram(gl, cacheProgram);
  gl.blendFunc(gl.ONE, gl.ZERO);
  const listR = res.list;
  for (let i = 0, len = listR.length; i < len; i++) {
    const item = listR[i];
    const { bbox, w, h, t } = item;
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      t!,
      0,
    );
    gl.viewport(0, 0, w, h);
    const cx = w * 0.5,
      cy = h * 0.5;
    for (let j = 0, len = listO.length; j < len; j++) {
      const { bbox: bbox2, w: w2, h: h2, t: t2 } = listO[j];
      const bbox3 = bbox2.slice(0);
      // 中间一块儿区域，但是如果是原始图形边界处，不应该取边界
      if (bbox3[0] !== bboxR[0]) {
        bbox3[0] += spread;
      }
      if (bbox3[1] !== bboxR[1]) {
        bbox3[1] += spread;
      }
      if (bbox3[2] !== bboxR[2]) {
        bbox3[2] -= spread;
      }
      if (bbox3[3] !== bboxR[3]) {
        bbox3[3] -= spread;
      }
      const w3 = bbox3[2] - bbox3[0],
        h3 = bbox3[3] - bbox3[1];
      if (checkInRect(bbox, undefined, bbox3[0], bbox3[1], w3, h3)) {
        drawTextureCache(
          gl,
          cx,
          cy,
          cacheProgram,
          {
            opacity: 1,
            bbox: bbox3,
            t: t2,
            tc: {
              x1: (bbox3[0] === bboxR[0] ? 0 : spread) / w2,
              y1: (bbox3[1] === bboxR[1] ? 0 : spread) / h2,
              x3: (bbox3[2] === bboxR[2] ? w2 : (w2 - spread)) / w2,
              y3: (bbox3[3] === bboxR[3] ? h2 : (h2 - spread)) / h2,
            },
            dx: -bbox[0],
            dy: -bbox[1],
          },
        );
      }
    }
  }
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  listO.forEach(item => gl.deleteTexture(item.t));
}

/**
 * https://www.w3.org/TR/2018/WD-filter-effects-1-20181218/#feGaussianBlurElement
 * 按照css规范的优化方法执行3次，避免卷积核d扩大3倍性能慢
 * 规范的优化方法对d的值分奇偶优化，这里再次简化，d一定是奇数，即卷积核大小
 * 先动态生成gl程序，根据sigma获得d（一定奇数，省略偶数情况），再计算权重
 * 然后将d尺寸和权重拼接成真正程序并编译成program，再开始绘制
 */
export function genGaussBlur(
  gl: WebGL2RenderingContext | WebGLRenderingContext,
  root: Root,
  textureTarget: TextureCache,
  sigma: number,
  W: number,
  H: number,
) {
  const d = kernelSize(sigma);
  const spread = outerSizeByD(d);
  const bboxS = textureTarget.bbox;
  const bboxR = bboxS.slice(0);
  bboxR[0] -= spread;
  bboxR[1] -= spread;
  bboxR[2] += spread;
  bboxR[3] += spread;
  // 写到一个扩展好尺寸的tex中方便后续处理
  const x = bboxR[0],
    y = bboxR[1];
  const w = bboxR[2] - bboxR[0],
    h = bboxR[3] - bboxR[1];
  const programs = root.programs;
  const main = programs.main;
  const temp = TextureCache.getEmptyInstance(gl, bboxR);
  temp.available = true;
  const listT = temp.list;
  // 由于存在扩展，原本的位置全部偏移，需要重算
  const frameBuffer = drawInSpreadBbox(gl, main, textureTarget, temp, x, y, w, h);
  // texture2Blob(gl, w, h);
  const dualTimes = getDualTimesFromSigma(sigma);
  const boxes = boxesForGauss(sigma * Math.pow(0.5, dualTimes));
  // 生成模糊，先不考虑多块情况下的边界问题，各个块的边界各自为政
  const res = TextureCache.getEmptyInstance(gl, bboxR);
  res.available = true;
  const listR = res.list;
  for (let i = 0, len = listT.length; i < len; i++) {
    const { bbox, w, h, t } = listT[i];
    listR.push({
      bbox: bbox.slice(0),
      w,
      h,
      t: t && genScaleGaussBlur(gl, root, boxes, dualTimes, t, w, h),
    });
  }
  // texture2Blob(gl, w, h);
  // 如果有超过1个区块，相邻部位需重新提取出来进行模糊替换
  if (listT.length > 1) {
    const listO = createInOverlay(gl, res, x, y, w, h, spread);
    // 遍历这些相邻部分，先绘制原始图像
    for (let i = 0, len = listO.length; i < len; i++) {
      const item = listO[i];
      const { bbox, w, h, t } = item;
      CacheProgram.useProgram(gl, main);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        t,
        0,
      );
      gl.viewport(0, 0, w, h);
      const cx = w * 0.5,
        cy = h * 0.5;
      let hasDraw = false;
      // 用temp而非原始的，因为位图存在缩放，bbox会有误差
      for (let j = 0, len = listT.length; j < len; j++) {
        const { bbox: bbox2, t: t2 } = listT[j];
        const w2 = bbox2[2] - bbox2[0],
          h2 = bbox2[3] - bbox2[1];
        if (t2 && checkInRect(bbox, undefined, bbox2[0], bbox2[1], w2, h2)) {
          drawTextureCache(
            gl,
            cx,
            cy,
            main,
            {
              opacity: 1,
              bbox: new Float32Array([
                bbox2[0],
                bbox2[1],
                bbox2[2],
                bbox2[3],
              ]),
              t: t2,
              dx: -bbox[0],
              dy: -bbox[1],
            },
          );
          hasDraw = true;
        }
      }
      // 一定会有，没有就是计算错了，这里预防下
      if (hasDraw) {
        item.t = genScaleGaussBlur(gl, root, boxes, dualTimes, t, w, h);
        gl.deleteTexture(t);
      }
    }
    // 所有相邻部分回填
    drawInOverlay(gl, main, res, listO, bboxR, spread);
  }
  // 删除fbo恢复
  temp.release();
  CacheProgram.useProgram(gl, main);
  releaseFrameBuffer(gl, frameBuffer!, W, H);
  return res;
}

/**
 * 7*7高斯核则缩放0.5进行，即用dual先缩小一次，再一半的模糊，再dual放大
 * https://www.intel.com/content/www/us/en/developer/articles/technical/an-investigation-of-fast-real-time-gpu-based-image-blur-algorithms.html
 * 由于这里使用的是均值box模糊模拟，核大小和高斯模糊核不一样，最终算出挡4px（无高清缩放）以上核才会需要
 * 17*17内核则缩放0.25，对应16px，规律是4^n，最大4次缩放
 */
function getDualTimesFromSigma(sigma: number) {
  let dualTimes = 0;
  if (sigma >= 256) {
    dualTimes = 4;
  }
  else if (sigma >= 64) {
    dualTimes = 3;
  }
  else if (sigma >= 16) {
    dualTimes = 2;
  }
  else if (sigma >= 4) {
    dualTimes = 1;
  }
  return dualTimes;
}

function genScaleGaussBlur(
  gl: WebGL2RenderingContext | WebGLRenderingContext,
  root: Root,
  boxes: number[],
  dualTimes: number,
  t: WebGLTexture,
  w: number,
  h: number,
) {
  const programs = root.programs;
  const box = programs.box;
  const dualDown = programs.dualDown;
  const dualUp = programs.dualUp;
  let w1 = w, h1 = h;
  let t2: WebGLTexture | undefined = undefined;
  // const p1 = performance.now();
  if (dualTimes) {
    // gl.useProgram(programDualDown);
    CacheProgram.useProgram(gl, dualDown);
    t2 = t;
    for (let i = 1; i <= dualTimes; i++) {
      const w2 = Math.ceil(w * Math.pow(0.5, i));
      const h2 = Math.ceil(h * Math.pow(0.5, i));
      gl.viewport(0, 0, w2, h2);
      const temp = t2;
      t2 = drawDual(gl, dualDown, temp, w1, h1, w2, h2);
      if (temp !== t) {
        gl.deleteTexture(temp);
      }
      w1 = w2;
      h1 = h2;
    }
  }
  // 无论是否缩小都复用box产生模糊
  // gl.useProgram(programBox);
  CacheProgram.useProgram(gl, box);
  gl.viewport(0, 0, w1, h1);
  let tex = drawBox(gl, box, t2 || t, w1, h1, boxes);
  // 可能再放大dualTimes次
  if (dualTimes) {
    // gl.useProgram(programDualUp);
    CacheProgram.useProgram(gl, dualUp);
    t2 = tex;
    for (let i = dualTimes - 1; i >= 0; i--) {
      const w2 = Math.ceil(w * Math.pow(0.5, i));
      const h2 = Math.ceil(h * Math.pow(0.5, i));
      gl.viewport(0, 0, w2, h2);
      const temp = t2;
      t2 = drawDual(gl, dualUp, temp, w1, h1, w2, h2);
      gl.deleteTexture(temp);
      w1 = w2;
      h1 = h2;
    }
    tex = t2;
  }
  gl.viewport(0, 0, w, h);
  // gl.deleteTexture(t);
  gl.useProgram(programs.program);
  // const pixels = new Uint8Array(w * h);
  // gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  // console.log(performance.now() - p1);
  // texture2Blob(gl, w, h);
  return tex;
}

export function genRadialBlur(
  gl: WebGL2RenderingContext | WebGLRenderingContext,
  root: Root,
  textureTarget: TextureCache,
  sigma: number,
  center: [number, number],
  W: number,
  H: number,
) {
  const bboxS = textureTarget.bbox;
  const d = kernelSize(sigma);
  const spread = outerSizeByD(d);
  const bboxR = bboxS.slice(0);
  // 根据center和shader算法得四周扩展，中心点和四边距离是向量长度r，spread*2/diagonal是扩展比例
  const w1 = bboxR[2] - bboxR[0],
    h1 = bboxR[3] - bboxR[1];
  const cx = center[0] * w1,
    cy = center[1] * h1;
  const diagonal = Math.sqrt(w1 * w1 + h1 * h1);
  const ratio = spread * 2 / diagonal;
  const left = Math.ceil(ratio * cx);
  const right = Math.ceil(ratio * (w1 - cx));
  const top = Math.ceil(ratio * cy);
  const bottom = Math.ceil(ratio * (h1 - cy));
  bboxR[0] -= left;
  bboxR[1] -= top;
  bboxR[2] += right;
  bboxR[3] += bottom;
  // 写到一个扩展好尺寸的tex中方便后续处理
  const x = bboxR[0],
    y = bboxR[1];
  const w = bboxR[2] - bboxR[0],
    h = bboxR[3] - bboxR[1];
  const programs = root.programs;
  const program = programs.program;
  const temp = TextureCache.getEmptyInstance(gl, bboxR);
  temp.available = true;
  const listT = temp.list;
  // 由于存在扩展，原本的位置全部偏移，需要重算
  const frameBuffer = drawInSpreadBbox(gl, program, textureTarget, temp, x, y, w, h);
  // 生成模糊，先不考虑多块情况下的边界问题，各个块的边界各自为政
  const programRadial = programs.radialProgram;
  gl.useProgram(programRadial);
  const res = TextureCache.getEmptyInstance(gl, bboxR);
  res.available = true;
  const listR = res.list;
  const cx0 = cx + left,
    cy0 = cy + top;
  for (let i = 0, len = listT.length; i < len; i++) {
    const { bbox, w, h, t } = listT[i];
    gl.viewport(0, 0, w, h);
    const w2 = bbox[2] - bbox[0],
      h2 = bbox[3] - bbox[1];
    const center2 = [
      (cx0 - bbox[0] + bboxR[0]) / w2,
      (cy0 - bbox[1] + bboxR[1]) / h2,
    ] as [number, number];
    const tex = t && drawRadial(gl, programRadial, t, ratio, spread, center2, w, h);
    listR.push({
      bbox: bbox.slice(0),
      w,
      h,
      t: tex,
    });
  }
  // 如果有超过1个区块，相邻部位需重新提取出来进行模糊替换
  if (listT.length > 1) {
    const listO = createInOverlay(gl, res, x, y, w, h, spread);
    for (let i = 0, len = listO.length; i < len; i++) {
      const item = listO[i];
      const { bbox, w, h, t } = item;
      gl.useProgram(program);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        t,
        0,
      );
      gl.viewport(0, 0, w, h);
      const center2 = [
        (cx0 - bbox[0] + bboxR[0]) / (bbox[2] - bbox[0]),
        (cy0 - bbox[1] + bboxR[0]) / (bbox[3] - bbox[1]),
      ] as [number, number];
      const cx = w * 0.5,
        cy = h * 0.5;
      let hasDraw = false;
      // 用temp而非原始的，因为位图存在缩放，bbox会有误差
      for (let j = 0, len = listT.length; j < len; j++) {
        const { bbox: bbox2, t: t2 } = listT[j];
        const w2 = bbox2[2] - bbox2[0],
          h2 = bbox2[3] - bbox2[1];
        if (t2 && checkInRect(bbox, undefined, bbox2[0], bbox2[1], w2, h2)) {
          drawTextureCache(
            gl,
            cx,
            cy,
            program,
            {
              opacity: 1,
              bbox: new Float32Array([
                bbox2[0],
                bbox2[1],
                bbox2[2],
                bbox2[3],
              ]),
              t: t2,
              dx: -bbox[0],
              dy: -bbox[1],
            },
          );
          hasDraw = true;
        }
      }
      if (hasDraw) {
        gl.useProgram(programRadial);
        item.t = drawRadial(gl, programRadial, t, ratio, spread, center2, w, h);
      }
      gl.deleteTexture(t);
    }
    drawInOverlay(gl, program, res, listO, bboxR, spread);
  }
  // 删除fbo恢复
  temp.release();
  gl.useProgram(program);
  releaseFrameBuffer(gl, frameBuffer, W, H);
  return res;
}

/**
 * 原理：https://zhuanlan.zhihu.com/p/125744132
 * 源码借鉴pixi：https://github.com/pixijs/filters
 */
export function genMotionBlur(
  gl: WebGL2RenderingContext | WebGLRenderingContext,
  root: Root,
  textureTarget: TextureCache,
  sigma: number,
  angle: number,
  offset: number,
  W: number,
  H: number,
) {
  const radian = d2r(angle);
  const spread = sigma * 3;
  const kernel = sigma; // 两个方向均分
  const bboxS = textureTarget.bbox;
  const bboxR = bboxS.slice(0);
  // 视频特殊的运动模糊，不超过原本的范围，配合CLAMP_TO_EDGE效果
  // const sin = Math.sin(radian);
  // const cos = Math.cos(radian);
  // const spreadY = Math.abs(Math.ceil(sin * spread));
  // const spreadX = Math.abs(Math.ceil(cos * spread));
  // bboxR[0] -= spreadX;
  // bboxR[1] -= spreadY;
  // bboxR[2] += spreadX;
  // bboxR[3] += spreadY;
  // 写到一个扩展好尺寸的tex中方便后续处理
  const x = bboxR[0],
    y = bboxR[1];
  const w = bboxR[2] - bboxR[0],
    h = bboxR[3] - bboxR[1];
  const programs = root.programs;
  const main = programs.main;
  const temp = TextureCache.getEmptyInstance(gl, bboxR);
  temp.available = true;
  const listT = temp.list;
  // 由于存在扩展，原本的位置全部偏移，需要重算
  const frameBuffer = drawInSpreadBbox(gl, main, textureTarget, temp, x, y, w, h);
  // 迭代运动模糊，先不考虑多块情况下的边界问题，各个块的边界各自为政
  const programMotion = programs.motionProgram;
  gl.useProgram(programMotion);
  const res = TextureCache.getEmptyInstance(gl, bboxR);
  res.available = true;
  const listR = res.list;
  for (let i = 0, len = listT.length; i < len; i++) {
    const { bbox, w, h, t } = listT[i];
    gl.viewport(0, 0, w, h);
    // sigma要么为0不会进入，要么>=1，*2后最小值为2，不会触发glsl中kernel的/0问题
    const tex = t && drawMotion(gl, programMotion, t, kernel, radian, offset, w, h);
    listR.push({
      bbox: bbox.slice(0),
      w,
      h,
      t: tex,
    });
  }
  // 如果有超过1个区块，相邻部位需重新提取出来进行模糊替换
  if (listT.length > 1) {
    const listO = createInOverlay(gl, res, x, y, w, h, spread);
    for (let i = 0, len = listO.length; i < len; i++) {
      const item = listO[i];
      const { bbox, w, h, t } = item;
      CacheProgram.useProgram(gl, main);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        t,
        0,
      );
      gl.viewport(0, 0, w, h);
      const cx = w * 0.5,
        cy = h * 0.5;
      let hasDraw = false;
      // 用temp而非原始的，因为位图存在缩放，bbox会有误差
      for (let j = 0, len = listT.length; j < len; j++) {
        const { bbox: bbox2, t: t2 } = listT[j];
        const w2 = bbox2[2] - bbox2[0],
          h2 = bbox2[3] - bbox2[1];
        if (t2 && checkInRect(bbox, undefined, bbox2[0], bbox2[1], w2, h2)) {
          drawTextureCache(
            gl,
            cx,
            cy,
            main,
            {
              opacity: 1,
              bbox: bbox2,
              t: t2,
              dx: -bbox[0],
              dy: -bbox[1],
            },
          );
          hasDraw = true;
        }
      }
      if (hasDraw) {
        gl.useProgram(programMotion);
        item.t = drawMotion(gl, programMotion, t, kernel, radian, offset, w, h);
      }
      gl.deleteTexture(t);
    }
    drawInOverlay(gl, main, res, listO, bboxR, spread);
  }
  // 删除fbo恢复
  temp.release();
  CacheProgram.useProgram(gl, main);
  releaseFrameBuffer(gl, frameBuffer, W, H);
  return res;
}
