import Container from './Container';
import Node from './Node';
import { RootProps } from '../format';
import ca from '../gl/ca';
import inject from '../util/inject';
import { renderWebgl, Struct } from '../refresh/struct';
import frame from '../animation/frame';
import { StyleUnit, VISIBILITY } from '../style/define';
import { getLevel, isReflow, RefreshLevel } from '../refresh/level';
import { checkReflow } from '../refresh/reflow';
import { initShaders } from '../gl/webgl';
import mainVert from '../gl/main.vert';
import mainFrag from '../gl/main.frag';
import boxFrag from '../gl/box.frag';
import dualDownFrag from '../gl/dualDown.frag';
import dualUpFrag from '../gl/dualUp.frag';
import motionFrag from '../gl/motion.frag';
import radialFrag from '../gl/radial.frag';
import simpleVert from '../gl/simple.vert';
import cmFrag from '../gl/cm.frag';
import AbstractAnimation from '../animation/AbstractAnimation';
import AniController from '../animation/AniController';
import { CAN_PLAY, REFRESH, REFRESH_COMPLETE, WAITING } from '../refresh/refreshEvent';
import MbVideoEncoder, { EncodeOptions } from '../util/MbVideoEncoder';

class Root extends Container {
  canvas?: HTMLCanvasElement;
  ctx?: WebGLRenderingContext | WebGL2RenderingContext;
  isWebgl2?: boolean;
  refs: Record<string, Node>;
  structs: Struct[]; // 队列代替递归Tree的数据结构
  task: Array<((sync: boolean) => void) | undefined>; // 异步绘制任务回调列表
  aniTask: AbstractAnimation[]; // 动画任务，空占位
  rl: RefreshLevel; // 一帧内画布最大刷新等级记录
  programs: Record<string, WebGLProgram>;
  private readonly frameCb: (delta: number) => void; // 帧动画回调
  aniController: AniController;
  audioContext: AudioContext;
  contentLoadingCount: number; // 各子节点控制（如视频）加载中++，完成后--，为0时说明渲染完整
  lastContentLoadingCount: number;

  constructor(props: RootProps, children: Node[] = []) {
    super(props, children);
    this.root = this;
    this.refs = {};
    this.structs = [];
    this.task = [];
    this.aniTask = [];
    this.rl = RefreshLevel.NONE;
    this.programs = {};
    this.frameCb = (delta: number) => {
      // console.log(delta);
      // 优先执行所有动画的差值更新计算，如有更新会调用addUpdate触发task添加，实现本帧绘制
      const aniTaskClone = this.aniTask.slice(0);
      aniTaskClone.forEach(item => {
        item.onRunning(delta);
      });
      // 异步绘制任务回调清空，有任务时才触发本帧刷新
      const taskClone = this.task.splice(0);
      if (taskClone.length) {
        this.draw();
      }
      aniTaskClone.forEach(item => {
        item.afterRunning();
      });
      taskClone.forEach(item => {
        if (item) {
          item(false);
        }
      });
      // 没有下一帧的任务和动画，结束帧动画
      if (!this.task.length && !this.aniTask.length) {
        frame.offFrame(this.frameCb);
      }
    };
    this.audioContext = new AudioContext();
    this.aniController = new AniController(this.audioContext);
    this.contentLoadingCount = 0;
    this.lastContentLoadingCount = 0;
  }

  appendTo(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const attributes = Object.assign(ca, (this.props as RootProps).contextAttributes);
    // gl的初始化和配置
    let gl: WebGL2RenderingContext | WebGLRenderingContext = canvas.getContext('webgl2', attributes) as WebGL2RenderingContext;
    if (gl) {
      this.isWebgl2 = true;
    }
    else {
      gl = canvas.getContext('webgl', attributes) as WebGLRenderingContext;
      this.isWebgl2 = false;
    }
    if (!gl) {
      throw new Error('Webgl unsupported!');
    }
    this.appendToGl(gl);
  }

  appendToGl(gl: WebGL2RenderingContext | WebGLRenderingContext) {
    // 不能重复
    if (this.ctx) {
      inject.error('Duplicate appendToGl');
      return;
    }
    this.ctx = gl;
    this.initShaders(gl);
    // 渲染前布局和设置关系结构
    this.reLayout();
    this.didMount();
    this.structs = this.structure(0);
    this.addUpdate(this, [], RefreshLevel.ADD_DOM);
  }

  reLayout() {
    this.checkRoot();
    this.layout({
      w: this.computedStyle.width,
      h: this.computedStyle.height,
    });
  }

  private checkRoot() {
    const { width, height } = this.style;
    const canvas = this.canvas;
    if (width.u === StyleUnit.AUTO) {
      if (canvas) {
        width.u = StyleUnit.PX;
        this.computedStyle.width = width.v = Math.max(1, canvas.width);
      }
    }
    else {
      this.computedStyle.width = Math.max(1, this.style.width.v as number);
    }
    if (height.u === StyleUnit.AUTO) {
      if (canvas) {
        height.u = StyleUnit.PX;
        this.computedStyle.height = height.v = Math.max(1, canvas.height);
      }
    }
    else {
      this.computedStyle.height = Math.max(1, this.style.height.v as number);
    }
    this.ctx?.viewport(0, 0, this.computedStyle.width, this.computedStyle.height);
  }

  /**
   * 添加更新，分析repaint/reflow和上下影响，异步刷新
   * sync是updateStyle()时没有变化，cb会返回true标明同步执行
   */
  addUpdate(
    node: Node, // 发生变更的节点
    keys: string[], // 发生变更的样式key
    focus: RefreshLevel = RefreshLevel.NONE, // 初始值默认空，可能图片src变了默认传重绘
    cb?: (sync: boolean) => void,
  ) {
    if (!this.isMounted) {
      return RefreshLevel.NONE;
    }
    let lv = focus;
    if (keys && keys.length) {
      for (let i = 0, len = keys.length; i < len; i++) {
        const k = keys[i];
        lv |= getLevel(k);
      }
    }
    const res = this.calUpdate(node, lv);
    if (res) {
      this.asyncDraw(cb);
    }
    else {
      cb && cb(true);
    }
    return lv;
  }

  calUpdate(
    node: Node,
    lv: RefreshLevel,
  ) {
    if (lv === RefreshLevel.NONE || !this.isMounted) {
      return false;
    }
    // reflow/repaint/<repaint分级
    const isRf = isReflow(lv);
    if (isRf) {
      // 除了特殊如窗口缩放变更canvas画布会影响根节点，其它都只会是变更节点自己
      if (node === this) {
        this.reLayout();
      }
      else {
        checkReflow(node, lv);
      }
    }
    else {
      const isRp = lv >= RefreshLevel.REPAINT;
      if (isRp) {
        node.calRepaintStyle(lv);
      }
      else {
        if (lv & RefreshLevel.TRANSFORM_ALL) {
          node.calMatrix(lv);
        }
        if (lv & RefreshLevel.OPACITY) {
          node.calOpacity();
        }
        if (lv & RefreshLevel.FILTER) {
          node.calFilter(lv);
        }
      }
    }
    node.clearTexCacheUpward();
    node.refreshLevel |= lv;
    this.rl |= lv;
    let parent = node.parent;
    while (parent) {
      if (parent.computedStyle.visibility === VISIBILITY.HIDDEN) {
        return false;
      }
      parent = parent.parent;
    }
    return lv > RefreshLevel.NONE;
  }

  asyncDraw(cb?: (sync: boolean) => void) {
    const { task, aniTask } = this;
    if (!task.length && !aniTask.length) {
      frame.onFrame(this.frameCb);
    }
    task.push(cb);
  }

  cancelAsyncDraw(cb: (sync: boolean) => void) {
    const { task, aniTask } = this;
    const i = task.indexOf(cb);
    if (i > -1) {
      task.splice(i, 1);
      if (!task.length && !aniTask.length) {
        frame.offFrame(this.frameCb);
      }
    }
  }

  // 总控动画，所有节点的动画引用都会存下来
  addAnimation(animation: AbstractAnimation) {
    const { task, aniTask } = this;
    if (!task.length && !aniTask.length) {
      frame.onFrame(this.frameCb);
    }
    if (aniTask.indexOf(animation) === -1) {
      aniTask.push(animation);
    }
  }

  removeAnimation(animation: AbstractAnimation) {
    const { task, aniTask } = this;
    const i = aniTask.indexOf(animation);
    if (i > -1) {
      aniTask.splice(i, 1);
      if (!task.length && !aniTask.length) {
        frame.offFrame(this.frameCb);
      }
    }
  }

  draw() {
    if (!this.isMounted) {
      return;
    }
    const rl = this.rl;
    if (rl > RefreshLevel.NONE) {
      this.clear();
      this.rl = RefreshLevel.NONE;
      if (this.ctx) {
        renderWebgl(this.ctx, this);
        this.emit(REFRESH);
        if (this.contentLoadingCount) {
          if (!this.lastContentLoadingCount) {
            this.emit(WAITING);
          }
        }
        else {
          if (this.lastContentLoadingCount) {
            this.emit(CAN_PLAY);
          }
          this.emit(REFRESH_COMPLETE);
        }
        this.lastContentLoadingCount = this.contentLoadingCount;
      }
    }
  }

  clear() {
    const gl = this.ctx;
    if (gl) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  private initShaders(gl: WebGL2RenderingContext | WebGLRenderingContext) {
    const program = (this.programs.program = initShaders(gl, mainVert, mainFrag));
    this.programs.boxProgram = initShaders(gl, simpleVert, boxFrag);
    this.programs.dualDownProgram = initShaders(gl, simpleVert, dualDownFrag);
    this.programs.dualUpProgram = initShaders(gl, simpleVert, dualUpFrag);
    this.programs.motionProgram = initShaders(gl, simpleVert, motionFrag);
    this.programs.radialProgram = initShaders(gl, simpleVert, radialFrag);
    this.programs.cmProgram = initShaders(gl, simpleVert, cmFrag);
    gl.useProgram(program);
  }

  async encode(encodeOptions?: EncodeOptions) {
    return MbVideoEncoder.getInstance().start(this, encodeOptions);
  }
}

export default Root;
