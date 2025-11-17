let max = 2048;
let manual = false;
let MAX_TEXTURE_SIZE = max;
let hasInit = false;

export default {
  debug: false,
  offscreenCanvas: false,
  get maxTextureSize() { // 系统纹理块尺寸限制记录，手动优先级>自动，默认2048自动不能超过
    return max;
  },
  set maxTextureSize(v: number) {
    if (hasInit) {
      max = Math.min(v, MAX_TEXTURE_SIZE);
    }
    else {
      max = v;
    }
    manual = true;
  },
  get MAX_TEXTURE_SIZE() {
    return MAX_TEXTURE_SIZE;
  },
  MAX_TEXTURE_UNITS: 8,
  MAX_VARYING_VECTORS: 15,
  // 初始化root的时候才会调用
  init(maxSize: number, maxUnits: number, maxVectors: number) {
    if (!manual) {
      max = Math.min(max, maxSize);
    }
    // 手动事先设置了超限的尺寸需缩小
    else if (maxSize < max) {
      max = maxSize;
    }
    hasInit = true;
    MAX_TEXTURE_SIZE = maxSize;
    this.MAX_TEXTURE_UNITS = maxUnits;
    this.MAX_VARYING_VECTORS = maxVectors;
  },
  historyTime: 1000, // 添加历史记录时命令之间是否合并的时间差阈值
  mp4boxWorker: '',
  mp4boxWorkerStr: '',
  decoderWorker: '',
  decoderWorkerStr: '',
  encoderWorker: '',
  encoderWorkerStr: '',
  decodeDuration: 2, // 距离多久s内开始预解码下一关键帧区域、释放上一关键帧区域
  preloadDuration: 8000, // 距离多久s内开始预加载下一关键帧区域
  loadLimit: 1024 * 1024 * 8, // 多小尺寸不分段而是直接请求，如果是0则整段加载
  gopMinDuration: 4, // 低于多少s的gop合并成一个大的逻辑gop一口气处理加载解码，防止碎片化影响性能
  preloadAll: false, // 是否全部加载模式而不是默认分段，在服务端合成时适用
  singleSample: false, // 单帧模式，服务端合成时内存资源紧张，使用单帧解码再合成
};
