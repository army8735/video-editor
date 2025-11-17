import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  WebMOutputFormat,
} from 'mediabunny';

export enum EncoderType {
  INIT = 0,
  VIDEO_FRAME = 1,
  END = 2, // 数据结束，可以输出视频
}

export enum EncoderEvent {
  PROGRESS = 0,
  FINISH = 1,
}

let videoEncoder: VideoEncoder | undefined;
let output: Output | undefined;
let videoSource: EncodedVideoPacketSource | undefined;

self.onmessage = async (e: MessageEvent<{
  type: EncoderType,
  videoFrame: VideoFrame,
  videoEncoderConfig: VideoEncoderConfig,
}>) => {
  const { type } = e.data;
  // console.log('encoder', type);
  if (type === EncoderType.INIT) {
    if (videoEncoder) {
      videoEncoder.close();
      videoEncoder = undefined;
    }
    const codec = e.data.videoEncoderConfig?.codec;
    let format: Mp4OutputFormat | WebMOutputFormat;
    if (/^vp/.test(codec)) {
      format = new WebMOutputFormat();
    }
    else {
      format = new Mp4OutputFormat();
    }
    output = new Output({
      format,
      target: new BufferTarget(),
    });
    if (/^vp0?8/.test(codec)) {
      videoSource = new EncodedVideoPacketSource('vp8');
    }
    else if (/^vp0?9/.test(codec)) {
      videoSource = new EncodedVideoPacketSource('vp9');
    }
    else {
      videoSource = new EncodedVideoPacketSource('avc');
    }
    output.addVideoTrack(videoSource);
    await output.start();
    videoEncoder = new VideoEncoder({
      output(chunk, metadata) {
        // console.log(chunk, metadata);
        const part = EncodedPacket.fromEncodedChunk(chunk);
        videoSource!.add(part, metadata);
        self.postMessage({
          type: EncoderEvent.PROGRESS,
        });
      },
      error(e) {
        console.error(e);
        console.error(e.name, e.message);
      },
    });
    videoEncoder.configure(e.data.videoEncoderConfig);
  }
  else if (type === EncoderType.VIDEO_FRAME) {
    const videoFrame = e.data.videoFrame;
    if (videoEncoder && videoEncoder.state === 'configured' && videoFrame) {
      videoEncoder.encode(videoFrame);
    }
    videoFrame?.close();
  }
  else if (type === EncoderType.END) {
    if (!videoEncoder || !output) {
      return;
    }
    await videoEncoder.flush();
    videoEncoder.close();
    videoEncoder = undefined;
    await output.finalize();
    const buffer = (output.target as BufferTarget).buffer;
    output = undefined;
    self.postMessage({
      type: EncoderEvent.FINISH,
      buffer,
      // @ts-ignore
    }, [buffer]);
  }};
