import { DEFAULT_STYLE } from './dft';
import {
  ComputedStyle,
  Style,
} from '../style/define';
import { VideoAudioMeta } from '../decoder';

export type Props = {
  uuid?: string;
  name?: string;
  style?: Partial<JStyle>;
}

export type RootProps = Props & {
  contextAttributes?: any,
}

export type BitmapProps = Props & {
  src: string;
  frameIndex?: number;
  onLoad?: () => void;
}

export type VideoProps = Props & {
  src: string;
  currentTime?: number;
  onMeta?: (o: VideoAudioMeta) => void;
  // onLoad?: (o: VideoAudioData) => void;
  onCanplay?: () => void;
  onError?: (e: string) => void;
  onWaiting?: () => void;
  volumn?: number;
  options?: RequestInit;
}

export type AudioProps = Props & {
  src: string;
  currentTime?: number;
  onMeta?: (o: VideoAudioMeta) => void;
  // onLoad?: (o: LoadAudioRes) => void;
  onCanplay?: () => void;
  onError?: (e: string) => void;
  onWaiting?: () => void;
  volumn?: number;
  options?: RequestInit;
};

export type LottieMeta = {
  duration: number;
};

export type LottieProps = Props & {
  src?: string;
  json?: JSON;
  currentTime?: number;
  onMeta?: (o: LottieMeta) => void;
  onLoad?: () => void;
  options?: RequestInit;
};

export type TextProps = Props & {
  content: string;
  rich?: JRich[];
  textBehaviour?: 'auto' | 'autoH' | 'fixed'; // sketch中特有，考虑字体的不确定性，记录原始文本框的大小位置对齐以便初始化
}

export type JRich = Pick<JStyle,
  'fontFamily'
  | 'fontSize'
  | 'fontWeight'
  | 'lineHeight'
  | 'letterSpacing'
  | 'paragraphSpacing'
  | 'fontStyle'
  | 'textAlign'
  | 'textDecoration'
  | 'color'
  | 'textShadow'
  | 'stroke'
  | 'strokeWidth'
  | 'strokeEnable'
> & {
  location: number,
  length: number,
};

export type Rich = Pick<Style,
  'fontFamily'
  | 'fontSize'
  | 'fontWeight'
  | 'lineHeight'
  | 'letterSpacing'
  | 'paragraphSpacing'
  | 'fontStyle'
  | 'textAlign'
  | 'textDecoration'
  | 'color'
  | 'textShadow'
  | 'stroke'
  | 'strokeWidth'
  | 'strokeEnable'
> & {
  location: number;
  length: number;
};

export type ComputedRich = Pick<ComputedStyle,
  'fontFamily'
  | 'fontSize'
  | 'fontWeight'
  | 'lineHeight'
  | 'letterSpacing'
  | 'paragraphSpacing'
  | 'fontStyle'
  | 'textAlign'
  | 'textDecoration'
  | 'color'
  | 'textShadow'
  | 'stroke'
  | 'strokeWidth'
  | 'strokeEnable'
> & {
  location: number;
  length: number;
};

export type JStyle = {
  top: number | string;
  right: number | string;
  bottom: number | string;
  left: number | string;
  width: number | string;
  height: number | string;
  lineHeight: number | 'normal';
  fontFamily: string;
  fontSize: number;
  fontWeight: number | string;
  fontStyle: 'normal' | 'italic' | 'oblique';
  letterSpacing: number;
  paragraphSpacing: number;
  textAlign: 'left' | 'center' | 'right' | 'justify';
  textVerticalAlign: 'top' | 'middle' | 'bottom';
  textDecoration: Array<'none' | 'underline' | 'line-through' | 'lineThrough'>;
  textShadow: string;
  color: string | number[];
  visibility: 'visible' | 'hidden';
  opacity: number;
  backgroundColor: string | number[];
  fill: Array<string | number[]>;
  fillOpacity: number[];
  fillEnable: boolean[];
  fillMode: string[];
  fillRule: 'nonzero' | 'evenodd';
  stroke: Array<string | number[]>;
  strokeEnable: boolean[];
  strokeWidth: number[];
  strokePosition: Array<'center' | 'inside' | 'outside'>;
  strokeMode: string[];
  strokeDasharray: number[];
  strokeLinecap: 'butt' | 'round' | 'square';
  strokeLinejoin: 'miter' | 'round' | 'bevel';
  strokeMiterlimit: number;
  translateX: string | number;
  translateY: string | number;
  scaleX: number;
  scaleY: number;
  rotateZ: number;
  transformOrigin: Array<number | 'left' | 'right' | 'top' | 'bottom' | 'center'> | string;
  mixBlendMode:
    | 'normal'
    | 'multiply'
    | 'screen'
    | 'overlay'
    | 'darken'
    | 'lighten'
    | 'color-dodge'
    | 'colorDodge'
    | 'color-burn'
    | 'colorBurn'
    | 'hard-light'
    | 'hardLight'
    | 'soft-light'
    | 'softLight'
    | 'difference'
    | 'exclusion'
    | 'hue'
    | 'saturation'
    | 'color'
    | 'luminosity';
  objectFit: 'fill' | 'contain' | 'cover';
  borderTopLeftRadius: number,
  borderTopRightRadius: number,
  borderBottomLeftRadius: number,
  borderBottomRightRadius: number,
  blur: string,
};

export type ResizeStyle = Partial<Pick<JStyle, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height' | 'scaleX' | 'scaleY'>>;

export type RotateZStyle = Pick<JStyle, 'rotateZ'>;

export type ModifyJRichStyle = Partial<Omit<JRich, 'location' | 'length'>>;

export type ModifyRichStyle = Partial<Omit<Rich, 'location' | 'length'>>;

export function getDefaultStyle(v?: Partial<JStyle>): JStyle {
  return Object.assign({}, DEFAULT_STYLE, v);
}

export default {
  getDefaultStyle,
};
