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
import AbstractAnimation from '../animation/AbstractAnimation';
import AniController from '../animation/AniController';
import config from '../config';
import { EncoderEvent, EncoderType } from '../encoder';
import { REFRESH, REFRESH_COMPLETE } from '../refresh/refreshEvent';

let worker: Worker;

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
        if (!this.contentLoadingCount) {
          this.emit(REFRESH_COMPLETE);
        }
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
    gl.useProgram(program);
  }

  async encode(name: string, customConfig?: Partial<VideoEncoderConfig>) {
    if (!this.canvas) {
      return;
    }
    const videoEncoderConfig: VideoEncoderConfig = Object.assign({
      // 1. 核心格式
      codec: 'avc1.420028', // H.264 Baseline Profile (广泛兼容)
      width: this.width,
      height: this.height,
      bitrate: 5_000_000, // 5 Mbps (高画质)
      bitrateMode: 'variable',
      framerate: 30,
      hardwareAcceleration: 'no-preference',
    }, customConfig);
    const support = await VideoEncoder.isConfigSupported(videoEncoderConfig);
    if (support && support.supported) {
      if (!worker) {
        if (config.encoderWorker) {
          worker = new Worker(config.encoderWorker);
        }
        else if (config.encoderWorkerStr) {
          const blob = new Blob([config.mp4boxWorkerStr.trim()], { 'type': 'application/javascript' });
          const url = URL.createObjectURL(blob);
          worker = new Worker(url);
        }
        else {
          throw new Error('Missing encoderWorker config');
        }
      }
      worker.postMessage({
        type: EncoderType.INIT,
        videoEncoderConfig,
      });
      // 计算帧数和时间，每次走一帧的时间渲染
      const duration = this.aniController.duration;
      if (!duration || !videoEncoderConfig.framerate) {
        return;
      }
      const spf = 1e3 / videoEncoderConfig.framerate;
      const num = Math.ceil(duration / spf);
      // 第一帧特殊处理，可能当前就是第一帧且已经渲染完
      this.aniController.gotoAndStop(0);
      let i = 0;
      if (this.contentLoadingCount) {
        i = 0;
      }
      else {
        i = 1;
        const bitmap = await createImageBitmap(this.canvas);
        const videoFrame = new VideoFrame(bitmap, {
          timestamp: 0,
          duration: spf,
        });
        worker.postMessage({
          type: EncoderType.VIDEO_FRAME,
          videoFrame,
        }, [videoFrame]);
        await new Promise<void>(resolve => {
          worker.onmessage = (e: MessageEvent<{
            type: EncoderEvent,
            buffer: ArrayBuffer,
          }>) => {
            if (e.data.type === EncoderEvent.PROGRESS) {
              resolve();
            }
          };
        });
      }
      for (; i < num; i++) {
        const timestamp = i * spf;
        console.log('encode', i, num, timestamp);
        this.aniController.gotoAndStop(timestamp);
        await new Promise<void>(resolve => {
          const cb = async () => {
            const bitmap = await createImageBitmap(this.canvas!);
            const videoFrame = new VideoFrame(bitmap, {
              timestamp: timestamp * 1e3,
              duration: spf * 1e3,
            });
            worker.postMessage({
              type: EncoderType.VIDEO_FRAME,
              videoFrame,
            }, [videoFrame]);
            worker.onmessage = (e: MessageEvent<{
              type: EncoderEvent,
              buffer: ArrayBuffer,
            }>) => {
              if (e.data.type === EncoderEvent.PROGRESS) {
                resolve();
              }
            };
          };
          // 可能没有刷新
          if (this.rl === RefreshLevel.NONE) {
            cb();
          }
          else {
            this.once(REFRESH_COMPLETE, cb);
          }
        });
      }
      return new Promise<ArrayBuffer>(resolve => {
        worker.postMessage({
          type: EncoderType.END,
        });
        worker.onmessage = (e: MessageEvent<{
          type: EncoderEvent,
          buffer: ArrayBuffer,
        }>) => {
          if (e.data.type === EncoderEvent.FINISH) {
            resolve(e.data.buffer);
          }
        };
      });
    }
  }
}

export default Root;
