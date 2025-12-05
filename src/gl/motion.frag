#ifdef GL_ES
precision mediump float;
#endif

varying vec2 v_texCoords;
uniform sampler2D u_texture;
uniform int u_kernel;
uniform vec4 u_velocity;

const int MAX_KERNEL_SIZE = 2048;

void main(void) {
  vec4 color = texture2D(u_texture, v_texCoords + u_velocity.zw);
  for (int i = 1; i < MAX_KERNEL_SIZE; i++) {
    if (i >= u_kernel) {
      break;
    }
    vec2 bias = u_velocity.xy * (float(i) / float(u_kernel));
    color += texture2D(u_texture, v_texCoords + bias + u_velocity.zw);
    color += texture2D(u_texture, v_texCoords - bias + u_velocity.zw);
  }
  gl_FragColor = color / float((u_kernel - 1) * 2 + 1);
}
