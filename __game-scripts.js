// bloom.js
// --------------- POST EFFECT DEFINITION --------------- //
const SAMPLE_COUNT = 15;

function computeGaussian(n, theta) {
    return ((1.0 / Math.sqrt(2 * Math.PI * theta)) * Math.exp(-(n * n) / (2 * theta * theta)));
}

function calculateBlurValues(sampleWeights, sampleOffsets, dx, dy, blurAmount) {
    // Look up how many samples our gaussian blur effect supports.

    // Create temporary arrays for computing our filter settings.
    // The first sample always has a zero offset.
    sampleWeights[0] = computeGaussian(0, blurAmount);
    sampleOffsets[0] = 0;
    sampleOffsets[1] = 0;

    // Maintain a sum of all the weighting values.
    let totalWeights = sampleWeights[0];

    // Add pairs of additional sample taps, positioned
    // along a line in both directions from the center.
    const len = Math.floor(SAMPLE_COUNT / 2);
    for (let i = 0; i < len; i++) {
        // Store weights for the positive and negative taps.
        const weight = computeGaussian(i + 1, blurAmount);
        sampleWeights[i * 2] = weight;
        sampleWeights[i * 2 + 1] = weight;
        totalWeights += weight * 2;

        // To get the maximum amount of blurring from a limited number of
        // pixel shader samples, we take advantage of the bilinear filtering
        // hardware inside the texture fetch unit. If we position our texture
        // coordinates exactly halfway between two texels, the filtering unit
        // will average them for us, giving two samples for the price of one.
        // This allows us to step in units of two texels per sample, rather
        // than just one at a time. The 1.5 offset kicks things off by
        // positioning us nicely in between two texels.
        const sampleOffset = i * 2 + 1.5;

        // Store texture coordinate offsets for the positive and negative taps.
        sampleOffsets[i * 4] = dx * sampleOffset;
        sampleOffsets[i * 4 + 1] = dy * sampleOffset;
        sampleOffsets[i * 4 + 2] = -dx * sampleOffset;
        sampleOffsets[i * 4 + 3] = -dy * sampleOffset;
    }

    // Normalize the list of sample weightings, so they will always sum to one.
    for (let i = 0; i < sampleWeights.length; i++) {
        sampleWeights[i] /= totalWeights;
    }
}

/**
 * @class
 * @name BloomEffect
 * @classdesc Implements the BloomEffect post processing effect.
 * @description Creates new instance of the post effect.
 * @augments PostEffect
 * @param {GraphicsDevice} graphicsDevice - The graphics device of the application.
 * @property {number} bloomThreshold Only pixels brighter then this threshold will be processed. Ranges from 0 to 1.
 * @property {number} blurAmount Controls the amount of blurring.
 * @property {number} bloomIntensity The intensity of the effect.
 */
class BloomEffect extends pc.PostEffect {
    constructor(graphicsDevice) {
        super(graphicsDevice);

        // Shaders
        const attributes = {
            aPosition: pc.SEMANTIC_POSITION
        };

        // Pixel shader extracts the brighter areas of an image.
        // This is the first step in applying a bloom postprocess.
        const extractFrag = /* glsl */`
            varying vec2 vUv0;

            uniform sampler2D uBaseTexture;
            uniform float uBloomThreshold;

            void main(void)
            {
                // Look up the original image color.
                vec4 color = texture2D(uBaseTexture, vUv0);

                // Adjust it to keep only values brighter than the specified threshold.
                gl_FragColor = clamp((color - uBloomThreshold) / (1.0 - uBloomThreshold), 0.0, 1.0);
            }
        `;

        // Pixel shader applies a one dimensional gaussian blur filter.
        // This is used twice by the bloom postprocess, first to
        // blur horizontally, and then again to blur vertically.
        const gaussianBlurFrag = /* glsl */`
            #define SAMPLE_COUNT ${SAMPLE_COUNT}

            varying vec2 vUv0;

            uniform sampler2D uBloomTexture;
            uniform vec2 uBlurOffsets[${SAMPLE_COUNT}];
            uniform float uBlurWeights[${SAMPLE_COUNT}];

            void main(void)
            {
                vec4 color = vec4(0.0);
                // Combine a number of weighted image filter taps.
                for (int i = 0; i < SAMPLE_COUNT; i++)
                {
                    color += texture2D(uBloomTexture, vUv0 + uBlurOffsets[i]) * uBlurWeights[i];
                }

                gl_FragColor = color;
            }
        `;

        // Pixel shader combines the bloom image with the original
        // scene, using tweakable intensity levels.
        // This is the final step in applying a bloom postprocess.
        const combineFrag = /* glsl */`
            varying vec2 vUv0;

            uniform float uBloomEffectIntensity;
            uniform sampler2D uBaseTexture;
            uniform sampler2D uBloomTexture;

            void main(void)
            {
                // Look up the bloom and original base image colors.
                vec4 bloom = texture2D(uBloomTexture, vUv0) * uBloomEffectIntensity;
                vec4 base = texture2D(uBaseTexture, vUv0);

                // Darken down the base image in areas where there is a lot of bloom,
                // to prevent things looking excessively burned-out.
                base *= (1.0 - clamp(bloom, 0.0, 1.0));

                // Combine the two images.
                gl_FragColor = base + bloom;
            }
        `;

        this.extractShader = pc.ShaderUtils.createShader(graphicsDevice, {
            uniqueName: 'BloomExtractShader',
            attributes: attributes,
            vertexGLSL: pc.PostEffect.quadVertexShader,
            fragmentGLSL: extractFrag
        });

        this.blurShader = pc.ShaderUtils.createShader(graphicsDevice, {
            uniqueName: 'BloomBlurShader',
            attributes: attributes,
            vertexGLSL: pc.PostEffect.quadVertexShader,
            fragmentGLSL: gaussianBlurFrag
        });

        this.combineShader = pc.ShaderUtils.createShader(graphicsDevice, {
            uniqueName: 'BloomCombineShader',
            attributes: attributes,
            vertexGLSL: pc.PostEffect.quadVertexShader,
            fragmentGLSL: combineFrag
        });

        this.targets = [];

        // Effect defaults
        this.bloomThreshold = 0.25;
        this.blurAmount = 4;
        this.bloomIntensity = 1.25;

        // Uniforms
        this.sampleWeights = new Float32Array(SAMPLE_COUNT);
        this.sampleOffsets = new Float32Array(SAMPLE_COUNT * 2);
    }

    _destroy() {
        if (this.targets) {
            for (let i = 0; i < this.targets.length; i++) {
                this.targets[i].destroyTextureBuffers();
                this.targets[i].destroy();
            }
        }
        this.targets.length = 0;
    }

    _resize(target) {
        const width = target.colorBuffer.width;
        const height = target.colorBuffer.height;

        if (width === this.width && height === this.height) {
            return;
        }

        this.width = width;
        this.height = height;

        this._destroy();

        // Render targets
        for (let i = 0; i < 2; i++) {
            const colorBuffer = new pc.Texture(this.device, {
                name: `Bloom Texture${i}`,
                format: pc.PIXELFORMAT_RGBA8,
                width: width >> 1,
                height: height >> 1,
                mipmaps: false
            });
            colorBuffer.minFilter = pc.FILTER_LINEAR;
            colorBuffer.magFilter = pc.FILTER_LINEAR;
            colorBuffer.addressU = pc.ADDRESS_CLAMP_TO_EDGE;
            colorBuffer.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
            colorBuffer.name = `pe-bloom-${i}`;
            const bloomTarget = new pc.RenderTarget({
                name: `Bloom Render Target ${i}`,
                colorBuffer: colorBuffer,
                depth: false
            });

            this.targets.push(bloomTarget);
        }
    }

    render(inputTarget, outputTarget, rect) {
        this._resize(inputTarget);

        const device = this.device;
        const scope = device.scope;

        // Pass 1: draw the scene into rendertarget 1, using a
        // shader that extracts only the brightest parts of the image.
        scope.resolve('uBloomThreshold').setValue(this.bloomThreshold);
        scope.resolve('uBaseTexture').setValue(inputTarget.colorBuffer);
        this.drawQuad(this.targets[0], this.extractShader);

        // Pass 2: draw from rendertarget 1 into rendertarget 2,
        // using a shader to apply a horizontal gaussian blur filter.
        calculateBlurValues(this.sampleWeights, this.sampleOffsets, 1.0 / this.targets[1].width, 0, this.blurAmount);
        scope.resolve('uBlurWeights[0]').setValue(this.sampleWeights);
        scope.resolve('uBlurOffsets[0]').setValue(this.sampleOffsets);
        scope.resolve('uBloomTexture').setValue(this.targets[0].colorBuffer);
        this.drawQuad(this.targets[1], this.blurShader);

        // Pass 3: draw from rendertarget 2 back into rendertarget 1,
        // using a shader to apply a vertical gaussian blur filter.
        calculateBlurValues(this.sampleWeights, this.sampleOffsets, 0, 1.0 / this.targets[0].height, this.blurAmount);
        scope.resolve('uBlurWeights[0]').setValue(this.sampleWeights);
        scope.resolve('uBlurOffsets[0]').setValue(this.sampleOffsets);
        scope.resolve('uBloomTexture').setValue(this.targets[1].colorBuffer);
        this.drawQuad(this.targets[0], this.blurShader);

        // Pass 4: draw both rendertarget 1 and the original scene
        // image back into the main backbuffer, using a shader that
        // combines them to produce the final bloomed result.
        scope.resolve('uBloomEffectIntensity').setValue(this.bloomIntensity);
        scope.resolve('uBloomTexture').setValue(this.targets[0].colorBuffer);
        scope.resolve('uBaseTexture').setValue(inputTarget.colorBuffer);
        this.drawQuad(outputTarget, this.combineShader, rect);
    }
}

// ----------------- SCRIPT DEFINITION ------------------ //
var Bloom = pc.createScript('bloom');

Bloom.attributes.add('bloomIntensity', {
    type: 'number',
    default: 1,
    min: 0,
    title: 'Intensity'
});

Bloom.attributes.add('bloomThreshold', {
    type: 'number',
    default: 0.25,
    min: 0,
    max: 1,
    title: 'Threshold'
});

Bloom.attributes.add('blurAmount', {
    type: 'number',
    default: 4,
    min: 1,
    'title': 'Blur amount'
});

Bloom.prototype.initialize = function () {
    this.effect = new BloomEffect(this.app.graphicsDevice);

    this.effect.bloomThreshold = this.bloomThreshold;
    this.effect.blurAmount = this.blurAmount;
    this.effect.bloomIntensity = this.bloomIntensity;

    var queue = this.entity.camera.postEffects;

    queue.addEffect(this.effect);

    this.on('attr', function (name, value) {
        this.effect[name] = value;
    }, this);

    this.on('state', function (enabled) {
        if (enabled) {
            queue.addEffect(this.effect);
        } else {
            queue.removeEffect(this.effect);
        }
    });

    this.on('destroy', function () {
        queue.removeEffect(this.effect);
        this.effect._destroy();
    });
};

// zoom.js
var Zoom = pc.createScript('zoom');

Zoom.attributes.add('smoothness', { 
    type: 'number', 
    default: 0.12, 
    title: 'Плавность' 
});

Zoom.prototype.initialize = function () {
    this.animLayer = this.entity.anim.baseLayer;
    
    const duration = this.animLayer ? this.animLayer.activeStateDuration || 1 : 1;
    
    this.currentTime = 0;
    this.targetTime = 0;
    
    this.entity.anim.speed = 0;

    window.addEventListener('message', this.onMessage.bind(this));
};

Zoom.prototype.onMessage = function (event) {
    if (event.data.type !== 'scrollProgress') return;
    
    const progress = event.data.progress || 0;
    const duration = this.animLayer ? this.animLayer.activeStateDuration || 1 : 1;
    this.targetTime = duration * progress;
};

Zoom.prototype.update = function (dt) {
    if (!this.animLayer) return;
    const duration = this.animLayer.activeStateDuration || 1;

    this.currentTime = pc.math.lerp(this.currentTime, this.targetTime, this.smoothness);
    this.currentTime = pc.math.clamp(this.currentTime, 0, duration);
    this.targetTime = pc.math.clamp(this.targetTime, 0, duration);

    this.animLayer.activeStateCurrentTime = this.currentTime;
};

// ResponsiveCamera.js
var ResponsiveCamera = pc.createScript('responsiveCamera');

ResponsiveCamera.attributes.add('fovWide', { type: 'number', default: 45 });
ResponsiveCamera.attributes.add('fovMobile', { type: 'number', default: 100 });
ResponsiveCamera.attributes.add('minWidth', { type: 'number', default: 375 });
ResponsiveCamera.attributes.add('maxWidth', { type: 'number', default: 1920 });

ResponsiveCamera.prototype.initialize = function() {
    this.lastWidth = 0;
    
    // Основной способ — window resize
    window.addEventListener('resize', this.updateFov.bind(this));
    
    // Запасной вариант — проверка каждый кадр
    this.app.on('update', this.checkResize, this);
    
    this.updateFov();
};

ResponsiveCamera.prototype.checkResize = function() {
    const currentWidth = this.app.graphicsDevice.width;
    if (currentWidth !== this.lastWidth) {
        this.updateFov();
        this.lastWidth = currentWidth;
    }
};

ResponsiveCamera.prototype.updateFov = function() {
    const width = this.app.graphicsDevice.width;
    
    let t = pc.math.clamp((width - this.minWidth) / (this.maxWidth - this.minWidth), 0, 1);
    const fov = pc.math.lerp(this.fovMobile, this.fovWide, t);
    
    this.entity.camera.fov = fov;
};

// triplanar-material.js
var TriplanarMaterial = pc.createScript('triplanarMaterial');

TriplanarMaterial.attributes.add('diffuseMap', { type: 'asset', assetType: 'texture' });
TriplanarMaterial.attributes.add('normalMap', { type: 'asset', assetType: 'texture', title: 'Normal Map (optional)' });
TriplanarMaterial.attributes.add('roughnessMap', { type: 'asset', assetType: 'texture', title: 'Roughness Map (optional)' });

TriplanarMaterial.attributes.add('tile', { type: 'number', default: 3.0, title: 'Tile (scale)' });
TriplanarMaterial.attributes.add('blendSharpness', { type: 'number', default: 8.0, title: 'Blend Sharpness' });

TriplanarMaterial.prototype.initialize = function() {
    this.updateMaterial();
};

TriplanarMaterial.prototype.updateMaterial = function() {
    let renderComp = this.entity.render;
    let modelComp = this.entity.model;

    let material;

    if (renderComp) {
        material = renderComp.material;
    } else if (modelComp) {
        material = modelComp.material;
    } else {
        console.error('[Triplanar] Нет render или model компонента!');
        return;
    }

    if (!material || !(material instanceof pc.StandardMaterial)) {
        material = new pc.StandardMaterial();
        if (renderComp) renderComp.material = material;
        else if (modelComp) modelComp.material = material;
    }

    this.material = material;

    // Назначаем текстуры
    if (this.diffuseMap) this.material.diffuseMap = this.diffuseMap.resource;
    if (this.normalMap) this.material.normalMap = this.normalMap.resource;
    if (this.roughnessMap) this.material.roughnessMap = this.roughnessMap.resource;

    // === САМОЕ ВАЖНОЕ: принудительно включаем текстуру ===
    if (this.diffuseMap) {
        this.material.setDefine('STD_DIFFUSE_TEXTURE', true);
    }

    // Переопределяем чанк
    this.material.chunks.diffusePS = `
        #ifdef STD_DIFFUSE_TEXTURE
        uniform sampler2D texture_diffuseMap;
        #endif

        void getAlbedo() {
            #ifdef STD_DIFFUSE_TEXTURE
                vec3 worldPos = vPositionW;
                vec3 n = normalize(vNormalW);

                vec3 blend = pow(abs(n), vec3(${this.blendSharpness.toFixed(1)}));
                blend /= (blend.x + blend.y + blend.z);

                float tile = ${this.tile.toFixed(1)};

                vec2 uvX = worldPos.yz * tile;
                vec2 uvY = worldPos.xz * tile;
                vec2 uvZ = worldPos.xy * tile;

                vec4 tx = texture2D(texture_diffuseMap, uvX);
                vec4 ty = texture2D(texture_diffuseMap, uvY);
                vec4 tz = texture2D(texture_diffuseMap, uvZ);

                dAlbedo = (tx * blend.x + ty * blend.y + tz * blend.z).rgb;
            #else
                dAlbedo = vec3(1.0, 0.0, 1.0);
            #endif
        }
    `;

    this.material.update();
};

// RainVelocityController.js
var RainVelocityController = pc.createScript('rainVelocityController');

RainVelocityController.attributes.add('smoothness', {
    type: 'number',
    default: 0.15,
    title: 'Плавность изменения скорости'
});

RainVelocityController.attributes.add('normalVelocityY', {
    type: 'number',
    default: -8,
    title: 'Скорость Y при progress = 0 и 1'
});

RainVelocityController.attributes.add('slowVelocityY', {
    type: 'number',
    default: -0.5,        // ← Изменено на -0.5
    title: 'Скорость Y при скролле (0.1 - 0.9)'
});

RainVelocityController.prototype.initialize = function () {
    this.currentVelocityY = this.normalVelocityY;
    this.targetVelocityY = this.normalVelocityY;

    window.addEventListener('message', this.onMessage.bind(this));
};

RainVelocityController.prototype.onMessage = function (event) {
    if (event.data.type !== 'scrollProgress') return;

    const progress = event.data.progress || 0;

    if (progress <= 0.05 || progress >= 0.95) {
        this.targetVelocityY = this.normalVelocityY;   // -8
    } else {
        this.targetVelocityY = this.slowVelocityY;     // -0.5
    }
};

RainVelocityController.prototype.update = function (dt) {
    this.currentVelocityY = pc.math.lerp(
        this.currentVelocityY, 
        this.targetVelocityY, 
        this.smoothness
    );

    this.updateParticleVelocity(this.currentVelocityY);
};

RainVelocityController.prototype.updateParticleVelocity = function (velocityY) {
    const ps = this.entity.particlesystem;
    if (!ps) return;

    const newGraph = new pc.CurveSet([
        [0, 0],          
        [0, velocityY],  
        [0, 0]           
    ]);

    ps.velocityGraph = newGraph;
    ps.velocityGraph2 = newGraph;
};

// camera-frame.js
var CameraFrame = pc.createScript('cameraFrame');

CameraFrame.attributes.add('enabled', { type: 'boolean', default: true });

// === Rendering ===
CameraFrame.attributes.add('toneMapping', { 
    type: 'number', default: 1, 
    enum: [
        { 'Linear': 0 },
        { 'Filmic': 1 },
        { 'Hejl': 2 },
        { 'ACES': 3 },
        { 'ACES2': 4 },
        { 'Neutral': 5 }
    ]
});
CameraFrame.attributes.add('sharpness', { type: 'number', default: 0, min: 0, max: 1 });

// === Bloom ===
CameraFrame.attributes.add('bloomEnabled', { type: 'boolean', default: true });
CameraFrame.attributes.add('bloomIntensity', { type: 'number', default: 0.8, min: 0, max: 2 });
CameraFrame.attributes.add('bloomThreshold', { type: 'number', default: 0.6, min: 0, max: 1 });
CameraFrame.attributes.add('bloomBlurLevel', { type: 'number', default: 5, min: 1, max: 9 });

// === Vignette ===
CameraFrame.attributes.add('vignetteEnabled', { type: 'boolean', default: true });
CameraFrame.attributes.add('vignetteIntensity', { type: 'number', default: 0.5, min: 0, max: 1 });
CameraFrame.attributes.add('vignetteInner', { type: 'number', default: 0.4, min: 0, max: 2 });
CameraFrame.attributes.add('vignetteOuter', { type: 'number', default: 1.2, min: 0, max: 2 });

// === Depth of Field ===
CameraFrame.attributes.add('dofEnabled', { type: 'boolean', default: false });
CameraFrame.attributes.add('dofFocusDistance', { type: 'number', default: 12, min: 0 });
CameraFrame.attributes.add('dofAperture', { type: 'number', default: 6, min: 0 });
CameraFrame.attributes.add('dofFocalLength', { type: 'number', default: 50 });
CameraFrame.attributes.add('dofHighQuality', { type: 'boolean', default: true });

// === SSAO ===
CameraFrame.attributes.add('ssaoEnabled', { type: 'boolean', default: false });
CameraFrame.attributes.add('ssaoIntensity', { type: 'number', default: 0.8, min: 0, max: 2 });
CameraFrame.attributes.add('ssaoRadius', { type: 'number', default: 0.3, min: 0, max: 1 });

// === TAA (Temporal Anti-Aliasing) ===
CameraFrame.attributes.add('taaEnabled', { type: 'boolean', default: false });
CameraFrame.attributes.add('taaJitter', { type: 'number', default: 1, min: 0, max: 1 });

// === Chromatic Aberration (Fringing) ===
CameraFrame.attributes.add('fringingEnabled', { type: 'boolean', default: false });
CameraFrame.attributes.add('fringingIntensity', { type: 'number', default: 0.5, min: 0, max: 2 });

// === Color Grading ===
CameraFrame.attributes.add('gradingEnabled', { type: 'boolean', default: false });
CameraFrame.attributes.add('gradingBrightness', { type: 'number', default: 1, min: 0, max: 2 });
CameraFrame.attributes.add('gradingContrast', { type: 'number', default: 1, min: 0, max: 2 });
CameraFrame.attributes.add('gradingSaturation', { type: 'number', default: 1, min: 0, max: 2 });

CameraFrame.prototype.initialize = function() {
    if (!this.entity.camera) {
        console.error("CameraFrame: Скрипт должен быть прикреплён к камере!");
        return;
    }

    this.cameraFrame = new pc.CameraFrame(this.app, this.entity.camera);
    this.updateAllEffects();
};

CameraFrame.prototype.updateAllEffects = function() {
    if (!this.cameraFrame) return;
    const cf = this.cameraFrame;

    // Rendering
    cf.rendering.toneMapping = this.toneMapping;
    cf.rendering.sharpness = this.sharpness;

    // Bloom
    cf.bloom.enabled = this.bloomEnabled;
    if (this.bloomEnabled) {
        cf.bloom.intensity = this.bloomIntensity;
        cf.bloom.threshold = this.bloomThreshold;
        cf.bloom.blurLevel = this.bloomBlurLevel;
    }

    // Vignette
    cf.vignette.enabled = this.vignetteEnabled;
    if (this.vignetteEnabled) {
        cf.vignette.intensity = this.vignetteIntensity;
        cf.vignette.inner = this.vignetteInner;
        cf.vignette.outer = this.vignetteOuter;
    }

    // DoF
    cf.dof.enabled = this.dofEnabled;
    if (this.dofEnabled) {
        cf.dof.focusDistance = this.dofFocusDistance;
        cf.dof.aperture = this.dofAperture;
        cf.dof.focalLength = this.dofFocalLength;
        cf.dof.highQuality = this.dofHighQuality;
    }

    // SSAO
    cf.ssao.type = this.ssaoEnabled ? 'lighting' : 'none';
    if (this.ssaoEnabled) {
        cf.ssao.intensity = this.ssaoIntensity;
        cf.ssao.radius = this.ssaoRadius;
    }

    // TAA
    cf.taa.enabled = this.taaEnabled;
    if (this.taaEnabled) {
        cf.taa.jitter = this.taaJitter;
    }

    // Fringing (Chromatic Aberration)
    cf.fringing.enabled = this.fringingEnabled;
    if (this.fringingEnabled) {
        cf.fringing.intensity = this.fringingIntensity;
    }

    // Color Grading
    cf.grading.enabled = this.gradingEnabled;
    if (this.gradingEnabled) {
        cf.grading.brightness = this.gradingBrightness;
        cf.grading.contrast = this.gradingContrast;
        cf.grading.saturation = this.gradingSaturation;
    }
};

CameraFrame.prototype.update = function(dt) {
    if (this.cameraFrame) {
        this.cameraFrame.update();
    }
};

// EmissiveFade.js
var EmissiveFade = pc.createScript('emissiveFade');

EmissiveFade.attributes.add('materialAsset', {
    type: 'asset',
    assetType: 'material',
    title: 'Материал'
});

EmissiveFade.prototype.initialize = function () {
    if (this.materialAsset?.resource) {
        this.material = this.materialAsset.resource;
    }
};

EmissiveFade.prototype.update = function () {
    if (!this.material || !this.entity.anim) return;

    const layer = this.entity.anim.baseLayer;
    if (!layer) return;

    const progress = pc.math.clamp(
        (layer.activeStateCurrentTime || 0) / (layer.activeStateDuration || 1), 
        0, 1
    );

    let intensity = 0;

    if (progress <= 0.2) {
        intensity = 2;
    } 
    else if (progress <= 0.3) {
        intensity = pc.math.lerp(2, 0, (progress - 0.2) / 0.1);
    } 
    else if (progress <= 0.7) {
        intensity = 0;
    } 
    else if (progress <= 0.8) {
        intensity = pc.math.lerp(0, 2, (progress - 0.7) / 0.1);
    } 
    else {
        intensity = 2;
    }

    this.material.emissiveIntensity = intensity;
    this.material.update?.();
};

