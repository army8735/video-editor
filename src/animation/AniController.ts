import Event from '../util/Event';
import AbstractAnimation from './AbstractAnimation';
import TimeAnimation from './TimeAnimation';
import Audio from '../node/Audio';

class AniController extends Event {
  aniList: AbstractAnimation[];
  audioContext: AudioContext;

  constructor(audioContext: AudioContext) {
    super();
    this.aniList = [];
    this.audioContext = audioContext;
  }

  addAni(animation: AbstractAnimation) {
    if (this.aniList.indexOf(animation) === -1) {
      this.aniList.push(animation);
      if (this.aniList.length === 1) {
        this.checkEvent();
      }
    }
  }

  removeAni(animation: AbstractAnimation) {
    const i = this.aniList.indexOf(animation);
    if (i > -1) {
      this.aniList.splice(i, 1);
      if (i === 0) {
        this.checkEvent();
      }
    }
  }

  play() {
    this.aniList.forEach(item => {
      item.play();
      checkPlayAudio(item);
    });
  }

  pause() {
    this.aniList.forEach(item => {
      item.pause();
      checkStopAudio(item);
    });
  }

  resume() {
    this.aniList.forEach(item => {
      item.resume();
      checkPlayAudio(item);
    });
  }

  finish() {
    this.aniList.forEach(item => {
      item.finish();
      checkStopAudio(item);
    });
  }

  cancel() {
    this.aniList.forEach(item => {
      item.cancel();
      checkStopAudio(item);
    });
  }

  gotoAndPlay(v: number) {
    this.aniList.forEach(item => {
      item.gotoAndPlay(v);
      checkPlayAudio(item);
    });
  }

  gotoAndStop(v: number) {
    this.aniList.forEach(item => {
      item.gotoAndStop(v);
      checkStopAudio(item);
    });
    this.aniList.forEach(item => {
      item.afterRunning();
    });
  }

  // 在没有添加动画前先侦听了事件，再添加动画，需要代理触发第0个的动画事件；或者移除了第0个动画后重新代理新的第0个动画事件
  private checkEvent() {
    const ani = this.aniList[0];
    if (ani) {
      Object.keys(this.__eHash).forEach(k => {
        const v = this.__eHash[k];
        v.forEach((handle: () => void) => {
          ani.on(k, handle);
        });
      });
    }
  }

  override on(id: string | string[], handle: (...p: any[]) => void) {
    super.on(id, handle);
    if (this.aniList.length) {
      this.aniList[0].on(id, handle);
    }
  }

  override once(id: string | string[], handle: (...p: any[]) => void) {
    super.once(id, handle);
    if (this.aniList.length) {
      this.aniList[0].once(id, handle);
    }
  }

  override off(id: string | string[], handle: (...p: any[]) => void) {
    super.off(id, handle);
    if (this.aniList.length) {
      this.aniList[0].off(id, handle);
    }
  }

  get currentTime() {
    const a = this.aniList[0];
    if (a) {
      return a.currentTime;
    }
    return 0;
  }

  set currentTime(v: number) {
    this.aniList.forEach(item => {
      item.currentTime = v;
    });
  }

  get duration() {
    const a = this.aniList[0];
    if (a) {
      return a.delay + a.duration + a.endDelay;
    }
    return 0;
  }

  get playCount() {
    const a = this.aniList[0];
    if (a) {
      return a.playCount;
    }
    return 0;
  }

  set playCount(v: number) {
    this.aniList.forEach(item => {
      item.playCount = v;
    });
  }

  get playState() {
    const a = this.aniList[0];
    if (a) {
      return a.playState;
    }
    return 'idle';
  }

  get pending() {
    const a = this.aniList[0];
    if (a) {
      return a.playState !== 'running';
    }
    return true;
  }
}

function checkPlayAudio(animation: AbstractAnimation) {
  if (animation instanceof TimeAnimation) {
    const node = animation.node;
    if (node.gainNode) {
      node.gainNode.disconnect();
      node.gainNode = undefined;
    }
    if (node instanceof Audio) {
      if (node.audioBufferSourceNode) {
        node.audioBufferSourceNode.stop();
        node.audioBufferSourceNode.disconnect();
        node.audioBufferSourceNode = undefined;
      }
      if (node.loader && node.loader.success && node.loader.audioBuffer && node.root) {
        const audioBuffer = node.loader.audioBuffer;
        const audioContext = node.root!.audioContext;
        if (!node.gainNode) {
          node.gainNode = audioContext.createGain();
          node.gainNode.gain.value = node.volumn;
        }
        if (animation.currentTime < animation.duration + animation.delay) {
          node.audioBufferSourceNode = audioContext.createBufferSource();
          node.audioBufferSourceNode.buffer = audioBuffer;
          node.audioBufferSourceNode.connect(node.gainNode);
          node.gainNode.connect(audioContext.destination);
          if (animation.currentTime >= animation.delay) {
            node.audioBufferSourceNode.start(0, (animation.currentTime - animation.delay) * 0.001, (animation.duration - animation.currentTime + animation.delay) * 0.001);
          }
          else {
            const delay = animation.delay - animation.currentTime;
            node.audioBufferSourceNode.start(audioContext.currentTime + delay * 0.001, 0, animation.duration * 0.001);
          }
        }
      }
    }
    // video可能没有声音就没有AudioBuffer
    else if (node.decoder) {
      const currentGOP = node.decoder.currentGOP;
      if (currentGOP?.audioBuffer && node.root) {
        const audioContext = node.root!.audioContext;
        if (!node.gainNode) {
          node.gainNode = audioContext.createGain();
          node.gainNode.gain.value = node.volumn;
        }
        if (currentGOP.audioBufferSourceNode) {
          currentGOP.audioBufferSourceNode.stop();
          currentGOP.audioBufferSourceNode.disconnect();
          currentGOP.audioBufferSourceNode = undefined;
        }
        if (animation.currentTime < animation.duration + animation.delay) {
          const audioBufferSourceNode = audioContext.createBufferSource();
          audioBufferSourceNode.buffer = currentGOP.audioBuffer;
          audioBufferSourceNode.connect(node.gainNode);
          node.gainNode.connect(audioContext.destination);
          currentGOP.audioBufferSourceNode = audioBufferSourceNode;
          // 当前时间进度条和区域的时间比靠后，立刻播放，offset计算是进度条减去前面的delay，然后位于当前区域的位置
          if (animation.currentTime >= animation.delay + currentGOP.timestamp * 1e3) {
            audioBufferSourceNode.start(
              0,
              (animation.currentTime - animation.delay) * 1e-3 + currentGOP.timestamp,
              currentGOP.duration,
            );
          }
          else {
            const delay = animation.delay - animation.currentTime;
            audioBufferSourceNode.start(
              audioContext.currentTime + delay * 1e-3,
              0,
              currentGOP.duration,
            );
          }
        }
        // 后面的可能解码好了，在区域非常近的情况，都是等待播放不会立刻播放
        const gopList = node.decoder.gopList;
        for (let i = node.decoder.gopIndex + 1, len = gopList.length; i < len; i++) {
          const item = gopList[i];
          if (item.audioBufferSourceNode) {
            item.audioBufferSourceNode.stop();
            item.audioBufferSourceNode.disconnect();
            item.audioBufferSourceNode = undefined;
          }
          if (item.audioBuffer) {
            const audioBufferSourceNode = audioContext.createBufferSource();
            audioBufferSourceNode.buffer = item.audioBuffer;
            if (!node.gainNode) {
              node.gainNode = audioContext.createGain();
              node.gainNode.gain.value = node.volumn;
            }
            audioBufferSourceNode.connect(node.gainNode);
            node.gainNode.connect(audioContext.destination);
            item.audioBufferSourceNode = audioBufferSourceNode;
            const delay = animation.delay - animation.currentTime + item.timestamp * 1e3;
            audioBufferSourceNode.start(
              audioContext.currentTime + delay * 1e-3,
              0,
              item.duration,
            );
          }
        }
      }
    }
  }
}

function checkStopAudio(animation: AbstractAnimation) {
  if (animation instanceof TimeAnimation) {
    const node = animation.node;
    if (node.gainNode) {
      node.gainNode.disconnect();
      node.gainNode = undefined;
    }
    if (node instanceof Audio) {
      if (node.audioBufferSourceNode) {
        node.audioBufferSourceNode.stop();
        node.audioBufferSourceNode.disconnect();
        node.audioBufferSourceNode = undefined;
      }
    }
    else {
      node.decoder?.gopList?.forEach(item => {
        item.audioBufferSourceNode?.stop();
        item.audioBufferSourceNode?.disconnect();
        item.audioBufferSourceNode = undefined;
      });
    }
  }
}

export default AniController;
