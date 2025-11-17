// @ts-ignore
import mp4box, { DataStream, ISOFile } from 'mp4box';
import { loadRange } from './util/loadRangeCache';
import config from './config';

export enum Mp4boxEvent {
  META = 'meta',
  LOADED = 'loaded',
  PART_INIT = 'part_init',
  PART_LOADED = 'part_loaded',
  PART_LOADED_ALL = 'part_loaded_all',
  RANGE_INIT = 'range_init',
  RANGE_LOADED = 'range_loaded',
  ERROR = 'error',
  DECODED = 'decoded',
}

export enum Mp4boxType {
  META = 0,
  LOAD_RANGE = 1,
  CANCEL_LOAD_RANGE = 2,
  DECODE = 3,
  RELEASE = 4,
}

export type SimpleGOP = Pick<GOP,
  'index' |
  'videoSampleIndex' |
  'audioSampleIndex' |
  'videoLength' |
  // 'videoLengthSpread' |
  'audioLength' |
  'relativeCts' |
  'cts' |
  'dts' |
  'duration' |
  'start' |
  // 'startSpread' |
  'end' |
  // 'endSpread' |
  'size' |
  'maxCts'
>;

export type VideoAudioMeta = {
  video?: {
    width: number,
    height: number,
    duration: number,
    startCts: number,
    fps: number,
  },
  audio?: {
    startCts: number,
    duration: number,
  },
  duration: number,
  fileSize: number;
  supportRange: boolean;
};

export type VideoAudioOriginData = {
  video?: VideoOriginData;
  audio?: AudioOriginData;
};

export type AudioOriginData = {
  samples: { keyframe: boolean, cts: number, dts: number, duration: number, data: ArrayBuffer }[];
  configure: {
    codec: string,
    sampleRate: number,
    numberOfChannels: number,
    description?: ArrayBuffer,
  },
};

export type VideoOriginData = {
  samples: { keyframe: boolean, cts: number, dts: number, duration: number, data: ArrayBuffer }[];
  configure: {
    codec: string,
    codedWidth: number,
    codedHeight: number,
    description?: ArrayBuffer,
  },
};

function description(file: any, track: any) {
  const trak = file.getTrackById(track.id);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return stream.buffer;
    }
  }
  // throw new Error('avcC, hvcC, vpcC, or av1C box not found');
}

export enum GOPState {
  NONE = 0,
  LOADING = 1,
  LOADED = 2,
  DECODING = 3,
  DECODED = 4,
  ERROR = 5,
}

export type AudioChunk = { channels: Float32Array[], timestamp: number, numberOfFrames: number };

export type GOP = {
  state: GOPState,
  index: number,
  videoSampleIndex: number,
  audioSampleIndex: number,
  videoLength: number, // samples长度
  // videoLengthSpread: number, // 可能b帧导致在下一关键帧后数量会比上面多一点
  audioLength: number,
  relativeCts: number,
  cts: number,
  dts: number,
  duration: number,
  start: number,
  // startSpread: number, // 可能seek波动导致需要把前一个音频offset考虑进来
  end: number,
  // endSpread: number, // 同b帧影响导致长度多一点
  size: number,
  maxCts: number, // 范围内最大的cts
  videoCount: number, // range情况下加载计数
  audioCount: number,
  videoDecoder?: VideoDecoder, // 单个区域range独立加载时使用
  audioDecoder?: AudioDecoder,
  videoFrames: VideoFrame[],
  audioChunks: AudioChunk[],
  users: number[], // smartVideoDecoder的id
};

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function search2(list: SimpleGOP[], time: number) {
  if (list.length === 1) {
    return 0;
  }
  let i = 0, j = list.length - 1;
  while (i < j) {
    if (i === j - 1) {
      const cts = list[j].cts;
      if (cts <= time) {
        return j;
      }
      return i;
    }
    const mid = i + ((j - i) >> 1);
    const cts = list[mid].cts;
    if (cts === time) {
      return mid;
    }
    if (cts > time) {
      j = Math.max(mid - 1, i + 1);
    }
    else {
      i = Math.min(mid, j - 1);
    }
  }
  throw new Error('Unknown error in search frame index of load range: ' + time);
}

enum State {
  NONE = 0,
  LOADING = 1,
  LOADED = 2,
  ERROR = 3,
}

type FileData = {
  mp4boxfile: ISOFile,
  fileSize: number,
  duration: number,
  start: number, // 已加载开头多少数据，初次读取moov时尝试
  end: number, // 同上，已加载末尾
  supportRange: boolean,
  originData: VideoAudioOriginData,
  gopList: GOP[],
  ranges: Record<number, {
    state: State,
    controller?: AbortController,
    users: number[],
  }>,
};

const MP4BOX_HASH: Record<string, FileData> = {};

self.onmessage = async (e: MessageEvent<{
  url: string,
  id: number,
  type: Mp4boxType,
  messageId: number,
  time: number,
  index: number,
}>) => {
  const { url, id, type } = e.data;
  const onError = (e: string) => {
    self.postMessage({
      url,
      type: Mp4boxEvent.ERROR,
      data: e,
    });
  };
  // console.log(url, id, type, e.data.messageId)
  if (!MP4BOX_HASH[url]) {
    MP4BOX_HASH[url] = {
      mp4boxfile: mp4box.createFile(),
      fileSize: 0,
      duration: 0,
      start: 0,
      end: 0,
      supportRange: false,
      originData: {},
      gopList: [],
      ranges: {},
    };
  }
  const fileData = MP4BOX_HASH[url];
  const mp4boxfile = fileData.mp4boxfile;
  if (type === Mp4boxType.META) {
    // 先请求文件大小，这个有304缓存
    const headResponse = await fetch(url, { method: 'HEAD' });
    const cl = headResponse.headers.get('content-length');
    if (!cl || headResponse.status !== 200 && headResponse.status !== 304) {
      onError('Unknown content-length');
      return;
    }
    fileData.fileSize = parseInt(cl);
    // 解封装的基础信息
    const meta: VideoAudioMeta = {
      duration: 0,
      supportRange: false,
      fileSize: fileData.fileSize,
    };
    const simpleGOPList: SimpleGOP[] = [];
    let isReady = false;
    let videoTrack: any | undefined;
    let audioTrack: any | undefined;
    let videoSampleTotal = 0;
    let videoSampleCount = 0;
    let audioSampleTotal = 0;
    let audioSampleCount = 0;
    let videoStartCts = 0;
    let audioStartCts = 0;
    let isStart = false;
    // 有moov信息时
    mp4boxfile.onMoovStart = () => {
      isStart = true;
    };
    // moov信息完整时
    mp4boxfile.onReady = (info: any) => {
      isReady = true;
      videoTrack = info.videoTracks[0];
      audioTrack = info.audioTracks[0];
      if (!videoTrack?.video && !audioTrack?.audio) {
        onError('Empty data in video: ' + url);
      }
      if (videoTrack?.video) {
        videoSampleTotal = videoTrack.nb_samples;
        // 将关键帧区域的位置记录下来，等待后续主线程通知按区域读取解析
        const samplesInfo = mp4boxfile.getTrackSamplesInfo(videoTrack.id);
        let max = 0;
        let maxCts = 0;
        samplesInfo.forEach((item: any, i: number) => {
          const cts = 1e6 * item.cts / item.timescale;
          if (!i) {
            videoStartCts = cts;
          }
          const duration = 1e6 * item.duration / item.timescale;
          const relativeCts = cts - videoStartCts;
          max = Math.max(max, relativeCts + duration);
          maxCts = Math.max(maxCts, cts);
          if (item.is_sync) {
            // 前一个区域的结束信息计算
            const len = fileData.gopList.length;
            if (len) {
              const last = fileData.gopList[len - 1];
              last.videoLength = i - last.videoSampleIndex;
              // last.videoLengthSpread = last.videoLength;
              last.duration = cts - last.cts;
              last.end = item.offset;
              // end计算比较特殊，向后查看下一区域，如果有cts比本区域小的，说明B帧，加载范围需到这里
              for (let j = i; j < samplesInfo.length; j++) {
                const item = samplesInfo[j];
                const cts = 1e6 * item.cts / item.timescale;
                if (cts < last.maxCts) {
                  // last.videoLengthSpread = j - last.videoSampleIndex;
                  // last.endSpread = item.offset + item.size;
                }
                if (item.is_sync) {
                  break;
                }
              }
            }
            fileData.gopList.push({
              state: GOPState.NONE,
              index: fileData.gopList.length,
              videoSampleIndex: i,
              audioSampleIndex: 0,
              videoLength: 1,
              // videoLengthSpread: 1,
              audioLength: 0,
              relativeCts,
              cts,
              dts: 1e6 * item.dts / item.timescale,
              duration: 0,
              start: item.offset,
              // startSpread: item.offset,
              end: item.offset + item.size,
              // endSpread: item.offset + item.size,
              size: item.size,
              maxCts,
              videoCount: 0,
              audioCount: 0,
              videoFrames: [],
              audioChunks: [],
              users: [],
            });
          }
          const len = fileData.gopList.length;
          if (len) {
            const last = fileData.gopList[len - 1];
            last.maxCts = maxCts;
          }
        });
        // 最后一段duration找到最后一帧cts+duration再减去关键帧cts
        const len = fileData.gopList.length;
        if (len) {
          const last = fileData.gopList[len - 1];
          last.videoLength = samplesInfo.length - last.videoSampleIndex;
          // last.videoLengthSpread = last.videoLength;
          last.duration = max - last.relativeCts;
          last.end = fileData.fileSize;
        }
        // 防止碎片化，将过小的相邻gop合并成一个大的逻辑gop
        outer:
        for (let i = 0; i < fileData.gopList.length; i++) {
          const cur = fileData.gopList[i];
          if (cur.duration * 1e-3 < config.gopMinDuration) {
            for (let j = i + 1, len = fileData.gopList.length; j < len; j++) {
              const next = fileData.gopList[j];
              cur.videoLength += next.videoLength;
              cur.audioLength += next.audioLength;
              if ((next.cts - cur.cts) * 1e-3 >= config.gopMinDuration || j === len - 1) {
                cur.duration = next.cts - cur.cts + next.duration;
                cur.end = next.end;
                cur.maxCts = next.maxCts;
                fileData.gopList.splice(i + 1, j - i);
                continue outer;
              }
            }
          }
        }
        fileData.gopList.forEach((item, i) => {
          item.index = i;
        });
        fileData.originData.video = {
          samples: [],
          configure: {
            codec: videoTrack.codec.startsWith('vp08') ? 'vp8' : videoTrack.codec,
            codedWidth: videoTrack.video.width,
            codedHeight: videoTrack.video.height,
            description: description(mp4boxfile, videoTrack),
          },
        };
        meta.video = {
          startCts: videoStartCts,
          width: videoTrack.video.width,
          height: videoTrack.video.height,
          duration: Math.ceil(max * 1e-3),
          fps: videoSampleTotal * 1e6 / max,
        };
        meta.duration = meta.video.duration;
        fileData.gopList.forEach(item => {
          simpleGOPList.push({
            index: item.index,
            videoSampleIndex: item.videoSampleIndex,
            audioSampleIndex: item.audioSampleIndex,
            videoLength: item.videoLength,
            // videoLengthSpread: item.videoLengthSpread,
            audioLength: item.audioLength,
            relativeCts: item.relativeCts,
            cts: item.cts,
            dts: item.dts,
            duration: item.duration,
            start: item.start,
            // startSpread: item.startSpread,
            end: item.end,
            // endSpread: item.endSpread,
            size: item.size,
            maxCts: item.maxCts,
          });
        });
        fileData.duration = meta.video.duration;
        mp4boxfile.setExtractionOptions(videoTrack.id, undefined, { nbSamples: 1 });
      }
      if (audioTrack?.audio) {
        audioSampleTotal = audioTrack.nb_samples;
        const samplesInfo = mp4boxfile.getTrackSamplesInfo(audioTrack.id);
        // 将音频的offset也考虑到每个区域里，其cts和dts一定相等按顺序排列，因为没有B帧，
        // 只需考虑开头结尾即可，因为中间部分不会和关键帧重叠，即便sample位于关键帧后但cts可能在其前，
        // 但这种误差极小可以忽略
        if (simpleGOPList.length && samplesInfo.length) {
          const first = simpleGOPList[0];
          first.start = Math.min(first.start, samplesInfo[0].offset);
          // first.startSpread = first.start;
          fileData.gopList[0].start = first.start;
          // fileData.gopList[0].startSpread = first.startSpread;
          const last = simpleGOPList[simpleGOPList.length - 1];
          const o = samplesInfo[samplesInfo.length - 1];
          last.end = Math.max(last.end, o.offset + o.size);
          // last.endSpread = last.end;
          fileData.gopList[fileData.gopList.length - 1].end = last.end;
          // fileData.gopList[fileData.gopList.length - 1].endSpread = last.endSpread;
          // 和video一样处理存到每个区域
          if (meta.video) {
            samplesInfo.forEach((item: any, i: number) => {
              const cts = 1e6 * item.cts / item.timescale;
              if (!i) {
                audioStartCts = cts;
              }
              const index = search2(fileData.gopList, cts);
              const gop = fileData.gopList[index];
              gop.audioLength++;
              const simpleGop = simpleGOPList[index];
              simpleGop.audioLength++;
              if (index) {
                if (gop.audioSampleIndex === 0) {
                  gop.audioSampleIndex = i;
                }
                else {
                  gop.audioSampleIndex = Math.min(gop.audioSampleIndex, i);
                }
                simpleGop.audioSampleIndex = gop.audioSampleIndex;
              }
              // 考虑音频加载范围偏移
              gop.start = Math.min(gop.start, item.offset);
              // gop.startSpread = Math.min(gop.startSpread, gop.start);
              gop.end = Math.max(gop.end, item.offset + item.size);
              // gop.endSpread = Math.max(gop.endSpread, gop.end);
              simpleGop.start = gop.start;
              // simpleGop.startSpread = gop.startSpread;
              simpleGop.end = gop.end;
              // simpleGop.endSpread = gop.endSpread;
            });
            // 特殊处理，区域不能只以关键帧的offset和音频最小offset为start，还需要考虑关键帧前面一个音频的offset
            fileData.gopList.forEach((item, i) => {
              if (i) {
                // const sample = samplesInfo[item.audioSampleIndex - 1];
                // item.startSpread = Math.min(item.startSpread, item.start, sample.offset);
                // simpleGOPList[i].startSpread = item.startSpread;
              }
            });
          }
        }
        let max = 0;
        samplesInfo.forEach((item: any, i: number) => {
          const cts = 1e6 * item.cts / item.timescale;
          if (!i) {
            audioStartCts = cts;
          }
          const duration = 1e6 * item.duration / item.timescale;
          const relativeCts = cts - videoStartCts;
          max = Math.max(max, relativeCts + duration);
        });
        fileData.originData.audio = {
          samples: [],
          configure: {
            codec: audioTrack.codec,
            sampleRate: audioTrack.audio.sample_rate,
            numberOfChannels: audioTrack.audio.channel_count,
            description: description(mp4boxfile, audioTrack),
          },
        };
        meta.audio = {
          startCts: audioStartCts,
          duration: Math.ceil(max * 1e-3),
        };
        meta.duration = Math.max(meta.duration, meta.audio.duration);
        mp4boxfile.setExtractionOptions(audioTrack.id, undefined, { nbSamples: 1 });
      }
      self.postMessage({
        url,
        type: Mp4boxEvent.META,
        data: { meta, simpleGOPList },
      });
    };
    mp4boxfile.onError = (e: string) => {
      onError(e);
    };
    // 小文件直接请求有304缓存，不需要IndexedDB
    if (config.loadLimit && fileData.fileSize > config.loadLimit) {
      // 先看文件开头1mb看是否有meta信息，排查文件很小的情况，limit mb以内都使用直接加载
      const end = Math.min(fileData.fileSize, 1024 * 1024) - 1;
      fileData.start = end;
      const { arrayBuffer } = await loadRange(url, 0, end);
      if (arrayBuffer) {
        fileData.supportRange = meta.supportRange = true;
        // @ts-ignore
        arrayBuffer.fileStart = 0;
        mp4boxfile.appendBuffer(arrayBuffer);
        mp4boxfile.flush();
      }
      // 支持分段，根据情况加载开头、结尾2mb，再5mb
      if (!isReady && meta.supportRange) {
        if (isStart) {
          const start = 1024 * 1024;
          const end = Math.min(fileData.fileSize, 1024 * 1024 * 2) - 1;
          fileData.start = end;
          const { arrayBuffer } = await loadRange(url, start, end);
          if (arrayBuffer) {
            fileData.supportRange = meta.supportRange = true;
            // @ts-ignore
            arrayBuffer.fileStart = start;
            mp4boxfile.appendBuffer(arrayBuffer);
            mp4boxfile.flush();
          }
          if (!isReady) {
            const start = 1024 * 1024 * 2;
            const end = Math.min(fileData.fileSize, 1024 * 1024 * 5) - 1;
            fileData.start = end;
            const { arrayBuffer } = await loadRange(url, start, end);
            if (arrayBuffer) {
              fileData.supportRange = meta.supportRange = true;
              // @ts-ignore
              arrayBuffer.fileStart = start;
              mp4boxfile.appendBuffer(arrayBuffer);
              mp4boxfile.flush();
            }
          }
        }
        else {
          fileData.end = 1024 * 1024 * 2;
          const start = fileData.fileSize - fileData.end;
          const end = fileData.fileSize - 1;
          const { arrayBuffer } = await loadRange(url, start, end);
          if (arrayBuffer) {
            fileData.supportRange = meta.supportRange = true;
            // @ts-ignore
            arrayBuffer.fileStart = start;
            mp4boxfile.appendBuffer(arrayBuffer);
            mp4boxfile.flush();
          }
          if (!isReady) {
            fileData.end = 1024 * 1024 * 5;
            const start = fileData.fileSize - fileData.end;
            const end = fileData.fileSize * 1024 * 1024 * 2 - 1;
            const { arrayBuffer } = await loadRange(url, start, end);
            if (arrayBuffer) {
              fileData.supportRange = meta.supportRange = true;
              // @ts-ignore
              arrayBuffer.fileStart = start;
              mp4boxfile.appendBuffer(arrayBuffer);
              mp4boxfile.flush();
            }
          }
        }
      }
    }
    // 头尾都没有meta数据、整体很小，这些极端情况直接加载整体文件，不支持分段加载也是降级直接加载整体
    if (!isReady || !meta.supportRange || fileData.fileSize <= config.loadLimit) {
      const response = await fetch(url);
      if (response.status !== 200 && response.status !== 304) {
        onError('Bad request ' + response.status + ': ' + url);
        return;
      }
      if (response.body) {
        mp4boxfile.onSamples = (id: number, user: any, samples: Array<any>) => {
          if (id === videoTrack.id) {
            for (const sample of samples) {
              fileData.originData.video!.samples.push({
                keyframe: sample.is_sync,
                cts: 1e6 * sample.cts / sample.timescale,
                dts: 1e6 * sample.dts / sample.timescale,
                duration: 1e6 * sample.duration / sample.timescale,
                data: sample.data.buffer,
              });
            }
            videoSampleCount += samples.length;
          }
          else if (id === audioTrack.id) {
            for (const sample of samples) {
              fileData.originData.audio!.samples.push({
                keyframe: sample.is_sync,
                cts: 1e6 * sample.cts / sample.timescale,
                dts: 1e6 * sample.dts / sample.timescale,
                duration: 1e6 * sample.duration / sample.timescale,
                data: sample.data.buffer,
              });
            }
            audioSampleCount += samples.length;
          }
          // 读取完毕
          if (videoSampleCount === videoSampleTotal && audioSampleCount === audioSampleTotal) {
            fileData.gopList.forEach(item => item.state = GOPState.LOADED);
            self.postMessage({
              url,
              type: Mp4boxEvent.LOADED,
            });
          }
        };
        mp4boxfile.start();
        let fileStart = 0;
        await response.body.pipeTo(new WritableStream<Uint8Array>({
          write(chunk) {
            const buffer = chunk.buffer as any;
            buffer.fileStart = fileStart;
            fileStart += buffer.byteLength;
            mp4boxfile.appendBuffer(buffer);
          },
          // 输入流结束关闭file，可能还有samples待解码
          close() {
            mp4boxfile.flush();
          },
        }));
      }
      else {
        onError('Empty body in request: ' + url);
      }
    }
    // 暂时使用range依次加载整个文件，一段段解析，由于meta加载的存在，可能开头/结尾数据使得一部分gop加载完成了，
    // 而且不知道是开头还是结尾的哪一部分，无法按顺序分析，只能每个sample进行时间2分查找对应的gop
    else if (meta.supportRange) {
      function checkGop(gop: GOP) {
        gop.state = GOPState.LOADED;
        if (gop.videoCount === gop.videoLength && gop.audioCount === gop.audioLength) {
          self.postMessage({
            url,
            type: Mp4boxEvent.PART_LOADED,
            data: gop.index,
          });
        }
      }
      mp4boxfile.onSamples = (id: number, user: any, samples: Array<any>) => {
        if (id === videoTrack.id) {
          for (const sample of samples) {
            const cts = 1e6 * sample.cts / sample.timescale;
            fileData.originData.video!.samples.push({
              keyframe: sample.is_sync,
              cts,
              dts: 1e6 * sample.dts / sample.timescale,
              duration: 1e6 * sample.duration / sample.timescale,
              data: sample.data.buffer,
            });
            const i = search2(simpleGOPList, cts);
            const gop = fileData.gopList[i];
            gop.videoCount++;
            checkGop(gop);
          }
          videoSampleCount += samples.length;
        }
        else if (id === audioTrack.id) {
          for (const sample of samples) {
            const cts = 1e6 * sample.cts / sample.timescale;
            fileData.originData.audio!.samples.push({
              keyframe: sample.is_sync,
              cts: 1e6 * sample.cts / sample.timescale,
              dts: 1e6 * sample.dts / sample.timescale,
              duration: 1e6 * sample.duration / sample.timescale,
              data: sample.data.buffer,
            });
            const i = search2(simpleGOPList, cts);
            const gop = fileData.gopList[i];
            gop.audioCount++;
            checkGop(gop);
          }
          audioSampleCount += samples.length;
        }
      };
      mp4boxfile.start();
      for (let i = 0, len = fileData.gopList.length; i < len; i++) {
        const gop = fileData.gopList[i];
        const start = Math.max(fileData.start + 1, gop.start);
        const end = Math.min(fileData.fileSize - fileData.end - 1, gop.end - 1);
        // 有可能加载meta过程中所需要的区域已经加载好了，正在解封装，此时主线程来通知加载，需要忽略
        if (start >= (fileData.fileSize - fileData.end - 1) || end <= fileData.start) {
          continue;
        }
        const { status, arrayBuffer } = await loadRange(url, start, end);
        if (!arrayBuffer) {
          onError('Bad request ' + status + ': ' + url);
          return;
        }
        if (arrayBuffer.byteLength) {
          // @ts-ignore
          arrayBuffer.fileStart = start;
          mp4boxfile.appendBuffer(arrayBuffer);
          mp4boxfile.flush();
        }
        else {
          onError('Empty body in request: ' + url);
        }
      }
    }
    // 支持range加载的先定义好，等待后续message通知加载，可能meta数据中包含了前面一点samples
    else {
      // function onRangeLoad(gop: GOP, index: number) {
      //   // 防止多区域同时加载时导致的乱序
      //   framesArea.videoSamples.sort((a, b) => a.dts - b.dts);
      //   // console.log('onRangeLoad', framesArea.videoSamples.length, framesArea)
      //   const transferList = framesArea.videoSamples.map(item => item.data)
      //     .concat(framesArea.audioSamples.map(item => item.data));
      //   self.postMessage({
      //     url,
      //     type: Mp4boxEvent.RANGE_LOADED,
      //     data: {
      //       video: {
      //         index,
      //         samples: framesArea.videoSamples,
      //       },
      //       audio: {
      //         samples: framesArea.audioSamples,
      //       },
      //     },
      //     // @ts-ignore
      //   }, transferList);
      // }
      // mp4boxfile.onSamples = (id: number, user: any, samples: Array<any>) => {
      //   if (id === videoTrack.id) {
      //     for (const sample of samples) {
      //       const o = {
      //         keyframe: sample.is_sync,
      //         cts: 1e6 * sample.cts / sample.timescale,
      //         dts: 1e6 * sample.dts / sample.timescale,
      //         duration: 1e6 * sample.duration / sample.timescale,
      //         data: sample.data.buffer,
      //       };
      //       // 找到对应的区域，判断去重后存入，当区域存满后，按dts排好序通知主线程事件
      //       const i = search2(fileData.gopList, o.cts);
      //       const framesArea = fileData.gopList[i];
      //       let duplicate = false;
      //       for (let i = 0; i < framesArea.videoSamples.length; i++) {
      //         const item = framesArea.videoSamples[i];
      //         if (item && item.cts === o.cts) {
      //           duplicate = true;
      //           break;
      //         }
      //       }
      //       if (!duplicate) {
      //         framesArea.videoSamples.push(o);
      //         framesArea.videoCount++;
      //         // console.log(framesArea.index, framesArea.videoCount, framesArea.videoLength, framesArea.audioCount, framesArea.audioLength)
      //         if (framesArea.videoCount === framesArea.videoLength && framesArea.audioCount === framesArea.audioLength) {
      //           onRangeLoad(framesArea, i);
      //         }
      //       }
      //       // 为防止B帧可能的影响，查看前后区域看是否也要存入
      //       if (i > 0) {
      //         const prev = fileData.gopList[i - 1];
      //         if (o.cts < prev.maxCts) {
      //           let duplicate = false;
      //           for (let i = 0; i < prev.videoSamples.length; i++) {
      //             const item = prev.videoSamples[i];
      //             if (item && item.cts === o.cts) {
      //               duplicate = true;
      //               break;
      //             }
      //           }
      //           if (!duplicate) {
      //             prev.videoSamples.push({
      //               ...o,
      //               data: o.data.slice(0),
      //             });
      //           }
      //         }
      //       }
      //       else if (i < fileData.gopList.length - 1) {
      //         const next = fileData.gopList[i + 1];
      //         if (o.cts > next.cts) {
      //           let duplicate = false;
      //           for (let i = 0; i < next.videoSamples.length; i++) {
      //             const item = next.videoSamples[i];
      //             if (item && item.cts === o.cts) {
      //               duplicate = true;
      //               break;
      //             }
      //           }
      //           if (!duplicate) {
      //             next.videoSamples.push({
      //               ...o,
      //               data: o.data.slice(0),
      //             });
      //           }
      //         }
      //       }
      //     }
      //   }
      //   else if (id === audioTrack.id) {
      //     for (const sample of samples) {
      //       const o = {
      //         keyframe: sample.is_sync,
      //         cts: 1e6 * sample.cts / sample.timescale,
      //         dts: 1e6 * sample.dts / sample.timescale,
      //         duration: 1e6 * sample.duration / sample.timescale,
      //         data: sample.data.buffer,
      //       };
      //       const i = search2(fileData.gopList, o.cts);
      //       const framesArea = fileData.gopList[i];
      //       for (let i = 0; i < framesArea.audioSamples.length; i++) {
      //         const item = framesArea.audioSamples[i];
      //         if (item && item.cts === o.cts) {
      //           return;
      //         }
      //       }
      //       framesArea.audioSamples.push(o);
      //       framesArea.audioCount++;
      //       // console.log(framesArea.index, framesArea.videoCount, framesArea.videoLength, framesArea.audioCount, framesArea.audioLength)
      //       if (framesArea.videoCount === framesArea.videoLength && framesArea.audioCount === framesArea.audioLength) {
      //         onRangeLoad(framesArea, i);
      //       }
      //     }
      //   }
      // };
      // mp4boxfile.start();
    }
  }
  else if (type === Mp4boxType.DECODE) {
    const gop = fileData.gopList[e.data.index];
    // 理论不会，预防，只有加载成功后才会进入解码状态
    if (gop.state === GOPState.NONE || gop.state === GOPState.LOADING || gop.state === GOPState.ERROR) {
      return;
    }
    // 线程异步可能别的gop解码完成了
    if (gop.state === GOPState.DECODED) {
      return;
    }
    // 剩下只有可能LOADED或者DECODING状态了，去重记录发起方id
    if (!gop.users.includes(id)) {
      gop.users.push(id);
    }
    else {
      return;
    }
    // 截流，先等待一段时间，防止如频繁拖动时间轴，再检查是否被release了
    await sleep(100);
    if (!gop.users.includes(id)) {
      return;
    }
    gop.state = GOPState.DECODING;
    function finish() {
      // 防止被释放
      if (gop.state !== GOPState.DECODING) {
        return;
      }
      gop.state = GOPState.DECODED;
      const videoDecoder = gop.videoDecoder;
      if (videoDecoder) {
        videoDecoder.close();
        gop.videoDecoder = undefined;
      }
      const audioDecoder = gop.audioDecoder;
      if (audioDecoder) {
        audioDecoder.close();
        gop.audioDecoder = undefined;
      }
      const transferList: Transferable[] = [];
      gop.videoFrames.forEach(item => {
        transferList.push(item);
      });
      gop.audioChunks.forEach(item => {
        item.channels.forEach(item => {
          transferList.push(item.buffer);
        });
      });
      self.postMessage({
        url,
        type: Mp4boxEvent.DECODED,
        data: {
          index: gop.index,
          videoFrames: gop.videoFrames,
          audioChunks: gop.audioChunks,
          sampleRate: fileData.originData.audio?.configure.sampleRate,
        },
        // @ts-ignore
      }, transferList);
    }
    // 音视频可能都有，也可能只有一个，完成需要2个都完成
    let count = 0;
    let total = 0;
    const originData = fileData.originData;
    const videoOriginData = originData.video;
    if (videoOriginData) {
      total++;
      const videoDecoder = gop.videoDecoder = new VideoDecoder({
        output(frame) {
          // 解码结果一定严格按照cts时间序给出，直接存到当前framesArea即可，由于可能包含B帧需要，下一area的关键帧也传入，需忽略
          if (gop.videoFrames.length < gop.videoLength) {
            gop.videoFrames.push(frame);
          }
          else {
            // B帧原因可能存在下一区域的关键帧
            frame.close();
            return;
          }
        },
        error(e) {
          // release会触发报错
          if (gop.state !== GOPState.DECODING || gop.videoDecoder !== videoDecoder) {
            return;
          }
          onError(e.toString());
        },
      });
      const configure = videoOriginData!.configure;
      videoDecoder.configure({
        codec: configure.codec,
        codedWidth: configure.codedWidth,
        codedHeight: configure.codedHeight,
        description: configure.description ? new Uint8Array(configure.description, 8) : undefined,
      });
      // 从当前关键帧开始，一直解析到下一个关键帧（包含，可能包含B帧需要）之前结束
      for (let i = gop.videoSampleIndex, len = i + gop.videoLength; i <= len; i++) {
        const item = videoOriginData.samples[i];
        if (!item) {
          continue;
        }
        videoDecoder.decode(new EncodedVideoChunk({
          type: item.keyframe ? 'key' : 'delta',
          timestamp: item.cts,
          duration: item.duration,
          data: item.data,
        }));
      }
      videoDecoder.flush().then(() => {
        // 可能被release了
        if (videoDecoder !== gop.videoDecoder) {
          return;
        }
        count++;
        if (count === total) {
          finish();
        }
      });
    }
    const audioOriginData = originData.audio;
    if (audioOriginData) {
      total++;
      const audioDecoder = gop.audioDecoder = new AudioDecoder({
        output(frame) {
          const channels: Float32Array[] = [];
          const { numberOfChannels, numberOfFrames, timestamp } = frame;
          for (let ch = 0; ch < numberOfChannels; ch++) {
            const tmp = new Float32Array(numberOfFrames);
            // 使用 copyTo 安全读取
            frame.copyTo(tmp, { planeIndex: ch, format: 'f32-planar' });
            channels.push(tmp);
          }
          gop.audioChunks.push({
            channels,
            timestamp,
            numberOfFrames,
          });
          frame.close();
        },
        error(e) {
          // release会触发报错
          if (gop.state !== GOPState.DECODING || gop.audioDecoder !== audioDecoder) {
            return;
          }
          onError(e.toString());
        },
      });
      const configure = audioOriginData.configure;
      audioDecoder.configure({
        codec: configure.codec,
        sampleRate: configure.sampleRate,
        numberOfChannels: configure.numberOfChannels,
        description: configure.description ? new Uint8Array(configure.description, 8) : undefined,
      });
      for (let i = gop.audioSampleIndex, len = i + gop.audioLength; i <= len; i++) {
        const item = audioOriginData.samples[i];
        if (!item) {
          continue;
        }
        audioDecoder.decode(new EncodedAudioChunk({
          type: item.keyframe ? 'key' : 'delta',
          timestamp: item.cts,
          duration: item.duration,
          data: item.data,
        }));
      }
      audioDecoder.flush().then(() => {
        if (audioDecoder !== gop.audioDecoder) {
          return;
        }
        count++;
        if (count === total) {
          finish();
        }
      });
    }
  }
  else if (type === Mp4boxType.RELEASE) {
    const gop = fileData.gopList[e.data.index];
    if (gop) {
      const i = gop.users.indexOf(id);
      if (i > -1) {
        gop.users.splice(i, 1);
        if (!gop.users.length) {
          if (gop.state === GOPState.DECODING || gop.state === GOPState.DECODED) {
            gop.state = GOPState.LOADED;
          }
          gop.videoFrames.splice(0).forEach(item => item.close());
          gop.videoCount = 0;
          const videoDecoder = gop.videoDecoder;
          if (videoDecoder) {
            videoDecoder.close();
            gop.videoDecoder = undefined;
          }
          gop.audioChunks.splice(0);
          gop.audioCount = 0;
          const audioDecoder = gop.audioDecoder;
          if (audioDecoder) {
            audioDecoder.close();
            gop.audioDecoder = undefined;
          }
        }
      }
    }
  }
  // else if (type === Mp4boxType.LOAD_RANGE) {
  //   const framesArea = fileData.gopList[e.data.index];
  //   const start = Math.max(fileData.start, framesArea.start);
  //   const end = Math.min(fileData.fileSize - fileData.end - 1, framesArea.end - 1);
  //   // 有可能加载meta过程中所需要的区域已经加载好了，正在解封装，此时主线程来通知加载，需要忽略
  //   if (start >= (fileData.fileSize - fileData.end - 1) || end <= fileData.start) {
  //     return;
  //   }
  //   const key = framesArea.index;
  //   const range = fileData.ranges[key] = fileData.ranges[key] || {
  //     state: State.NONE,
  //     users: [],
  //   };
  //   // 防止重复
  //   if (range.users.includes(id)) {
  //     return;
  //   }
  //   range.users.push(id);
  //   // 多实例加载可能会因为线程时差导致重复
  //   if (range.state === State.LOADED || range.state === State.LOADING) {
  //     return;
  //   }
  //   range.state = State.LOADING;
  //   const controller = new AbortController();
  //   range.controller = controller;
  //   const { status, arrayBuffer } = await loadRange(url, start, end, {
  //     signal: controller.signal,
  //   });
  //   // 加载完成了清空controller，可能过程中主线程cancel了，此时无需继续解封，后续重新请求也会有网络缓存
  //   const i = range.users.indexOf(id);
  //   if (i > -1) {
  //     range.users.splice(i, 1);
  //   }
  //   else {
  //     return;
  //   }
  //   const time = framesArea.cts * 1e-6;
  //   console.log('load', messageId, framesArea.index, start, end, time);
  //   range.state = State.LOADED;
  //   if (!arrayBuffer) {
  //     onError('Bad request ' + status + ': ' + url);
  //     return;
  //   }
  //   if (arrayBuffer.byteLength) {
  //     mp4boxfile.seek(time, true);
  //     let fileStart = start;
  //     // @ts-ignore
  //     arrayBuffer.fileStart = fileStart;
  //     fileStart += arrayBuffer.byteLength;
  //     mp4boxfile.appendBuffer(arrayBuffer, start);
  //     mp4boxfile.flush();
  //   }
  //   else {
  //     onError('Empty body in range request: ' + url + ', ' + start + '-' + end);
  //   }
  // }
  // else if (type === Mp4boxType.CANCEL_LOAD_RANGE) {
  //   const framesArea = fileData.gopList[e.data.index];
  //   const key = framesArea.index;
  //   const range = fileData.ranges[key];
  //   // 理论不会出现
  //   if (!range) {
  //     return;
  //   }
  //   if (range.state === State.LOADED) {
  //     return;
  //   }
  //   const i = range.users.indexOf(id);
  //   if (i > -1) {
  //     range.users.splice(i, 1);
  //     console.log('cancel', messageId, framesArea.index, framesArea.start, framesArea.end)
  //   }
  //   if (!range.users.length) {
  //     range.state = State.NONE;
  //     range.controller?.abort();
  //     range.controller = undefined;
  //   }
  // }
};
