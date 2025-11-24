import Root from '../node/Root';
import Lottie from '../node/Lottie';
import Event from './Event';
import config from '../config';
import { EncoderEvent, EncoderType, onMessage } from '../encoder';
import { CAN_PLAY } from '../refresh/refreshEvent';
import TimeAnimation from '../animation/TimeAnimation';
import MbVideoDecoder from './MbVideoDecoder';
import { sliceAudioBuffer } from './sound';

let worker: Worker;
let noWorker = false;
let messageId = 0;
let instance: MbVideoEncoder | undefined;

export enum MbVideoEncoderEvent {
  START = 'start',
  PROGRESS = 'progress',
  FINISH = 'finish',
  ERROR = 'error',
}

export class MbVideoEncoder extends Event {
  constructor() {
    super();
  }

  private initWorker() {
    if (worker) {
      return;
    }
    if (config.encoderWorker) {
      worker = new Worker(config.encoderWorker);
    }
    else if (config.encoderWorkerStr) {
      const blob = new Blob([config.encoderWorkerStr.trim()], { 'type': 'application/javascript' });
      const url = URL.createObjectURL(blob);
      worker = new Worker(url);
    }
    else {
      // noWorker = true;
    }
  }

  async start(root: Root, cfg?: { duration?: number, video?: Partial<VideoEncoderConfig>, audio?: Partial<AudioEncoderConfig> }) {
    if (!root.canvas) {
      throw new Error('Root Missing appendTo canvas');
    }
    this.initWorker();
    const videoEncoderConfig: VideoEncoderConfig = Object.assign({
      codec: 'avc1.420028', // H.264 Baseline Profile (广泛兼容)
      width: root.width,
      height: root.height,
      bitrate: 5_000_000, // 5 Mbps (高画质)
      bitrateMode: 'variable',
      framerate: 30,
      hardwareAcceleration: 'no-preference',
    }, cfg?.video);
    const support = await VideoEncoder.isConfigSupported(videoEncoderConfig);
    if (!support || !support.supported) {
      throw new Error('Unsupported video encoder config');
    }
    const audioEncoderConfig: AudioEncoderConfig = Object.assign({
      codec: 'opus',
      sampleRate: 44100,
      numberOfChannels: 2,
    }, cfg?.audio);
    // 计算帧数和时间，每次走一帧的时间渲染
    const duration = cfg?.duration || root.aniController.duration;
    if (!duration || !videoEncoderConfig.framerate) {
      return;
    }
    const spf = 1e3 / videoEncoderConfig.framerate;
    const num = Math.ceil(duration / spf);
    const mes = {
      type: EncoderType.INIT,
      messageId: messageId++,
      isWorker: !!config.encoderWorker || !!config.encoderWorkerStr,
      duration,
      videoEncoderConfig,
      audioEncoderConfig,
      mute: config.mute,
    };
    if (worker) {
      worker.postMessage(mes);
    }
    else {
      await onMessage({ data: mes } as any);
    }
    this.emit(MbVideoEncoderEvent.START, num);
    // 初始化decoder的音频间隔
    MbVideoDecoder.spf = spf;
    // 记录每个node的当前时间的音频有没有提取过，避免encode重复，已node的id+时间做key
    const audioRecord: Record<string, true> = {};
    // 先跳到后面某帧，随后从第一帧开始，以便触发音频解码
    root.aniController.gotoAndStop(1000);
    for (let i = 0; i < num; i++) {
      const timestamp = i * spf;
      root.aniController.gotoAndStop(timestamp);
      // console.log('encode', i, num, timestamp);
      this.emit(MbVideoEncoderEvent.PROGRESS, i, num, true);
      await new Promise<void>((resolve, reject) => {
        const cb = async () => {
          const bitmap = await createImageBitmap(root.canvas!);
          const videoFrame = new VideoFrame(bitmap, {
            timestamp: timestamp * 1e3,
            duration: spf * 1e3,
          });
          let audioBuffers: { id: number, data: AudioBuffer, volume: number, timestamp: number }[] = [];
          root.aniController.aniList.forEach(item => {
            const { delay, duration } = item;
            // 范围内的声音才有效
            if (item instanceof TimeAnimation
              && item.currentTime >= delay
              && item.currentTime < duration + delay
            ) {
              const node = item.node;
              if (node instanceof Lottie || !node.volumn) {
                return;
              }
              const decoder = node.decoder;
              if (!decoder) {
                return;
              }
              const gop = decoder.currentGOP;
              if (!gop) {
                return;
              }
              const audioBuffer = gop.audioBuffer;
              if (!audioBuffer) {
                return;
              }
              const key = node.id + '-' + gop.index;
              if (audioRecord[key]) {
                return;
              }
              audioRecord[key] = true;
              const diff = gop.audioTimestamp - gop.timestamp;
              if (gop.audioTimestamp + gop.audioDuration > item.duration) {
                audioBuffers.push({ id: node.id, data: sliceAudioBuffer(audioBuffer, 0, item.duration - gop.audioTimestamp), volume: node.volumn, timestamp: timestamp + diff });
              }
              else {
                audioBuffers.push({ id: node.id, data: audioBuffer, volume: node.volumn, timestamp: timestamp + diff });
              }
            }
          });
          const cb = (e: MessageEvent<{
            type: EncoderEvent,
            buffer: ArrayBuffer,
            error: string,
          }>) => {
            if (e.data.type === EncoderEvent.PROGRESS) {
              resolve();
              this.emit(MbVideoEncoderEvent.PROGRESS, i, num, false);
            }
            else {
              reject(e.data.error);
              this.emit(MbVideoEncoderEvent.ERROR, e.data.error);
            }
          };
          const mes = {
            type: EncoderType.FRAME,
            messageId: messageId++,
            isWorker: !!config.encoderWorker || !!config.encoderWorkerStr,
            timestamp,
            videoFrame,
            audioBuffers,
            audioEncoderConfig,
            mute: config.mute,
          };
          if (worker) {
            worker.onmessage = cb;
            worker.postMessage(
              mes,
              // @ts-ignore
              [videoFrame] as Transferable,
            );
          }
          else {
            onMessage({ data: mes } as any).then(res => {
              cb(res as any);
            });
          }
        };
        // 可能没有刷新
        if (root.contentLoadingCount) {
          root.once(CAN_PLAY, cb);
        }
        else {
          cb();
        }
        // if (root.rl === RefreshLevel.NONE) {
        //   cb();
        // }
        // else {
        //   root.once(REFRESH_COMPLETE, cb);
        // }
      });
    }
    return new Promise<ArrayBuffer>(resolve => {
      const cb = (e: MessageEvent<{
        type: EncoderEvent,
        buffer: ArrayBuffer,
      }>) => {
        if (e.data.type === EncoderEvent.FINISH) {
          resolve(e.data.buffer);
        }
        this.emit(MbVideoEncoderEvent.FINISH);
      };
      const mes = {
        type: EncoderType.END,
        messageId: messageId++,
        isWorker: !!config.encoderWorker || !!config.encoderWorkerStr,
      };
      if (worker) {
        worker.onmessage = cb;
        worker.postMessage(mes);
      }
      else {
        onMessage({ data: mes } as any).then(res => {
          cb(res as any);
        });
      }
    });
  }

  static getInstance() {
    if (!instance) {
      instance = new MbVideoEncoder();
    }
    return instance;
  }
}

export default MbVideoEncoder;
