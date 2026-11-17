// The previews of the 30th Anniversary Edition's choices (terep2.js): a PCX
// image, decoded by the game's own decoder (in terep2.wasm), and a car
// (.dat) drawn with its texture, turning, with WebGL 2.

// The image ({ width, height, pixels, palette }) of a PCX file, null if it
// cannot be read.
export function decodePcx(wasm, buffer) {
    const file = new Uint8Array(buffer), p = wasm.web_alloc(file.length);
    new Uint8Array(wasm.memory.buffer, p, file.length).set(file);
    const ok = wasm.web_pcx(p, file.length);
    wasm.web_free(p);
    if (!ok)
        return null;
    const width = wasm.web_pcx_width(), height = wasm.web_pcx_height(), palette = wasm.web_pcx_palette();
    return {
        width, height,
        pixels: new Uint8Array(wasm.memory.buffer, wasm.web_pcx_pixels(), width * height).slice(),
        palette: palette ? new Uint8Array(wasm.memory.buffer, palette, 768).slice() : null,
    };
}

// Draws the image on the canvas, in a palette (grey without one), cut to
// width x height (the top left).
export function drawPcx(canvas, image, palette = image.palette, width = image.width, height = image.height) {
    canvas.width = width = Math.min(width, image.width);
    canvas.height = height = Math.min(height, image.height);
    const ctx = canvas.getContext('2d'), out = ctx.createImageData(width, height);
    for (let y = 0, i = 0; y < height; y++)
        for (let x = 0; x < width; x++, i++) {
            const c = image.pixels[y * image.width + x];
            out.data.set(palette ? palette.subarray(c * 3, c * 3 + 3) : [c, c, c], i * 4);
            out.data[i * 4 + 3] = 255;
        }
    ctx.putImageData(out, 0, 0);
}

// A car file (see src/car_file.cpp): its points ({ x, y, z, radius, wheel },
// in map units, z up) and what its model (src/car_draw.cpp) draws: the
// program read straight through, its polygons and wheels taken whatever
// the view (a depth buffer sorts them out), its jumps passed over: polygons
// ({ points, uv: [[u, v]...] or null, colour }, the points as { x, y, z })
// and wheels ({ at, axle, uv: the four corners of the sprites seen from
// either end of the axle, views 0 and 8 }).  The
// shadows (polygons on the ground under the car) and the smoke are left out.
export function decodeCar(buffer) {
    const dv = new DataView(buffer), size = buffer.byteLength;
    const u16 = (at) => at + 2 <= size ? dv.getUint16(at, true) : 0;
    const vo = u16(0), mo = u16(4), points = [];
    for (let i = 0, at = vo + 2; i < u16(vo) && at + 0x1c <= size; i++, at += 0x1c)
        points.push({ x: dv.getInt32(at, true) / 65536, y: dv.getInt32(at + 4, true) / 65536,
            z: dv.getInt32(at + 8, true) / 65536, radius: dv.getInt16(at + 24, true), wheel: u16(at + 26) });

    // the model's point k: vertex k / 2 (k odd: the ground under it), then
    // vertices 0 and 1 moved along the front axle (not steered here)
    const n = points.length;
    const point = (k) => k < 2 * n ? (k & 1 ? null : points[k >> 1])
        : k === 2 * n && n > 0 ? { ...points[0], x: points[0].x + 128 }
        : k === 2 * n + 1 && n > 1 ? { ...points[1], x: points[1].x - 128 } : null;

    const code = new Uint8Array(buffer, Math.min(mo, size));
    const rd8 = (pc) => pc < code.length ? code[pc] : 0, rd16 = (pc) => rd8(pc) | rd8(pc + 1) << 8;
    const polygons = [], wheels = [];
    const polygon = (pc, count, step, uv, colour) => {
        const corners = [], uvs = [];
        for (let i = 0; i < count; i++, pc += step) {
            corners.push(point(rd16(pc)));
            uvs.push([rd16(pc + 2) / 256, rd16(pc + 4) / 256]);    // 8.8 texels
        }
        if (corners.every(Boolean))
            polygons.push({ points: corners, uv: uv ? uvs : null, colour });
    };
    for (let pc = 0, len = 0; pc < code.length; pc += len) {
        const op = rd8(pc++) & 0x1f, count = rd8(pc) + 1;
        len = 0;
        switch (op) {
        case 1: len = 4; break;                                         // pixel
        case 2: case 3: len = 6; break;                                 // nearer, facing
        case 4:                                                         // flat
            polygon(pc + 1, count, 2, false, rd8(pc + 1 + count * 2));
            len = 1 + count * 2 + 2;
            break;
        case 6:                                                         // shaded: its first shade
            polygon(pc + 1, count, 4, false, rd8(pc + 4));
            len = 1 + count * 4;
            break;
        case 7:                                                         // shaded from a table: its base
            polygon(pc + 3, count, 4, false, rd8(pc + 2));
            len = 3 + count * 4;
            break;
        case 8:                                                         // textured
            polygon(pc + 1, count, 6, true, 0);
            len = 1 + count * 6;
            break;
        case 9: len = 20; break;                                        // sprite (smoke)
        case 10: {                                                      // wheel: its views 0 and 8
            const at = point(rd16(pc)), q = point(rd16(pc + 2));
            const uv = [0, 8].map((view) => [0, 1, 2, 3].map((i) =>
                [rd16(pc + 6 + view * 20 + 4 + 4 * i) / 256, rd16(pc + 6 + view * 20 + 6 + 4 * i) / 256]));
            if (at)
                wheels.push({ at, axle: q && q !== at ? [q.x - at.x, q.y - at.y, q.z - at.z] : [1, 0, 0], uv });
            len = 186;
            break;
        }
        case 16: len = 4; break;                                        // sort2
        case 17: case 18: case 19: case 20: len = 2; break;             // jumps, call
        }
    }
    return { points, polygons, wheels };
}

// The triangles of a wheel: a short cylinder across the car, the sprites
// of views 0 and 8 on its ends, the tread dark.
export function wheelTriangles(wheel, radius) {
    const len = Math.hypot(...wheel.axle), ax = wheel.axle.map((c) => c / len);
    // two directions across the axle: e1 up as much as it can be, e0 along the car
    let e1 = [-ax[2] * ax[0], -ax[2] * ax[1], 1 - ax[2] * ax[2]];
    const l1 = Math.hypot(...e1) || 1;
    e1 = e1.map((c) => c / l1);
    const e0 = [ax[1] * e1[2] - ax[2] * e1[1], ax[2] * e1[0] - ax[0] * e1[2], ax[0] * e1[1] - ax[1] * e1[0]];
    const half = radius * 0.4;
    // the sprite's corners at (-1, -1), (-1, 1), (1, 1), (1, -1) of (e0, e1)
    const uvAt = (s, t, side) => { const c = wheel.uv[side < 0 ? 0 : 1]; return [0, 1].map((k) => ((1 - s) * (1 - t) * c[0][k] + (1 - s) * (1 + t) * c[1][k]
        + (1 + s) * (1 + t) * c[2][k] + (1 + s) * (1 - t) * c[3][k]) / 4); };
    const at = (s, t, side) => ({
        x: wheel.at.x + radius * (s * e0[0] + t * e1[0]) + side * half * ax[0],
        y: wheel.at.y + radius * (s * e0[1] + t * e1[1]) + side * half * ax[1],
        z: wheel.at.z + radius * (s * e0[2] + t * e1[2]) + side * half * ax[2],
    });
    const tris = [], N = 16;
    for (let i = 0; i < N; i++) {
        const a0 = i / N * 2 * Math.PI, a1 = (i + 1) / N * 2 * Math.PI;
        const s0 = Math.cos(a0), t0 = Math.sin(a0), s1 = Math.cos(a1), t1 = Math.sin(a1);
        for (const side of [-1, 1])
            tris.push({ points: [at(0, 0, side), at(s0, t0, side), at(s1, t1, side)],
                uv: [uvAt(0, 0, side), uvAt(s0, t0, side), uvAt(s1, t1, side)] });
        tris.push({ points: [at(s0, t0, -1), at(s1, t1, -1), at(s1, t1, 1)], rgb: [24, 24, 24] });
        tris.push({ points: [at(s0, t0, -1), at(s1, t1, 1), at(s0, t0, 1)], rgb: [24, 24, 24] });
    }
    return tris;
}

// One WebGL 2 context, on a canvas of its own that is not shown, draws the
// previews (the car's and the map's), each then copied onto its 2D canvas:
// a page has only so many contexts, and the game wants its own.
let shared;

function glShared() {
    if (shared !== undefined)
        return shared;
    const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl2');
    return shared = gl ? { canvas, gl } : null;
}

function glProgram(gl, vertex, fragment) {
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            console.error(gl.getShaderInfoLog(shader));
        gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    return program;
}

function glTexture(gl) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
        gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
        gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    return texture;
}

// Starts a drawing the size of the canvas (at the bottom left of the shared
// one, which only grows), cleared.
function glBegin(canvas) {
    const { gl } = shared;
    if (shared.canvas.width < canvas.width || shared.canvas.height < canvas.height) {
        shared.canvas.width = Math.max(shared.canvas.width, canvas.width);
        shared.canvas.height = Math.max(shared.canvas.height, canvas.height);
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
}

// Copies the drawing onto the canvas (in the same task as it was drawn,
// before the browser drops it).
function glPresent(canvas) {
    const ctx = canvas.getContext('2d'), { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(shared.canvas, 0, shared.canvas.height - height, width, height, 0, 0, width, height);
}

// The car's drawing: its program, and the triangles and texture of the
// car, texture and palette it was last given.
const VERTEX_SHADER = `#version 300 es
in vec3 pos; in vec2 uv; in vec3 rgb;
uniform vec3 mid; uniform float angle, tilt, scale, aspect;
out vec2 vUv; out vec3 vRgb;
void main() {
    vec3 p = pos - mid;
    float c = cos(angle), s = sin(angle), ce = cos(tilt), se = sin(tilt);
    float rx = p.x * c - p.y * s, ry = p.x * s + p.y * c;
    // in perspective, as the map's: the eye 5 times the car's size away
    float depth = (ry * ce - p.z * se) * scale, w = 1.0 + depth / 4.5;
    gl_Position = vec4(rx * scale / aspect, (p.z * ce + ry * se) * scale, depth * 0.5 * w, w);
    vUv = uv; vRgb = rgb;
}`;
const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 vUv; in vec3 vRgb;
uniform sampler2D tex; uniform vec2 texSize;
out vec4 colour;
void main() {
    colour = vUv.x < 0.0 ? vec4(vRgb, 1.0) : texture(tex, vUv / texSize);
}`;

function carView() {
    if (!glShared())
        return null;
    if (shared.car)
        return shared.car;
    const { gl } = shared, program = glProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    const view = { gl, program, vao: gl.createVertexArray(), buffer: gl.createBuffer(), texture: glTexture(gl), count: 0, given: [] };
    gl.bindVertexArray(view.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, view.buffer);
    for (const [name, size, offset] of [['pos', 3, 0], ['uv', 2, 12], ['rgb', 3, 20]]) {
        const at = gl.getAttribLocation(program, name);
        gl.enableVertexAttribArray(at);
        gl.vertexAttribPointer(at, size, gl.FLOAT, false, 32, offset);
    }
    return shared.car = view;
}

// The car's triangles (8 floats a corner: x, y, z, u, v, r, g, b; u < 0 for
// a colour) and its texture (RGBA), in a palette.
function upload(view, car, texture, palette) {
    const { gl } = view, colour = (i) => palette ? [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]] : [i, i, i];
    const data = [];
    const triangle = (p, uv, rgb) => {
        for (let i = 0; i < 3; i++)
            data.push(p[i].x, p[i].y, p[i].z, ...(uv ? uv[i] : [-1, -1]), ...(rgb || [0, 0, 0]).map((c) => c / 255));
    };
    for (const poly of car.polygons)            // as fans
        for (let i = 1; i + 1 < poly.points.length; i++)
            triangle([poly.points[0], poly.points[i], poly.points[i + 1]],
                poly.uv && [poly.uv[0], poly.uv[i], poly.uv[i + 1]], colour(poly.colour));
    view.body = data.length / 8;
    for (const wheel of car.wheels)
        for (const t of wheelTriangles(wheel, wheel.at.radius || 20))
            triangle(t.points, t.uv, t.rgb);
    gl.bindBuffer(gl.ARRAY_BUFFER, view.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    view.count = data.length / 8;

    const w = texture?.width || 1, h = texture?.height || 1, rgba = new Uint8Array(w * h * 4).fill(128);
    if (texture)
        texture.pixels.forEach((c, i) => rgba.set([...colour(c), 255], i * 4));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, view.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    view.texSize = [w, h];

    const n = car.points.length;
    view.mid = ['x', 'y', 'z'].map((k) => car.points.reduce((s, p) => s + p[k], 0) / n);
    view.size = Math.max(...car.points.map((p) => Math.hypot(p.x - view.mid[0], p.y - view.mid[1], p.z - view.mid[2]) + p.radius));
}

// Draws the car turned by angle (radians, around z), seen from tilt
// (radians over the horizon) zoomed by zoom, with its texture (an image of decodePcx) in a palette, with WebGL.
export function drawCar(canvas, car, angle, texture, palette, tilt = 0.45, zoom = 1) {
    const view = carView();
    if (!view || !car.points.length)
        return;
    const { gl } = view;
    if (view.given[0] !== car || view.given[1] !== texture || view.given[2] !== palette) {
        upload(view, car, texture, palette);
        view.given = [car, texture, palette];
    }
    glBegin(canvas);
    gl.cullFace(gl.BACK);
    gl.useProgram(view.program);
    gl.bindVertexArray(view.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, view.texture);
    const u = (name) => gl.getUniformLocation(view.program, name);
    gl.uniform3fv(u('mid'), view.mid);
    gl.uniform1f(u('angle'), angle);
    gl.uniform1f(u('scale'), 0.9 * zoom / view.size);
    gl.uniform1f(u('tilt'), tilt);
    gl.uniform1f(u('aspect'), canvas.width / canvas.height);
    gl.uniform2fv(u('texSize'), view.texSize);
    gl.enable(gl.CULL_FACE);            // the body without the back of its polygons, as the game
    gl.drawArrays(gl.TRIANGLES, 0, view.body);
    gl.disable(gl.CULL_FACE);           // the wheels whichever way they turn
    gl.drawArrays(gl.TRIANGLES, view.body, view.count - view.body);
    glPresent(canvas);
}

// The map in 3D by relief (parallax) mapping: a box around the ground (from
// its lowest to its highest), each point of it following the ray from the
// eye into the box until under the ground (map.pcx, a height a byte,
// filtered), coloured there (col.pcx) and lit by the slope; its sides the
// ground's edges.  As in the game, both are the top left 256 x 256 of their
// images, and a height of 255 is 255 * 16 map units over cells of 256.
const TRACK_VERTEX_SHADER = `#version 300 es
uniform float angle, scale, aspect, tilt, top, distance, low, high;
out vec3 vPos;
const int FACES[36] = int[36](0,1,3, 0,3,2, 4,6,7, 4,7,5, 0,4,5, 0,5,1, 2,3,7, 2,7,6, 0,2,6, 0,6,4, 1,5,7, 1,7,3);
void main() {
    int k = FACES[gl_VertexID];
    vec3 p = vec3(float(k & 1) - 0.5, float(k >> 1 & 1) - 0.5, ((k & 4) != 0 ? high : low) / 256.0);
    p.z = (p.z - 0.3) * top;
    float c = cos(angle), s = sin(angle), ce = cos(tilt), se = sin(tilt);
    float rx = p.x * c - p.y * s, ry = p.x * s + p.y * c;
    float depth = ry * ce - p.z * se, w = 1.0 + depth / distance;
    gl_Position = vec4(rx * scale / aspect, (p.z * ce + ry * se) * scale, depth * scale * 0.5 * w, w);
    vPos = p;
}`;
const TRACK_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vPos;
uniform sampler2D ground; uniform sampler2D colours;
uniform float top, low, high; uniform vec3 eye;
out vec4 colour;
float z(vec2 p) { return (texture(ground, vec2(p.x + 0.5, 0.5 - p.y)).r * 255.0 / 256.0 - 0.3) * top; }
void main() {
    vec3 d = normalize(vPos - eye);
    // where the ray enters and leaves the box
    vec3 lo = vec3(-0.5, -0.5, (low / 256.0 - 0.3) * top - 1e-4), hi = vec3(0.5, 0.5, (high / 256.0 - 0.3) * top + 1e-4);
    vec3 t0 = (lo - eye) / d, t1 = (hi - eye) / d;
    float enter = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
    float leave = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
    if (enter > leave)
        discard;
    // steps of half a cell across the ground, then halved down to the crossing
    float span = leave - enter, steps = clamp(ceil(length(d.xy) * span * 512.0), 1.0, 768.0), dt = span / steps;
    float t = enter;
    bool hit = false;
    for (float i = 0.0; i <= steps; i++, t += dt) {
        vec3 p = eye + d * min(t, leave);
        if (p.z <= z(p.xy)) { hit = true; break; }
    }
    if (!hit)
        discard;
    float a = max(t - dt, enter), b = min(t, leave);
    for (int i = 0; i < 6; i++) {
        float m = (a + b) * 0.5;
        vec3 p = eye + d * m;
        if (p.z <= z(p.xy)) b = m; else a = m;
    }
    vec3 p = eye + d * b;
    vec2 e = vec2(1.0 / 256.0, 0.0);
    vec2 slope = vec2(z(p.xy + e.xy) - z(p.xy - e.xy), z(p.xy + e.yx) - z(p.xy - e.yx)) * 128.0;
    vec3 n = normalize(vec3(-slope, 1.0));
    float light = 0.5 + 0.5 * max(dot(n, normalize(vec3(-0.6, 0.6, 1.0))), 0.0);
    ivec2 at = clamp(ivec2(vec2(p.x + 0.5, 0.5 - p.y) * 256.0), ivec2(0), ivec2(255));
    colour = vec4(texelFetch(colours, at, 0).rgb * light, 1.0);
}`;

function trackView() {
    if (!glShared())
        return null;
    if (shared.track)
        return shared.track;
    const { gl } = shared;
    const view = { program: glProgram(gl, TRACK_VERTEX_SHADER, TRACK_FRAGMENT_SHADER),
        box: gl.createVertexArray(),            // no attributes: the corners from gl_VertexID
        ground: glTexture(gl), colours: glTexture(gl), given: [] };
    gl.bindTexture(gl.TEXTURE_2D, view.ground);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return shared.track = view;
}

function crop256(image) {
    const out = new Uint8Array(256 * 256);
    for (let y = 0; y < Math.min(256, image.height); y++)
        out.set(image.pixels.subarray(y * image.width, y * image.width + Math.min(256, image.width)), y * 256);
    return out;
}

// Draws the map (images of decodePcx: its heights, map.pcx, and its colours,
// col.pcx, in their palette) turned by angle (radians), seen from above at
// tilt (radians over the horizon), with WebGL; false without WebGL 2.

// Draws the map (images of decodePcx: its heights, map.pcx, and its colours,
// col.pcx, in their palette) turned by angle (radians), seen from above at
// tilt (radians over the horizon), in perspective, zoomed by zoom, with WebGL; false
// without WebGL 2.
export function drawTrack(canvas, heights, colours, angle, tilt = 0.6, zoom = 1) {
    const view = trackView();
    if (!view)
        return false;
    const { gl } = shared;
    if (view.given[0] !== heights || view.given[1] !== colours) {
        const ground = crop256(heights);
        view.low = ground.reduce((a, b) => Math.min(a, b), 255);
        view.high = ground.reduce((a, b) => Math.max(a, b), 0);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, view.ground);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 256, 0, gl.RED, gl.UNSIGNED_BYTE, ground);
        const index = crop256(colours), palette = colours.palette, rgba = new Uint8Array(256 * 256 * 4);
        index.forEach((c, i) => rgba.set(palette ? [palette[c * 3], palette[c * 3 + 1], palette[c * 3 + 2], 255] : [c, c, c, 255], i * 4));
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, view.colours);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        gl.activeTexture(gl.TEXTURE0);
        view.given = [heights, colours];
    }
    glBegin(canvas);
    gl.disable(gl.DEPTH_TEST);          // every face of the box draws the same
    gl.disable(gl.CULL_FACE);
    gl.useProgram(view.program);
    gl.bindVertexArray(view.box);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, view.ground);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, view.colours);
    gl.activeTexture(gl.TEXTURE0);
    const u = (name) => gl.getUniformLocation(view.program, name);
    gl.uniform1i(u('ground'), 1);
    gl.uniform1i(u('colours'), 2);
    gl.uniform1f(u('angle'), angle);
    gl.uniform1f(u('tilt'), tilt);
    gl.uniform1f(u('top'), 256 * 16 / (256 * 256) * TRACK_RELIEF);
    gl.uniform1f(u('low'), view.low);
    gl.uniform1f(u('high'), view.high);
    gl.uniform1f(u('scale'), 2 * zoom);
    gl.uniform1f(u('distance'), TRACK_EYE);
    gl.uniform1f(u('aspect'), canvas.width / canvas.height);
    // the eye in the map: the drawing's (0, 0, -distance) turned back
    const ce = Math.cos(tilt), se = Math.sin(tilt), c = Math.cos(angle), s = Math.sin(angle);
    const ry = -TRACK_EYE * ce;
    gl.uniform3f(u('eye'), ry * s, ry * c, TRACK_EYE * se);
    gl.drawArrays(gl.TRIANGLES, 0, 36);
    gl.enable(gl.DEPTH_TEST);
    glPresent(canvas);
    return true;
}

// How far the eye is from the middle of the map (in maps).
const TRACK_EYE = 2.5;

// How much higher than in the game the ground is drawn, to be seen.
const TRACK_RELIEF = 2;

