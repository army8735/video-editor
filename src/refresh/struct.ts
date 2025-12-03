import Node from '../node/Node';
import Root from '../node/Root';
import { checkInScreen, genFrameBufferWithTexture, genMerge, releaseFrameBuffer, shouldIgnore } from './merge';
import { assignMatrix, multiply } from '../math/matrix';
import Container from '../node/Container';
import { drawTextureCache, texture2Blob } from '../gl/webgl';

export type Struct = {
  node: Node;
  num: number;
  total: number;
  lv: number;
};

export function renderWebgl(
  gl: WebGL2RenderingContext | WebGLRenderingContext,
  root: Root,
) {
  const { structs, width: W, height: H } = root;
  genMerge(gl, root, 0, 0, W, H);
  const cx = W * 0.5;
  const cy = H * 0.5;
  const programs = root.programs;
  const program = programs.program;
  gl.useProgram(program);
  for (let i = 0, len = structs.length; i < len; i++) {
    const { node, total } = structs[i];
    // 不可见和透明的跳过
    const computedStyle = node.computedStyle;
    if (shouldIgnore(computedStyle)) {
      for (let j = i + 1; j < i + total; j++) {
        const node = structs[j].node;
        calWorldMatrixAndOpacity(node, j, node.parent);
      }
      i += total;
      continue;
    }
    const { parent } = node;
    calWorldMatrixAndOpacity(node, i, parent);
    // 计算后的世界坐标结果
    const opacity = node._opacity;
    const matrix = node._matrixWorld;
    let target = node.textureTarget;
    let isInScreen = false;
    // 有merge的直接判断是否在可视范围内，合成结果在merge中做了，可能超出范围不合成
    if (target?.available) {
      isInScreen = checkInScreen(target.bbox, matrix, W, H);
    }
    // 无merge的是单个节点，判断是否有内容以及是否在可视范围内，首次渲染或更新后会无target
    else {
      isInScreen = checkInScreen(
        node._filterBbox || node.filterBbox, // 检测用原始的渲染用取整的
        matrix,
        W,
        H,
      );
      if (isInScreen && node.hasContent) {
        node.genTexture(gl);
        target = node.textureTarget;
      }
    }
    // console.log(i, node.name, node.hasContent, target?.available)
    // 屏幕内有内容渲染
    if (isInScreen && target?.available) {
      const list = target.list;
      for (let i = 0, len = list.length; i < len; i++) {
        const { bbox, t, tc } = list[i];
        t && drawTextureCache(gl, cx, cy, program, [{
          opacity,
          matrix,
          bbox,
          texture: t,
          tc,
        }], 0, 0, true);
        texture2Blob(gl, W, H);
      }
    }
    // 有局部子树缓存可以跳过其所有子孙节点
    if (target?.available && target !== node.textureCache) {
      i += total;
    }
  }
}

function calWorldMatrixAndOpacity(node: Node, i: number, parent?: Container) {
  // 世界opacity和matrix不一定需要重算，有可能之前调用算过了有缓存
  let hasCacheOp = false;
  let hasCacheMw = false;
  // 第一个是Root层级0
  if (!i) {
    hasCacheOp = node.hasCacheOp;
    hasCacheMw = node.hasCacheMw;
  }
  else {
    hasCacheOp = node.hasCacheOp && node.parentOpId === parent!.localOpId;
    hasCacheMw = node.hasCacheMw && node.parentMwId === parent!.localMwId;
  }
  // opacity和matrix的世界计算，父子相乘
  if (!hasCacheOp) {
    node._opacity = parent
      ? parent._opacity * node.computedStyle.opacity
      : node.computedStyle.opacity;
    if (parent) {
      node.parentOpId = parent.localOpId;
    }
    node.hasCacheOp = true;
  }
  if (!hasCacheMw) {
    assignMatrix(
      node._matrixWorld,
      parent ? multiply(parent._matrixWorld, node.matrix) : node.matrix,
    );
    if (parent) {
      node.parentMwId = parent.localMwId;
    }
    if (node.hasCacheMw) {
      node.localMwId++;
    }
    node.hasCacheMw = true;
  }
}
