/**
 * Катсцены — волны на воде по кадру: шейдер WebGL на отдельном холсте поверх.
 */

import { easeOut } from "./math.js";

/**
 * Волны на воде — шейдером WebGL, одним проходом: каждый пиксель берётся из кадра со сдвигом
 * к точке удара или от неё по бегущей синусоиде расстояния — изображение колышется кругами.
 * За фронтом волны — спокойно, к концу волны гаснут; по фронту — тонкие светлые гребни.
 * На 2D-холсте то же самое стоило десятков полноэкранных отрисовок за кадр и тормозило.
 * @returns {{canvas: HTMLCanvasElement, draw: Function}|null}  null — WebGL недоступен.
 */
export function rippleRenderer(W, H) {
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true });
    if (!gl) return null;
    const compile = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, 'attribute vec2 p; varying vec2 uv; void main() { uv = p * 0.5 + 0.5; uv.y = 1.0 - uv.y; gl_Position = vec4(p, 0.0, 1.0); }'));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `
        precision highp float;
        varying vec2 uv;
        uniform sampler2D image;
        uniform vec2 size, center;
        uniform float front, wave, calm;
        void main() {
            vec2 px = uv * size, d = px - center;
            float r = length(d), s = 1.0;
            if (r < front) {
                float strength = 0.05 * calm * (0.25 + 0.75 * r / front);
                s = 1.0 + strength * sin((r - front) / wave * 6.2831853);
            }
            vec4 color = texture2D(image, (center + d / s) / size);
            for (int k = 0; k < 4; k++) {
                float crest = front - float(k) * wave * 1.3;
                float a = 0.35 * calm * (1.0 - float(k) / 4.0) * step(0.0, crest) * (1.0 - smoothstep(0.0, wave * 0.035, abs(r - crest)));
                color = mix(color, vec4(1.0), a);
            }
            gl_FragColor = color;
        }`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const u = name => gl.getUniformLocation(program, name);
    gl.uniform2f(u('size'), W, H);
    gl.viewport(0, 0, W, H);
    /** @param {number} age  Доля времени волн, 0 → 1. */
    const draw = (image, cx, cy, age, unit) => {
        const reach = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.uniform2f(u('center'), cx, cy);
        gl.uniform1f(u('front'), reach * (0.15 + 0.95 * easeOut(age)));
        gl.uniform1f(u('wave'), unit * 0.11);
        gl.uniform1f(u('calm'), (1 - age) ** 1.5);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    return { canvas, draw };
}

// Шейдер волн: один на размер экрана — компилируется один раз
let rippleCache = null;
export function rippleFor(W, H) {
    if (rippleCache?.W !== W || rippleCache?.H !== H) {
        let renderer = null;
        try { renderer = rippleRenderer(W, H); } catch (error) { console.warn('gachadnd | волны', error); }
        rippleCache = { W, H, renderer };
    }
    return rippleCache.renderer;
}
