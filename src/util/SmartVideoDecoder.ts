import Event from './Event';
import config from '../config';
import { AudioChunk, GOPState, Mp4boxEvent, Mp4boxType, SimpleGOP, VideoAudioMeta, } from '../mp4box';

export enum SmartVideoDecoderEvent {
  META = 'meta',
  RANGE_LOADED = 'range_loaded',
  LOADED = 'loaded',
  ERROR = 'error',
  PROGRESS = 'progress',
  CANPLAY = 'canplay',
  AUDIO_BUFFER = 'audio_buffer',
}

export { GOPState, VideoAudioMeta };

export enum LoadState {
  NONE = 0,
  LOADING_META = 1,
  META = 2,
  PART_LOADED = 3,
  RANGE_INIT = 4,
  LOADED = 5,
  ERROR = 6,
}

export type CacheGOP = SimpleGOP & {
  state: GOPState,
  videoFrames: VideoFrame[],
  audioBuffer?: AudioBuffer,
  audioBufferSourceNode?: AudioBufferSourceNode,
  users: SmartVideoDecoder[],
};

type Cache = {
  state: LoadState,
  metaList: [SmartVideoDecoder], // meta加载完之前所有尝试加载meta的等待队列
  loadList: [SmartVideoDecoder], // meta之后的队列
  meta: VideoAudioMeta,
  gopList: CacheGOP[],
  error?: string,
  count: number;
};

const HASH: Record<string, Cache> = {};

let worker: Worker;
let id = 0;
let messageId = 0;

export class SmartVideoDecoder extends Event {
  url: string;
  id: number;
  currentTime: number; // 当前解析的时间
  gopIndex: number; // 当前区域索引

  constructor(url: string) {
    super();
    this.url = url;
    this.id = id++;
    this.currentTime = -Infinity;
    this.gopIndex = -1;
  }

  initWorker() {
    if (worker) {
      return;
    }
    if (config.mp4boxWorker) {
      worker = new Worker(config.mp4boxWorker);
    }
    else if (config.mp4boxWorkerStr) {
      const blob = new Blob([config.mp4boxWorkerStr.trim()], { 'type': 'application/javascript' });
      const url = URL.createObjectURL(blob);
      worker = new Worker(url);
    }
    else {
      throw new Error('Missing mp4boxWorker config');
    }
    worker.onmessage = (event: MessageEvent<{
      url: string,
      id: number,
      type: Mp4boxEvent,
      data: any,
    }>) => {
      const { url, type, data } = event.data;
      const cache = HASH[url];
      // 预防，应该不会，除非release()了
      if (!cache) {
        return;
      }
      if (type === Mp4boxEvent.META) {
        cache.state = LoadState.META;
        cache.meta = data.meta;
        cache.gopList = data.simpleGOPList.map((item: SimpleGOP) => {
          return {
            ...item,
            state: GOPState.NONE,
            videoFrames: [],
            users: [],
          };
        });
        cache.metaList.splice(0).forEach(item => {
          // 设置gopIndex
          item.start(item.currentTime);
          item.emit(SmartVideoDecoderEvent.META, data.meta);
        });
      }
      // 仅降级整体加载才会出现，每个区域都是LOADED状态
      else if (type === Mp4boxEvent.LOADED) {
        cache.gopList.forEach((item) => {
          item.state = GOPState.LOADED;
        });
        cache.state = LoadState.LOADED;
        cache.loadList.splice(0).forEach(item => {
          item.process(item.currentTime);
        });
      }
      // 目前的降级分段顺序加载
      else if (type === Mp4boxEvent.PART_LOADED) {
        cache.state = LoadState.PART_LOADED;
        cache.gopList[data].state = GOPState.LOADED;
        cache.loadList.forEach(item => {
          if (item.gopIndex === data) {
            item.process(item.currentTime);
          }
        });
      }
      // else if (type === Mp4boxEvent.PART_LOADED_ALL) {
      //   cache.state = LoadState.LOADED;
      //   cache.loadList.splice(0).forEach(item => {
      //     // item.emit(SmartVideoDecoderEvent.LOADED, data);
      //   });
      // }
      // 支持range加载的情况，meta之后传递解码信息，samples为空长度已预先定义好
      // else if (type === Mp4boxEvent.RANGE_INIT) {
      //   cache.state = LoadState.RANGE_INIT;
      //   // cache.originData = data;
      //   // 虽然没有数据，但进入后只走设置区域索引逻辑
      //   cache.loadList.forEach(item => {
      //     item.start(item.currentTime);
      //   });
      // }
      // // 支持range加载的情况，range已加载好传递来数据
      // else if (type === Mp4boxEvent.RANGE_LOADED) {
      //   if (data.video) {
      //     const { index, samples } = data.video;
      //     // const framesArea = cache.data.framesAreas[index];
      //     // if (framesArea) {
      //     //   framesArea.state = FramesAreaState.LOADED;
      //     //   const videoSampleIndex = framesArea.videoSampleIndex;
      //     //   samples.forEach((item: any, i: number) => {
      //     //     cache.originData.video!.samples[i + videoSampleIndex] = item;
      //     //   });
      //     //   // 判断每个decoder的currentTime是否符合，才发送事件通知，可能有的在其它区域
      //     //   cache.loadList.forEach(item => {
      //     //     if (item.framesAreaIndex === index) {
      //     //       item.start(item.currentTime);
      //     //     }
      //     //   });
      //     // }
      //   }
      // }
      else if (type === Mp4boxEvent.DECODED) {
        const gop = cache.gopList[data.index];
        if (gop) {
          gop.state = GOPState.DECODED;
          gop.videoFrames = data.videoFrames;
          if (data.audioChunks.length) {
            const totalFrames = data.audioChunks.reduce((sum: number, item: AudioChunk) => sum + item.numberOfFrames, 0);
            const audioContext = new AudioContext();
            const audioBuffer = audioContext.createBuffer(data.audioChunks[0].channels.length, totalFrames, data.sampleRate);
            let offset = 0;
            data.audioChunks.forEach((item: AudioChunk) => {
              for (let ch = 0; ch < item.channels.length; ch++) {
                const channelData = audioBuffer.getChannelData(ch);
                channelData.set(item.channels[ch], offset);
              }
              offset += item.numberOfFrames;
            });
            gop.audioBuffer = audioBuffer;
            audioContext.close();
          }
          gop.users.forEach(item => {
            if (item.gopIndex === gop.index) {
              item.emit(SmartVideoDecoderEvent.CANPLAY, gop);
            }
            // 后续的gop音频添加通知
            if (item.gopIndex < gop.index) {
              item.emit(SmartVideoDecoderEvent.AUDIO_BUFFER, gop);
            }
          });
        }
      }
      else if (type === Mp4boxEvent.ERROR) {
        const state = cache.state;
        cache.state = LoadState.ERROR;
        cache.error = data;
        if (state === LoadState.LOADING_META) {
          cache.metaList.splice(0);
          cache.loadList.splice(0).forEach(item => {
            item.emit(SmartVideoDecoderEvent.ERROR, data);
          });
        }
        else {}
      }
    };
  }

  /**
   * 统一开始解码入口，自动根据状态进行初始化、加载、meta、解码等操作，
   * range加载情况下还会优化当前区域索引等，负责worker的唯一初始化和通信逻辑。
   * @param time
   */
  start(time: number) {
    this.initWorker();
    this.currentTime = time;
    const { url, id } = this;
    const cache = HASH[url];
    if (cache) {
      // 重复设置currentTime，还在读meta要忽略
      if (cache.state === LoadState.LOADING_META) {
        if (!cache.metaList.includes(this)) {
          cache.metaList.push(this);
          cache.loadList.push(this);
          cache.count++;
        }
      }
      else if (cache.state === LoadState.META) {
        // 无论是整体加载还是分段加载，所有的都存入loadList一起处理
        if (!cache.loadList.includes(this)) {
          cache.loadList.push(this);
          cache.count++;
        }
        this.gopIndex = this.getForwardsNearestGOPIndex(time);
      }
      // 一般是播放中不停调用，检查下一个gop预加载解码
      else if (cache.state === LoadState.PART_LOADED) {
        if (!cache.loadList.includes(this)) {
          cache.loadList.push(this);
          cache.count++;
        }
        this.process(time);
      }
      // 只可能是支持range的情况，目前没有
      // else if (cache.state === LoadState.RANGE_INIT) {
      //   if (!cache.loadList.includes(this)) {
      //     cache.loadList.push(this);
      //     cache.count++;
      //   }
      // }
      // 只可能是降级情况才会整体加载完成
      else if (cache.state === LoadState.LOADED) {
        if (!cache.loadList.includes(this)) {
          cache.loadList.push(this);
          cache.count++;
        }
        this.process(time);
      }
      else if (cache.state === LoadState.ERROR) {
        this.emit(SmartVideoDecoderEvent.ERROR, cache.error);
      }
      return;
    }
    HASH[url] = {
      state: LoadState.LOADING_META,
      metaList: [this],
      loadList: [this],
      meta: {
        duration: 0,
        fileSize: 0,
        supportRange: false,
      },
      gopList: [],
      count: 1,
    };
    worker.postMessage({
      url,
      id,
      type: Mp4boxType.META,
      messageId: messageId++,
    });
  }

  /**
   * 开始处理解码逻辑，当区域加载已完成时调用，会根据策略自动释放不需要部分的帧数据，
   * 加载解码后续即将播放的区域，不需要的地方也会取消加载（如有）。
   * @param time
   */
  process(time: number) {
    if (time < -config.decodeDuration) {
      this.releaseGOPList();
      return;
    }
    const cache = HASH[this.url];
    // 理论不会，预防被回收
    if (!cache || cache.state === LoadState.NONE || cache.state === LoadState.LOADING_META) {
      return;
    }
    const duration = cache.meta.duration;
    const gopList = cache.gopList;
    if (!gopList.length) {
      return;
    }
    if (time >= duration + config.decodeDuration) {
      this.releaseGOPList();
      return;
    }
    // 查找最近前置关键帧，从关键帧开始解析，直到下一个关键帧为止
    const gopIndex = this.getForwardsNearestGOPIndex(time);
    this.gopIndex = gopIndex;
    const gop = gopList[gopIndex];
    if (!gop) {
      return;
    }
    // const isRange = cache.state === LoadState.RANGE_INIT;
    // const isDowngrade = cache.state === LoadState.PART_INIT;
    // 降级模式整体已经加载；或者支持range的停留在meta状态；或者降级range分段一口气加载状态
    // if (cache.state === LoadState.LOADED || gop.state === GOPState.LOADED || gop.state === GOPState.DECODING) {
      // 支持range则类似上述逻辑，但用另外一个DUR间隔，预加载后面的数据，取消其它部分的预加载（可能加载完成无效）
      // if (isRange) {
      //   for (let i = gopIndex - 1; i >= 0; i--) {
      //     const gop = gopList[i];
      //     if (gop
      //       // 向前特殊还是用decodeDuration，向后用preloadDuration
      //       && ((gop.relativeCts + gop.duration) < (time - config.decodeDuration) * 1000)
      //       && (gop.state === GOPState.NONE || gop.state === GOPState.LOADING)) {
      //       this.cancelLoadGOP(gop);
      //     }
      //   }
      //   for (let i = gopIndex + 1, len = gopList.length; i < len; i++) {
      //     const gop = gopList[i];
      //     if (gop
      //       && gop.relativeCts < (time + config.preloadDuration) * 1000) {
      //       this.loadGOP(gop);
      //     }
      //     else if (gop
      //       && gop.relativeCts >= (time + config.preloadDuration) * 1000) {
      //       this.cancelLoadGOP(gop);
      //     }
      //   }
      // }
    // }
    this.decodeGOP(gop);
    // 视频不停播放，currentTime不断更新调用，向后看currentTime+DUR以内的FramesArea也需要预加载，
    // 向前看currentTime-DUR以外的FramesArea释放清空，另外可能时间轴会跳跃任意值，向后看currentTime+DUR以外的也释放清空
    for (let i = gopIndex - 1; i >= 0; i--) {
      const gop = gopList[i];
      if (gop && ((gop.relativeCts + gop.duration) < (time - config.decodeDuration) * 1000)) {
        this.releaseGOP(gop);
      }
    }
    for (let i = gopIndex + 1, len = gopList.length; i < len; i++) {
      const gop = gopList[i];
      if (gop && gop.relativeCts < (time + config.decodeDuration) * 1000) {
        this.decodeGOP(gop);
      }
      else if (gop && gop.relativeCts >= (time + config.decodeDuration) * 1000) {
        this.releaseGOP(gop);
      }
    }
  }

  getForwardsNearestGOPIndex(time: number) {
    const cache = HASH[this.url];
    const duration = cache.meta.duration;
    const gopList = cache.gopList;
    // 超过duration+DUR限制为空，DUR是为了防止精度计算导致最后一帧时间不太准确找不到正确索引
    if (time < -config.decodeDuration || !gopList.length || time > duration + config.decodeDuration) {
      return -1;
    }
    if (gopList.length === 1 || time <= 0) {
      return 0;
    }
    if (time > duration) {
      return gopList.length - 1;
    }
    let i = 0, j = gopList.length - 1;
    while (i < j) {
      if (i === j - 1) {
        const cts = gopList[j].relativeCts;
        if (cts <= time * 1000) {
          return j;
        }
        return i;
      }
      const mid = i + ((j - i) >> 1);
      const cts = gopList[mid].relativeCts;
      if (cts === time * 1000) {
        return mid;
      }
      if (cts > time * 1000) {
        j = Math.max(mid - 1, i + 1);
      }
      else {
        i = Math.min(mid, j - 1);
      }
    }
    return -1;
  }

  getFrameByTime(time: number) {
    const cache = HASH[this.url];
    const duration = cache.meta.duration;
    const gopList = cache.gopList;
    if (time < 0 || !gopList.length || time > duration + config.decodeDuration) {
      return;
    }
    let gop: CacheGOP | undefined;
    // 先查找到当前framesArea，如果time超过整体时长+DUR则无效，
    // 此举是因为chunks的duration可能和video的duration存在计算误差，另外时间轴上也可能存在显示误差，
    // 防止时间轴指向最后一帧时但却因为误差导致无法找到当前framesArea不显示。
    if (gopList.length === 1) {
      gop = gopList[0];
    }
    else {
      const i = this.getForwardsNearestGOPIndex(time);
      if (i > -1) {
        gop = gopList[i];
      }
    }
    if (gop) {
      const list = gop.videoFrames;
      if (!list.length) {
        return;
      }
      if (list.length === 1) {
        return list[0];
      }
      const start = cache.meta.video!.startCts || 0;
      let i = 0, j = list.length - 1;
      while (i < j) {
        if (i === j - 1) {
          const item = list[j];
          const cts = item.timestamp - start;
          // 由于解码按顺序的缘故，可能当前时间的帧还未解得，此时获取到的是前面的某帧，不能展示
          if (cts <= time * 1000) {
            if (item.duration && cts + item.duration > time * 1000
              || j === gop.videoLength - 1) {
              return item;
            }
            // 防止精度计算问题，时间在下一帧之前都是本帧
            const next = list[j + 1];
            if (next && next.timestamp - start > time * 1000) {
              return item;
            }
            return;
          }
          return list[i];
        }
        const mid = i + ((j - i) >> 1);
        const item = list[mid];
        const cts = item.timestamp - start;
        if (cts === time * 1000 || cts < time * 1000 && (cts + (item.duration || 0)) > time * 1000) {
          return list[mid];
        }
        if (cts > time * 1000) {
          j = Math.max(mid - 1, i + 1);
        }
        else {
          i = Math.min(mid, j - 1);
        }
      }
    }
  }

  decodeGOP(gop: CacheGOP) {
    // 理论不会，预防，只有加载成功后才会进入解码状态
    if (gop.state === GOPState.NONE || gop.state === GOPState.LOADING || gop.state === GOPState.ERROR) {
      return;
    }
    // 线程异步可能别的gop解码完成了
    if (gop.state === GOPState.DECODED) {
      return;
    }
    // 剩下只有可能LOADED或者DECODING状态了，去重记录发起方id
    if (!gop.users.includes(this)) {
      gop.users.push(this);
    }
    else {
      return;
    }
    gop.state = GOPState.DECODING;
    gop.videoFrames.splice(0).forEach(item => item.close());
    if (gop.audioBufferSourceNode) {
      gop.audioBufferSourceNode.stop();
      gop.audioBufferSourceNode.disconnect();
      gop.audioBufferSourceNode = undefined;
    }
    gop.audioBuffer = undefined;
    worker.postMessage({
      url: this.url,
      type: Mp4boxType.DECODE,
      id: this.id,
      index: gop.index,
      messageId: messageId++,
    });
  }

  loadGOP(gop: CacheGOP) {
    const { url, id } = this;
    const cache = HASH[url];
    if (!cache
      || gop.state === GOPState.LOADED
      || gop.state === GOPState.DECODING
      || gop.state === GOPState.DECODED) {
      return;
    }
    gop.state = GOPState.LOADING;
    worker.postMessage({
      url,
      id,
      type: Mp4boxType.LOAD_RANGE,
      messageId: messageId++,
      index: gop.index,
    });
  }

  cancelLoadGOP(gop: CacheGOP) {
    const { url, id } = this;
    const cache = HASH[url];
    if (!cache
      || gop.state === GOPState.LOADED
      || gop.state === GOPState.DECODING
      || gop.state === GOPState.DECODED) {
      return;
    }
    gop.state = GOPState.NONE;
    worker.postMessage({
      url,
      id,
      type: Mp4boxType.CANCEL_LOAD_RANGE,
      messageId: messageId++,
      index: gop.index,
    });
  }

  releaseGOP(gop: CacheGOP) {
    const i = gop.users.indexOf(this);
    if (i > -1) {
      gop.users.splice(i, 1);
      if (!gop.users.length) {
        // 可能还在加载中，只有解码状态才会切回LOADED
        if (gop.state === GOPState.DECODING || gop.state === GOPState.DECODED) {
          gop.state = GOPState.LOADED;
        }
        gop.videoFrames.splice(0).forEach(frame => frame.close());
        gop.audioBufferSourceNode?.stop();
        gop.audioBufferSourceNode?.disconnect();
        gop.audioBuffer = undefined;
      }
      worker.postMessage({
        url: this.url,
        type: Mp4boxType.RELEASE,
        id: this.id,
        index: gop.index,
        messageId: messageId++,
      });
    }
  }

  releaseGOPList() {
    const cache = HASH[this.url];
    cache.gopList.forEach(item => {
      this.releaseGOP(item);
    });
  }

  release() {
    this.releaseGOPList();
    const cache = HASH[this.url];
    if (!cache) {
      throw new Error('Unknown release url: ' + this.url);
    }
    let i = cache.metaList.indexOf(this);
    if (i > -1) {
      cache.metaList.splice(i, 1);
    }
    i = cache.loadList.indexOf(this);
    if (i > -1) {
      cache.loadList.splice(i, 1);
    }
    cache.count--;
    if (!cache.count) {
      delete HASH[this.url];
    }
  }

  get gopList() {
    return HASH[this.url]?.gopList;
  }

  get currentGOP() {
    return HASH[this.url]?.gopList[this.gopIndex];
  }

  static SmartVideoDecoderEvent = SmartVideoDecoderEvent;
}

export default SmartVideoDecoder;
