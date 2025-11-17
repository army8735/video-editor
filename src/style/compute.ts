import { ComputedGradient, ComputedPattern, Gradient, Pattern, Style } from './define';

export function calComputedFill(fill: Style['fill']) {
  return fill.map((item) => {
    if (Array.isArray(item.v)) {
      return item.v.slice(0);
    }
    const v = item.v as Gradient;
    return {
      t: v.t,
      d: v.d.slice(0),
      stops: v.stops.map(item => {
        const offset = item.offset.v * 0.01;
        return {
          color: item.color.v.slice(0),
          offset,
        };
      }),
    } as ComputedGradient;
  });
}

export function calComputedStroke(stroke: Style['stroke']) {
  return stroke.map((item) => {
    if (Array.isArray(item.v)) {
      return item.v.slice(0);
    }
    const v = item.v as Gradient;
    return {
      t: v.t,
      d: v.d.slice(0),
      stops: v.stops.map(item => {
        const offset = item.offset ? item.offset.v * 0.01 : undefined;
        return {
          color: item.color.v.slice(0),
          offset,
        };
      }),
    } as ComputedGradient;
  });
}

export default {
  calComputedFill,
  calComputedStroke,
};
