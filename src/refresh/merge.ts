import { BLUR, ComputedStyle, MIX_BLEND_MODE, VISIBILITY } from '../style/define';
import Node from '../node/Node';
import Root from '../node/Root';
import { RefreshLevel } from './level';
import { d2r, isConvexPolygonOverlapRect, isRectsOverlap } from '../math/geom';
import { assignMatrix, calRectPoints, multiply, toE } from '../math/matrix';
import { Struct } from './struct';
import { mergeBbox } from '../math/bbox';
import TextureCache, { SubTexture } from './TextureCache';
import config from '../config';
import {
  createTexture,
  drawBox,
  drawDual,
  drawMbm,
  drawMotion,
  drawRadial,
  drawTextureCache,
  // texture2Blob,
} from '../gl/webgl';
import inject from '../util/inject';
import { boxesForGauss, kernelSize, outerSizeByD } from '../math/blur';

export type Merge = {
  i: number;
  lv: number;
  total: number;
  node: Node;
  valid: boolean;
  subList: Merge[]; // 子节点在可视范围外无需merge但父节点在内需要强制子节点merge
  isNew: boolean; // 新生成的merge，老的要么有merge结果，要么可视范围外有tempBbox
  isTop: boolean; // 是否是顶层，当嵌套时子Merge不是顶层，判断范围父子关系有影响
}

export function genMerge(
  gl: WebGL2RenderingContext | WebGLRenderingContext,
  root: Root,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  const { structs, width: W, height: H } = root;
  root.contentLoadingCount = 0; // 归零重新计数
  const mergeList: Merge[] = [];
  const mergeHash: Merge[] = [];
  for (let i = 0, len = structs.length; i < len; i++) {
    const { node, lv, total } = structs[i];
    const { refreshLevel, computedStyle, textureTotal, textureFilter } = node;
    node.refreshLevel = RefreshLevel.NONE;
    // 无任何变化即refreshLevel为NONE（0）忽略
    if (refreshLevel >= RefreshLevel.REPAINT) {
      node.calContent();
    }
    // 加载中的计数
    root.contentLoadingCount += node.calContentLoading();
    const { blur, opacity, mixBlendMode } = computedStyle;
    // 非单节点透明需汇总子树，有mask的也需要，已经存在的无需汇总
    const needTotal =
      ((opacity > 0 && opacity < 1)
        || mixBlendMode !== MIX_BLEND_MODE.NORMAL)
      && total > 0
      && !textureTotal?.available;
    const needBlur =
      ((blur.t === BLUR.GAUSSIAN && blur.radius >= 1) ||
        (blur.t === BLUR.BACKGROUND &&
          (blur.radius >= 1 || blur.saturation !== 1) && total) ||
        (blur.t === BLUR.RADIAL && blur.radius >= 1) ||
        (blur.t === BLUR.MOTION && blur.radius >= 1)) &&
      !textureFilter?.available;
    if (needTotal || needBlur) {
      const t: Merge = {
        i,
        lv,
        total,
        node,
        valid: false,
        subList: [],
        isNew: false,
        isTop: true, // 后续遍历检查时子的置false
      }
      mergeList.push(t);
      mergeHash[i] = t;
    }
    if (textureTotal?.available) {
      i += total;
    }
  }
  // 后根顺序，即叶子节点在前，兄弟的后节点在前
  mergeList.sort(function (a, b) {
    if (a.lv === b.lv) {
      return b.i - a.i;
    }
    return b.lv - a.lv;
  });
  // 先循环求一遍各自merge的bbox汇总，以及是否有嵌套关系
  for (let j = 0, len = mergeList.length; j < len; j++) {
    const item = mergeList[j];
    const { i, total, node } = item;
    // 曾经求过merge汇总但因为可视范围外没展示的，且没有变更过的省略计算，但需要统计嵌套关系
    const isNew = item.isNew = !node.tempBbox;
    node.tempBbox = genBboxTotal(
      structs,
      node,
      i,
      total,
      isNew,
      item,
      mergeHash,
    );
  }
  // 再循环一遍，判断merge是否在可视范围内，这里只看最上层的即可，在范围内则将其及所有子merge打标valid
  for (let j = 0, len = mergeList.length; j < len; j++) {
    const item = mergeList[j];
    const { node, isTop } = item;
    if (isTop) {
      if (checkInRect(node.tempBbox!, node.matrixWorld, x1, y1, x2 - x1, y2 - y1)) {
        // 检查子节点中是否有因为可视范围外暂时忽略的，全部标记valid，这个循环会把数据集中到最上层subList，后面反正不再用了
        setValid(item);
      }
    }
  }
  // 最后一遍循环根据可视范围内valid标记产生真正的merge汇总
  for (let j = 0, len = mergeList.length; j < len; j++) {
    const { i, total, node, valid } = mergeList[j];
    // 过滤可视范围外的，如果新生成的，则要统计可能存在mask影响后续节点数量
    if (!valid) {
      continue;
    }
    // 不可见的，注意蒙版不可见时也生效
    if (shouldIgnore(node.computedStyle)) {
      continue;
    }
    let res: TextureCache | undefined;
    // 尝试生成此节点汇总纹理，无论是什么效果，都是对汇总后的起效，单个节点的绘制等于本身纹理缓存
    if (!node.textureTotal?.available) {
      const t = genTotal(
        gl,
        root,
        node,
        structs,
        i,
        total,
        W,
        H,
      );
      // 这里判断特殊，因为单节点genTotal可能返回了cache自身，同时有tint，不能让cache覆盖了tint
      if (t && !res) {
        node.textureTotal = node.textureTarget = t;
        res = t;
      }
    }
    // 生成filter，这里直接进去，如果没有filter会返回空，group的tint也视作一种filter
    if (node.textureTarget && !node.textureFilter?.available) {
      const t = genFilter(gl, root, node, W, H);
      if (t) {
        node.textureFilter = node.textureTarget = t;
        res = t;
      }
    }
  }
}

export function shouldIgnore(computedStyle: ComputedStyle) {
  return computedStyle.visibility === VISIBILITY.HIDDEN || computedStyle.opacity <= 0;
}

/**
 * 汇总作为局部根节点的bbox，注意作为根节点自身不会包含filter/mask等，但又border所以用bbox，其子节点则是需要考虑的
 * 由于根节点视作E，因此子节点可以直接使用matrix预乘父节点，不会产生transformOrigin偏移
 */
function genBboxTotal(
  structs: Struct[],
  node: Node,
  index: number,
  total: number,
  isNew: boolean,
  merge: Merge,
  mergeHash: Merge[],
) {
  const res = (node.tempBbox || node._bbox || node.bbox).slice(0);
  toE(node.tempMatrix);
  for (let i = index + 1, len = index + total + 1; i < len; i++) {
    const { node: node2, total: total2 } = structs[i];
    const target = node2.textureTarget;
    // 已有省略计算
    if (isNew) {
      const parent = node2.parent!;
      const m = multiply(parent.tempMatrix, node2.matrix);
      assignMatrix(node2.tempMatrix, m);
      // 合并不能用textureCache，因为如果有shadow的话bbox不正确
      const b = (target && target !== node2.textureCache) ?
        target.bbox : (node2._filterBboxInt || node2.filterBboxInt);
      // 防止空
      if (b[2] - b[0] && b[3] - b[1]) {
        mergeBbox(res, b, m);
      }
    }
    // 收集子节点中的嵌套关系，子的不是顶层isTop
    const mg = mergeHash[i];
    if (mg) {
      mg.isTop = false;
      merge.subList.push(mg);
    }
    // 有局部缓存跳过，注意可用
    if (target?.available && target !== node2.textureCache) {
      i += total2;
    }
  }
  return res;
}

type ListRect = Omit<SubTexture, 't'> & {
  x: number;
  y: number;
  t?: WebGLTexture;
  ref?: SubTexture;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

function genTotal(
  gl: WebGL2RenderingContext | WebGLRenderingContext,
  root: Root,
  node: Node,
  structs: Struct[],
  index: number,
  total: number,
  W: number,
  H: number,
  force = false, // Bitmap在mask时强制生成
) {
  // 缓存仍然还在直接返回，无需重新生成
  if (node.textureTotal?.available) {
    // bitmap的total默认都是自己的cache，区分出来
    if (force) {
      if (node.textureTotal !== node.textureCache) {
        return node.textureTotal;
      }
    }
    else {
      return node.textureTotal;
    }
  }
  const bbox = node.tempBbox!;
  node.tempBbox = undefined;
  bbox[0] = Math.floor(bbox[0]);
  bbox[1] = Math.floor(bbox[1]);
  bbox[2] = Math.ceil(bbox[2]);
  bbox[3] = Math.ceil(bbox[3]);
  // 单个叶子节点也不需要，就是本身节点的内容
  if (!total && !force) {
    let target = node.textureCache;
    if (!target?.available && node.hasContent) {
      node.genTexture(gl);
      target = node.textureCache;
    }
    return target;
  }
  const programs = root.programs;
  const program = programs.program;
  // 创建一个空白纹理来绘制，尺寸由于bbox已包含整棵子树内容可以直接使用
  const x = bbox[0],
    y = bbox[1];
  const x2 = x,
    y2 = y;
  const w = Math.ceil(bbox[2] - x),
    h = Math.ceil(bbox[3] - y);
  const w2 = w,
    h2 = h;
  const res = TextureCache.getEmptyInstance(gl, bbox);
  res.available = true;
  const list = res.list;
  let frameBuffer: WebGLFramebuffer | undefined;
  const UNIT = config.maxTextureSize;
  const listRect: ListRect[] = [];
  // 要先按整数创建纹理块，再反向计算bbox（真实尺寸/scale），创建完再重新遍历按节点顺序渲染，因为有bgBlur存在
  for (let i = 0, len = Math.ceil(h2 / UNIT); i < len; i++) {
    for (let j = 0, len2 = Math.ceil(w2 / UNIT); j < len2; j++) {
      const width = j === len2 - 1 ? (w2 - j * UNIT) : UNIT;
      const height = i === len - 1 ? (h2 - i * UNIT) : UNIT;
      const x0 = x + j * UNIT,
        y0 = y + i * UNIT;
      const w0 = width,
        h0 = height;
      const bbox = new Float64Array([
        x0,
        y0,
        x0 + w0,
        y0 + h0,
      ]);
      // 如有设置frame的overflow裁剪
      let xa = -1, ya = -1, xb = 1, yb = 1;
      listRect.push({
        x: x2 + j * UNIT, // 坐标checkInRect用，同时真实渲染时才创建纹理，防止空白区域浪费显存，最后过滤
        y: y2 + i * UNIT,
        w: width,
        h: height,
        bbox,
        x1: xa, y1: ya, x2: xb, y2: yb,
      });
    }
  }
  // 再外循环按节点序，内循环按分块，确保节点序内容先渲染，从而正确生成分块的bgBlur
  for (let i = index, len = index + total + 1; i < len; i++) {
    const { node: node2, total: total2 } = structs[i];
    const computedStyle = node2.computedStyle;
    // 这里和主循环类似，不可见或透明考虑跳过
    if (shouldIgnore(computedStyle)) {
      i += total2;
      continue;
    }
    let opacity: number, matrix: Float64Array;
    // 首个节点即局部根节点
    if (i === index) {
      opacity = node2.tempOpacity = 1;
      toE(node2.tempMatrix);
      matrix = node2.tempMatrix;
    }
    // 子节点的matrix计算比较复杂，可能dx/dy不是0原点，造成transformOrigin偏移需重算matrix
    else {
      const parent = node2.parent!;
      opacity = node2.tempOpacity = computedStyle.opacity * parent.tempOpacity;
      matrix = multiply(parent.tempMatrix, node2.matrix);
    }
    assignMatrix(node2.tempMatrix, matrix);
    let target2 = node2.textureTarget;
    // 可能没生成，存在于一开始在可视范围外的节点情况，且当时也没有进行合成
    if (!target2?.available && node2.hasContent) {
      node2.genTexture(gl);
      target2 = node2.textureTarget;
    }
    if (target2 && target2.available) {
      const { mixBlendMode } = computedStyle;
      const list2 = target2.list;
      // 内循环目标分块
      for (let j = 0, len = listRect.length; j < len; j++) {
        const rect = listRect[j];
        const { x, y, w, h, x1, y1, x2, y2 } = rect;
        let t = rect.t;
        const cx = w * 0.5,
          cy = h * 0.5;
        // 再循环当前target的分块
        for (let k = 0, len = list2.length; k < len; k++) {
          const { bbox: bbox2, t: t2 } = list2[k];
          if (t2 && checkInRect(bbox2, matrix, x, y, w, h)) {
            if (!t) {
              t = rect.t = createTexture(gl, 0, undefined, w, h);
            }
            if (frameBuffer) {
              gl.framebufferTexture2D(
                gl.FRAMEBUFFER,
                gl.COLOR_ATTACHMENT0,
                gl.TEXTURE_2D,
                t,
                0,
              );
              gl.viewport(0, 0, w, h);
            }
            else {
              frameBuffer = genFrameBufferWithTexture(gl, t, w, h);
            }
            let tex: WebGLTexture | undefined;
            // 有mbm先将本节点内容绘制到同尺寸纹理上
            if (mixBlendMode !== MIX_BLEND_MODE.NORMAL && i > index) {
              tex = createTexture(gl, 0, undefined, w, h);
              gl.framebufferTexture2D(
                gl.FRAMEBUFFER,
                gl.COLOR_ATTACHMENT0,
                gl.TEXTURE_2D,
                tex,
                0,
              );
            }
            // 有无mbm都复用这段逻辑
            drawTextureCache(
              gl,
              cx,
              cy,
              program,
              [
                {
                  opacity,
                  matrix,
                  bbox: bbox2,
                  texture: t2,
                },
              ],
              -rect.x,
              -rect.y,
              false,
              i > index ? x1 : -1, // 子节点可能的裁剪，忽略本身
              i > index ? y1 : -1,
              i > index ? x2 : 1,
              i > index ? y2 : 1,
            );
            // 这里才是真正生成mbm
            if (mixBlendMode !== MIX_BLEND_MODE.NORMAL && tex) {
              t = rect.t = genMbm(
                gl,
                t,
                tex,
                mixBlendMode,
                programs,
                w,
                h,
              );
            }
          }
        }
      }
    }
    // 有局部子树缓存可以跳过其所有子孙节点
    if (target2?.available && target2 !== node2.textureCache) {
      i += total2;
    }
  }
  // 删除fbo恢复
  if (frameBuffer) {
    releaseFrameBuffer(gl, frameBuffer, W, H);
  }
  // 赋给结果，这样可能存在的空白区域无纹理
  listRect.forEach(item => {
    list.push({
      bbox: item.bbox,
      w: item.w,
      h: item.h,
      t: item.t!,
    });
  });
  return res;
}

function genFilter(
  gl: WebGL2RenderingContext | WebGLRenderingContext,
  root: Root,
  node: Node,
  W: number,
  H: number,
) {
  // 缓存仍然还在直接返回，无需重新生成
  if (node.textureFilter?.available) {
    return node.textureFilter;
  }
  let res: TextureCache | undefined;
  const {
    blur,
  } = node.computedStyle;
  const source = node.textureTarget!;
  // 高斯模糊
  if (blur.t === BLUR.GAUSSIAN && blur.radius >= 1) {
    const t = genGaussBlur(gl, root, res || source, blur.radius, W, H);
    if (res) {
      res.release();
    }
    res = t;
  }
  // 径向模糊/缩放模糊
  else if (blur.t === BLUR.RADIAL && blur.radius >= 1) {
    const t = genRadialBlur(
      gl,
      root,
      res || source,
      blur.radius,
      blur.center!,
      W,
      H,
    );
    if (res) {
      res.release();
    }
    res = t;
  }
  // 运动模糊/方向模糊
  else if (blur.t === BLUR.MOTION && blur.radius >= 1) {
    const t = genMotionBlur(
      gl,
      root,
      res || source,
      blur.radius,
      blur.angle || 0, // 一定有，0兜底
      W,
      H,
    );
    if (res) {
      res.release();
    }
    res = t;
  }
  return res;
}

/**
 * https://www.w3.org/TR/2018/WD-filter-effects-1-20181218/#feGaussianBlurElement
 * 按照css规范的优化方法执行3次，避免卷积核d扩大3倍性能慢
 * 规范的优化方法对d的值分奇偶优化，这里再次简化，d一定是奇数，即卷积核大小
 * 先动态生成gl程序，根据sigma获得d（一定奇数，省略偶数情况），再计算权重
 * 然后将d尺寸和权重拼接成真正程序并编译成program，再开始绘制
 */
function genGaussBlur(
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
  // const x2 = x * scale,
  //   y2 = y * scale;
  const w2 = w,
    h2 = h;
  const programs = root.programs;
  const program = programs.program;
  const temp = TextureCache.getEmptyInstance(gl, bboxR);
  temp.available = true;
  const listT = temp.list;
  // 由于存在扩展，原本的位置全部偏移，需要重算
  const frameBuffer = drawInSpreadBbox(gl, program, textureTarget, temp, x, y, w2, h2);
  const sigma2 = sigma;
  const dualTimes = getDualTimesFromSigma(sigma2);
  const boxes = boxesForGauss(sigma2 * Math.pow(0.5, dualTimes));
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
      gl.useProgram(program);
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
            program,
            [
              {
                opacity: 1,
                bbox: new Float64Array([
                  bbox2[0],
                  bbox2[1],
                  bbox2[2],
                  bbox2[3],
                ]),
                texture: t2,
              },
            ],
            -bbox[0],
            -bbox[1],
            false,
            -1, -1, 1, 1,
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
    drawInOverlay(gl, program, res, listO, bboxR, spread);
  }
  // 删除fbo恢复
  temp.release();
  gl.useProgram(program);
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
  const programBox = programs.boxProgram;
  const programDualDown = programs.dualDownProgram;
  const programDualUp = programs.dualUpProgram;
  let w1 = w, h1 = h;
  let t2: WebGLTexture | undefined = undefined;
  // const p1 = performance.now();
  if (dualTimes) {
    gl.useProgram(programDualDown);
    t2 = t;
    for (let i = 1; i <= dualTimes; i++) {
      const w2 = Math.ceil(w * Math.pow(0.5, i));
      const h2 = Math.ceil(h * Math.pow(0.5, i));
      gl.viewport(0, 0, w2, h2);
      const temp = t2;
      t2 = drawDual(gl, programDualDown, temp, w1, h1, w2, h2);
      if (temp !== t) {
        gl.deleteTexture(temp);
      }
      w1 = w2;
      h1 = h2;
    }
  }
  // 无论是否缩小都复用box产生模糊
  gl.useProgram(programBox);
  gl.viewport(0, 0, w1, h1);
  let tex = drawBox(gl, programBox, t2 || t, w1, h1, boxes);
  // 可能再放大dualTimes次
  if (dualTimes) {
    gl.useProgram(programDualUp);
    t2 = tex;
    for (let i = dualTimes - 1; i >= 0; i--) {
      const w2 = Math.ceil(w * Math.pow(0.5, i));
      const h2 = Math.ceil(h * Math.pow(0.5, i));
      gl.viewport(0, 0, w2, h2);
      const temp = t2;
      t2 = drawDual(gl, programDualUp, temp, w1, h1, w2, h2);
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

// 因为blur原因，原本内容先绘入一个更大尺寸的fbo中
function drawInSpreadBbox(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  program: WebGLProgram,
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
      const bbox = new Float64Array([
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
        if (t2 && checkInRect(bbox2, undefined, x0, y0, w0, h0)) {
          drawTextureCache(
            gl,
            cx,
            cy,
            program,
            [
              {
                opacity: 1,
                bbox: new Float64Array([
                  bbox2[0],
                  bbox2[1],
                  bbox2[2],
                  bbox2[3],
                ]),
                texture: t2,
              },
            ],
            -x0,
            -y0,
            false,
            -1, -1, 1, 1,
          );
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
    bbox: Float64Array,
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
      const bbox = new Float64Array([x1, y1, x2, y2]);
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
      const bbox = new Float64Array([x1, y1, x2, y2]);
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
  program: WebGLProgram,
  res: TextureCache,
  listO: {
    bbox: Float64Array,
    w: number, h: number,
    x1: number, y1: number, x2: number, y2: number,
    t: WebGLTexture,
  }[],
  bboxR: Float64Array,
  spread: number,
) {
  gl.useProgram(program);
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
          program,
          [
            {
              opacity: 1,
              bbox: new Float64Array([
                bbox3[0],
                bbox3[1],
                bbox3[2],
                bbox3[3],
              ]),
              texture: t2,
              tc: {
                x1: (bbox3[0] === bboxR[0] ? 0 : spread) / w2,
                y1: (bbox3[1] === bboxR[1] ? 0 : spread) / h2,
                x3: (bbox3[2] === bboxR[2] ? w2 : (w2 - spread)) / w2,
                y3: (bbox3[3] === bboxR[3] ? h2 : (h2 - spread)) / h2,
              },
            },
          ],
          -bbox[0],
          -bbox[1],
          false,
          -1, -1, 1, 1,
        );
      }
    }
  }
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  listO.forEach(item => gl.deleteTexture(item.t));
}


function genRadialBlur(
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
  // const x2 = x * scale,
  //   y2 = y * scale;
  const w2 = w,
    h2 = h;
  const programs = root.programs;
  const program = programs.program;
  const temp = TextureCache.getEmptyInstance(gl, bboxR);
  temp.available = true;
  const listT = temp.list;
  // 由于存在扩展，原本的位置全部偏移，需要重算
  const frameBuffer = drawInSpreadBbox(gl, program, textureTarget, temp, x, y, w2, h2);
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
            [
              {
                opacity: 1,
                bbox: new Float64Array([
                  bbox2[0],
                  bbox2[1],
                  bbox2[2],
                  bbox2[3],
                ]),
                texture: t2,
              },
            ],
            -bbox[0],
            -bbox[1],
            false,
            -1, -1, 1, 1,
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
function genMotionBlur(
  gl: WebGL2RenderingContext | WebGLRenderingContext,
  root: Root,
  textureTarget: TextureCache,
  sigma: number,
  angle: number,
  W: number,
  H: number,
) {
  const radian = d2r(angle);
  const spread = sigma * 2;
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
  // const x2 = x * scale,
  //   y2 = y * scale;
  const w2 = w,
    h2 = h;
  const programs = root.programs;
  const program = programs.program;
  const temp = TextureCache.getEmptyInstance(gl, bboxR);
  temp.available = true;
  const listT = temp.list;
  // 由于存在扩展，原本的位置全部偏移，需要重算
  const frameBuffer = drawInSpreadBbox(gl, program, textureTarget, temp, x, y, w2, h2);
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
    const tex = t && drawMotion(gl, programMotion, t, spread, radian, w, h);
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
            [
              {
                opacity: 1,
                bbox: new Float64Array([
                  bbox2[0],
                  bbox2[1],
                  bbox2[2],
                  bbox2[3],
                ]),
                texture: t2,
              },
            ],
            -bbox[0],
            -bbox[1],
            false,
            -1, -1, 1, 1,
          );
          hasDraw = true;
        }
      }
      if (hasDraw) {
        gl.useProgram(programMotion);
        item.t = drawMotion(gl, programMotion, t, spread, radian, w, h);
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

export function genFrameBufferWithTexture(
  gl: WebGL2RenderingContext | WebGLRenderingContext,
  texture: WebGLTexture | undefined,
  width: number,
  height: number,
) {
  const frameBuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer);
  if (texture) {
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
  }
  gl.viewport(0, 0, width, height);
  return frameBuffer;
}

export function releaseFrameBuffer(
  gl: WebGL2RenderingContext | WebGLRenderingContext,
  frameBuffer: WebGLFramebuffer,
  width: number,
  height: number,
) {
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    null,
    0,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(frameBuffer);
  gl.viewport(0, 0, width, height);
}

// 创建一个和画布一样大的纹理，将画布和即将mbm混合的节点作为输入，结果重新赋值给画布
export function genMbm(
  gl: WebGL2RenderingContext | WebGLRenderingContext,
  tex1: WebGLTexture,
  tex2: WebGLTexture,
  mixBlendMode: MIX_BLEND_MODE,
  programs: Record<string, WebGLProgram>,
  w: number,
  h: number,
) {
  // 获取对应的mbm程序
  let program: WebGLProgram;
  if (mixBlendMode === MIX_BLEND_MODE.MULTIPLY) {
    program = programs.multiplyProgram;
  }
  else if (mixBlendMode === MIX_BLEND_MODE.SCREEN) {
    program = programs.screenProgram;
  }
  else if (mixBlendMode === MIX_BLEND_MODE.OVERLAY) {
    program = programs.overlayProgram;
  }
  else if (mixBlendMode === MIX_BLEND_MODE.DARKEN) {
    program = programs.darkenProgram;
  }
  else if (mixBlendMode === MIX_BLEND_MODE.LIGHTEN) {
    program = programs.lightenProgram;
  }
  else if (mixBlendMode === MIX_BLEND_MODE.COLOR_DODGE) {
    program = programs.colorDodgeProgram;
  }
  else if (mixBlendMode === MIX_BLEND_MODE.COLOR_BURN) {
    program = programs.colorBurnProgram;
  }
  else if (mixBlendMode === MIX_BLEND_MODE.HARD_LIGHT) {
    program = programs.hardLightProgram;
  }
  else if (mixBlendMode === MIX_BLEND_MODE.SOFT_LIGHT) {
    program = programs.softLightProgram;
  }
  else if (mixBlendMode === MIX_BLEND_MODE.DIFFERENCE) {
    program = programs.differenceProgram;
  }
  else if (mixBlendMode === MIX_BLEND_MODE.EXCLUSION) {
    program = programs.exclusionProgram;
  }
  else if (mixBlendMode === MIX_BLEND_MODE.HUE) {
    program = programs.hueProgram;
  }
  else if (mixBlendMode === MIX_BLEND_MODE.SATURATION) {
    program = programs.saturationProgram;
  }
  else if (mixBlendMode === MIX_BLEND_MODE.COLOR) {
    program = programs.colorProgram;
  }
  else if (mixBlendMode === MIX_BLEND_MODE.LUMINOSITY) {
    program = programs.luminosityProgram;
  }
  else {
    inject.error('Unknown mixBlendMode: ' + mixBlendMode);
    program = programs.program;
  }
  gl.useProgram(program);
  const res = createTexture(gl, 0, undefined, w, h);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    res,
    0,
  );
  drawMbm(gl, program, tex1, tex2);
  gl.deleteTexture(tex1);
  gl.deleteTexture(tex2);
  gl.useProgram(programs.program);
  return res;
}

export function checkInScreen(
  bbox: Float64Array,
  matrix: Float64Array | undefined,
  width: number,
  height: number,
) {
  return checkInRect(bbox, matrix, 0, 0, width, height);
}

export function checkInRect(
  bbox: Float64Array,
  matrix: Float64Array | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const box = calRectPoints(bbox[0], bbox[1], bbox[2], bbox[3], matrix);
  let { x1, y1, x2, y2, x3, y3, x4, y4 } = box;
  // box是无旋转矩形可以加速，注意可能因为镜像导致坐标顺序颠倒
  if (x1 === x4 && y1 === y2 && x2 === x3 && y3 === y4) {
    if (x1 > x2) {
      [x1, x3] = [x3, x1];
    }
    if (y2 > y3) {
      [y1, y3] = [y3, y1];
    }
    return isRectsOverlap(x, y, x + width, y + height, x1, y1, x3, y3, false);
  }
  return isConvexPolygonOverlapRect(x, y, x + width, y + height, [
    { x: x1, y: y1 },
    { x: x2, y: y2 },
    { x: x3, y: y3 },
    { x: x4, y: y4 },
  ], false);
}

function setValid(merge: Merge) {
  merge.valid = true;
  const subList = merge.subList;
  while (subList.length) {
    const t = subList.pop()!;
    t.valid = true;
    const subList2 = t.subList;
    while (subList2.length) {
      subList.push(subList2.pop()!);
    }
  }
}
