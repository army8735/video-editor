#ifdef GL_ES
precision mediump float;
#endif

varying vec4 v_position;
varying vec2 v_texCoords;
varying float v_opacity;
uniform vec4 u_clip;
uniform sampler2D u_texture;

void main() {
  if (v_position.x < u_clip[0] || v_position.x > u_clip[2] || v_position.y < u_clip[1] || v_position.y > u_clip[3]) {
    discard;
  }
  float opacity = v_opacity;
  if (opacity <= 0.0) {
    discard;
  }
  opacity = clamp(opacity, 0.0, 1.0);
  vec4 color = texture2D(u_texture, v_texCoords);
  gl_FragColor = color * opacity;
}
