import Node from './Node'
import { AudioProps } from '../format';
import { loadAudio, LoadAudioRes } from '../util/loadAudio';
import { Options } from '../animation/AbstractAnimation';
import TimeAnimation from '../animation/TimeAnimation';

class Audio extends Node {
  private _src: string;
  loader?: LoadAudioRes;
  onLoad?: (e: LoadAudioRes) => void;
  onError?: (e: string) => void;
  audioBufferSourceNode?: AudioBufferSourceNode;
  gainNode?: GainNode;
  private _currentTime: number;
  private _volumn: number;
  timeAnimation?: TimeAnimation;

  constructor(props: AudioProps) {
    super(props);
    if (props.onLoad) {
      this.onLoad = props.onLoad;
    }
    if (props.onError) {
      this.onError = props.onError;
    }
    this._currentTime = props.currentTime || 0;
    this._volumn = Math.max(0, Math.min(1, props.volumn ?? 1));
    const src = (this._src = props.src || '');
    if (src) {
      loadAudio(src).then(res => {
        this.loader = res;
        if (res.success) {
          if (this.onLoad) {
            this.onLoad(res);
          }
        }
      });
    }
  }

  override release() {
    super.release();
    const { loader, audioBufferSourceNode, gainNode } = this;
    if (loader?.success) {
      loader.release();
    }
    if (audioBufferSourceNode) {
      audioBufferSourceNode.stop();
      audioBufferSourceNode.disconnect();
      this.audioBufferSourceNode = undefined;
    }
    if (gainNode) {
      gainNode.disconnect();
      this.gainNode = undefined;
    }
  }

  timeAnimate(start: number, options: Options & {
    autoPlay?: boolean;
  }) {
    this.timeAnimation?.remove();
    const animation = this.timeAnimation = new TimeAnimation(this, start, options);
    return this.initAnimate(animation, options);
  }

  get src() {
    return this._src;
  }

  get currentTime() {
    return this._currentTime;
  }

  set currentTime(v: number) {
    if (this._currentTime !== v) {
      this._currentTime = v;
      this.refresh();
    }
  }

  get volumn() {
    return this._volumn;
  }

  set volumn(v: number) {
    const n = Math.max(0, Math.min(1, v));
    if (this._volumn !== n) {
      this._volumn = n;
      if (this.gainNode) {
        this.gainNode.gain.value = n;
      }
    }
  }

  get duration() {
    return this.loader?.duration || 0;
  }
}

export default Audio;
