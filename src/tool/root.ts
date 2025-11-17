import Root from '../node/Root';
import Node from '../node/Node';
import Container from '../node/Container';
import { pointInRect } from '../math/geom';
import { VISIBILITY } from '../style/define';

function getChildByPoint(parent: Container, x: number, y: number): Node | undefined {
  const children = parent.children;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    const { matrixWorld } = child;
    if (!child.hasContent || child.computedStyle.visibility === VISIBILITY.HIDDEN) {
      continue;
    }
    const rect = child._rect || child.rect;
    const inRect = pointInRect(x, y, rect[0], rect[1], rect[2], rect[3], matrixWorld, true);
    // 在范围内继续递归子节点寻找，找不到返回自己
    if (inRect) {
      if (child instanceof Container) {
        const res = getChildByPoint(child, x, y);
        if (res) {
          return res;
        }
      }
      return child;
    }
    // 范围外也需要遍历子节点，子节点可能超出范围
    else {
      if (child instanceof Container) {
        const res = getChildByPoint(child, x, y);
        if (res) {
          return res;
        }
      }
    }
  }
}

export function getNodeByPoint(root: Root, x: number, y: number, metaKey = false) {
  const res = getChildByPoint(root, x, y);
  if (metaKey) {}
  return res;
}
