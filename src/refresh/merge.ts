import { BLUR, ComputedStyle, MIX_BLEND_MODE, VISIBILITY } from '../style/define';
import Node from '../node/Node';
import Root from '../node/Root';
import { RefreshLevel } from './level';
import { assignMatrix, multiply, toE } from '../math/matrix';
import { Struct } from './struct';
import { mergeBbox } from '../math/bbox';
import TextureCache, { SubTexture } from './TextureCache';
import config from '../config';
import {
  createTexture,
  drawMbm,
  drawTextureCache,
  // texture2Blob,
} from '../gl/webgl';
import inject from '../util/inject';
import { genGaussBlur, genMotionBlur, genRadialBlur } from './blur';
import { genFrameBufferWithTexture, releaseFrameBuffer } from './fb';
import { checkInRect } from './check';
import { genColorMatrix } from './cm';

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
    const {
      blur,
      opacity,
      mixBlendMode,
      hueRotate,
      saturate,
      brightness,
      contrast,
    } = computedStyle;
    // 非单节点透明需汇总子树，有mask的也需要，已经存在的无需汇总
    const needTotal =
      ((opacity > 0 && opacity < 1)
        || mixBlendMode !== MIX_BLEND_MODE.NORMAL)
      && total > 0
      && !textureTotal?.available;
    const needBlur =
      (
        (blur.t === BLUR.GAUSSIAN && blur.radius >= 1) ||
        (blur.t === BLUR.BACKGROUND &&
          (blur.radius >= 1 || blur.saturation !== 1) && total) ||
        (blur.t === BLUR.RADIAL && blur.radius >= 1) ||
        (blur.t === BLUR.MOTION && blur.radius > 0)
      ) &&
      !textureFilter?.available;
    const needColor = hueRotate || saturate !== 1 || brightness !== 1 || contrast !== 1;
    if (needTotal || needBlur || needColor) {
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
    hueRotate,
    saturate,
    brightness,
    contrast,
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
  else if (blur.t === BLUR.MOTION && blur.radius > 0) {
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
  // 颜色调整
  if (hueRotate || saturate !== 1 || brightness !== 1 || contrast !== 1) {
    const t = genColorMatrix(
      gl,
      root,
      res || source,
      hueRotate,
      saturate,
      brightness,
      contrast,
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
