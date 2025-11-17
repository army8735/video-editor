import {
  ALL_FORMATS,
  Input,
  UrlSource,
  StreamSource,
  EncodedPacketSink,
  InputVideoTrack,
  InputAudioTrack,
  VideoSampleSink,
  AudioSampleSink,
} from 'mediabunny';
import { loadRange } from './util/loadRangeCache';

export enum DecoderType {
  META = 0,
  DECODE = 1,
  DECODE_SINGLE = 2,
  RELEASE = 3,
}

export enum DecoderEvent {
  META = 'meta',
  ERROR = 'error',
  DECODED = 'decoded',
  DECODED_SINGLE = 'decoded_single',
}

export enum GOPState {
  NONE = 0,
  DECODING = 1,
  DECODED = 2,
  DECODED_SINGLE = 3,
  ERROR = 4,
}

export type AudioChunk = { channels: Float32Array[], numberOfFrames: number };

export type GOP = {
  state: GOPState,
  index: number,
  sequenceNumber: number,
  timestamp: number,
  duration: number,
  users: number[], // smartVideoDecoder的id
};

export type SimpleGOP = Pick<GOP,
  'index' |
  'sequenceNumber' |
  'timestamp' |
  'duration'
>;

export type VideoAudioMeta = {
  video?: {
    id: number,
    languageCode: string,
    codec: string | null,
    name: string | null,
    codedWidth: number,
    codedHeight: number,
    displayWidth: number,
    displayHeight: number,
    width: number,
    height: number,
    timeResolution: number,
    rotation: number,
    timestamp: number,
    duration: number,
  },
  audio?: {
    id: number,
    languageCode: string,
    codec: string | null,
    name: string | null,
    numberOfChannels: number,
    sampleRate: number,
    timestamp: number,
    duration: number,
  },
  duration: number,
  fileSize: number;
};

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type FileData = {
  videoTrack?: InputVideoTrack,
  audioTrack?: InputAudioTrack,
  gopList: GOP[],
};

const FILE_HASH: Record<string, FileData> = {};

self.onmessage = async (e: MessageEvent<{
  url: string,
  id: number,
  type: DecoderType,
  messageId: number,
  preloadAll: boolean,
  gopMinDuration: number,
  time: number,
  index: number,
  singleSample: boolean,
}>) => {
  const { url, id, type } = e.data;
  // console.log('decoder', url, id, type);
  const onError = (e: string) => {
    self.postMessage({
      url,
      type: DecoderEvent.ERROR,
      data: e,
    });
  };
  if (!FILE_HASH[url]) {
    FILE_HASH[url] = {
      gopList: [],
    };
  }
  const fileData = FILE_HASH[url];
  if (type === DecoderType.META) {
    // 先请求文件大小，这个有304缓存
    const headResponse = await fetch(url, { method: 'HEAD' });
    const cl = headResponse.headers.get('content-length');
    if (!cl || headResponse.status !== 200 && headResponse.status !== 304) {
      onError('Unknown content-length');
      return;
    }
    const fileSize = parseInt(cl);
    // 解封装的基础信息
    const meta: VideoAudioMeta = {
      duration: 0,
      fileSize: fileSize,
    };
    let source: UrlSource | StreamSource;
    if (e.data.preloadAll) {
      source = new UrlSource(url);
    }
    else {
      source = new StreamSource({
        read: async (start, end) => {
          // console.warn(start, end);
          const { arrayBuffer } = await loadRange(url, start, end - 1);
          if (!arrayBuffer) {
            throw new Error('Missing buffer in range: ' + start + '-' + (end - 1));
          }
          return new Uint8Array(arrayBuffer);
        },
        getSize: async () => {
          return fileSize;
        },
        prefetchProfile: 'network',
      });
    }
    const input = new Input({
      formats: ALL_FORMATS,
      source,
    });
    const data = await input.computeDuration();
    meta.duration = data;
    const videoTrack = await input.getPrimaryVideoTrack();
    if (videoTrack) {
      fileData.videoTrack = videoTrack;
      const duration = await videoTrack.computeDuration();
      const sink = new EncodedPacketSink(videoTrack);
      for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
        if (packet.type === 'key') {
          // 前一个区域的结束信息计算，碎片GOP合并一起做了
          const len = fileData.gopList.length;
          if (len) {
            const last = fileData.gopList[len - 1];
            // 这个GOP太短合并
            if (e.data.gopMinDuration && packet.timestamp - last.timestamp < e.data.gopMinDuration) {
              continue;
            }
            last.duration = packet.timestamp - last.timestamp;
          }
          fileData.gopList.push({
            state: GOPState.NONE,
            index: fileData.gopList.length,
            sequenceNumber: packet.sequenceNumber,
            timestamp: packet.timestamp,
            duration: packet.duration,
            users: [],
          });
        }
      }
      // 最后一个用整体时长计算
      const len = fileData.gopList.length;
      if (len) {
        const last = fileData.gopList[len - 1];
        last.duration = duration - last.timestamp;
      }
      const timestamp = await videoTrack.getFirstTimestamp();
      meta.video = {
        id: videoTrack.id,
        languageCode: videoTrack.languageCode,
        codec: videoTrack.codec,
        name: videoTrack.name,
        codedWidth: videoTrack.codedWidth,
        codedHeight: videoTrack.codedHeight,
        displayWidth: videoTrack.displayWidth,
        displayHeight: videoTrack.displayHeight,
        width: videoTrack.displayWidth,
        height: videoTrack.displayHeight,
        timeResolution: videoTrack.timeResolution,
        rotation: videoTrack.rotation,
        timestamp,
        duration,
      };
    }
    const audioTrack = await input.getPrimaryAudioTrack();
    if (audioTrack) {
      fileData.audioTrack = audioTrack;
      const duration = await audioTrack.computeDuration();
      const timestamp = await audioTrack.getFirstTimestamp();
      meta.audio = {
        id: audioTrack.id,
        languageCode: audioTrack.languageCode,
        codec: audioTrack.codec,
        name: audioTrack.name,
        numberOfChannels: audioTrack.numberOfChannels,
        sampleRate: audioTrack.sampleRate,
        timestamp,
        duration,
      };
      // 没有视频仅有音频的特殊视频文件，用音频轨道虚拟出gop列表
      if (!videoTrack) {
        // const sink = new EncodedPacketSink(audioTrack);
      }
    }
    const simpleGOPList: SimpleGOP[] = fileData.gopList.map(item => {
      return {
        index: item.index,
        sequenceNumber: item.sequenceNumber,
        timestamp: item.timestamp,
        duration: item.duration,
      };
    });
    self.postMessage({
      url,
      type: DecoderEvent.META,
      data: { meta, simpleGOPList },
    });
  }
  else if (type === DecoderType.DECODE) {
    const gop = fileData.gopList[e.data.index];
    // 理论不会，预防，只有加载成功后才会进入解码状态
    if (!gop || gop.state === GOPState.ERROR) {
      return;
    }
    // 线程异步可能别的gop解码完成了
    if (gop.state === GOPState.DECODED) {
      return;
    }
    // 剩下只有可能NONE或DECODING状态了，去重记录发起方id
    if (!gop.users.includes(id)) {
      gop.users.push(id);
    }
    // 截流，先等待一段时间，防止如频繁拖动时间轴，再检查是否被release移除users
    await sleep(100);
    if (!gop.users.includes(id)) {
      return;
    }
    // 防止异步线程
    // @ts-ignore
    if (gop.state === GOPState.DECODING || gop.state === GOPState.DECODED) {
      return;
    }
    gop.state = GOPState.DECODING;
    const videoFrames: VideoFrame[] = [];
    if (fileData.videoTrack) {
      const sink = new VideoSampleSink(fileData.videoTrack);
      for await (const sample of sink.samples(gop.timestamp, gop.timestamp + gop.duration)) {
        videoFrames.push(sample.toVideoFrame());
        sample.close();
      }
    }
    const audioChunks: AudioChunk[] = [];
    let sampleRate = 0;
    if (fileData.audioTrack) {
      const sink = new AudioSampleSink(fileData.audioTrack);
      for await (const sample of sink.samples(gop.timestamp, gop.timestamp + gop.duration)) {
        sampleRate = sample.sampleRate;
        const { numberOfChannels, numberOfFrames } = sample;
        const channels: Float32Array[] = [];
        for (let ch = 0; ch < numberOfChannels; ch++) {
          const tmp = new Float32Array(numberOfFrames);
          sample.copyTo(tmp, { planeIndex: ch, format: sample.format });
          channels.push(tmp);
        }
        audioChunks.push({
          channels,
          numberOfFrames,
        });
        sample.close();
      }
    }
    // 防止被释放
    if (gop.state !== GOPState.DECODING) {
      videoFrames.forEach(item => {
        item.close();
      });
      return;
    }
    gop.state = GOPState.DECODED;
    const transferList: Transferable[] = (videoFrames as Transferable[]).slice(0);
    audioChunks.forEach(item => {
      item.channels.forEach(item => {
        transferList.push(item.buffer);
      });
    });
    self.postMessage({
      url,
      type: DecoderEvent.DECODED,
      data: {
        index: e.data.index,
        videoFrames,
        audioChunks,
        sampleRate,
      },
      // @ts-ignore
    }, transferList);
  }
  else if (type === DecoderType.DECODE_SINGLE) {
    const videoFrames: VideoFrame[] = [];
    if (fileData.videoTrack) {
      const sink = new VideoSampleSink(fileData.videoTrack);
      const sample = await sink.getSample(e.data.time);
      if (sample) {
        videoFrames.push(sample.toVideoFrame());
        sample.close();
      }
    }
    const audioData: AudioData[] = [];
    if (fileData.audioTrack) {}
    const transferList: Transferable[] = (videoFrames as Transferable[]).concat(audioData);
    self.postMessage({
      url,
      type: DecoderEvent.DECODED_SINGLE,
      data: {
        index: e.data.index,
        videoFrames,
        audioData,
      },
      // @ts-ignore
    }, transferList);
  }
};
