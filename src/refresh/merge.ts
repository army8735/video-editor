import { ComputedStyle, VISIBILITY } from '../style/define';
import Root from '../node/Root';
import { RefreshLevel } from './level';
import { isConvexPolygonOverlapRect, isRectsOverlap } from '../math/geom';
import { calRectPoints } from '../math/matrix';

export type Merge = {
  i: number;
  lv: number;
  total: number;
}

export function genMerge(
  gl: WebGL2RenderingContext | WebGLRenderingContext,
  root: Root,
) {
  const { structs, width: W, height: H } = root;
  for (let i = 0, len = structs.length; i < len; i++) {
    const { node, lv, total } = structs[i];
    const { refreshLevel, computedStyle } = node;
    node.refreshLevel = RefreshLevel.NONE;
    // 无任何变化即refreshLevel为NONE（0）忽略
    if (refreshLevel >= RefreshLevel.REPAINT) {
      node.calContent();
    }
  }
}

export function shouldIgnore(computedStyle: ComputedStyle) {
  return computedStyle.visibility === VISIBILITY.HIDDEN || computedStyle.opacity <= 0;
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
