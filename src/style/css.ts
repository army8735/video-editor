import { ComputedRich, JRich, JStyle, Rich, } from '../format';
import inject from '../util/inject';
import { isNil, isString } from '../util/type';
import {
  BLUR,
  calUnit,
  ComputedBlur,
  ComputedGradient,
  ComputedStyle,
  FILL_RULE,
  FONT_STYLE,
  MIX_BLEND_MODE,
  OBJECT_FIT,
  PATTERN_FILL_TYPE,
  RICH_KEYS,
  STROKE_LINE_CAP,
  STROKE_LINE_JOIN,
  STROKE_POSITION,
  Style,
  StyleNumValue,
  StyleUnit,
  TEXT_ALIGN,
  TEXT_DECORATION,
  TEXT_VERTICAL_ALIGN,
  VISIBILITY,
} from './define';
import reg from './reg';
import { color2rgbaInt, color2rgbaStr } from './color';
import font from './font';
import { convert2Css, isGradient, parseGradient } from './gradient';

function compatibleTransform(k: string, v: StyleNumValue) {
  if (k === 'scaleX' || k === 'scaleY') {
    v.u = StyleUnit.NUMBER;
  }
  else if (k === 'translateX' || k === 'translateY') {
    if (v.u === StyleUnit.NUMBER) {
      v.u = StyleUnit.PX;
    }
  }
  else if (k === 'rotateZ') {
    if (v.u === StyleUnit.NUMBER) {
      v.u = StyleUnit.DEG;
    }
  }
}

export function normalize(style: Partial<JStyle>) {
  const res: any = {};
  [
    'left', 'top', 'right', 'bottom', 'width', 'height',
    'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
  ].forEach((k) => {
    let v = style[k as keyof JStyle];
    if (v === undefined) {
      return;
    }
    const n = calUnit((v as string | number) || 0, true);
    // 限定正数
    if (k === 'width' || k === 'height') {
      if (n.v < 0) {
        n.v = 0;
      }
    }
    res[k] = n;
  });
  if (style.lineHeight !== undefined) {
    const lineHeight = style.lineHeight;
    if (isNil(lineHeight) || lineHeight === 'normal') {
      res.lineHeight = {
        v: 0,
        u: StyleUnit.AUTO,
      };
    }
    else {
      let n = calUnit(lineHeight || 0, true);
      if (n.v <= 0) {
        n = {
          v: 0,
          u: StyleUnit.AUTO,
        };
      }
      res.lineHeight = n;
    }
  }
  if (style.fontFamily !== undefined) {
    res.fontFamily = {
      v: style.fontFamily
        .trim()
        .replace(/['"]/g, '')
        .replace(/\s*,\s*/g, ','),
      u: StyleUnit.STRING,
    };
  }
  if (style.fontSize !== undefined) {
    let n = calUnit(style.fontSize || inject.defaultFontSize, true);
    if (n.v <= 0) {
      n.v = inject.defaultFontSize;
    }
    res.fontSize = n;
  }
  if (style.fontWeight !== undefined) {
    const fontWeight = style.fontWeight;
    if (isString(fontWeight)) {
      if (/thin/i.test(fontWeight as string)) {
        res.fontWeight = { v: 100, u: StyleUnit.NUMBER };
      }
      else if (/lighter/i.test(fontWeight as string)) {
        res.fontWeight = { v: 200, u: StyleUnit.NUMBER };
      }
      else if (/light/i.test(fontWeight as string)) {
        res.fontWeight = { v: 300, u: StyleUnit.NUMBER };
      }
      else if (/medium/i.test(fontWeight as string)) {
        res.fontWeight = { v: 500, u: StyleUnit.NUMBER };
      }
      else if (/semiBold/i.test(fontWeight as string)) {
        res.fontWeight = { v: 600, u: StyleUnit.NUMBER };
      }
      else if (/bold/i.test(fontWeight as string)) {
        res.fontWeight = { v: 700, u: StyleUnit.NUMBER };
      }
      else if (/extraBold/i.test(fontWeight as string)) {
        res.fontWeight = { v: 800, u: StyleUnit.NUMBER };
      }
      else if (/black/i.test(fontWeight as string)) {
        res.fontWeight = { v: 900, u: StyleUnit.NUMBER };
      }
      else {
        res.fontWeight = { v: 400, u: StyleUnit.NUMBER };
      }
    }
    else {
      res.fontWeight = {
        v: Math.min(900, Math.max(100, parseInt(fontWeight as string) || 400)),
        u: StyleUnit.NUMBER,
      };
    }
  }
  if (style.fontStyle !== undefined) {
    const fontStyle = style.fontStyle;
    let v = FONT_STYLE.NORMAL;
    if (fontStyle && /italic/i.test(fontStyle)) {
      v = FONT_STYLE.ITALIC;
    }
    else if (fontStyle && /oblique/i.test(fontStyle)) {
      v = FONT_STYLE.OBLIQUE;
    }
    res.fontStyle = { v, u: StyleUnit.NUMBER };
  }
  if (style.letterSpacing !== undefined) {
    res.letterSpacing = calUnit(style.letterSpacing || 0, true);
  }
  if (style.paragraphSpacing !== undefined) {
    res.paragraphSpacing = calUnit(style.paragraphSpacing || 0, true);
  }
  if (style.textAlign !== undefined) {
    const textAlign = style.textAlign;
    let v = TEXT_ALIGN.LEFT;
    if (textAlign === 'center') {
      v = TEXT_ALIGN.CENTER;
    }
    else if (textAlign === 'right') {
      v = TEXT_ALIGN.RIGHT;
    }
    else if (textAlign === 'justify') {
      v = TEXT_ALIGN.JUSTIFY;
    }
    res.textAlign = { v, u: StyleUnit.NUMBER };
  }
  if (style.textVerticalAlign !== undefined) {
    const textVerticalAlign = style.textVerticalAlign;
    let v = TEXT_VERTICAL_ALIGN.TOP;
    if (textVerticalAlign === 'middle') {
      v = TEXT_VERTICAL_ALIGN.MIDDLE;
    }
    else if (textVerticalAlign === 'bottom') {
      v = TEXT_VERTICAL_ALIGN.BOTTOM;
    }
    res.textVerticalAlign = { v, u: StyleUnit.NUMBER };
  }
  if (style.textDecoration !== undefined) {
    const textDecoration = style.textDecoration;
    if (Array.isArray(textDecoration)) {
      res.textDecoration = textDecoration.map(item => {
        let v = TEXT_DECORATION.NONE;
        if (item === 'underline') {
          v = TEXT_DECORATION.UNDERLINE;
        }
        else if (item === 'line-through' || item === 'lineThrough') {
          v = TEXT_DECORATION.LINE_THROUGH;
        }
        return { v, u: StyleUnit.NUMBER };
      });
    }
    else {
      res.textDecoration = [];
    }
  }
  if (style.textShadow !== undefined) {
    if (reg.shadow.test(style.textShadow)) {
      const v = reg.shadow.exec(style.textShadow);
      if (v) {
        res.textShadow = {
          v: {
            x: parseFloat(v[1]),
            y: parseFloat(v[2]),
            blur: parseFloat(v[3]),
            color: color2rgbaInt(v[4]),
          },
          u: StyleUnit.SHADOW,
        };
      }
    }
    else {
      res.textShadow = {
        u: StyleUnit.SHADOW,
      };
    }
  }
  if (style.color !== undefined) {
    res.color = { v: color2rgbaInt(style.color), u: StyleUnit.RGBA };
  }
  if (style.visibility !== undefined) {
    res.visibility = {
      v: /hidden/i.test(style.visibility) ? VISIBILITY.HIDDEN : VISIBILITY.VISIBLE,
      u: StyleUnit.NUMBER,
    };
  }
  if (style.opacity !== undefined) {
    res.opacity = { v: Math.max(0, Math.min(1, style.opacity!)), u: StyleUnit.NUMBER };
  }
  if (style.backgroundColor !== undefined) {
    res.backgroundColor = { v: color2rgbaInt(style.backgroundColor), u: StyleUnit.RGBA };
  }
  if (style.fill !== undefined) {
    const fill = style.fill;
    if (Array.isArray(fill)) {
      res.fill = fill.map((item: string | number[]) => {
        if (isString(item)) {
          if (isGradient(item as string)) {
            const v = parseGradient(item as string);
            if (v) {
              return { v, u: StyleUnit.GRADIENT };
            }
          }
        }
        return { v: color2rgbaInt(item), u: StyleUnit.RGBA };
      });
    }
    else {
      res.fill = [];
    }
  }
  if (style.fillEnable !== undefined) {
    const fillEnable = style.fillEnable;
    if (Array.isArray(fillEnable)) {
      res.fillEnable = fillEnable.map((item: boolean) => {
        return { v: item, u: StyleUnit.BOOLEAN };
      });
    }
    else {
      res.fillEnable = res.fill.map(() => ({ v: true, u: StyleUnit.BOOLEAN }));
    }
  }
  if (style.fillOpacity !== undefined) {
    const fillOpacity = style.fillOpacity;
    if (Array.isArray(fillOpacity)) {
      res.fillOpacity = fillOpacity.map((item: number) => {
        return { v: Math.max(0, Math.min(1, item)), u: StyleUnit.NUMBER };
      });
    }
    else {
      res.fillOpacity = res.fill.map(() => ({ v: 1, u: StyleUnit.NUMBER }));
    }
  }
  if (style.fillMode !== undefined) {
    const fillMode = style.fillMode;
    if (Array.isArray(fillMode)) {
      res.fillMode = fillMode.map((item: string) => {
        return { v: getBlendMode(item), u: StyleUnit.NUMBER };
      });
    }
    else {
      res.fillMode = res.fill.map(() => ({ v: MIX_BLEND_MODE.NORMAL, u : StyleUnit.NUMBER }));
    }
  }
  if (style.fillRule !== undefined) {
    const fillRule = style.fillRule;
    res.fillRule = {
      v: fillRule === 'evenodd' ? FILL_RULE.EVEN_ODD : FILL_RULE.NON_ZERO,
      u: StyleUnit.NUMBER,
    };
  }
  if (style.stroke !== undefined) {
    const stroke = style.stroke;
    if (Array.isArray(stroke)) {
      res.stroke = stroke.map((item: string | number[]) => {
        if (isString(item)) {
          if (isGradient(item as string)) {
            const v = parseGradient(item as string);
            if (v) {
              return { v, u: StyleUnit.GRADIENT };
            }
          }
          else if (reg.img.test(item as string)) {
            const v = reg.img.exec(item as string);
            if (v) {
              let type = PATTERN_FILL_TYPE.TILE;
              const s = (item as string).replace(v[0], '');
              if (s.indexOf('fill') > -1) {
                type = PATTERN_FILL_TYPE.FILL;
              }
              else if (s.indexOf('stretch') > -1) {
                type = PATTERN_FILL_TYPE.STRETCH;
              }
              else if (s.indexOf('fit') > -1) {
                type = PATTERN_FILL_TYPE.FIT;
              }
              let scale;
              const v2 = /([\d.]+)%/.exec(s);
              if (v2) {
                scale = {
                  v: parseFloat(v2[1]),
                  u: StyleUnit.PERCENT,
                };
              }
              return { v: { url: v[2], type, scale }, u: StyleUnit.PATTERN };
            }
          }
        }
        return { v: color2rgbaInt(item), u: StyleUnit.RGBA };
      });
    }
    else {
      res.stroke = [];
    }
  }
  if (style.strokeEnable !== undefined) {
    const strokeEnable = style.strokeEnable;
    if (Array.isArray(strokeEnable)) {
      res.strokeEnable = strokeEnable.map((item: boolean) => {
        return { v: item, u: StyleUnit.BOOLEAN };
      });
    }
    else {
      res.strokeEnable = res.stroke.map(() => ({ v: true, u: StyleUnit.BOOLEAN }));
    }
  }
  if (style.strokeWidth !== undefined) {
    const strokeWidth = style.strokeWidth;
    if (Array.isArray(strokeWidth)) {
      res.strokeWidth = strokeWidth.map((item: number) => {
        return { v: Math.max(0, item), u: StyleUnit.PX };
      });
    }
    else {
      res.strokeWidth = res.stroke.map(() => ({ v: 1, u: StyleUnit.NUMBER }));
    }
  }
  if (style.strokePosition !== undefined) {
    const strokePosition = style.strokePosition;
    if (Array.isArray(strokePosition)) {
      res.strokePosition = strokePosition.map((item: string) => {
        let v = STROKE_POSITION.CENTER;
        if (item === 'inside') {
          v = STROKE_POSITION.INSIDE;
        }
        else if (item === 'outside') {
          v = STROKE_POSITION.OUTSIDE;
        }
        return { v, u: StyleUnit.NUMBER };
      });
    }
    else {
      res.strokePosition = res.stroke.map(() => ({ v: STROKE_POSITION.CENTER, u: StyleUnit.NUMBER }));
    }
  }
  if (style.strokeMode !== undefined) {
    const strokeMode = style.strokeMode;
    if (Array.isArray(strokeMode)) {
      res.strokeMode = strokeMode.map((item: string) => {
        return { v: getBlendMode(item), u: StyleUnit.NUMBER };
      });
    }
    else {
      res.strokeMode = res.stroke.map(() => ({ v: MIX_BLEND_MODE.NORMAL, u: StyleUnit.NUMBER }));
    }
  }
  if (style.strokeDasharray !== undefined) {
    const strokeDasharray = style.strokeDasharray;
    if (Array.isArray(strokeDasharray)) {
      res.strokeDasharray = strokeDasharray.map((item: number) => {
        return { v: Math.max(0, item), u: StyleUnit.PX };
      });
    }
    else {
      res.strokeDasharray = [];
    }
  }
  if (style.strokeLinecap !== undefined) {
    const strokeLinecap = style.strokeLinecap;
    let v = STROKE_LINE_CAP.BUTT;
    if (strokeLinecap === 'round') {
      v = STROKE_LINE_CAP.ROUND;
    }
    else if (strokeLinecap === 'square') {
      v = STROKE_LINE_CAP.SQUARE;
    }
    res.strokeLinecap = { v, u: StyleUnit.NUMBER };
  }
  if (style.strokeLinejoin !== undefined) {
    const strokeLinejoin = style.strokeLinejoin;
    let v = STROKE_LINE_JOIN.MITER;
    if (strokeLinejoin === 'round') {
      v = STROKE_LINE_JOIN.ROUND;
    }
    else if (strokeLinejoin === 'bevel') {
      v = STROKE_LINE_JOIN.BEVEL;
    }
    res.strokeLinejoin = { v, u: StyleUnit.NUMBER };
  }
  if (style.strokeMiterlimit !== undefined) {
    res.strokeMiterlimit = { v: style.strokeMiterlimit, u: StyleUnit.NUMBER };
  }
  // 只有这几个，3d没有
  ['translateX', 'translateY', 'scaleX', 'scaleY', 'rotateZ'].forEach((k) => {
    let v = style[k as keyof JStyle];
    if (v === undefined) {
      return;
    }
    const n = calUnit(v as string | number);
    // 没有单位或默认值处理单位
    compatibleTransform(k, n);
    res[k] = n;
  });
  if (style.transformOrigin !== undefined) {
    const transformOrigin = style.transformOrigin;
    let o: Array<number | string>;
    if (Array.isArray(transformOrigin)) {
      o = transformOrigin;
    }
    else {
      o = (transformOrigin || '').toString().match(reg.position) as Array<string>;
    }
    if (!o || !o.length) {
      o = [50, 50];
    }
    else if (o.length === 1) {
      o[1] = o[0];
    }
    const arr: Array<StyleNumValue> = [];
    for (let i = 0; i < 2; i++) {
      let item = o[i];
      if (/^[-+]?[\d.]/.test(item as string)) {
        let n = calUnit(item);
        arr.push(n);
      }
      else {
        arr.push({
          v: {
            top: 0,
            left: 0,
            center: 50,
            right: 100,
            bottom: 100,
          }[item] as number,
          u: StyleUnit.PERCENT,
        });
        // 不规范的写法变默认值50%
        if (isNil(arr[i].v)) {
          arr[i].v = 50;
        }
      }
    }
    res.transformOrigin = arr;
  }
  if (style.mixBlendMode !== undefined) {
    res.mixBlendMode = { v: getBlendMode(style.mixBlendMode), u: StyleUnit.NUMBER };
  }
  if (style.objectFit !== undefined) {
    res.objectFit = { v: getObjectFit(style.objectFit), u: StyleUnit.NUMBER };
  }
  if (style.blur !== undefined) {
    const blur = style.blur;
    const v = reg.blur.exec(blur);
    if (v) {
      const t = v[1].toLowerCase();
      let n = parseFloat(v[2]);
      if (n > 0) {
        n = Math.max(n, 1);
      }
      else {
        n = 0;
      }
      if (t === 'gauss') {
        res.blur = {
          v: { t: BLUR.GAUSSIAN, radius: { v: n, u: StyleUnit.PX } },
          u: StyleUnit.BLUR,
        };
      }
      else if (t === 'background') {
        const match = /saturation\s*\((.+)\)/i.exec(blur);
        let saturation = 0;
        if (match) {
          saturation = parseInt(match[1]) || 0;
        }
        res.blur = {
          v: {
            t: BLUR.BACKGROUND,
            radius: { v: n, u: StyleUnit.PX },
            saturation: { v: saturation, u: StyleUnit.PERCENT },
          },
          u: StyleUnit.BLUR,
        };
      }
      else if (t === 'radial') {
        const match = /center\s*\((.+)\)/i.exec(blur);
        let center = [{ v: 50, u: StyleUnit.PERCENT }, { v: 50, u: StyleUnit.PERCENT }];
        if (match) {
          const m = match[1].match(reg.number);
          if (m) {
            center[0] = {
              v: parseFloat(m[0]),
              u: StyleUnit.PERCENT,
            };
            center[1] = {
              v: parseFloat(m[1]),
              u: StyleUnit.PERCENT,
            };
          }
        }
        res.blur = {
          v: { t: BLUR.RADIAL, radius: { v: n, u: StyleUnit.PX }, center },
          u: StyleUnit.BLUR,
        };
      }
      else if (t === 'motion') {
        const matchAngle = /angle\s*\((.+)\)/i.exec(blur);
        const angle = {
          v: 0,
          u: StyleUnit.DEG,
        };
        if (matchAngle) {
          angle.v = parseFloat(matchAngle[1]);
        }
        const matchOffset = /offset\s*\((.+)\)/i.exec(blur);
        let offset = {
          v: 0,
          u: StyleUnit.PX,
        };
        if (matchOffset) {
          offset.v = parseFloat(matchOffset[1]);
        }
        res.blur = {
          v: {
            t: BLUR.MOTION,
            radius: { v: parseFloat(v[2]) || 0, u: StyleUnit.PX },
            angle,
            offset,
          },
          u: StyleUnit.BLUR,
        };
      }
      else {
        res.blur = { v: { t: BLUR.NONE }, u: StyleUnit.BLUR };
      }
    }
    else {
      res.blur = { v: { t: BLUR.NONE }, u: StyleUnit.BLUR };
    }
    ['hueRotate', 'saturate', 'brightness', 'contrast'].forEach(k => {
      if (style[k as keyof JStyle] === undefined) {
        return;
      }
      const n = calUnit(style[k as keyof JStyle] as string | number);
      // hue是角度，其它都是百分比
      if (k === 'hueRotate') {
        if (n.u !== StyleUnit.DEG) {
          n.u = StyleUnit.DEG;
        }
      }
      else {
        if (n.u !== StyleUnit.PERCENT) {
          n.v *= 100;
          n.u = StyleUnit.PERCENT;
        }
      }
      res[k] = n;
    });
  }
  return res;
}

export function setFontStyle(style: ComputedStyle | ComputedRich) {
  const fontSize = style.fontSize || inject.defaultFontSize;
  let fontFamily = style.fontFamily || inject.defaultFontFamily;
  // fontFamily += ',' + 'pingfangsc-regular';
  if (/[\s.,/\\]/.test(fontFamily)) {
    fontFamily = '"' + fontFamily.replace(/"/g, '\\"') + '"';
  }
  let fontStyle = '';
  if (style.fontStyle === FONT_STYLE.ITALIC) {
    fontStyle = 'italic ';
  }
  let fontWeight = '';
  if (style.fontWeight !== 400) {
    fontWeight = style.fontWeight + ' ';
  }
  return (
    fontStyle +
    fontWeight +
    fontSize + 'px ' +
    fontFamily
  );
}

export function calFontFamily(fontFamily: string) {
  const ff = fontFamily.split(/\s*,\s*/);
  for (let i = 0, len = ff.length; i < len; i++) {
    let item = ff[i].replace(/^['"]/, '').replace(/['"]$/, '');
    if (font.hasRegister(item) || inject.checkSupportFontFamily(item)) {
      return item;
    }
  }
  return inject.defaultFontFamily;
}

export function calNormalLineHeight(style: Pick<ComputedStyle, 'fontFamily' | 'fontSize'>, ff?: string) {
  if (!ff) {
    ff = calFontFamily(style.fontFamily);
  }
  const lhr =
    (font.data[ff] || font.data[inject.defaultFontFamily] || font.data.Arial || {})
      .lhr;
  return style.fontSize * lhr;
}

/**
 * https://zhuanlan.zhihu.com/p/25808995
 * 根据字形信息计算baseline的正确值，差值上下均分
 */
export function getBaseline(style: Pick<ComputedStyle, 'fontSize' | 'fontFamily' | 'lineHeight'>, lineHeight?: number) {
  const fontSize = style.fontSize;
  const ff = calFontFamily(style.fontFamily);
  const normal = calNormalLineHeight(style, ff);
  const blr =
    (font.data[ff] || font.data[inject.defaultFontFamily] || font.data.Arial || {})
      .blr || 1;
  return ((lineHeight ?? style.lineHeight) - normal) * 0.5 + fontSize * blr;
}

export function getContentArea(style: Pick<ComputedStyle, 'fontSize' | 'fontFamily' | 'lineHeight'>, lineHeight?: number) {
  const fontSize = style.fontSize;
  const ff = calFontFamily(style.fontFamily);
  const normal = calNormalLineHeight(style, ff);
  const car =
    (font.data[ff] || font.data[inject.defaultFontFamily] || font.data.Arial || {})
      .car || 1;
  return ((lineHeight ?? style.lineHeight) - normal) * 0.5 + fontSize * car;
}

export function getBlendMode(blend: string) {
  let v = MIX_BLEND_MODE.NORMAL;
  if (/multiply/i.test(blend)) {
    v = MIX_BLEND_MODE.MULTIPLY;
  }
  else if (/screen/i.test(blend)) {
    v = MIX_BLEND_MODE.SCREEN;
  }
  else if (/overlay/i.test(blend)) {
    v = MIX_BLEND_MODE.OVERLAY;
  }
  else if (/darken/i.test(blend)) {
    v = MIX_BLEND_MODE.DARKEN;
  }
  else if (/lighten/i.test(blend)) {
    v = MIX_BLEND_MODE.LIGHTEN;
  }
  else if (/color[-\s]dodge/i.test(blend) || /colorDodge/.test(blend)) {
    v = MIX_BLEND_MODE.COLOR_DODGE;
  }
  else if (/color[-\s]burn/i.test(blend) || /colorBurn/.test(blend)) {
    v = MIX_BLEND_MODE.COLOR_BURN;
  }
  else if (/hard[\-\s]light/i.test(blend) || /hardLight/.test(blend)) {
    v = MIX_BLEND_MODE.HARD_LIGHT;
  }
  else if (/soft[-\s]light/i.test(blend) || /softLight/.test(blend)) {
    v = MIX_BLEND_MODE.SOFT_LIGHT;
  }
  else if (/difference/i.test(blend)) {
    v = MIX_BLEND_MODE.DIFFERENCE;
  }
  else if (/exclusion/i.test(blend)) {
    v = MIX_BLEND_MODE.EXCLUSION;
  }
  else if (/hue/i.test(blend)) {
    v = MIX_BLEND_MODE.HUE;
  }
  else if (/saturation/i.test(blend)) {
    v = MIX_BLEND_MODE.SATURATION;
  }
  else if (/color/i.test(blend)) {
    v = MIX_BLEND_MODE.COLOR;
  }
  else if (/luminosity/i.test(blend)) {
    v = MIX_BLEND_MODE.LUMINOSITY;
  }
  return v;
}

export function getObjectFit(s: string) {
  let v = OBJECT_FIT.FILL;
  if (s === 'contain') {
    v = OBJECT_FIT.CONTAIN;
  }
  else if (s === 'cover') {
    v = OBJECT_FIT.COVER;
  }
  return v;
}

export function equalStyle(a: Partial<Style>, b: Partial<Style>, k: string) {
  if (a === b) {
    return true;
  }
  // @ts-ignore
  const av = a[k];
  // @ts-ignore
  const bv = b[k];
  if (k === 'transformOrigin') {
    return (
      av[0].v === bv[0].v &&
      av[0].u === bv[0].u &&
      av[1].v === bv[1].v &&
      av[1].u === bv[1].u
    );
  }
  if (k === 'color' || k === 'backgroundColor') {
    return (
      av.v[0] === bv.v[0] &&
      av.v[1] === bv.v[1] &&
      av.v[2] === bv.v[2] &&
      av.v[3] === bv.v[3]
    );
  }
  if (k === 'blur') {
    // TODO
  }
  return av.v === bv.v && av.u === bv.u;
}

export function cloneStyle(style: Partial<Style>, keys?: string | string[]) {
  if (!keys) {
    keys = Object.keys(style);
  }
  else if (!Array.isArray(keys)) {
    keys = [keys];
  }
  const res: Partial<Style> = {};
  for (let i = 0, len = keys.length; i < len; i++) {
    const k = keys[i];
    // @ts-ignore
    const v = style[k];
    if (!v) {
      continue;
    }
    if (k === 'transformOrigin') {
      res[k] = [Object.assign({}, v[0]), Object.assign({}, v[1])];
    }
    else if (k === 'blur') {
      res[k] = {
        v: {
          t: v.v.t,
          radius: Object.assign({}, v.v.radius),
          angle: Object.assign({}, v.v.angle),
          offset: Object.assign({}, v.v.offset),
        },
        u: v.u,
      };
    }
    else {
      // @ts-ignore
      res[k] = Object.assign({}, v);
    }
  }
  return res;
}

export function calSize(v: StyleNumValue, p: number): number {
  if (v.u === StyleUnit.PX) {
    return v.v;
  }
  if (v.u === StyleUnit.PERCENT) {
    return v.v * p * 0.01;
  }
  return 0;
}

export function normalizeRich(rich: Partial<JRich> & {
  location: number,
  length: number,
}, style: Style) {
  const res: any = {};
  RICH_KEYS.forEach((k) => {
    const v = style[k as keyof Style];
    if (v !== undefined) {
      res[k] = v;
    }
  });
  return {
    location: rich.location,
    length: rich.length,
    ...res,
    ...normalize(rich),
  } as Rich;
}

export function getCssMbm(v: MIX_BLEND_MODE) {
  return [
    'normal',
    'multiply',
    'screen',
    'overlay',
    'darken',
    'lighten',
    'color-dodge',
    'color-burn',
    'hard-light',
    'soft-light',
    'difference',
    'exclusion',
    'hue',
    'saturation',
    'color',
    'luminosity',
  ][v];
}

export function getCssObjectFit(v: OBJECT_FIT) {
  return ['fill', 'contain', 'cover'][v];
}

export function getCssBlur(blur: ComputedBlur) {
  if (blur.t === BLUR.NONE) {
    return 'none';
  }
  let s = ['none', 'gauss', 'motion', 'radial', 'background'][blur.t] + `(${blur.radius})`;
  if (blur.t === BLUR.MOTION) {
    s += ` angle(${blur.angle || 0}) offset(${blur.offset || 0})`;
  }
  else if (blur.t === BLUR.RADIAL) {
    const p = (blur.center || []).map(item => {
      return item * 100 + '%';
    });
    while (p.length < 2) {
      p.push('50%');
    }
    s += ` center(${p.join(', ')})`;
  }
  else if (blur.t === BLUR.BACKGROUND) {
    s += ` saturation(${(blur.saturation === undefined ? 1 : blur.saturation) * 100}%)`;
  }
  return s;
}

export function getCssFillStroke(item: number[] | ComputedGradient, width?: number, height?: number, standard = false) {
  if (Array.isArray(item)) {
    return color2rgbaStr(item);
  }
  return convert2Css(item as ComputedGradient, width, height, standard);
}

export function getCssStrokePosition(o: STROKE_POSITION) {
  return (['center', 'inside', 'outside'][o] || 'inside') as 'center' | 'inside' | 'outside';
}

export default {
  normalize,
  equalStyle,
  cloneStyle,
  calSize,
  normalizeRich,
  getCssMbm,
  getCssFillStroke,
  getCssStrokePosition,
  getCssBlur,
};
