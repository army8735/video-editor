import * as uuid from 'uuid';
import Event from '../util/Event';
import Root from './Root';
import { getDefaultStyle, JStyle, Props } from '../format';
import {
  calNormalLineHeight,
  calSize,
  equalStyle,
  getCssFillStroke,
  getCssMbm,
  getCssObjectFit,
  getCssStrokePosition,
  normalize,
} from '../style/css';
import { ComputedStyle, Style, StyleUnit, VISIBILITY } from '../style/define';
import { Struct } from '../refresh/struct';
import { RefreshLevel } from '../refresh/level';
import {
  assignMatrix,
  calRectPoints,
  identity,
  isE,
  multiply,
  multiplyRotateZ,
  multiplyScaleX,
  multiplyScaleY,
  toE,
} from '../math/matrix';
import Container from './Container';
import { LayoutData } from '../refresh/layout';
import { calMatrixByOrigin, calRotateZ } from '../style/transform';
import { d2r, H } from '../math/geom';
import CanvasCache from '../refresh/CanvasCache';
import TextureCache from '../refresh/TextureCache';
import AbstractAnimation, { Options } from '../animation/AbstractAnimation';
import Animation, { JKeyFrame } from '../animation/Animation';
import { calComputedFill, calComputedStroke } from '../style/compute';
import { clone } from '../util/type';
import { color2rgbaStr } from '../style/color';
import inject from '../util/inject';

let id = 0;

class Node extends Event {
  id: number;
  props: Props;
  uuid: string;
  name?: string;
  root?: Root;
  parent?: Container;
  prev?: Node;
  next?: Node;
  style: Style;
  computedStyle: ComputedStyle;
  struct: Struct;
  isMounted: boolean; // 是否在dom上
  isDestroyed: boolean; // 是否永久被销毁，手动调用
  refreshLevel: RefreshLevel;
  _opacity: number; // 世界透明度
  hasCacheOp: boolean; // 是否计算过世界opacity
  localOpId: number; // 同下面的matrix
  parentOpId: number;
  transform: Float64Array; // 不包含transformOrigin
  matrix: Float64Array; // 包含transformOrigin
  _matrixWorld: Float64Array; // 世界transform
  hasCacheMw: boolean; // 是否计算过世界matrix
  localMwId: number; // 当前计算后的世界matrix的id，每次改变自增
  parentMwId: number; // 父级的id副本，用以对比确认父级是否变动过
  hasContent: boolean; // 是否有内容需要渲染
  canvasCache?: CanvasCache; // 先渲染到2d上作为缓存
  textureCache?: TextureCache; // 从canvasCache生成的纹理缓存
  textureTotal?: TextureCache; // 局部子树缓存
  textureFilter?: TextureCache; // 有filter时的缓存
  textureTarget?: TextureCache; // 指向自身所有缓存中最优先的那个
  _rect?: Float64Array; // 真实内容组成的内容框，group/geom特殊计算
  _bbox?: Float64Array; // 以rect为基础，包含边框包围盒
  _filterBbox?: Float64Array; // 包含filter/阴影内内容外的包围盒
  _bboxInt?: Float64Array; // 扩大取整的bbox，渲染不会糊
  _filterBboxInt?: Float64Array; // 同上
  animationList: AbstractAnimation[]; // 节点上所有的动画列表
  protected contentLoadingNum: number; // 标识当前一共有多少显示资源在加载中

  constructor(props: Props) {
    super();
    this.id = id++;
    this.props = props;
    this.uuid = props.uuid || uuid.v4();
    this.name = props.name;
    this.style = normalize(getDefaultStyle(props.style));
    // @ts-ignore
    this.computedStyle = {};
    this.struct = {
      node: this,
      num: 0,
      total: 0,
      lv: 0,
    };
    this.isMounted = false;
    this.isDestroyed = false;
    this.refreshLevel = RefreshLevel.REFLOW;
    this._opacity = 0;
    this.hasCacheOp = false;
    this.localOpId = 0;
    this.parentOpId = 0;
    this.transform = identity();
    this.matrix = identity();
    this._matrixWorld = identity();
    this.hasCacheMw = false;
    this.localMwId = 0;
    this.parentMwId = 0;
    this.hasContent = false;
    this.animationList = [];
    this.contentLoadingNum = 0;
  }

  didMount() {
    this.isMounted = true;
    const parent = this.parent;
    // 只有Root没有parent
    if (!parent) {
      return;
    }
    this.parentOpId = parent.localOpId;
    this.parentMwId = parent.localMwId;
    const root = (this.root = parent.root);
    const uuid = this.uuid;
    if (root && uuid) {
      root.refs[uuid] = this;
    }
    // 添加dom之前的动画需生效
    this.animationList.forEach(item => {
      this.root!.aniController.addAni(item);
    });
  }

  didUnmount() {
    // 无论是否真实dom，都清空
    this.clearTexCache(true);
    this.isMounted = false;
    const root = this.root;
    const uuid = this.uuid;
    if (root && uuid) {
      delete root.refs[uuid];
    }
    this.animationList.forEach(item => {
      item.cancel();
      root!.aniController.removeAni(item);
    });
    this.prev = this.next = undefined;
    this.parent = this.root = undefined;
  }

  structure(lv: number) {
    const temp = this.struct;
    temp.lv = lv;
    return [temp];
  }

  // 特殊子节点复写如Text、Img自适应尺寸
  protected lay(data: LayoutData) {
    const { style, computedStyle } = this;
    const { left, top, right, bottom, width, height } = style;
    // 检查是否按相对边固定（px/%）还是尺寸固定，如左右vs宽度
    let fixedLeft = false;
    let fixedTop = false;
    let fixedRight = false;
    let fixedBottom = false;
    if (left.u !== StyleUnit.AUTO) {
      fixedLeft = true;
      computedStyle.left = calSize(left, data.w);
    }
    if (right.u !== StyleUnit.AUTO) {
      fixedRight = true;
      computedStyle.right = calSize(right, data.w);
    }
    if (top.u !== StyleUnit.AUTO) {
      fixedTop = true;
      computedStyle.top = calSize(top, data.h);
    }
    if (bottom.u !== StyleUnit.AUTO) {
      fixedBottom = true;
      computedStyle.bottom = calSize(bottom, data.h);
    }
    // 左右决定width
    if (fixedLeft && fixedRight) {
      computedStyle.width = Math.max(0, data.w - computedStyle.left - computedStyle.right);
    }
    else if (fixedLeft) {
      if (width.u !== StyleUnit.AUTO) {
        computedStyle.width = Math.max(0, calSize(width, data.w));
      }
      else {
        computedStyle.width = 0;
      }
      computedStyle.right = data.w - computedStyle.left - computedStyle.width;
    }
    else if (fixedRight) {
      if (width.u !== StyleUnit.AUTO) {
        computedStyle.width = Math.max(0, calSize(width, data.w));
      }
      else {
        computedStyle.width = 0;
      }
      computedStyle.left = data.w - computedStyle.right - computedStyle.width;
    }
    else {
      if (width.u !== StyleUnit.AUTO) {
        computedStyle.width = Math.max(0, calSize(width, data.w));
      }
      else {
        computedStyle.width = 0;
      }
      computedStyle.left = 0;
      computedStyle.right = data.w - computedStyle.width;
    }
    // 上下决定height
    if (fixedTop && fixedBottom) {
      computedStyle.height = Math.max(0, data.h - computedStyle.top - computedStyle.bottom);
    }
    else if (fixedTop) {
      if (height.u !== StyleUnit.AUTO) {
        computedStyle.height = Math.max(0, calSize(height, data.h));
      }
      else {
        computedStyle.height = 0;
      }
      computedStyle.bottom = data.w - computedStyle.top - computedStyle.height;
    }
    else if (fixedBottom) {
      if (height.u !== StyleUnit.AUTO) {
        computedStyle.height = Math.max(0, calSize(height, data.h));
      }
      else {
        computedStyle.height = 0;
      }
      computedStyle.top = data.w - computedStyle.bottom - computedStyle.height;
    }
    else {
      if (height.u !== StyleUnit.AUTO) {
        computedStyle.height = Math.max(0, calSize(height, data.h));
      }
      else {
        computedStyle.height = 0;
      }
      computedStyle.top = 0;
      computedStyle.bottom = data.w - computedStyle.height;
    }
  }

  layout(data: LayoutData) {
    if (this.isDestroyed) {
      throw new Error('Node is destroyed');
    }
    this.refreshLevel = RefreshLevel.REFLOW;
    // 布局时计算所有样式，更新时根据不同级别调用
    this.calReflowStyle();
    this.lay(data);
    // repaint和matrix计算需要x/y/width/height
    this.calRepaintStyle(RefreshLevel.REFLOW);
    this._rect = undefined;
  }

  calReflowStyle() {
    const { style, computedStyle, parent } = this;
    computedStyle.fontFamily = style.fontFamily.v;
    computedStyle.fontSize = style.fontSize.v;
    computedStyle.fontWeight = style.fontWeight.v;
    computedStyle.fontStyle = style.fontStyle.v;
    const lineHeight = style.lineHeight;
    if (lineHeight.u === StyleUnit.AUTO) {
      computedStyle.lineHeight = calNormalLineHeight(computedStyle);
    }
    else {
      computedStyle.lineHeight = lineHeight.v;
    }
    computedStyle.width = computedStyle.height = 0; // 归零方便debug，后续有min值约束
    const width = style.width;
    const height = style.height;
    if (parent) {
      if (width.u !== StyleUnit.AUTO) {
        computedStyle.width = Math.max(0, calSize(width, parent.width));
      }
      if (height.u !== StyleUnit.AUTO) {
        computedStyle.height = Math.max(0, calSize(height, parent.height));
      }
    }
    // 不应该没有parent，Root会自己强制计算要求px，但防止特殊逻辑比如添加自定义矢量fake计算还是兜底
    else {
      if (width.u === StyleUnit.PX) {
        computedStyle.width = Math.max(0, width.v);
      }
      if (height.u === StyleUnit.PX) {
        computedStyle.height = Math.max(0, height.v);
      }
    }
    computedStyle.letterSpacing = style.letterSpacing.v;
    computedStyle.paragraphSpacing = style.paragraphSpacing.v;
    computedStyle.textAlign = style.textAlign.v;
    computedStyle.textVerticalAlign = style.textVerticalAlign.v;
  }

  calRepaintStyle(lv: RefreshLevel) {
    const { style, computedStyle } = this;
    computedStyle.visibility = style.visibility.v;
    computedStyle.textDecoration = style.textDecoration.map(item => item.v);
    computedStyle.textShadow = style.textShadow.v;
    computedStyle.color = style.color.v;
    computedStyle.backgroundColor = style.backgroundColor.v;
    computedStyle.fill = calComputedFill(style.fill);
    computedStyle.fillEnable = style.fillEnable.map((item) => item.v);
    computedStyle.fillOpacity = style.fillOpacity.map((item) => item.v);
    computedStyle.fillMode = style.fillMode.map((item) => item.v);
    computedStyle.fillRule = style.fillRule.v;
    computedStyle.stroke = calComputedStroke(style.stroke);
    computedStyle.strokeEnable = style.strokeEnable.map((item) => item.v);
    computedStyle.strokeWidth = style.strokeWidth.map((item) => item.v);
    computedStyle.strokePosition = style.strokePosition.map((item) => item.v);
    computedStyle.strokeMode = style.strokeMode.map((item) => item.v);
    computedStyle.strokeDasharray = style.strokeDasharray.map((item) => item.v);
    computedStyle.strokeLinecap = style.strokeLinecap.v;
    computedStyle.strokeLinejoin = style.strokeLinejoin.v;
    computedStyle.strokeMiterlimit = style.strokeMiterlimit.v;
    computedStyle.mixBlendMode = style.mixBlendMode.v;
    computedStyle.objectFit = style.objectFit.v;
    computedStyle.borderTopLeftRadius = style.borderTopLeftRadius.v;
    computedStyle.borderTopRightRadius = style.borderTopRightRadius.v;
    computedStyle.borderBottomLeftRadius = style.borderBottomLeftRadius.v;
    computedStyle.borderBottomRightRadius = style.borderBottomRightRadius.v;
    this.clearTexCache(true);
    // 只有重布局或者改transform才影响，普通repaint不变
    if (lv & RefreshLevel.REFLOW_TRANSFORM) {
      this.calMatrix(lv);
    }
    // 同matrix
    if (lv & RefreshLevel.REFLOW_OPACITY) {
      this.calOpacity();
    }
    this._bbox = undefined;
    this._bboxInt = undefined;
    this._filterBbox = undefined;
    this._filterBboxInt = undefined;
  }

  calMatrix(lv: RefreshLevel) {
    const { style, computedStyle, matrix, transform } = this;
    // 每次更新标识且id++，获取matrixWorld或者每帧渲染会置true，首次0时强制进入，虽然布局过程中会调用，防止手动调用不可预期
    if (this.hasCacheMw || !this.localMwId) {
      this.hasCacheMw = false;
      this.localMwId++;
    }
    let optimize = true;
    if (
      lv >= RefreshLevel.REFLOW ||
      lv & RefreshLevel.TRANSFORM ||
      (lv & RefreshLevel.SCALE_X && !computedStyle.scaleX) ||
      (lv & RefreshLevel.SCALE_Y && !computedStyle.scaleY)
    ) {
      optimize = false;
    }
    // 优化计算scale不能为0，无法计算倍数差
    if (optimize) {
      if (lv & RefreshLevel.TRANSLATE_X) {
        const v = calSize(style.translateX, this.computedStyle.width);
        const diff = v - computedStyle.translateX;
        computedStyle.translateX = v;
        transform[12] += diff;
        matrix[12] += diff;
      }
      if (lv & RefreshLevel.TRANSLATE_Y) {
        const v = calSize(style.translateY, this.computedStyle.height);
        const diff = v - computedStyle.translateY;
        computedStyle.translateY = v;
        transform[13] += diff;
        matrix[13] += diff;
      }
      if (lv & RefreshLevel.ROTATE_Z) {
        const v = style.rotateZ.v;
        computedStyle.rotateZ = v;
        const r = d2r(v);
        const sin = Math.sin(r),
          cos = Math.cos(r);
        const x = computedStyle.scaleX,
          y = computedStyle.scaleY;
        matrix[0] = transform[0] = cos * x;
        matrix[1] = transform[1] = sin * y;
        matrix[4] = transform[4] = -sin * x;
        matrix[5] = transform[5] = cos * y;
        const t = computedStyle.transformOrigin,
          ox = t[0],
          oy = t[1];
        matrix[12] = transform[12] + ox - transform[0] * ox - oy * transform[4];
        matrix[13] = transform[13] + oy - transform[1] * ox - oy * transform[5];
      }
      if (lv & RefreshLevel.SCALE) {
        if (lv & RefreshLevel.SCALE_X) {
          const v = style.scaleX.v;
          const x = v / computedStyle.scaleX;
          computedStyle.scaleX = v;
          transform[0] *= x;
          transform[4] *= x;
          matrix[0] *= x;
          matrix[4] *= x;
        }
        if (lv & RefreshLevel.SCALE_Y) {
          const v = style.scaleY.v;
          const y = v / computedStyle.scaleY;
          computedStyle.scaleY = v;
          transform[1] *= y;
          transform[5] *= y;
          matrix[1] *= y;
          matrix[5] *= y;
        }
        const t = computedStyle.transformOrigin,
          ox = t[0],
          oy = t[1];
        matrix[12] = transform[12] + ox - transform[0] * ox - transform[4] * oy;
        matrix[13] = transform[13] + oy - transform[1] * ox - transform[5] * oy;
        matrix[14] = transform[14] - transform[2] * ox - transform[6] * oy;
      }
    }
    else {
      toE(transform);
      const tfo = style.transformOrigin.map((item, i) => {
        return calSize(item, i ? this.computedStyle.height : this.computedStyle.width);
      });
      computedStyle.transformOrigin = tfo as [number, number];
      // 一般走这里，特殊将left/top和translate合并一起加到matrix上，这样渲染视为[0, 0]开始
      computedStyle.translateX = calSize(style.translateX, this.computedStyle.width);
      transform[12] = computedStyle.left + computedStyle.translateX;
      computedStyle.translateY = calSize(style.translateY, this.computedStyle.height);
      transform[13] = computedStyle.top + computedStyle.translateY;
      const rotateZ = style.rotateZ ? style.rotateZ.v : 0;
      const scaleX = style.scaleX ? style.scaleX.v : 1;
      const scaleY = style.scaleY ? style.scaleY.v : 1;
      computedStyle.rotateZ = rotateZ;
      computedStyle.scaleX = scaleX;
      computedStyle.scaleY = scaleY;
      if (isE(transform) && rotateZ) {
        calRotateZ(transform, rotateZ);
      }
      else if (rotateZ) {
        multiplyRotateZ(transform, d2r(rotateZ));
      }
      if (scaleX !== 1) {
        if (isE(transform)) {
          transform[0] = scaleX;
        }
        else {
          multiplyScaleX(transform, scaleX);
        }
      }
      if (scaleY !== 1) {
        if (isE(transform)) {
          transform[5] = scaleY;
        }
        else {
          multiplyScaleY(transform, scaleY);
        }
      }
      const t = calMatrixByOrigin(transform, tfo[0], tfo[1]);
      assignMatrix(matrix, t);
    }
  }

  calOpacity() {
    const { style, computedStyle } = this;
    if (this.hasCacheOp || !this.localOpId) {
      this.hasCacheOp = false;
      this.localOpId++;
    }
    computedStyle.opacity = style.opacity.v;
  }

  // 是否有内容，由各个子类自己实现
  calContent() {
    return (this.hasContent = false);
  }

  calContentLoading() {
    const computedStyle = this.computedStyle;
    if (computedStyle.opacity <= 0
      || computedStyle.visibility === VISIBILITY.HIDDEN
      || !computedStyle.width || !computedStyle.height) {
      return 0;
    }
    return this.contentLoadingNum;
  }

  renderCanvas() {
    const canvasCache = this.canvasCache;
    if (canvasCache && canvasCache.available) {
      canvasCache.release();
    }
  }

  genTexture(gl: WebGL2RenderingContext | WebGLRenderingContext) {
    this.renderCanvas();
    this.textureCache?.release();
    const canvasCache = this.canvasCache;
    if (canvasCache?.available) {
      this.textureTarget = this.textureCache = new TextureCache(gl, this._bboxInt || this.bboxInt, canvasCache);
      canvasCache.release();
    }
    else {
      this.textureTarget = this.textureCache = undefined;
    }
  }

  resetTextureTarget() {
    const { textureCache, textureTotal, textureFilter } = this;
    if (textureFilter?.available) {
      this.textureTarget = textureFilter;
    }
    if (textureTotal?.available) {
      this.textureTarget = textureTotal;
    }
    if (textureCache?.available) {
      this.textureTarget = textureCache;
    }
  }

  updateStyle(style: Partial<JStyle>, cb?: (sync: boolean) => void) {
    const formatStyle = normalize(style);
    return this.updateFormatStyle(formatStyle, cb);
  }

  updateFormatStyle(style: Partial<Style>, cb?: ((sync: boolean) => void)) {
    const keys = this.updateFormatStyleData(style);
    // 无变更
    if (!keys.length) {
      cb && cb(true);
    }
    return this.root?.addUpdate(this, keys, undefined, cb);
  }

  updateFormatStyleData(style: Partial<Style>) {
    const keys: string[] = [];
    for (let k in style) {
      if (style.hasOwnProperty(k)) {
        const v = style[k as keyof Style];
        if (!equalStyle(style, this.style, k)) {
          // @ts-ignore
          this.style[k] = v;
          keys.push(k);
        }
      }
    }
    return keys;
  }

  clearTexCache(includeSelf = false) {
    if (includeSelf) {
      this.textureCache?.release();
    }
    this.textureTotal?.release();
    this.textureFilter?.release();
  }

  clearTexCacheUpward(includeSelf = false) {
    let parent = this.parent;
    while (parent) {
      parent.clearTexCache(includeSelf);
      parent = parent.parent;
    }
  }

  refresh(lv: RefreshLevel = RefreshLevel.REPAINT, cb?: ((sync: boolean) => void)) {
    this.root?.addUpdate(this, [], lv, cb);
  }

  getBackgroundCoords(x = 0, y = 0) {
    const computedStyle = this.computedStyle;
    const { borderTopLeftRadius, borderTopRightRadius, borderBottomLeftRadius, borderBottomRightRadius } = computedStyle;
    // 限制圆角半径，不能超过宽高一半
    const min = Math.min(computedStyle.width * 0.5, computedStyle.height * 0.5);
    const tl = Math.min(min, borderTopLeftRadius);
    const tr = Math.min(min, borderTopRightRadius);
    const bl = Math.min(min, borderBottomLeftRadius);
    const br = Math.min(min, borderBottomRightRadius);
    let coords: number[][];
    if (tl === 0 && tr === 0 && bl === 0 && br === 0) {
      coords = [
        [x, y],
        [computedStyle.width, y],
        [computedStyle.width, computedStyle.height],
        [x, computedStyle.height],
        [x, y],
      ];
    }
    else {
      coords = [
        [tl, y],
        [computedStyle.width - tr, y],
        [computedStyle.width - tr + tr * H, y, computedStyle.width, tr * H, computedStyle.width, tr],
        [computedStyle.width, computedStyle.height - br],
        [computedStyle.width, computedStyle.height - br + br * H, computedStyle.width - br + br * H, computedStyle.height, computedStyle.width - br, computedStyle.height],
        [bl, computedStyle.height],
        [bl * H, computedStyle.height, x, computedStyle.height - bl + bl * H, x, computedStyle.height - bl],
        [x, tl],
        [x, tl - tl * H, tl - tl * H, y, tl, y],
      ];
    }
    return coords;
  }

  getStyle() {
    return clone(this.style) as Style;
  }

  getComputedStyle() {
    const res: ComputedStyle = Object.assign({}, this.computedStyle);
    if (this.isMounted) {
      res.color = res.color.slice(0);
      res.backgroundColor = res.backgroundColor.slice(0);
      res.fill = clone(res.fill);
      res.stroke = clone(res.stroke);
      res.fillOpacity = res.fillOpacity.slice(0);
      res.fillEnable = res.fillEnable.slice(0);
      res.fillMode = res.fillMode.slice(0);
      res.strokeEnable = res.strokeEnable.slice(0);
      res.strokeWidth = res.strokeWidth.slice(0);
      res.transformOrigin = res.transformOrigin.slice(0);
      res.strokeDasharray = res.strokeDasharray.slice(0);
    }
    return res;
  }

  getCssStyle(standard = false) {
    const { style, computedStyle } = this;
    const res: any = {};
    // %单位转换
    [
      'top', 'right', 'bottom', 'left', 'width', 'height',
      'translateX', 'translateY', 'scaleX', 'scaleY', 'rotateZ',
      'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
    ].forEach((k) => {
      const o: any = style[k as keyof JStyle];
      if (o.u === StyleUnit.AUTO) {
        res[k] = 'auto';
      }
      else if (o.u === StyleUnit.PERCENT) {
        res[k] = o.v + '%';
      }
      else if (o.u === StyleUnit.PX || o.u === StyleUnit.NUMBER || o.u === StyleUnit.DEG) {
        res[k] = o.v;
      }
    });
    res.opacity = style.opacity.v;
    res.visibility = style.visibility.v === VISIBILITY.VISIBLE ? 'visible' : 'hidden';
    res.color = color2rgbaStr(style.color.v);
    res.backgroundColor = color2rgbaStr(style.backgroundColor.v);
    res.fontStyle = ['normal', 'italic', 'oblique'][style.fontStyle.v];
    res.textAlign = ['left', 'right', 'center', 'justify'][style.textAlign.v];
    res.textVerticalAlign = ['top', 'middle', 'bottom'][style.textVerticalAlign.v];
    res.mixBlendMode = getCssMbm(style.mixBlendMode.v);
    res.objectFit = getCssObjectFit(style.objectFit.v);
    ['strokeEnable', 'fillEnable', 'fillOpacity', 'strokeWidth'].forEach((k) => {
      res[k] = style[k as | 'strokeEnable' | 'fillEnable' | 'fillOpacity' | 'strokeWidth'].map(item => item.v);
    });
    if (standard) {
      if (this.isMounted) {
        res.fill = computedStyle.fill.map(item => getCssFillStroke(item, this.width, this.height, true));
      }
      else {
        inject.error('Can not get CSS standard fill unmounted');
      }
    }
    else {
      res.fill = calComputedFill(style.fill).map(item => getCssFillStroke(item));
    }
    res.fillRule = ['nonzero', 'evenodd'][style.fillRule.v];
    res.fillMode = style.fillMode.map(item => getCssMbm(item.v));
    if (standard) {
      if (this.isMounted) {
        res.stroke = computedStyle.stroke.map(item => getCssFillStroke(item, this.width, this.height, true));
      }
      else {
        inject.error('Can not get CSS standard stroke unmounted');
      }
    }
    else {
      res.stroke = calComputedStroke(style.stroke).map(item => getCssFillStroke(item, this.width, this.height));
    }
    res.strokeLinecap = ['butt', 'round', 'square'][style.strokeLinecap.v];
    res.strokeLinejoin = ['miter', 'round', 'bevel'][style.strokeLinejoin.v];
    res.strokePosition = style.strokePosition.map(item => getCssStrokePosition(item.v));
    res.strokeMiterlimit = style.strokeMiterlimit.v;
    res.strokeDasharray = style.strokeDasharray.map(item => item.v);
    res.strokeMode = style.strokeMode.map(item => getCssMbm(item.v));
    res.transformOrigin = style.transformOrigin.map(item => {
      if (item.u === StyleUnit.PERCENT) {
        return item.v + '%';
      }
      return item;
    });
    return res as JStyle;
  }

  isParent(target: Node) {
    let p = this.parent;
    while (p) {
      if (p === target) {
        return true;
      }
      p = p.parent;
    }
    return false;
  }

  isChild(target: Node) {
    return target.isParent(this);
  }

  // 插入node到自己后面
  insertAfter(node: Node, cb?: (sync: boolean) => void) {
    node.remove();
    const { root, parent } = this;
    if (!parent) {
      throw new Error('Can not appendSelf without parent');
    }
    node.parent = parent;
    node.prev = this;
    if (this.next) {
      this.next.prev = node;
    }
    node.next = this.next;
    this.next = node;
    node.root = root;
    const children = parent.children;
    const i = children.indexOf(this);
    children.splice(i + 1, 0, node);
    if (parent.isDestroyed) {
      cb && cb(true);
      return;
    }
    parent.insertStruct(node, i + 1);
    root!.addUpdate(node, [], RefreshLevel.ADD_DOM, cb);
  }

  // 插入node到自己前面
  insertBefore(node: Node, cb?: (sync: boolean) => void) {
    node.remove();
    const { root, parent } = this;
    if (!parent) {
      throw new Error('Can not prependBefore without parent');
    }
    node.parent = parent;
    node.prev = this.prev;
    if (this.prev) {
      this.prev.next = node;
    }
    node.next = this;
    this.prev = node;
    node.root = root;
    const children = parent.children;
    const i = children.indexOf(this);
    children.splice(i, 0, node);
    if (parent.isDestroyed) {
      cb && cb(true);
      return;
    }
    parent.insertStruct(node, i);
    root!.addUpdate(node, [], RefreshLevel.ADD_DOM, cb);
  }

  remove(cb?: (sync: boolean) => void) {
    const { root, parent } = this;
    if (parent) {
      const i = parent.children.indexOf(this);
      if (i === -1) {
        throw new Error('Invalid index of remove()');
      }
      parent.children.splice(i, 1);
      const { prev, next } = this;
      if (prev) {
        prev.next = next;
      }
      if (next) {
        next.prev = prev;
      }
      parent.deleteStruct(this);
    }
    // 未添加到dom时
    if (!root || !this.isMounted) {
      cb && cb(true);
      return;
    }
    root.addUpdate(this, [], RefreshLevel.REMOVE_DOM, cb);
  }

  // 同dom同名api
  getBoundingClientRect(opt?: {
    includeBbox?: boolean,
  }) {
    const bbox = opt?.includeBbox
      ? this._bbox || this.bbox
      : this._rect || this.rect;
    const t = calRectPoints(bbox[0], bbox[1], bbox[2], bbox[3], this.matrixWorld);
    const x1 = t.x1;
    const y1 = t.y1;
    const x2 = t.x2;
    const y2 = t.y2;
    const x3 = t.x3;
    const y3 = t.y3;
    const x4 = t.x4;
    const y4 = t.y4;
    const left = Math.min(x1, x2, x3, x4);
    const top = Math.min(y1, y2, y3, y4);
    const right = Math.max(x1, x2, x3, x4);
    const bottom = Math.max(y1, y2, y3, y4);
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      points: [
        {
          x: x1,
          y: y1,
        },
        {
          x: x2,
          y: y2,
        },
        {
          x: x3,
          y: y3,
        },
        {
          x: x4,
          y: y4,
        },
      ],
    };
  }

  // 相对parent不考虑旋转rect只考虑自身width/height
  getOffsetRect() {
    const computedStyle = this.computedStyle;
    const left = computedStyle.left + computedStyle.translateX;
    const top = computedStyle.top + computedStyle.translateY;
    return {
      left,
      top,
      right: left + this.width,
      bottom: top + this.height,
    };
  }

  /**
   * 拖拽开始变更尺寸前预校验，如果style有translate初始值，需要改成普通模式（为0），比如Text和固定尺寸的节点，
   * left调整到以左侧为基准（translateX从-50%到0，差值重新加到left上），top同理，
   * 如此才能防止拉伸时（如往右）以自身中心点为原点左右一起变化，拖拽结束后再重置回去（translateX重新-50%，left也重算）。
   * right/bottom一般情况不用关心，因为如果是left+right说明Text是固定尺寸width无效且无translateX，但为了扩展兼容一并考虑，
   * 只有left百分比+translateX-50%需要，width可能固定也可能自动不用考虑只需看当前计算好的width值。
   */
  startSizeChange() {
    const {
      width,
      height,
      style,
      computedStyle,
      parent,
      isDestroyed,
    } = this;
    if (isDestroyed || !parent) {
      throw new Error('Can not resize a destroyed Node or Root');
    }
    const {
      left,
      right,
      top,
      bottom,
      translateX,
      translateY,
    } = style;
    const { width: pw, height: ph } = parent;
    // 理论sketch中只有-50%，但人工可能有其他值，可统一处理
    if (translateX.v && translateX.u === StyleUnit.PERCENT) {
      const v = translateX.v * width * 0.01;
      if (left.u === StyleUnit.PERCENT) {
        left.v += v * 100 / pw;
      }
      else if (left.u === StyleUnit.PX) {
        left.v += v;
      }
      computedStyle.left += v;
      if (right.u === StyleUnit.PERCENT) {
        right.v -= v * 100 / pw;
      }
      else if (right.u === StyleUnit.PX) {
        right.v -= v;
      }
      computedStyle.right -= v;
      translateX.v = 0;
    }
    if (translateY.v && translateY.u === StyleUnit.PERCENT) {
      const v = translateY.v * height * 0.01;
      if (top.u === StyleUnit.PERCENT) {
        top.v += v * 100 / ph;
      }
      else if (top.u === StyleUnit.PX) {
        top.v += v;
      }
      computedStyle.top += v;
      if (bottom.u === StyleUnit.PERCENT) {
        bottom.v -= v * 100 / ph;
      }
      else if (bottom.u === StyleUnit.PX) {
        bottom.v -= v;
      }
      computedStyle.bottom -= v;
      translateY.v = 0;
    }
  }

  /**
   * 参考 startSizeChange()，反向进行，在连续拖拽改变尺寸的过程中，最后结束调用。
   * 根据开始调整时记录的prev样式，还原布局信息到translate（仅百分比）上。
   * 还需向上检查组的自适应尺寸，放在外部自己调用check。
   */
  endSizeChange(prev: Style) {
    const {
      translateX,
      translateY,
    } = prev;
    const {
      style,
      computedStyle,
      parent,
      width: w,
      height: h,
    } = this;
    const {
      left,
      right,
      top,
      bottom,
    } = style;
    const { width: pw, height: ph } = parent!;
    if (translateX.v && translateX.u === StyleUnit.PERCENT) {
      const v = translateX.v * w * 0.01;
      if (left.u === StyleUnit.PX) {
        left.v -= v;
      }
      else if (left.u === StyleUnit.PERCENT) {
        left.v -= v * 100 / pw;
      }
      computedStyle.left -= v;
      if (right.u === StyleUnit.PX) {
        right.v += v;
      }
      else if (right.u === StyleUnit.PERCENT) {
        right.v += v * 100 / pw;
      }
      computedStyle.right += v;
      computedStyle.translateX += v; // start置0了
    }
    if (translateY.v && translateY.u === StyleUnit.PERCENT) {
      const v = translateY.v * h * 0.01;
      if (top.u === StyleUnit.PX) {
        top.v -= v;
      }
      else if (style.top.u === StyleUnit.PERCENT) {
        top.v -= v * 100 / ph;
      }
      computedStyle.top -= v;
      if (bottom.u === StyleUnit.PX) {
        bottom.v += v;
      }
      else if (bottom.u === StyleUnit.PERCENT) {
        bottom.v += v * 100 / ph;
      }
      computedStyle.bottom += v;
      computedStyle.translateY += v;
    }
    style.translateX.v = translateX.v;
    style.translateX.u = translateX.u;
    style.translateY.v = translateY.v;
    style.translateY.u = translateY.u;
  }

  // 移动过程是用translate加速，结束后要更新TRBL的位置以便后续定位，还要还原translate为原本的%（可能）
  endPosChange(prev: Style, dx: number, dy: number) {
    const { style, computedStyle, parent } = this;
    // 未添加到dom
    if (!parent) {
      return;
    }
    const {
      translateX,
      translateY,
    } = prev;
    const {
      top,
      right,
      bottom,
      left,
    } = style;
    // 一定有parent，不会改root下固定的Container子节点
    const { width: pw, height: ph } = parent;
    if (dx) {
      if (left.u === StyleUnit.PX) {
        left.v += dx;
      }
      else if (left.u === StyleUnit.PERCENT) {
        left.v += dx * 100 / pw;
      }
      computedStyle.left += dx;
      if (right.u === StyleUnit.PX) {
        right.v -= dx;
      }
      else if (right.u === StyleUnit.PERCENT) {
        right.v -= dx * 100 / pw;
      }
      computedStyle.right -= dx;
      computedStyle.translateX -= dx;
    }
    if (dy) {
      if (top.u === StyleUnit.PX) {
        top.v += dy;
      }
      else if (top.u === StyleUnit.PERCENT) {
        top.v += dy * 100 / ph;
      }
      computedStyle.top += dy;
      if (bottom.u === StyleUnit.PX) {
        bottom.v -= dy;
      }
      else if (bottom.u === StyleUnit.PERCENT) {
        bottom.v -= dy * 100 / ph;
      }
      computedStyle.bottom -= dy;
      computedStyle.translateY -= dy;
    }
    style.translateX.v = translateX.v;
    style.translateX.u = translateX.u;
    style.translateY.v = translateY.v;
    style.translateY.u = translateY.u;
  }

  // 无刷新调整尺寸位置，比如父节点自适应尺寸将超出的无效范围收缩到孩子节点集合范围
  adjustPosAndSizeSelf(
    dx1: number,
    dy1: number,
    dx2: number,
    dy2: number,
  ) {
    const { style, computedStyle, parent, root } = this;
    if (!parent || !root || (!dx1 && !dy1 && !dx2 && !dy2)) {
      return;
    }
    const { width: pw, height: ph } = parent;
    const {
      top,
      right,
      bottom,
      left,
      width,
      height,
      translateX,
      translateY,
    } = style;
    // 如果有%的tx，改变之前需要先转换掉，将其清空变成对应的left/right/width，否则会影响
    const needConvertTx = (dx1 || dx2) && translateX.u === StyleUnit.PERCENT && translateX.v;
    if (needConvertTx) {
      const d = needConvertTx * 0.01 * this.width;
      if (left.u === StyleUnit.PX) {
        left.v += d;
      }
      else if (left.u === StyleUnit.PERCENT) {
        left.v += d * 100 / pw;
      }
      computedStyle.left += d;
      if (right.u === StyleUnit.PX) {
        right.v -= d;
      }
      else if (right.u === StyleUnit.PERCENT) {
        right.v -= d * 100 / pw;
      }
      computedStyle.right -= d;
    }
    // 水平调整统一处理，固定此时无效
    if (dx1) {
      if (left.u === StyleUnit.PX) {
        left.v += dx1;
      }
      else if (left.u === StyleUnit.PERCENT) {
        left.v += (dx1 * 100) / pw;
      }
      computedStyle.left += dx1;
    }
    if (dx2) {
      if (right.u === StyleUnit.PX) {
        right.v -= dx2;
      }
      else if (right.u === StyleUnit.PERCENT) {
        right.v -= (dx2 * 100) / pw;
      }
      computedStyle.right -= dx2;
    }
    // 上面如果调整无论如何都会影响width
    if (dx2 - dx1) {
      if (width.u === StyleUnit.PX) {
        width.v = dx2 + this.width - dx1;
      }
      else if (width.u === StyleUnit.PERCENT) {
        width.v = (dx2 + this.width - dx1) * 100 / parent.width;
      }
      computedStyle.width = parent.width - computedStyle.left - computedStyle.right;
    }
    // 可能调整right到了left的左边形成负值，此时交换它们
    if (this.width < 0) {
      computedStyle.width = -this.width;
      const oldLeft = computedStyle.left;
      const oldRight = computedStyle.right;
      computedStyle.left = pw - oldRight;
      if (left.u === StyleUnit.PX) {
        left.v = computedStyle.left;
      }
      else if (left.u === StyleUnit.PERCENT) {
        left.v = computedStyle.left * 100 / pw;
      }
      computedStyle.right = pw - oldLeft;
      if (right.u === StyleUnit.PX) {
        right.v = computedStyle.right;
      }
      else if (right.u === StyleUnit.PERCENT) {
        right.v = computedStyle.right * 100 / pw;
      }
    }
    // 还原
    if (needConvertTx) {
      const d = needConvertTx * 0.01 * this.width;
      if (left.u === StyleUnit.PX) {
        left.v -= d;
      }
      else if (left.u === StyleUnit.PERCENT) {
        left.v -= d * 100 / pw;
      }
      computedStyle.left -=d;
      if (right.u === StyleUnit.PX) {
        right.v += d;
      }
      else if (right.u === StyleUnit.PERCENT) {
        right.v += d * 100 / pw;
      }
      computedStyle.right += d;
    }
    // 垂直和水平一样
    const needConvertTy = (dy1 || dy2) && translateY.u === StyleUnit.PERCENT && translateY.v;
    if (needConvertTy) {
      const d = needConvertTy * 0.01 * this.height;
      if (top.u === StyleUnit.PX) {
        top.v += d;
      }
      else if (top.u === StyleUnit.PERCENT) {
        top.v += d * 100 / ph;
      }
      computedStyle.top += d;
      if (bottom.u === StyleUnit.PX) {
        bottom.v -= d;
      }
      else if (bottom.u === StyleUnit.PERCENT) {
        bottom.v -= d * 100 / ph;
      }
      computedStyle.bottom -= d;
    }
    if (dy1) {
      if (top.u === StyleUnit.PX) {
        top.v += dy1;
      }
      else if (top.u === StyleUnit.PERCENT) {
        top.v += (dy1 * 100) / ph;
      }
      computedStyle.top += dy1;
    }
    if (dy2) {
      if (bottom.u === StyleUnit.PX) {
        bottom.v -= dy2
      }
      else if (bottom.u === StyleUnit.PERCENT) {
        bottom.v -= (dy2 * 100) / ph;
      }
      computedStyle.bottom -= dy2;
    }
    if (dy2 - dy1) {
      if (height.u === StyleUnit.PX) {
        height.v = dy2 + this.height - dy1;
      }
      else if (height.u === StyleUnit.PERCENT) {
        height.v = (dy2 + this.height - dy1) * 100 / parent.height;
      }
      computedStyle.height = parent.height - computedStyle.top - computedStyle.bottom;
    }
    if (this.height < 0) {
      computedStyle.height = -this.height;
      const oldTop = computedStyle.top;
      const oldBottom = computedStyle.bottom;
      computedStyle.top = ph - oldTop;
      if (top.u === StyleUnit.PX) {
        top.v = computedStyle.top;
      }
      else if (top.u === StyleUnit.PERCENT) {
        top.v = computedStyle.top * 100 / ph;
      }
      computedStyle.bottom = ph - oldBottom;
      if (bottom.u === StyleUnit.PX) {
        bottom.v = computedStyle.bottom;
      }
      else if (bottom.u === StyleUnit.PERCENT) {
        bottom.v = computedStyle.bottom * 100 / ph;
      }
    }
    if (needConvertTy) {
      const d = needConvertTy * 0.01 * this.height;
      if (top.u === StyleUnit.PX) {
        top.v -= d;
      }
      else if (top.u === StyleUnit.PERCENT) {
        top.v -= d * 100 / ph;
      }
      computedStyle.top -=d;
      if (bottom.u === StyleUnit.PX) {
        bottom.v += d;
      }
      else if (bottom.u === StyleUnit.PERCENT) {
        bottom.v += d * 100 / ph;
      }
      computedStyle.bottom += d;
    }
    // 影响matrix，这里不能用优化optimize计算，必须重新计算，因为最终值是left+translateX
    this.refreshLevel |= RefreshLevel.TRANSFORM;
    root.rl |= RefreshLevel.TRANSFORM;
    this.calMatrix(RefreshLevel.TRANSFORM);
    // 记得重置
    this._rect = undefined;
    this._bbox = undefined;
    this._bboxInt = undefined;
    this._filterBbox = undefined;
    this._filterBboxInt = undefined;
  }

  // 节点位置尺寸发生变更后，会递归向上影响，逐步检查，可能在某层没有影响提前跳出中断
  checkPosSizeUpward() {
    const root = this.root!;
    let parent = this.parent;
    while (parent && parent !== root) {
      if (!parent.adjustPosAndSize()) {
        // 无影响中断向上递归，比如拖动节点并未超过组的范围
        break;
      }
      parent = parent.parent;
    }
  }

  // 空实现，叶子节点没children不关心根据children自适应尺寸，Container会覆盖
  adjustPosAndSize() {
    return false;
  }

  protected initAnimate(animation: AbstractAnimation, options: Options & {
    autoPlay?: boolean;
  }) {
    this.animationList.push(animation);
    const root = this.root;
    if (this.isDestroyed || !root) {
      animation.cancel();
      return animation;
    }
    root.aniController.addAni(animation);
    if (options.autoPlay) {
      animation.play();
    }
    return animation;
  }

  animate(keyFrames: JKeyFrame[], options: Options & {
    autoPlay?: boolean;
  }) {
    const animation = new Animation(this, keyFrames, options);
    return this.initAnimate(animation, options);
  }

  release() {
    this.remove();
    this.animationList.splice(0).forEach(item => item.remove());
    this.clearTexCache();
  }

  get width() {
    return this.computedStyle.width || 0;
  }

  get height() {
    return this.computedStyle.height || 0;
  }

  // 可能在布局后异步渲染前被访问，此时没有这个数据，刷新后就有缓存，变更transform或者reflow无缓存
  get matrixWorld() {
    const root = this.root;
    let m = this._matrixWorld;
    if (!root) {
      return m;
    }
    // 循环代替递归，判断包含自己在内的这条分支上的父级是否有缓存，如果都有缓存，则无需计算
    /* eslint-disable */
    let node: Node = this,
      cache = this.hasCacheMw,
      parent = node.parent,
      index = -1;
    const pList: Container[] = [];
    while (parent) {
      pList.push(parent);
      // 父级变更过后id就会对不上，但首次初始化后是一致的，防止初始化后立刻调用所以要多判断下
      if (!parent.hasCacheMw || parent.localMwId !== node.parentMwId) {
        cache = false;
        index = pList.length; // 供后面splice裁剪用
      }
      node = parent;
      parent = parent.parent;
    }
    // 这里的cache是考虑了向上父级的，只要有失败的就进入，从这条分支上最上层无缓存的父级开始计算
    if (!cache) {
      // 父级有变化则所有向下都需更新，可能第一个是root（极少场景会修改root的matrix）
      if (index > -1) {
        pList.splice(index);
        pList.reverse();
        for (let i = 0, len = pList.length; i < len; i++) {
          const node = pList[i];
          /**
           * 被动变更判断，自己没有变更但父级发生了变更需要更新id，这里的情况比较多
           * 某个父节点可能没有变更，也可能发生变更，变更后如果进行了读取则不会被记录进来
           * 记录的顶层父节点比较特殊，会发生上述情况，中间父节点不会有变更后读取的情况
           * 因此只有没有变化且和父级id不一致时，其id自增标识，有变化已经主动更新过了
           */
          if (node.hasCacheMw && node.parentMwId !== node.parent?.localMwId) {
            node.localMwId++;
          }
          node.hasCacheMw = true;
          if (node === root) {
            assignMatrix(node._matrixWorld, node.matrix);
          }
          else {
            const t = multiply(node.parent!._matrixWorld, node.matrix);
            assignMatrix(node._matrixWorld, t);
            node.parentMwId = node.parent!.localMwId;
          }
        }
      }
      // 自己没有变化但父级出现变化影响了这条链路，被动变更，这里父级id一定是不一致的，否则进不来
      if (this.hasCacheMw) {
        this.localMwId++;
      }
      this.hasCacheMw = true;
      // 仅自身变化，或者有父级变化但父级前面已经算好了，防止自己是Root
      parent = this.parent;
      if (parent) {
        const t = multiply(parent._matrixWorld, this.matrix);
        assignMatrix(m, t);
        this.parentMwId = parent.localMwId; // 更新以便后续对比
      }
      else {
        assignMatrix(m, this.matrix);
      }
    }
    return m;
  }

  get rect() {
    let res = this._rect;
    if (!res) {
      res = this._rect = new Float64Array(4);
      res[0] = 0;
      res[1] = 0;
      res[2] = this.computedStyle.width;
      res[3] = this.computedStyle.height;
    }
    return res;
  }

  get bbox() {
    let res = this._bbox;
    if (!res) {
      const rect = this._rect || this.rect;
      res = this._bbox = rect.slice(0);
    }
    return res;
  }

  get filterBbox() {
    let res = this._filterBbox;
    if (!res) {
      const bbox = this._bbox || this.bbox;
      res = this._filterBbox = bbox.slice(0);
    }
    return res;
  }

  get bboxInt() {
    let res = this._bboxInt;
    if (!res) {
      res = this._bboxInt = (this._bbox || this.bbox).slice(0);
      res[0] = Math.floor(res[0]);
      res[1] = Math.floor(res[1]);
      res[2] = Math.ceil(res[2]);
      res[3] = Math.ceil(res[3]);
    }
    return res;
  }

  get filterBboxInt() {
    let res = this._filterBboxInt;
    if (!res) {
      res = this._filterBboxInt = (this._filterBbox || this.filterBbox).slice(0);
      res[0] = Math.floor(res[0]);
      res[1] = Math.floor(res[1]);
      res[2] = Math.ceil(res[2]);
      res[3] = Math.ceil(res[3]);
    }
    return res;
  }
}

export default Node;
