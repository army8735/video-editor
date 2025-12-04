import { createTexture, drawColorMatrix } from '../gl/webgl';
import { genFrameBufferWithTexture, releaseFrameBuffer } from './fb';
import TextureCache from './TextureCache';
import { identity, multiply } from '../math/matrix';
import Root from '../node/Root';
import { d2r } from '../math/geom';

// https://docs.rainmeter.net/tips/colormatrix-guide/
export function genColorMatrix(
  gl: WebGL2RenderingContext | WebGLRenderingContext,
  root: Root,
  textureTarget: TextureCache,
  hueRotate: number,
  saturate: number,
  brightness: number,
  contrast: number,
  W: number,
  H: number,
) {
  const programs = root.programs;
  const cmProgram = programs.cmProgram;
  gl.useProgram(cmProgram);
  let res: TextureCache = textureTarget;
  let frameBuffer: WebGLFramebuffer | undefined;
  if (hueRotate || saturate !== 1 || brightness !== 1 || contrast !== 1) {
    const rotation = d2r(hueRotate % 360);
    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    const mh = hueRotate ? new Float64Array([
      0.213 + cosR * 0.787 - sinR * 0.213, 0.715 - cosR * 0.715 - sinR * 0.715, 0.072 - cosR * 0.072 + sinR * 0.928, 0,
      0.213 - cosR * 0.213 + sinR * 0.143, 0.715 + cosR * 0.285 + sinR * 0.140, 0.072 - cosR * 0.072 - sinR * 0.283, 0,
      0.213 - cosR * 0.213 - sinR * 0.787, 0.715 - cosR * 0.715 + sinR * 0.715, 0.072 + cosR * 0.928 + sinR * 0.072, 0,
      0, 0, 0, 1,
    ]) : identity();
    const s = saturate;
    const lr = 0.213;
    const lg = 0.715;
    const lb = 0.072;
    const sr = (1 - s) * lr;
    const sg = (1 - s) * lg;
    const sb = (1 - s) * lb;
    const ms = saturate !== 1 ? new Float64Array([
      sr + s, sg, sb, 0,
      sr, sg + s, sb, 0,
      sr, sg, sb + s, 0,
      0, 0, 0, 1,
    ]) : identity();
    const b = brightness - 1;
    const c = contrast;
    const d = (1 - c) * 0.5;
    // 不是简单的mh * ms * mb * mc，第5行是加法（b+d），https://stackoverflow.com/questions/49796623/how-to-implement-a-color-matrix-filter-in-a-glsl-shader
    const m = multiply(mh, ms);
    if (c !== 1) {
      m[0] *= c;
      m[1] *= c;
      m[2] *= c;
      m[4] *= c;
      m[5] *= c;
      m[6] *= c;
      m[8] *= c;
      m[9] *= c;
      m[10] *= c;
    }
    const old = res;
    const t = genColorByMatrix(gl, cmProgram, old, [
      m[0], m[1], m[2], m[3], b + d,
      m[4], m[5], m[6], m[7], b + d,
      m[8], m[9], m[10], m[11], b + d,
      0, 0, 0, 1,
    ], frameBuffer);
    res = t.res;
    frameBuffer = t.frameBuffer;
    if (old !== textureTarget) {
      old.release();
    }
  }
  gl.useProgram(programs.program);
  if (frameBuffer) {
    releaseFrameBuffer(gl, frameBuffer, W, H);
    return res;
  }
  else {
    gl.viewport(0, 0, W, H);
  }
}

function genColorByMatrix(
  gl: WebGL2RenderingContext | WebGLRenderingContext,
  cmProgram: WebGLProgram,
  old: TextureCache,
  m: number[],
  frameBuffer?: WebGLFramebuffer,
) {
  const res = TextureCache.getEmptyInstance(gl, old.bbox);
  res.available = true;
  const list = old.list;
  const listR = res.list;
  for (let i = 0, len = list.length; i < len; i++) {
    const { bbox, w, h, t } = list[i];
    const tex = createTexture(gl, 0, undefined, w, h);
    if (frameBuffer) {
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        tex,
        0,
      );
      gl.viewport(0, 0, w, h);
    }
    else {
      frameBuffer = genFrameBufferWithTexture(gl, tex, w, h);
    }
    t && drawColorMatrix(gl, cmProgram, t, m);
    listR.push({
      bbox: bbox.slice(0),
      w,
      h,
      t: tex,
    });
    // const pixels = new Uint8Array(w * h * 4);
    // gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  }
  return { res, frameBuffer };
}
