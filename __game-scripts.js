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

EmissiveFade.attributes.add('targetEntity', {
    type: 'entity',
    title: 'Объект с материалом (plane)'
});

EmissiveFade.attributes.add('animEntity', {
    type: 'entity',
    title: 'Объект с анимацией'
});

EmissiveFade.prototype.initialize = function () {
    if (this.targetEntity && this.targetEntity.render && this.targetEntity.render.meshInstances[0]) {
        this.material = this.targetEntity.render.meshInstances[0].material;
    }
};

EmissiveFade.prototype.update = function () {
    if (!this.material || !this.animEntity || !this.animEntity.anim || !this.animEntity.anim.baseLayer) return;

    var layer = this.animEntity.anim.baseLayer;
    var progress = layer.activeStateCurrentTime / layer.activeStateDuration;
    if (progress < 0) progress = 0;
    if (progress > 1) progress = 1;

    var intensity = 0;

    if (progress <= 0.2) {
        intensity = 2;
    } else if (progress <= 0.3) {
        intensity = pc.math.lerp(2, 0, (progress - 0.2) / 0.1);
    } else if (progress <= 0.7) {
        intensity = 0;
    } else if (progress <= 0.8) {
        intensity = pc.math.lerp(0, 2, (progress - 0.7) / 0.1);
    } else {
        intensity = 2;
    }

    this.material.emissiveIntensity = intensity;
    
    if (this.material.update) {
        this.material.update();
    }
};
