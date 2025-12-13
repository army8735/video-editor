import AbstractAnimation, { Options } from './AbstractAnimation';
import Node from '../node/Node';
import { JStyle } from '../format';
import easing from './easing';
import { isFunction, isNumber, isString } from '../util/type';
import { Style, StyleBlurValue, StyleNumValue, StyleUnit } from '../style/define';
import css, { cloneStyle } from '../style/css';

export type JKeyFrame = Partial<JStyle> & {
  offset?: number;
  easing?: string | number[] | ((v: number) => number);
};

export type KeyFrame = {
  style: Partial<Style>;
  time: number;
  easing?: (v: number) => number;
  transition: { key: keyof Style, diff: number | [number, number] | { radius: number, angle?: number, offset?: number } }[]; // 到下帧有变化的key和差值
  fixed: (keyof Style)[]; // 固定不变化的key
};

export class CssAnimation extends AbstractAnimation {
  private _keyFrames: KeyFrame[];
  private _keyFramesR: KeyFrame[];
  currentKeyFrames: KeyFrame[];
  originStyle: Partial<Style>;

  constructor(node: Node, jKeyFrames: JKeyFrame[], options: Options) {
    super(node, options);
    this._keyFrames = [];
    this._keyFramesR = [];
    this.currentKeyFrames = this._keyFrames;
    this.originStyle = {};
    this.initKeyFrames(jKeyFrames);
    this.setCurrentFrames();
  }

  private initKeyFrames(jKeyFrames: JKeyFrame[]) {
    const { keys, keyFrames, keyFramesR, originStyle } = parseKeyFrames(this.node, jKeyFrames, this.duration, this.easing);
    this._keyFrames = keyFrames;
    this._keyFramesR = keyFramesR;
    calTransition(this.node, this._keyFrames, keys);
    calTransition(this.node, this._keyFramesR, keys);
    this.originStyle = originStyle;
  }

  override finish() {
    if (this._playState === 'finished') {
      return;
    }
    super.finish();
    this.onFirstInEndDelay();
  }

  override cancel() {
    if (this._playState === 'idle') {
      return;
    }
    super.cancel();
    const { node } = this;
    node.updateFormatStyle(this.originStyle);
  }

  // 根据播放方向和初始轮次确定当前帧序列是正向还是反向
  private setCurrentFrames() {
    const { direction, _keyFrames, _keyFramesR, _playCount } = this;
    if (direction === 'backwards') {
      this.currentKeyFrames = _keyFramesR;
    }
    else if (direction === 'alternate') {
      if (_playCount % 2 === 0) {
        this.currentKeyFrames = _keyFrames;
      }
      else {
        this.currentKeyFrames = _keyFramesR;
      }
    }
    else if (direction === 'alternateReverse') {
      if (_playCount % 2 === 0) {
        this.currentKeyFrames = _keyFramesR;
      }
      else {
        this.currentKeyFrames = _keyFrames;
      }
    }
    else {
      this.currentKeyFrames = _keyFrames;
    }
  }

  onRunning(delta: number, old?: number) {
    super.onRunning(delta, old);
    const { duration, delay, iterations, time } = this;
    const currentTime = this._currentTime;
    // 如有delay则这段时间等待状态，根据fill设置是否是初始帧样式
    if (currentTime < delay) {
      return;
    }
    const isLastCount = this._playCount >= iterations - 1;
    const currentKeyFrames = this.currentKeyFrames;
    const length = currentKeyFrames.length;
    // 只有2帧可优化（大部分情况），否则2分查找当前帧
    let i: number;
    if (length === 2) {
      i = time < duration ? 0 : 1;
    }
    else {
      i = binarySearchFrame(0, length - 1, time, currentKeyFrames);
    }
    const currentKeyFrame = currentKeyFrames[i];
    // 最后一帧结束动画，仅最后一轮才会进入
    const isLastKeyFrame = isLastCount && i === length - 1;
    // 当前帧和下一帧之间的进度百分比
    let percent = 0;
    if (isLastKeyFrame) {
      // 无需任何处理
    }
    // 否则根据目前到下一帧的时间差，计算百分比，再反馈到变化数值上
    else if (length === 2) {
      percent = time / duration;
    }
    else {
      const time0 = currentKeyFrame.time;
      const total = currentKeyFrames[i + 1].time - time0;
      percent = (time - time0) / total;
    }
    // 最后结束特殊处理，根据endDelay/fill决定是否还原还是停留最后一帧
    if (isLastKeyFrame) {
    }
    // 两帧之间动画计算
    else {
      if (currentKeyFrame.easing) {
        percent = currentKeyFrame.easing(percent);
      }
      else if (this.easing) {
        percent = this.easing(percent);
      }
      const { transition, fixed, style } = currentKeyFrame;
      const update: Partial<Style> = {};
      // 可计算差值部分
      transition.forEach(item => {
        const { key, diff } = item;
        if (key === 'opacity'
          || key === 'translateX'
          || key === 'translateY'
          || key === 'translateZ'
          || key === 'scaleX'
          || key === 'scaleY'
          || key === 'rotateX'
          || key === 'rotateY'
          || key === 'rotateZ'
          || key === 'perspective'
        ) {
          const o = Object.assign({}, style[key]) as StyleNumValue;
          o.v += (diff as number) * percent;
          update[key] = o;
        }
        else if (key === 'transformOrigin' || key === 'perspectiveOrigin') {
          const v = style[key] as [StyleNumValue, StyleNumValue];
          const o = [Object.assign({}, v[0]), Object.assign({}, v[1])] as [StyleNumValue, StyleNumValue];
          o[0].v += (diff as [number, number])[0] * percent;
          o[1].v += (diff as [number, number])[1] * percent;
          update[key] = o;
        }
        else if (key === 'blur') {
          const o = cloneStyle(style, key).blur as StyleBlurValue;
          o.v.radius.v += (diff as any).radius * percent;
          if (o.v.angle) {
            o.v.angle.v += (diff as any).angle * percent;
          }
          if (o.v.offset) {
            o.v.offset.v += (diff as any).offset * percent;
          }
          update[key] = o;
        }
      });
      // 固定部分
      fixed.forEach(key => {
        // @ts-ignore
        update[key] = Object.assign({}, style[key]);
      });
      this.node.updateFormatStyle(update);
    }
  }

  onFirstInDelay() {
    const { fill, node } = this;
    if (fill === 'backwards' || fill === 'both') {
      node.updateFormatStyle(this.currentKeyFrames[0].style);
    }
    else {
      node.updateFormatStyle(this.originStyle);
    }
  }

  onFirstInEndDelay() {
    const { fill, node } = this;
    if (fill === 'forwards' || fill === 'both') {
      const currentKeyFrames = this.currentKeyFrames;
      node.updateFormatStyle(currentKeyFrames[currentKeyFrames.length - 1].style);
    }
    else {
      node.updateFormatStyle(this.originStyle);
    }
  }

  onChangePlayCount() {
    this.setCurrentFrames();
  }
}

// 将关键帧序列标准化样式结构
function parseKeyFrames(node: Node, jKeyFrames: JKeyFrame[], duration: number, ea?: (v: number) => number) {
  const list: JKeyFrame[] = [];
  // 过滤时间非法的，过滤后续offset<=前面的
  let prevOffset = 0;
  for (let i = 0, len = jKeyFrames.length; i < len; i++) {
    const item = jKeyFrames[i];
    if (isNumber(item.offset)) {
      const offset = item.offset!;
      if (offset < 0 || offset > 1) {
        continue;
      }
      if (offset <= prevOffset && i) {
        continue;
      }
      prevOffset = offset;
    }
    list.push(Object.assign({}, item));
  }
  // 只有1帧复制出来变成2帧方便运行
  if (list.length === 1) {
    list.push(Object.assign({}, list[0]));
    const clone = Object.assign({}, list[0]);
    if (list[0].offset === 1) {
      clone.offset = 0;
      list.unshift(clone);
    }
    else {
      clone.offset = 1;
      list.push(clone);
    }
  }
  // 首尾时间偏移强制为[0, 1]，不是的话前后加空帧
  const first = list[0];
  if (first.offset && first.offset > 0) {
    list.unshift({
      offset: 0,
    });
  }
  else {
    first.offset = 0;
  }
  const last = list[list.length - 1];
  if (last.offset && last.offset < 1) {
    list.push({
      offset: 1,
    });
  }
  else {
    last.offset = 1;
  }
  // 计算没有设置offset的帧
  for(let i = 1, len = list.length; i < len; i++) {
    const item = list[i];
    // 从i=1开始offset一定>0，找到下一个有offset的，最后一个一定是1，均分中间无声明的
    if (!isNumber(item.offset)) {
      let end: JKeyFrame;
      let j = i + 1;
      for(; j < len; j++) {
        end = list[j];
        if (end.offset) {
          break;
        }
      }
      const num = j - i + 1;
      const prev = list[i - 1];
      const per = (end!.offset! - prev.offset!) / num;
      for (let k = i; k < j; k++) {
        list[k].offset = prev.offset! + per * (k + 1 - i);
      }
      i = j;
    }
  }
  // 标准化关键帧的样式，并统计有哪些样式出现
  const keyFrames: KeyFrame[] = [];
  const hash: Record<string, boolean> = {};
  const keys: (keyof Style)[] = [];
  for(let i = 0, len = list.length; i < len; i++) {
    const item = list[i];
    const style = css.normalize(item);
    Object.keys(style).forEach(k => {
      if (!hash.hasOwnProperty(k)) {
        hash[k] = true;
        keys.push(k as keyof Style);
      }
    });
    const o = {
      style,
      time: item.offset! * duration,
      easing: ea,
      transition: [],
      fixed: [],
    };
    if (item.easing) {
      if (isFunction(item.easing)) {
        o.easing = item.easing as (v :number) => number;
      }
      else if (Array.isArray(item.easing)) {
        o.easing = easing.getEasing(item.easing as number[]);
      }
      else if (isString(item.easing)) {
        o.easing = easing[item.easing as 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'];
      }
    }
    keyFrames.push(o);
  }
  // 添补没有声明完全的关键帧属性为节点当前值
  keyFrames.forEach(item => {
    const style = item.style;
    keys.forEach(k => {
      if (!style.hasOwnProperty(k)) {
        Object.assign(style, cloneStyle(node.style, [k]));
      }
    });
  });
  // 反向播放的
  const keyFramesR = keyFrames.map(item => {
    return Object.assign({}, item, {
      transition: [],
      fixed: [],
    });
  }).reverse();
  keyFramesR.forEach(item => {
    item.time = duration - item.time;
  });
  // 记录原始样式，动画结束可能需要还原
  const originStyle: Partial<Style> = cloneStyle(node.style, keys);
  return {
    keys,
    keyFrames,
    keyFramesR,
    originStyle,
  };
}

function calTransition(node: Node, keyFrames: KeyFrame[], keys: (keyof Style)[]) {
  for (let i = 1, len = keyFrames.length; i < len; i++) {
    const prev = keyFrames[i - 1];
    const next = keyFrames[i];
    const prevStyle = prev.style;
    const nextStyle = next.style;
    keys.forEach(key => {
      const p = prevStyle[key];
      const n = nextStyle[key];
      if (key === 'opacity'
        || key === 'scaleX'
        || key === 'scaleY'
        || key === 'rotateX'
        || key === 'rotateY'
        || key === 'rotateZ'
      ) {
        prev.transition.push({
          key,
          diff: (n as StyleNumValue).v - (p as StyleNumValue).v,
        });
      }
      // 数值单位考虑不同单位换算
      else if (key === 'translateX'
        || key === 'translateY'
        || key === 'translateZ'
        || key === 'perspective'
      ) {
        if ((p as StyleNumValue).u === (n as StyleNumValue).u) {
          prev.transition.push({
            key,
            diff: (n as StyleNumValue).v - (p as StyleNumValue).v,
          });
        }
        else {
          let unit = 0;
          if (key === 'translateX' || key === 'translateZ') {
            unit = node.computedStyle.width;
          }
          else if (key === 'translateY') {
            unit = node.computedStyle.height;
          }
          prev.transition.push({
            key,
            diff: calLengthByUnit((p as StyleNumValue), (n as StyleNumValue), unit),
          });
        }
      }
      else if (key === 'transformOrigin' || key === 'perspectiveOrigin') {
        const pv = p as [StyleNumValue, StyleNumValue];
        const nv = n as [StyleNumValue, StyleNumValue];
        const diff: [number, number] = [0, 0];
        for (let i = 0; i < 2; i++) {
          if (pv[i].u === nv[i].u) {
            diff.push(nv[i].v - pv[i].v);
          }
          else {
            let unit = i ? node.computedStyle.height : node.computedStyle.width;
            prev.transition.push({
              key,
              diff: calLengthByUnit(nv[i], pv[i], unit),
            });
          }
        }
        prev.transition.push({
          key,
          diff,
        });
      }
      else if (key === 'visibility' || key === 'overflow') {
        next.fixed.push(key);
        // fixed很特殊首帧渲染需要
        if (i === 1) {
          prev.fixed.push(key);
        }
      }
      else if (key === 'blur') {
        if ((p as StyleBlurValue).v.t === (n as StyleBlurValue).v.t) {
          prev.transition.push({
            key,
            diff: {
              radius: (n as StyleBlurValue).v.radius.v - (p as StyleBlurValue).v.radius.v,
              angle: ((n as StyleBlurValue).v.angle?.v || 0) - ((p as StyleBlurValue).v.angle?.v || 0),
              offset: ((n as StyleBlurValue).v.offset?.v || 0) - ((p as StyleBlurValue).v.offset?.v || 0),
            },
          });
        }
        else {
          next.fixed.push(key);
          // fixed很特殊首帧渲染需要
          if (i === 1) {
            prev.fixed.push(key);
          }
        }
      }
    });
  }
}

function calLengthByUnit(p: StyleNumValue, n: StyleNumValue, unit: number) {
  if (p.u === StyleUnit.PX) {
    if (n.u === StyleUnit.PERCENT) {
      return n.v * 0.01 * unit - p.v;
    }
  }
  else if (p.u === StyleUnit.PERCENT) {
    if (n.u === StyleUnit.PX) {
      return n.v * 100 / unit - p.v;
    }
  }
  return 0;
}

function binarySearchFrame(i: number, j: number, currentTime: number, keyFrames: KeyFrame[]) {
  while (i < j) {
    if (i === j - 1) {
      if (keyFrames[j].time <= currentTime) {
        return j;
      }
      return i;
    }
    const mid = i + ((j - i) >> 1);
    const time = keyFrames[mid].time;
    if (time === currentTime) {
      return mid;
    }
    if (time > currentTime) {
      j = Math.max(mid - 1, i);
    }
    else {
      i = Math.min(mid, j);
    }
  }
  return i;
}

export default CssAnimation;
