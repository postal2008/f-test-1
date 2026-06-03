var Zoom = pc.createScript('zoom');

Zoom.attributes.add('smoothness', {
    type: 'number',
    default: 0.12,
    title: 'Плавность'
});

Zoom.prototype.initialize = function () {
    console.log('🚀 Zoom script initialized on:', this.entity.name);

    // Проверяем наличие анимации
    if (!this.entity.anim) {
        console.error('❌ На сущности нет компонента Animation!');
        return;
    }

    this.animLayer = this.entity.anim.baseLayer;
    console.log('📊 baseLayer:', this.animLayer ? 'найден' : 'НЕ НАЙДЕН');

    if (this.animLayer) {
        console.log('⏱ Длительность анимации:', this.animLayer.activeStateDuration);
        console.log('🎬 Активное состояние:', this.animLayer.activeState);
    }

    // Начальные значения
    this.currentTime = 0;
    this.targetTime = 0;

    this.entity.anim.speed = 0;

    // Основной обработчик сообщений
    window.addEventListener('message', this.onMessage.bind(this));

    // Диагностика всех входящих сообщений
    window.addEventListener('message', (e) => {
        console.log('📨 Получено сообщение:', e.data);
    });
};

Zoom.prototype.onMessage = function (event) {
    if (event.data.type !== 'scrollProgress') {
        // console.log('Сообщение другого типа:', event.data.type); // можно раскомментировать
        return;
    }
   
    const progress = event.data.progress || 0;
    const duration = this.animLayer ? this.animLayer.activeStateDuration || 1 : 1;
    
    this.targetTime = duration * progress;
    console.log(`🎯 Progress: ${progress.toFixed(3)} → Time: ${this.targetTime.toFixed(2)}/${duration.toFixed(2)}`);
};

Zoom.prototype.update = function (dt) {
    if (!this.animLayer) return;

    const duration = this.animLayer.activeStateDuration || 1;

    this.currentTime = pc.math.lerp(this.currentTime, this.targetTime, this.smoothness);
    this.currentTime = pc.math.clamp(this.currentTime, 0, duration);
    this.targetTime = pc.math.clamp(this.targetTime, 0, duration);

    this.animLayer.activeStateCurrentTime = this.currentTime;
};
