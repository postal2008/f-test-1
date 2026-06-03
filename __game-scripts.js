var Zoom = pc.createScript('zoom');

Zoom.attributes.add('smoothness', { 
    type: 'number', 
    default: 0.12, 
    title: 'Плавность' 
});

Zoom.prototype.initialize = function () {
    this.animLayer = this.entity.anim.baseLayer;
    
    const duration = this.animLayer ? this.animLayer.activeStateDuration || 1 : 1;
    
    this.currentTime = duration;
    this.targetTime = duration;
    
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
