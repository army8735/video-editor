import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
  WebMOutputFormat,
} from 'mediabunny';
import { AudioChunk } from './decoder';

export enum EncoderType {
  INIT = 0,
  FRAME = 1,
  END = 2, // 数据结束，可以输出视频
}

export enum EncoderEvent {
  PROGRESS = 0,
  FINISH = 1,
  ERROR = 2,
}

let videoEncoder: VideoEncoder | undefined;
let audioEncoder: AudioEncoder | undefined;
let output: Output | undefined;
let videoSource: EncodedVideoPacketSource | undefined;
let audioSource: EncodedAudioPacketSource | undefined;
let offlineContext: OfflineAudioContext | undefined;
let didVideo = false;
let didAudio = false;
let onFrame: (value: unknown) => void;
const masterChannels: Float32Array[] = []; // 音频混合缓冲区
let lastIndex = 0;
let lastTimestamp = 0;
let masterOffset = 0;

export const onMessage = async (e: MessageEvent<{
  type: EncoderType,
  messageId: number,
  isWorker: boolean,
  timestamp: number,
  duration: number,
  videoFrame: VideoFrame,
  videoEncoderConfig: VideoEncoderConfig,
  // audioChunks?: AudioChunk[],
  audioBuffers: { id: number, data: AudioBuffer, volume: number, timestamp: number }[],
  audioList: { audioChunk: AudioChunk, volume: number }[],
  audioEncoderConfig: AudioEncoderConfig,
  mute: boolean,
}>) => {
  const { type, isWorker } = e.data;
  // console.log('encoder', type, isWorker, e.data.messageId);
  const onError = (e: string) => {
    const res = {
      type: EncoderEvent.ERROR,
      error: e,
    };
    if (isWorker) {
      self.postMessage(res);
    }
    return { data: res };
  };
  const pm = new Promise(resolve => {
    onFrame = resolve;
  });
  if (type === EncoderType.INIT) {
    if (videoEncoder) {
      videoEncoder.close();
      videoEncoder = undefined;
    }
    if (audioEncoder) {
      audioEncoder.close();
      audioEncoder = undefined;
    }
    if (offlineContext) {
      offlineContext = undefined;
    }
    const fin = () => {
      if (didVideo && didAudio) {
        const res = {
          type: EncoderEvent.PROGRESS,
        };
        if (isWorker) {
          self.postMessage(res);
        }
        onFrame({ data: res });
      }
    };
    const vc = e.data.videoEncoderConfig?.codec;
    let format: Mp4OutputFormat | WebMOutputFormat;
    if (/^vp/.test(vc)) {
      format = new WebMOutputFormat();
    }
    else {
      format = new Mp4OutputFormat();
    }
    output = new Output({
      format,
      target: new BufferTarget(),
    });
    if (/^vp8/.test(vc)) {
      videoSource = new EncodedVideoPacketSource('vp8');
    }
    else if (/^vp09\./.test(vc)) {
      videoSource = new EncodedVideoPacketSource('vp9');
    }
    else if (/^av01\./.test(vc)) {
      videoSource = new EncodedVideoPacketSource('av1');
    }
    else if (/^hev1\./.test(vc) || /^hvc1\./.test(vc)) {
      videoSource = new EncodedVideoPacketSource('hevc');
    }
    else if (/^avc1\./.test(vc) || /^avc3\./.test(vc)) {
      videoSource = new EncodedVideoPacketSource('avc');
    }
    if (videoSource) {
      output.addVideoTrack(videoSource);
      videoEncoder = new VideoEncoder({
        output(chunk, metadata) {
          // console.log('v', chunk, metadata);
          const part = EncodedPacket.fromEncodedChunk(chunk);
          videoSource!.add(part, metadata);
          didVideo = true;
          fin();
        },
        error(e) {
          onError(e.message);
        },
      });
      videoEncoder.configure(e.data.videoEncoderConfig);
    }
    const ac = e.data.audioEncoderConfig?.codec;
    if (e.data.mute) {
      // 不合成音频
      audioSource = undefined;
    }
    else if (/^mp3/.test(ac)) {
      audioSource = new EncodedAudioPacketSource('mp3');
    }
    else if (/^flac/.test(ac)) {
      audioSource = new EncodedAudioPacketSource('flac');
    }
    else if (/^opus/.test(ac)) {
      audioSource = new EncodedAudioPacketSource('opus');
    }
    else if (/^vorbis/.test(ac)) {
      audioSource = new EncodedAudioPacketSource('vorbis');
    }
    else if (/^pcm-/.test(ac)) {
      audioSource = new EncodedAudioPacketSource(ac as any);
    }
    else if (/^mp4a\./.test(ac)) {
      audioSource = new EncodedAudioPacketSource('aac');
    }
    else if (/^ulaw/.test(ac)) {
      audioSource = new EncodedAudioPacketSource('ulaw');
    }
    else if (/^alaw/.test(ac)) {
      audioSource = new EncodedAudioPacketSource('alaw');
    }
    if (audioSource) {
      output.addAudioTrack(audioSource);
      audioEncoder = new AudioEncoder({
        output(chunk, metadata) {
          // console.log('a',  chunk, metadata)
          const part = EncodedPacket.fromEncodedChunk(chunk);
          audioSource!.add(part, metadata);
          didAudio = true;
          fin();
        },
        error(e) {
          onError(e.message);
        }
      });
      audioEncoder.configure(e.data.audioEncoderConfig);
      // 初始化10s足够大的arraybuffer存储混音数据，处理过程中一段段处理，然后处理好的扔掉不要
      masterChannels.splice(0);
      const num = e.data.audioEncoderConfig.sampleRate * Math.ceil(e.data.duration * 1e-3);
      for (let i = 0; i < e.data.audioEncoderConfig.numberOfChannels; i++) {
        masterChannels.push(new Float32Array(num));
      }
      lastIndex = 0;
      lastTimestamp = 0;
      masterOffset = 0;
    }
    await output.start();
  }
  else if (type === EncoderType.FRAME) {
    didVideo = false;
    didAudio = false;
    const videoFrame = e.data.videoFrame;
    if (videoEncoder && videoEncoder.state === 'configured' && videoFrame) {
      videoEncoder.encode(videoFrame);
    }
    videoFrame?.close();
    const audioList = e.data.audioList;
    const { numberOfChannels, sampleRate } = e.data.audioEncoderConfig;
    if (audioEncoder && audioEncoder.state === 'configured') {
      if (audioList.length) {
        for (let i = 0, len = audioList.length; i < len; i++) {
          const { audioChunk, volume } = audioList[i];
          // const audioContext = new OfflineAudioContext(
          //   audioChunk.numberOfChannels,
          //   audioChunk.numberOfFrames,
          //   audioChunk.sampleRate,
          // );
          // const audioBuffer = audioContext.createBuffer(audioChunk.channels.length, audioChunk.numberOfFrames, audioChunk.sampleRate);
          // for (let ch = 0; ch < audioChunk.channels.length; ch++) {
          //   const channelData = audioBuffer.getChannelData(ch);
          //   channelData.set(audioChunk.channels[ch], 0);
          // }
          // const newBuffer = await reSample(audioBuffer, numberOfChannels, sampleRate);
          // 计算当前时间在整体的偏移frame位置
          const frameOffset = Math.round(audioChunk.timestamp * 1e-3 * sampleRate);
          const length = audioChunk.numberOfFrames;
          for (let i = 0; i < numberOfChannels; i++) {
            const masterChannel = masterChannels[i];
            // 直接获取每个声道的 Float32Array 数据
            const d = audioChunk.channels[i];
            // console.log(d);
            for (let j = 0; j < length; j++) {
              const index = frameOffset + j;
              // 简单的增益控制clamping
              const n = (masterChannel[index] + d[j] * volume);
              masterChannel[index] = Math.max(-1, Math.min(1, n));
            }
          }
        }
      }
      // audioBuffer总是每个gop开头就会给到，所以每帧时把混合结果中当前时间之前的给到audioEncoder
      if (e.data.timestamp) {
        const index = Math.round(e.data.timestamp * 1e-3 * sampleRate);
        if (index > lastIndex) {
          const numberOfFrames = index - lastIndex;
          const data = new Float32Array(numberOfFrames * masterChannels.length);
          for (let i = 0; i < masterChannels.length; i++) {
            const mc = masterChannels[i];
            const sub = mc.subarray(lastIndex, index);
            data.set(sub, i * numberOfFrames);
          }
          const audioData = new AudioData({
            format: 'f32-planar',
            sampleRate,
            numberOfFrames: numberOfFrames,
            numberOfChannels,
            timestamp: lastTimestamp,
            data,
          });
          lastIndex = index;
          lastTimestamp = e.data.timestamp;
          audioEncoder!.encode(audioData);
        }
      }
      didAudio = true;
    }
    else if (!e.data.mute) {
      didAudio = true;
    }
    return pm;
  }
  else if (type === EncoderType.END) {
    if (!videoEncoder || !output) {
      return;
    }
    await videoEncoder.flush();
    videoEncoder.close();
    videoEncoder = undefined;
    if (audioEncoder?.state === 'configured') {
      await audioEncoder.flush();
      audioEncoder.close();
      audioEncoder = undefined;
    }
    await output.finalize();
    const buffer = (output.target as BufferTarget).buffer;
    output = undefined;
    const res = {
      type: EncoderEvent.FINISH,
      buffer,
    };
    if (isWorker) {
      (self as DedicatedWorkerGlobalScope).postMessage(res, [buffer] as Transferable[]);
    }
    else {
      return { data: res };
    }
  }
};

self.onmessage = onMessage;
