var Zoom = pc.createScript('zoom');

Zoom.attributes.add('smoothness', { 
    type: 'number', 
    default: 0.15, 
    title: 'Плавность' 
});

Zoom.prototype.initialize = function () {
    this.animLayer = this.entity.anim.baseLayer;
    
    const duration = this.animLayer ? this.animLayer.activeStateDuration || 1 : 1;
    
    this.currentTime = 0;        // начинаем с начала
    this.targetTime = 0;
    this.isInitialized = false;  // ← добавили
    
    this.entity.anim.speed = 0;

    window.addEventListener('message', this.onMessage.bind(this));
};

Zoom.prototype.onMessage = function (event) {
    if (event.data.type !== 'scrollProgress') return;
    
    const progress = event.data.progress || 0;
    const duration = this.animLayer ? this.animLayer.activeStateDuration || 1 : 1;
    
    this.targetTime = duration * progress;

    // Первый пришедший progress устанавливаем жёстко, без плавности
    if (!this.isInitialized) {
        this.currentTime = this.targetTime;
        this.isInitialized = true;
    }
};

Zoom.prototype.update = function (dt) {
    if (!this.animLayer) return;
    const duration = this.animLayer.activeStateDuration || 1;

    this.currentTime = pc.math.lerp(this.currentTime, this.targetTime, this.smoothness);
    this.currentTime = pc.math.clamp(this.currentTime, 0, duration);
    this.targetTime = pc.math.clamp(this.targetTime, 0, duration);

    this.animLayer.activeStateCurrentTime = this.currentTime;
};
