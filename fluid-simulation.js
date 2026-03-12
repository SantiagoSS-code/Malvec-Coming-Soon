'use strict';

// WebGL Fluid Simulation (MIT License, Saiprava Nayak — codepen.io/Saiprava/pen/GRWwqzB)
// Integrated as a full-screen interactive background for the landing page.
// Refactored for cross-browser resilience: Safari iPhone, Chrome Android/Windows,
// Instagram/WhatsApp in-app browsers, incognito, low power mode.

(function () {

    /* ─── Feature detection & environment ──────────────────────── */
    var ua = navigator.userAgent || '';
    var isSafari    = /^((?!chrome|android).)*safari/i.test(ua);
    var isIOS       = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var isInApp     = /FBAN|FBAV|Instagram|Line\/|WhatsApp|Snapchat|MicroMessenger/i.test(ua);
    var isMobile    = /Mobi|Android/i.test(ua) || isIOS;
    var prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ─── Grab the hero canvas already in the DOM ──────────────── */
    var canvas = document.getElementById('hero-fluid-canvas');
    var cssFallback = document.getElementById('hero-css-fallback');

    if (!canvas) return;

    /* ─── Activate CSS fallback (hidden by default) ────────────── */
    function showCSSFallback() {
        if (canvas) canvas.style.display = 'none';
        if (cssFallback) cssFallback.classList.add('active');
    }

    /* ─── Reduced motion: show static frame, pause loop ────────── */
    if (prefersReducedMotion) {
        // Show a subtle static CSS fallback instead of animating WebGL
        showCSSFallback();
        return;
    }

    /* ─── WebGL context acquisition with fallback chain ────────── */
    var glResult = getWebGLContext(canvas);
    if (!glResult) {
        showCSSFallback();
        return;
    }
    var gl  = glResult.gl;
    var ext = glResult.ext;

    /* ─── Resize canvas to match CSS size ────────────────────────── */
    function resizeCanvas() {
        if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
            canvas.width  = canvas.clientWidth;
            canvas.height = canvas.clientHeight;
            return true; // resized
        }
        return false;
    }
    canvas.width  = canvas.clientWidth;
    canvas.height = canvas.clientHeight;

    /* ─── Config (tuned per device class) ──────────────────────── */
    var TEXTURE_DOWNSAMPLE   = (isMobile || isInApp) ? 2 : 1;
    var DENSITY_DISSIPATION  = 0.98;
    var VELOCITY_DISSIPATION = 0.99;
    var PRESSURE_DISSIPATION = 0.8;
    var PRESSURE_ITERATIONS  = (isMobile || isInApp) ? 15 : 25;
    var CURL                 = 30;
    var SPLAT_RADIUS         = 0.003;

    /* ─── Malvec brand palette ─────────────────────────────────── */
    var MALVEC_COLORS = [
        [9.1, 0.5, 5.5],   // --pink      #e91e8c
        [7.6, 0.4, 3.6],   // --pink-dim  #c2185b
        [4.8, 0.8, 6.4],   // --purple    #7b1fa2
        [8.0, 0.3, 6.0],   // hot-pink blend
        [6.0, 0.5, 7.5],   // purple-pink blend
    ];
    function malvecColor() {
        var base = MALVEC_COLORS[Math.floor(Math.random() * MALVEC_COLORS.length)];
        var v = 0.4 + Math.random() * 0.6;
        return [base[0] * v, base[1] * v, base[2] * v];
    }

    /* ─── Pointer state ────────────────────────────────────────── */
    var pointers = [];
    var splatStack = [];

    function PointerPrototype() {
        this.id    = -1;
        this.x     = 0;
        this.y     = 0;
        this.dx    = 0;
        this.dy    = 0;
        this.down  = false;
        this.moved = false;
        this.color = [9.1, 0.5, 5.5];
    }
    pointers.push(new PointerPrototype());

    /* ═══════════════════════════════════════════════════════════
       WebGL Context
       ═══════════════════════════════════════════════════════════ */

    function getWebGLContext(cvs) {
        var params = {
            alpha: false,
            depth: false,
            stencil: false,
            antialias: false,
            // Critical for iOS Safari & in-app browsers:
            preserveDrawingBuffer: false,
            powerPreference: 'low-power',
            failIfMajorPerformanceCaveat: false
        };

        var glCtx = null;
        var isWebGL2 = false;

        // Try WebGL2 first, then WebGL1
        try { glCtx = cvs.getContext('webgl2', params); isWebGL2 = !!glCtx; } catch(e) {}
        if (!glCtx) {
            try { glCtx = cvs.getContext('webgl', params) || cvs.getContext('experimental-webgl', params); } catch(e) {}
        }
        if (!glCtx) return null;

        var halfFloat;
        var supportLinearFiltering;
        if (isWebGL2) {
            glCtx.getExtension('EXT_color_buffer_float');
            supportLinearFiltering = glCtx.getExtension('OES_texture_float_linear');
        } else {
            halfFloat = glCtx.getExtension('OES_texture_half_float');
            supportLinearFiltering = glCtx.getExtension('OES_texture_half_float_linear');
        }

        glCtx.clearColor(0.0, 0.0, 0.0, 1.0);

        var halfFloatTexType = isWebGL2 ? glCtx.HALF_FLOAT : (halfFloat ? halfFloat.HALF_FLOAT_OES : null);
        if (!halfFloatTexType) return null;

        var formatRGBA, formatRG, formatR;
        if (isWebGL2) {
            formatRGBA = getSupportedFormat(glCtx, glCtx.RGBA16F, glCtx.RGBA, halfFloatTexType);
            formatRG   = getSupportedFormat(glCtx, glCtx.RG16F, glCtx.RG, halfFloatTexType);
            formatR    = getSupportedFormat(glCtx, glCtx.R16F, glCtx.RED, halfFloatTexType);
        } else {
            formatRGBA = getSupportedFormat(glCtx, glCtx.RGBA, glCtx.RGBA, halfFloatTexType);
            formatRG   = getSupportedFormat(glCtx, glCtx.RGBA, glCtx.RGBA, halfFloatTexType);
            formatR    = getSupportedFormat(glCtx, glCtx.RGBA, glCtx.RGBA, halfFloatTexType);
        }

        // If no renderable format found, bail
        if (!formatRGBA || !formatRG || !formatR) return null;

        return {
            gl: glCtx,
            ext: {
                formatRGBA: formatRGBA,
                formatRG: formatRG,
                formatR: formatR,
                halfFloatTexType: halfFloatTexType,
                supportLinearFiltering: supportLinearFiltering
            }
        };
    }

    function getSupportedFormat(glCtx, internalFormat, format, type) {
        if (!supportRenderTextureFormat(glCtx, internalFormat, format, type)) {
            switch (internalFormat) {
                case glCtx.R16F:
                    return getSupportedFormat(glCtx, glCtx.RG16F, glCtx.RG, type);
                case glCtx.RG16F:
                    return getSupportedFormat(glCtx, glCtx.RGBA16F, glCtx.RGBA, type);
                default:
                    return null;
            }
        }
        return { internalFormat: internalFormat, format: format };
    }

    function supportRenderTextureFormat(glCtx, internalFormat, format, type) {
        var texture = glCtx.createTexture();
        glCtx.bindTexture(glCtx.TEXTURE_2D, texture);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_MIN_FILTER, glCtx.NEAREST);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_MAG_FILTER, glCtx.NEAREST);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_WRAP_S, glCtx.CLAMP_TO_EDGE);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_WRAP_T, glCtx.CLAMP_TO_EDGE);
        glCtx.texImage2D(glCtx.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

        var fbo = glCtx.createFramebuffer();
        glCtx.bindFramebuffer(glCtx.FRAMEBUFFER, fbo);
        glCtx.framebufferTexture2D(glCtx.FRAMEBUFFER, glCtx.COLOR_ATTACHMENT0, glCtx.TEXTURE_2D, texture, 0);

        var status = glCtx.checkFramebufferStatus(glCtx.FRAMEBUFFER);

        // Clean up test resources
        glCtx.bindFramebuffer(glCtx.FRAMEBUFFER, null);
        glCtx.deleteTexture(texture);
        glCtx.deleteFramebuffer(fbo);

        return status === glCtx.FRAMEBUFFER_COMPLETE;
    }

    /* ═══════════════════════════════════════════════════════════
       Shader Compilation (with error recovery)
       ═══════════════════════════════════════════════════════════ */

    function GLProgram(vertexShader, fragmentShader) {
        this.uniforms = {};
        this.program = gl.createProgram();

        gl.attachShader(this.program, vertexShader);
        gl.attachShader(this.program, fragmentShader);
        gl.linkProgram(this.program);

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            console.warn('Fluid sim: shader link failed', gl.getProgramInfoLog(this.program));
            return;
        }

        var uniformCount = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
        for (var i = 0; i < uniformCount; i++) {
            var uniformName = gl.getActiveUniform(this.program, i).name;
            this.uniforms[uniformName] = gl.getUniformLocation(this.program, uniformName);
        }
    }
    GLProgram.prototype.bind = function () {
        gl.useProgram(this.program);
    };

    function compileShader(type, source) {
        var shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.warn('Fluid sim: shader compile failed', gl.getShaderInfoLog(shader));
            return null;
        }
        return shader;
    }

    /* ═══════════════════════════════════════════════════════════
       Shaders
       ═══════════════════════════════════════════════════════════ */

    var baseVertexShader = compileShader(gl.VERTEX_SHADER,
        'precision highp float;\n' +
        'precision mediump sampler2D;\n' +
        'attribute vec2 aPosition;\n' +
        'varying vec2 vUv;\n' +
        'varying vec2 vL;\n' +
        'varying vec2 vR;\n' +
        'varying vec2 vT;\n' +
        'varying vec2 vB;\n' +
        'uniform vec2 texelSize;\n' +
        'void main () {\n' +
        '    vUv = aPosition * 0.5 + 0.5;\n' +
        '    vL = vUv - vec2(texelSize.x, 0.0);\n' +
        '    vR = vUv + vec2(texelSize.x, 0.0);\n' +
        '    vT = vUv + vec2(0.0, texelSize.y);\n' +
        '    vB = vUv - vec2(0.0, texelSize.y);\n' +
        '    gl_Position = vec4(aPosition, 0.0, 1.0);\n' +
        '}\n'
    );

    if (!baseVertexShader) { showCSSFallback(); return; }

    var clearShader = compileShader(gl.FRAGMENT_SHADER,
        'precision highp float;\n' +
        'precision mediump sampler2D;\n' +
        'varying vec2 vUv;\n' +
        'uniform sampler2D uTexture;\n' +
        'uniform float value;\n' +
        'void main () {\n' +
        '    gl_FragColor = value * texture2D(uTexture, vUv);\n' +
        '}\n'
    );

    var displayShader = compileShader(gl.FRAGMENT_SHADER,
        'precision highp float;\n' +
        'precision mediump sampler2D;\n' +
        'varying vec2 vUv;\n' +
        'uniform sampler2D uTexture;\n' +
        'void main () {\n' +
        '    gl_FragColor = texture2D(uTexture, vUv);\n' +
        '}\n'
    );

    var splatShader = compileShader(gl.FRAGMENT_SHADER,
        'precision highp float;\n' +
        'precision mediump sampler2D;\n' +
        'varying vec2 vUv;\n' +
        'uniform sampler2D uTarget;\n' +
        'uniform float aspectRatio;\n' +
        'uniform vec3 color;\n' +
        'uniform vec2 point;\n' +
        'uniform float radius;\n' +
        'void main () {\n' +
        '    vec2 p = vUv - point.xy;\n' +
        '    p.x *= aspectRatio;\n' +
        '    vec3 splat = exp(-dot(p, p) / radius) * color;\n' +
        '    vec3 base = texture2D(uTarget, vUv).xyz;\n' +
        '    gl_FragColor = vec4(base + splat, 1.0);\n' +
        '}\n'
    );

    var advectionManualFilteringShader = compileShader(gl.FRAGMENT_SHADER,
        'precision highp float;\n' +
        'precision mediump sampler2D;\n' +
        'varying vec2 vUv;\n' +
        'uniform sampler2D uVelocity;\n' +
        'uniform sampler2D uSource;\n' +
        'uniform vec2 texelSize;\n' +
        'uniform float dt;\n' +
        'uniform float dissipation;\n' +
        'vec4 bilerp (in sampler2D sam, in vec2 p) {\n' +
        '    vec4 st;\n' +
        '    st.xy = floor(p - 0.5) + 0.5;\n' +
        '    st.zw = st.xy + 1.0;\n' +
        '    vec4 uv = st * texelSize.xyxy;\n' +
        '    vec4 a = texture2D(sam, uv.xy);\n' +
        '    vec4 b = texture2D(sam, uv.zy);\n' +
        '    vec4 c = texture2D(sam, uv.xw);\n' +
        '    vec4 d = texture2D(sam, uv.zw);\n' +
        '    vec2 f = p - st.xy;\n' +
        '    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);\n' +
        '}\n' +
        'void main () {\n' +
        '    vec2 coord = gl_FragCoord.xy - dt * texture2D(uVelocity, vUv).xy;\n' +
        '    gl_FragColor = dissipation * bilerp(uSource, coord);\n' +
        '    gl_FragColor.a = 1.0;\n' +
        '}\n'
    );

    var advectionShader = compileShader(gl.FRAGMENT_SHADER,
        'precision highp float;\n' +
        'precision mediump sampler2D;\n' +
        'varying vec2 vUv;\n' +
        'uniform sampler2D uVelocity;\n' +
        'uniform sampler2D uSource;\n' +
        'uniform vec2 texelSize;\n' +
        'uniform float dt;\n' +
        'uniform float dissipation;\n' +
        'void main () {\n' +
        '    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;\n' +
        '    gl_FragColor = dissipation * texture2D(uSource, coord);\n' +
        '    gl_FragColor.a = 1.0;\n' +
        '}\n'
    );

    var divergenceShader = compileShader(gl.FRAGMENT_SHADER,
        'precision highp float;\n' +
        'precision mediump sampler2D;\n' +
        'varying vec2 vUv;\n' +
        'varying vec2 vL;\n' +
        'varying vec2 vR;\n' +
        'varying vec2 vT;\n' +
        'varying vec2 vB;\n' +
        'uniform sampler2D uVelocity;\n' +
        'vec2 sampleVelocity (in vec2 uv) {\n' +
        '    vec2 multiplier = vec2(1.0, 1.0);\n' +
        '    if (uv.x < 0.0) { uv.x = 0.0; multiplier.x = -1.0; }\n' +
        '    if (uv.x > 1.0) { uv.x = 1.0; multiplier.x = -1.0; }\n' +
        '    if (uv.y < 0.0) { uv.y = 0.0; multiplier.y = -1.0; }\n' +
        '    if (uv.y > 1.0) { uv.y = 1.0; multiplier.y = -1.0; }\n' +
        '    return multiplier * texture2D(uVelocity, uv).xy;\n' +
        '}\n' +
        'void main () {\n' +
        '    float L = sampleVelocity(vL).x;\n' +
        '    float R = sampleVelocity(vR).x;\n' +
        '    float T = sampleVelocity(vT).y;\n' +
        '    float B = sampleVelocity(vB).y;\n' +
        '    float div = 0.5 * (R - L + T - B);\n' +
        '    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);\n' +
        '}\n'
    );

    var curlShader = compileShader(gl.FRAGMENT_SHADER,
        'precision highp float;\n' +
        'precision mediump sampler2D;\n' +
        'varying vec2 vUv;\n' +
        'varying vec2 vL;\n' +
        'varying vec2 vR;\n' +
        'varying vec2 vT;\n' +
        'varying vec2 vB;\n' +
        'uniform sampler2D uVelocity;\n' +
        'void main () {\n' +
        '    float L = texture2D(uVelocity, vL).y;\n' +
        '    float R = texture2D(uVelocity, vR).y;\n' +
        '    float T = texture2D(uVelocity, vT).x;\n' +
        '    float B = texture2D(uVelocity, vB).x;\n' +
        '    float vorticity = R - L - T + B;\n' +
        '    gl_FragColor = vec4(vorticity, 0.0, 0.0, 1.0);\n' +
        '}\n'
    );

    var vorticityShader = compileShader(gl.FRAGMENT_SHADER,
        'precision highp float;\n' +
        'precision mediump sampler2D;\n' +
        'varying vec2 vUv;\n' +
        'varying vec2 vT;\n' +
        'varying vec2 vB;\n' +
        'uniform sampler2D uVelocity;\n' +
        'uniform sampler2D uCurl;\n' +
        'uniform float curl;\n' +
        'uniform float dt;\n' +
        'void main () {\n' +
        '    float T = texture2D(uCurl, vT).x;\n' +
        '    float B = texture2D(uCurl, vB).x;\n' +
        '    float C = texture2D(uCurl, vUv).x;\n' +
        '    vec2 force = vec2(abs(T) - abs(B), 0.0);\n' +
        '    force *= 1.0 / length(force + 0.00001) * curl * C;\n' +
        '    vec2 vel = texture2D(uVelocity, vUv).xy;\n' +
        '    gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);\n' +
        '}\n'
    );

    var pressureShader = compileShader(gl.FRAGMENT_SHADER,
        'precision highp float;\n' +
        'precision mediump sampler2D;\n' +
        'varying vec2 vUv;\n' +
        'varying vec2 vL;\n' +
        'varying vec2 vR;\n' +
        'varying vec2 vT;\n' +
        'varying vec2 vB;\n' +
        'uniform sampler2D uPressure;\n' +
        'uniform sampler2D uDivergence;\n' +
        'vec2 boundary (in vec2 uv) {\n' +
        '    uv = min(max(uv, 0.0), 1.0);\n' +
        '    return uv;\n' +
        '}\n' +
        'void main () {\n' +
        '    float L = texture2D(uPressure, boundary(vL)).x;\n' +
        '    float R = texture2D(uPressure, boundary(vR)).x;\n' +
        '    float T = texture2D(uPressure, boundary(vT)).x;\n' +
        '    float B = texture2D(uPressure, boundary(vB)).x;\n' +
        '    float C = texture2D(uPressure, vUv).x;\n' +
        '    float divergence = texture2D(uDivergence, vUv).x;\n' +
        '    float pressure = (L + R + B + T - divergence) * 0.25;\n' +
        '    gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);\n' +
        '}\n'
    );

    var gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER,
        'precision highp float;\n' +
        'precision mediump sampler2D;\n' +
        'varying vec2 vUv;\n' +
        'varying vec2 vL;\n' +
        'varying vec2 vR;\n' +
        'varying vec2 vT;\n' +
        'varying vec2 vB;\n' +
        'uniform sampler2D uPressure;\n' +
        'uniform sampler2D uVelocity;\n' +
        'vec2 boundary (in vec2 uv) {\n' +
        '    uv = min(max(uv, 0.0), 1.0);\n' +
        '    return uv;\n' +
        '}\n' +
        'void main () {\n' +
        '    float L = texture2D(uPressure, boundary(vL)).x;\n' +
        '    float R = texture2D(uPressure, boundary(vR)).x;\n' +
        '    float T = texture2D(uPressure, boundary(vT)).x;\n' +
        '    float B = texture2D(uPressure, boundary(vB)).x;\n' +
        '    vec2 velocity = texture2D(uVelocity, vUv).xy;\n' +
        '    velocity.xy -= vec2(R - L, T - B);\n' +
        '    gl_FragColor = vec4(velocity, 0.0, 1.0);\n' +
        '}\n'
    );

    // Bail if any shader failed to compile
    if (!clearShader || !displayShader || !splatShader || !advectionManualFilteringShader ||
        !advectionShader || !divergenceShader || !curlShader || !vorticityShader ||
        !pressureShader || !gradientSubtractShader) {
        showCSSFallback();
        return;
    }

    /* ═══════════════════════════════════════════════════════════
       Framebuffers
       ═══════════════════════════════════════════════════════════ */

    var textureWidth;
    var textureHeight;
    var density;
    var velocity;
    var divergenceFBO;
    var curlFBO;
    var pressure;

    function initFramebuffers() {
        textureWidth  = gl.drawingBufferWidth >> TEXTURE_DOWNSAMPLE;
        textureHeight = gl.drawingBufferHeight >> TEXTURE_DOWNSAMPLE;

        // Minimum texture size to prevent zero-size FBO errors on resize
        textureWidth  = Math.max(textureWidth, 1);
        textureHeight = Math.max(textureHeight, 1);

        var texType = ext.halfFloatTexType;
        var rgba    = ext.formatRGBA;
        var rg      = ext.formatRG;
        var r       = ext.formatR;
        var filterParam = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

        density      = createDoubleFBO(2, textureWidth, textureHeight, rgba.internalFormat, rgba.format, texType, filterParam);
        velocity     = createDoubleFBO(0, textureWidth, textureHeight, rg.internalFormat, rg.format, texType, filterParam);
        divergenceFBO = createFBO(4, textureWidth, textureHeight, r.internalFormat, r.format, texType, gl.NEAREST);
        curlFBO      = createFBO(5, textureWidth, textureHeight, r.internalFormat, r.format, texType, gl.NEAREST);
        pressure     = createDoubleFBO(6, textureWidth, textureHeight, r.internalFormat, r.format, texType, gl.NEAREST);
    }

    function createFBO(texId, w, h, internalFormat, format, type, param) {
        gl.activeTexture(gl.TEXTURE0 + texId);
        var texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

        var fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.viewport(0, 0, w, h);
        gl.clear(gl.COLOR_BUFFER_BIT);

        return [texture, fbo, texId];
    }

    function createDoubleFBO(texId, w, h, internalFormat, format, type, param) {
        var fbo1 = createFBO(texId, w, h, internalFormat, format, type, param);
        var fbo2 = createFBO(texId + 1, w, h, internalFormat, format, type, param);

        return {
            get read()  { return fbo1; },
            get write() { return fbo2; },
            swap: function () {
                var temp = fbo1;
                fbo1 = fbo2;
                fbo2 = temp;
            }
        };
    }

    // Try to init framebuffers, fall back to CSS if GPU can't handle it
    try {
        initFramebuffers();
    } catch (e) {
        console.warn('Fluid sim: FBO init failed', e);
        showCSSFallback();
        return;
    }

    /* ═══════════════════════════════════════════════════════════
       GL Programs
       ═══════════════════════════════════════════════════════════ */

    var clearProgram             = new GLProgram(baseVertexShader, clearShader);
    var displayProgram           = new GLProgram(baseVertexShader, displayShader);
    var splatProgram             = new GLProgram(baseVertexShader, splatShader);
    var advectionProgram         = new GLProgram(baseVertexShader, ext.supportLinearFiltering ? advectionShader : advectionManualFilteringShader);
    var divergenceProgram        = new GLProgram(baseVertexShader, divergenceShader);
    var curlProgram              = new GLProgram(baseVertexShader, curlShader);
    var vorticityProgram         = new GLProgram(baseVertexShader, vorticityShader);
    var pressureProgram          = new GLProgram(baseVertexShader, pressureShader);
    var gradientSubtractProgram  = new GLProgram(baseVertexShader, gradientSubtractShader);

    /* ═══════════════════════════════════════════════════════════
       Quad blit
       ═══════════════════════════════════════════════════════════ */

    var blit = (function () {
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);

        return function (destination) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
            gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
        };
    })();

    /* ═══════════════════════════════════════════════════════════
       Simulation loop
       ═══════════════════════════════════════════════════════════ */

    var lastTime = Date.now();
    var animFrameId = null;
    var isPageVisible = true;

    // Initial splats
    multipleSplats(Math.floor(Math.random() * 20) + 5);

    update();

    function update() {
        animFrameId = requestAnimationFrame(update);

        if (!isPageVisible) return;

        var resized = resizeCanvas();
        if (resized) {
            try {
                initFramebuffers();
            } catch (e) {
                cancelAnimationFrame(animFrameId);
                showCSSFallback();
                return;
            }
        }

        // Cap delta time to prevent huge jumps after tab switch / throttling
        var now = Date.now();
        var dt = Math.min((now - lastTime) / 1000, 0.016);
        lastTime = now;

        gl.viewport(0, 0, textureWidth, textureHeight);

        if (splatStack.length > 0) {
            multipleSplats(splatStack.pop());
        }

        // Advect velocity
        advectionProgram.bind();
        gl.uniform2f(advectionProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
        gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read[2]);
        gl.uniform1i(advectionProgram.uniforms.uSource, velocity.read[2]);
        gl.uniform1f(advectionProgram.uniforms.dt, dt);
        gl.uniform1f(advectionProgram.uniforms.dissipation, VELOCITY_DISSIPATION);
        blit(velocity.write[1]);
        velocity.swap();

        // Advect density
        gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read[2]);
        gl.uniform1i(advectionProgram.uniforms.uSource, density.read[2]);
        gl.uniform1f(advectionProgram.uniforms.dissipation, DENSITY_DISSIPATION);
        blit(density.write[1]);
        density.swap();

        // Process pointer input
        for (var i = 0; i < pointers.length; i++) {
            var pointer = pointers[i];
            if (pointer.moved) {
                splat(pointer.x, pointer.y, pointer.dx, pointer.dy, pointer.color);
                pointer.moved = false;
            }
        }

        // Curl
        curlProgram.bind();
        gl.uniform2f(curlProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
        gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read[2]);
        blit(curlFBO[1]);

        // Vorticity
        vorticityProgram.bind();
        gl.uniform2f(vorticityProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
        gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read[2]);
        gl.uniform1i(vorticityProgram.uniforms.uCurl, curlFBO[2]);
        gl.uniform1f(vorticityProgram.uniforms.curl, CURL);
        gl.uniform1f(vorticityProgram.uniforms.dt, dt);
        blit(velocity.write[1]);
        velocity.swap();

        // Divergence
        divergenceProgram.bind();
        gl.uniform2f(divergenceProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
        gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read[2]);
        blit(divergenceFBO[1]);

        // Clear pressure
        clearProgram.bind();
        var pressureTexId = pressure.read[2];
        gl.activeTexture(gl.TEXTURE0 + pressureTexId);
        gl.bindTexture(gl.TEXTURE_2D, pressure.read[0]);
        gl.uniform1i(clearProgram.uniforms.uTexture, pressureTexId);
        gl.uniform1f(clearProgram.uniforms.value, PRESSURE_DISSIPATION);
        blit(pressure.write[1]);
        pressure.swap();

        // Pressure solve
        pressureProgram.bind();
        gl.uniform2f(pressureProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
        gl.uniform1i(pressureProgram.uniforms.uDivergence, divergenceFBO[2]);
        pressureTexId = pressure.read[2];
        gl.uniform1i(pressureProgram.uniforms.uPressure, pressureTexId);
        gl.activeTexture(gl.TEXTURE0 + pressureTexId);
        for (var j = 0; j < PRESSURE_ITERATIONS; j++) {
            gl.bindTexture(gl.TEXTURE_2D, pressure.read[0]);
            blit(pressure.write[1]);
            pressure.swap();
        }

        // Gradient subtract
        gradientSubtractProgram.bind();
        gl.uniform2f(gradientSubtractProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
        gl.uniform1i(gradientSubtractProgram.uniforms.uPressure, pressure.read[2]);
        gl.uniform1i(gradientSubtractProgram.uniforms.uVelocity, velocity.read[2]);
        blit(velocity.write[1]);
        velocity.swap();

        // Display
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        displayProgram.bind();
        gl.uniform1i(displayProgram.uniforms.uTexture, density.read[2]);
        blit(null);
    }

    function splat(x, y, dx, dy, color) {
        splatProgram.bind();
        gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read[2]);
        gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
        gl.uniform2f(splatProgram.uniforms.point, x / canvas.width, 1.0 - y / canvas.height);
        gl.uniform3f(splatProgram.uniforms.color, dx, -dy, 1.0);
        gl.uniform1f(splatProgram.uniforms.radius, SPLAT_RADIUS);
        blit(velocity.write[1]);
        velocity.swap();

        gl.uniform1i(splatProgram.uniforms.uTarget, density.read[2]);
        gl.uniform3f(splatProgram.uniforms.color, color[0] * 0.3, color[1] * 0.3, color[2] * 0.3);
        blit(density.write[1]);
        density.swap();
    }

    function multipleSplats(amount) {
        for (var i = 0; i < amount; i++) {
            var color = malvecColor();
            var x = canvas.width * Math.random();
            var y = canvas.height * Math.random();
            var dx = 700 * (Math.random() - 0.5);
            var dy = 700 * (Math.random() - 0.5);
            splat(x, y, dx, dy, color);
        }
    }

    /* ═══════════════════════════════════════════════════════════
       Page Visibility — pause rendering when tab is hidden
       (saves GPU/CPU; prevents Safari from killing the context)
       ═══════════════════════════════════════════════════════════ */

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            isPageVisible = false;
        } else {
            isPageVisible = true;
            lastTime = Date.now(); // prevent dt spike on resume
        }
    }, false);

    /* ═══════════════════════════════════════════════════════════
       WebGL context loss recovery (iOS Safari, low-memory, etc.)
       ═══════════════════════════════════════════════════════════ */

    canvas.addEventListener('webglcontextlost', function (e) {
        e.preventDefault();
        cancelAnimationFrame(animFrameId);
        showCSSFallback();
    }, false);

    canvas.addEventListener('webglcontextrestored', function () {
        // Context restored — for simplicity, keep the CSS fallback
        // A full re-init could be done here if needed
    }, false);

    /* ═══════════════════════════════════════════════════════════
       Input handlers (touch-safe, no page drag)
       ═══════════════════════════════════════════════════════════ */

    // ── Mouse ────────────────────────────────────────────────
    canvas.parentElement.addEventListener('mousemove', function (e) {
        pointers[0].moved = true;
        pointers[0].dx = (e.clientX - pointers[0].x) * 10.0;
        pointers[0].dy = (e.clientY - pointers[0].y) * 10.0;
        pointers[0].x = e.clientX;
        pointers[0].y = e.clientY;
        if (!pointers[0].down) {
            pointers[0].color = malvecColor();
        }
    }, { passive: true });

    canvas.parentElement.addEventListener('mousedown', function () {
        pointers[0].down = true;
        pointers[0].color = malvecColor();
    }, { passive: true });

    window.addEventListener('mouseup', function () {
        pointers[0].down = false;
    }, { passive: true });

    // ── Touch (prevents page drag while interacting with canvas) ──
    canvas.parentElement.addEventListener('touchstart', function (e) {
        // Only prevent default on the canvas area (not on buttons etc.)
        if (e.target === canvas || e.target === canvas.parentElement) {
            e.preventDefault();
        }
        var touches = e.targetTouches;
        for (var i = 0; i < touches.length; i++) {
            if (i >= pointers.length) {
                pointers.push(new PointerPrototype());
            }
            pointers[i].id    = touches[i].identifier;
            pointers[i].down  = true;
            pointers[i].x     = touches[i].clientX;
            pointers[i].y     = touches[i].clientY;
            pointers[i].color = malvecColor();
        }
    }, { passive: false });

    canvas.parentElement.addEventListener('touchmove', function (e) {
        if (e.target === canvas || e.target === canvas.parentElement) {
            e.preventDefault();
        }
        var touches = e.targetTouches;
        for (var i = 0; i < touches.length; i++) {
            if (i >= pointers.length) continue;
            pointers[i].moved = true;
            pointers[i].dx = (touches[i].clientX - pointers[i].x) * 10.0;
            pointers[i].dy = (touches[i].clientY - pointers[i].y) * 10.0;
            pointers[i].x = touches[i].clientX;
            pointers[i].y = touches[i].clientY;
        }
    }, { passive: false });

    canvas.parentElement.addEventListener('touchend', function (e) {
        var touches = e.changedTouches;
        for (var i = 0; i < touches.length; i++) {
            for (var j = 0; j < pointers.length; j++) {
                if (touches[i].identifier === pointers[j].id) {
                    pointers[j].down = false;
                }
            }
        }
    }, { passive: true });

    /* ═══════════════════════════════════════════════════════════
       Reduced-motion live preference change
       ═══════════════════════════════════════════════════════════ */

    if (window.matchMedia) {
        var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        var handleMotionChange = function (mq) {
            if (mq.matches) {
                cancelAnimationFrame(animFrameId);
                showCSSFallback();
            }
        };
        // Modern browsers use addEventListener, older ones use addListener
        if (motionQuery.addEventListener) {
            motionQuery.addEventListener('change', handleMotionChange);
        } else if (motionQuery.addListener) {
            motionQuery.addListener(handleMotionChange);
        }
    }

})();
