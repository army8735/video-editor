// import { MP4BoxBuffer, Track, ISOFile, MultiBufferStream, VisualSampleEntry, Sample, createFile } from 'mp4box';
// @ts-ignore
import mp4box, { DataStream } from 'mp4box';

export type LoadVideoRes = {
  success: boolean;
  frames: VideoFrame[];
  duration: number;
  audioBuffer?: AudioBuffer;
  width: number;
  height: number;
  release: () => void;
};

enum State {
  NONE = 0,
  LOADING = 1,
  LOADED = 2,
}

const HASH: Record<string, {
  state: State,
  list: Array<(p: LoadVideoRes) => void>,
  count: number, // 简易计数器回收
  res: LoadVideoRes,
}> = {};

function description(file: any, track: any) {
  const trak = file.getTrackById(track.id);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8);
    }
  }
  // throw new Error('avcC, hvcC, vpcC, or av1C box not found');
}

export async function loadVideo(url: string, options?: RequestInit) {
  let cache = HASH[url];
  // 已加载或正在加载的复用
  if (cache) {
    cache.count++;
    if (cache.state === State.LOADED) {
      return cache.res;
    }
    else if (cache.state === State.LOADING) {
      return new Promise<LoadVideoRes>((resolve) => {
        cache.list.push(resolve);
      });
    }
  }
  // 新加载
  cache = HASH[url] = {
    state: State.LOADING,
    list: [],
    count: 0,
    res: {
      success: false,
      frames: [],
      duration: 0,
      width: 0,
      height: 0,
      release() {
        cache.count--;
        if (cache.count <= 0) {
          cache.res.frames.forEach(item => item.close());
          cache.res.audioBuffer = undefined;
          delete HASH[url];
        }
      },
    },
  };
  const data = await fetch(url, Object.assign({
    mode: 'cors',
  }, options));
  if (data.status !== 200 && data.status !== 304) {
    cache.state = State.LOADED;
    return cache.res;
  }
  cache.count++;
  return new Promise<LoadVideoRes>((resolve, reject) => {
    const videoDecoder = new VideoDecoder({
      output(frame) {
        cache.res.frames.push(frame);
      },
      error(e) {
        reject(e);
      },
    });
    const audioChunks: { channels: Float32Array[], timestamp: number, numberOfFrames: number }[] = [];
    const audioDecoder = new AudioDecoder({
      output(frame) {
        const channels: Float32Array[] = [];
        const { numberOfChannels, numberOfFrames, timestamp } = frame;
        const tmp = new Float32Array(numberOfFrames);
        for (let ch = 0; ch < numberOfChannels; ch++) {
          // 使用 copyTo 安全读取
          frame.copyTo(tmp, { planeIndex: ch });
          channels.push(tmp);
        }
        audioChunks.push({
          channels,
          timestamp,
          numberOfFrames,
        })
        frame.close();
      },
      error(e) {
        reject(e);
      },
    });
    let videoSampleTotal = 0;
    let videoSampleCount = 0;
    let audioSampleTotal = 0;
    let audioSampleCount = 0;
    const mp4boxfile = mp4box.createFile();
    mp4boxfile.onError = (e: any) => {
      reject(e);
    };
    let videoTrack: any;
    let audioTrack: any;
    mp4boxfile.onReady = (info: any) => {
      videoTrack = info.videoTracks[0];
      audioTrack = info.audioTracks[0];
      if (!videoTrack?.video && !audioTrack?.audio) {
        reject();
        return;
      }
      cache.res.width = videoTrack.video.width;
      cache.res.height = videoTrack.video.height;
      cache.res.duration = videoTrack.movie_duration;
      videoSampleTotal = videoTrack.nb_samples;
      if (videoTrack?.video) {
        videoDecoder.configure({
          codec: videoTrack.codec.startsWith('vp08') ? 'vp8' : videoTrack.codec,
          codedWidth: videoTrack.video.width,
          codedHeight: videoTrack.video.height,
          description: description(mp4boxfile, videoTrack),
        });
        mp4boxfile.setExtractionOptions(videoTrack.id);
      }
      if (audioTrack?.audio) {
        audioSampleTotal = audioTrack.nb_samples;
        audioDecoder.configure({
          codec: audioTrack.codec,
          sampleRate: audioTrack.audio.sample_rate,
          numberOfChannels: audioTrack.audio.channel_count,
          description: description(mp4boxfile, audioTrack),
        });
        mp4boxfile.setExtractionOptions(audioTrack.id);
      }
      mp4boxfile.start();
    };
    mp4boxfile.onSamples = (id: number, user: any, samples: Array<any>) => {
      if (id === videoTrack.id) {
        for (const sample of samples) {
          if (!sample.data) {
            continue;
          }
          videoDecoder.decode(new EncodedVideoChunk({
            type: sample.is_sync ? 'key' : 'delta',
            timestamp: 1e6 * sample.cts / sample.timescale,
            duration: 1e6 * sample.duration / sample.timescale,
            data: sample.data,
          }));
        }
        videoSampleCount += samples.length;
      }
      else if (id === audioTrack.id) {
        for (const sample of samples) {
          if (!sample.data) {
            continue;
          }
          audioDecoder.decode(new EncodedAudioChunk({
            type: sample.is_sync ? 'key' : 'delta',
            timestamp: 1e6 * sample.cts / sample.timescale,
            duration: 1e6 * sample.duration / sample.timescale,
            data: sample.data,
          }))
        }
        audioSampleCount += samples.length;
      }
      // 所有读取完关闭videoDecoder
      if (videoSampleCount === videoSampleTotal && audioSampleCount === audioSampleTotal) {
        Promise.all([
          audioTrack?.audio ? audioDecoder.flush().then(() => {
            // 确保音频顺序正确，decoder已经确保顺序
            if (audioChunks.length) {
              // audioChunks.sort((a, b) => a.timestamp - b.timestamp);
              const totalFrames = audioChunks.reduce((sum, item) => sum + item.numberOfFrames, 0);
              const audioContext = new AudioContext();
              const audioBuffer = audioContext.createBuffer(audioChunks[0].channels.length, totalFrames, audioTrack.audio.sample_rate);
              let offset = 0;
              audioChunks.forEach(item => {
                for (let ch = 0; ch < item.channels.length; ch++) {
                  const channelData = audioBuffer.getChannelData(ch);
                  channelData.set(item.channels[ch], offset);
                }
                offset += item.numberOfFrames;
              });
              cache.res.audioBuffer = audioBuffer;
              audioContext.close();
              audioChunks.splice(0);
            }
          }) : undefined,
          videoTrack?.video ? videoDecoder.flush() : undefined,
        ]).then(() => {
          cache.res.success = true;
          cache.state = State.LOADED;
          videoDecoder.close();
          audioDecoder.close();
          resolve(cache.res);
          cache.list.splice(0).forEach(item => {
            cache.count++;
            item(cache.res);
          });
        });
      }
    };
    let fileStart = 0;
    data.body!.pipeTo(new WritableStream<Uint8Array>({
      write(chunk) {
        const buffer = chunk.buffer as any;
        buffer.fileStart = fileStart;
        fileStart += buffer.byteLength;
        mp4boxfile.appendBuffer(buffer);
        mp4boxfile.flush();
      },
      // 输入流结束关闭file，可能还有samples待解码
      close() {
        mp4boxfile.flush();
      },
    }));
  });
}
