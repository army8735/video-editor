// prettier-ignore
export enum RefreshLevel {
  NONE =               0b000000000000000000000,
  CACHE =              0b000000000000000000001,
  TRANSLATE_X =        0b000000000000000000010,
  TRANSLATE_Y =        0b000000000000000000100,
  TRANSLATE =          0b000000000000000000110,
  TRANSLATE_Z =        0b000000000000000001000,
  ROTATE_X =           0b000000000000000010000,
  ROTATE_Y =           0b000000000000000100000,
  ROTATE_Z =           0b000000000000001000000,
  SCALE_X =            0b000000000000010000000,
  SCALE_Y =            0b000000000000100000000,
  SCALE =              0b000000000000110000000,
  MATRIX =             0b000000000001000000000,
  TRANSFORM_ORIGIN =   0b000000000010000000000,
  TRANSFORM_ALL =      0b000000000011111111110,
  PERSPECTIVE =        0b000000000100000000000,
  OPACITY =            0b000000001000000000000,
  FILTER =             0b000000010000000000000,
  MIX_BLEND_MODE =     0b000000100000000000000,
  MASK =               0b000001000000000000000,
  BREAK_MASK =         0b000010000000000000000,
  REPAINT =            0b000100000000000000000,
  REFLOW =             0b001000000000000000000,
  REFLOW_REPAINT =     0b001100000000000000000,
  REFLOW_TRANSFORM =   0b001000000011111111110,
  REFLOW_PERSPECTIVE = 0b001000000100000000000,
  REFLOW_OPACITY =     0b001000001000000000000,
  REFLOW_FILTER =      0b001000010000000000000,
  ADD_DOM =            0b010000000000000000000,
  REMOVE_DOM =         0b100000000000000000000,
}

export function isReflow(lv: number) {
  return lv >= RefreshLevel.REFLOW;
}

export function isRepaint(lv: number) {
  return lv < RefreshLevel.REFLOW && lv >= RefreshLevel.REPAINT;
}

export function isReflowKey(k: string) {
  return (
    k === 'width' ||
    k === 'height' ||
    k === 'letterSpacing' ||
    k === 'paragraphSpacing' ||
    k === 'textAlign' ||
    k === 'textVerticalAlign' ||
    k === 'fontFamily' ||
    k === 'fontSize' ||
    k === 'fontWeight' ||
    k === 'fontStyle' ||
    k === 'lineHeight' ||
    k === 'left' ||
    k === 'top' ||
    k === 'right' ||
    k === 'bottom'
  );
}

export function getLevel(k: string) {
  if (k === 'pointerEvents' ||
    k === 'constrainProportions' ||
    k === 'isLocked' ||
    k === 'isSelected' ||
    k === 'resizesContent' ||
    k === 'isRectangle') {
    return RefreshLevel.NONE;
  }
  if (k === 'translateX') {
    return RefreshLevel.TRANSLATE_X;
  }
  if (k === 'translateY') {
    return RefreshLevel.TRANSLATE_Y;
  }
  if (k === 'translateZ') {
    return RefreshLevel.TRANSLATE_Z;
  }
  if (k === 'rotateX') {
    return RefreshLevel.ROTATE_X;
  }
  if (k === 'rotateY') {
    return RefreshLevel.ROTATE_Y;
  }
  if (k === 'rotateZ') {
    return RefreshLevel.ROTATE_Z;
  }
  if (k === 'scaleX') {
    return RefreshLevel.SCALE_X;
  }
  if (k === 'scaleY') {
    return RefreshLevel.SCALE_Y;
  }
  if (k === 'matrix') {
    return RefreshLevel.MATRIX;
  }
  if (k === 'transformOrigin') {
    return RefreshLevel.TRANSFORM_ORIGIN;
  }
  if (k === 'opacity') {
    return RefreshLevel.OPACITY;
  }
  if (k === 'perspective' || k === 'perspectiveOrigin') {
    return RefreshLevel.PERSPECTIVE;
  }
  if (k === 'blur' ||
    k === 'shadow' ||
    k === 'shadowEnable' ||
    k === 'hueRotate' ||
    k === 'saturate' ||
    k === 'brightness' ||
    k === 'contrast') {
    return RefreshLevel.FILTER;
  }
  if (k === 'mixBlendMode') {
    return RefreshLevel.MIX_BLEND_MODE;
  }
  if (k === 'maskMode') {
    return RefreshLevel.MASK;
  }
  if (k === 'breakMask') {
    return RefreshLevel.BREAK_MASK;
  }
  if (isReflowKey(k)) {
    return RefreshLevel.REFLOW;
  }
  return RefreshLevel.REPAINT;
}

export default {
  RefreshLevel,
  isRepaint,
  isReflow,
  isReflowKey,
};
