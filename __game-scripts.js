// orbitCamera.js
////////////////////////////////////////////////////////////////////////////////
//                             Orbit Camera Script                            //
////////////////////////////////////////////////////////////////////////////////
var OrbitCamera = pc.createScript('orbitCamera');

OrbitCamera.attributes.add('distanceMax', { type: 'number', default: 0, title: 'Distance Max', description: 'Setting this at 0 will give an infinite distance limit' });
OrbitCamera.attributes.add('distanceMin', { type: 'number', default: 0, title: 'Distance Min' });
OrbitCamera.attributes.add('pitchAngleMax', { type: 'number', default: 90, title: 'Pitch Angle Max (degrees)' });
OrbitCamera.attributes.add('pitchAngleMin', { type: 'number', default: -90, title: 'Pitch Angle Min (degrees)' });

OrbitCamera.attributes.add('inertiaFactor', {
    type: 'number',
    default: 0,
    title: 'Inertia Factor',
    description: 'Higher value means that the camera will continue moving after the user has stopped dragging. 0 is fully responsive.'
});

OrbitCamera.attributes.add('focusEntity', {
    type: 'entity',
    title: 'Focus Entity',
    description: 'Entity for the camera to focus on. If blank, then the camera will use the whole scene'
});

OrbitCamera.attributes.add('frameOnStart', {
    type: 'boolean',
    default: true,
    title: 'Frame on Start',
    description: 'Frames the entity or scene at the start of the application."'
});


// Property to get and set the distance between the pivot point and camera
// Clamped between this.distanceMin and this.distanceMax
Object.defineProperty(OrbitCamera.prototype, 'distance', {
    get: function () {
        return this._targetDistance;
    },

    set: function (value) {
        this._targetDistance = this._clampDistance(value);
    }
});

// Property to get and set the camera orthoHeight
// Clamped above 0
Object.defineProperty(OrbitCamera.prototype, 'orthoHeight', {
    get: function () {
        return this.entity.camera.orthoHeight;
    },

    set: function (value) {
        this.entity.camera.orthoHeight = Math.max(0, value);
    }
});


// Property to get and set the pitch of the camera around the pivot point (degrees)
// Clamped between this.pitchAngleMin and this.pitchAngleMax
// When set at 0, the camera angle is flat, looking along the horizon
Object.defineProperty(OrbitCamera.prototype, 'pitch', {
    get: function () {
        return this._targetPitch;
    },

    set: function (value) {
        this._targetPitch = this._clampPitchAngle(value);
    }
});


// Property to get and set the yaw of the camera around the pivot point (degrees)
Object.defineProperty(OrbitCamera.prototype, 'yaw', {
    get: function () {
        return this._targetYaw;
    },

    set: function (value) {
        this._targetYaw = value;

        // Ensure that the yaw takes the shortest route by making sure that
        // the difference between the targetYaw and the actual is 180 degrees
        // in either direction
        var diff = this._targetYaw - this._yaw;
        var reminder = diff % 360;
        if (reminder > 180) {
            this._targetYaw = this._yaw - (360 - reminder);
        } else if (reminder < -180) {
            this._targetYaw = this._yaw + (360 + reminder);
        } else {
            this._targetYaw = this._yaw + reminder;
        }
    }
});


// Property to get and set the world position of the pivot point that the camera orbits around
Object.defineProperty(OrbitCamera.prototype, 'pivotPoint', {
    get: function () {
        return this._pivotPoint;
    },

    set: function (value) {
        this._pivotPoint.copy(value);
    }
});


// Moves the camera to look at an entity and all its children so they are all in the view
OrbitCamera.prototype.focus = function (focusEntity) {
    // Calculate an bounding box that encompasses all the models to frame in the camera view
    this._buildAabb(focusEntity);

    var halfExtents = this._modelsAabb.halfExtents;
    var radius = Math.max(halfExtents.x, Math.max(halfExtents.y, halfExtents.z));

    this.distance = (radius * 1.5) / Math.sin(0.5 * this.entity.camera.fov * pc.math.DEG_TO_RAD);

    this._removeInertia();

    this._pivotPoint.copy(this._modelsAabb.center);
};


OrbitCamera.distanceBetween = new pc.Vec3();

// Set the camera position to a world position and look at a world position
// Useful if you have multiple viewing angles to swap between in a scene
OrbitCamera.prototype.resetAndLookAtPoint = function (resetPoint, lookAtPoint) {
    this.pivotPoint.copy(lookAtPoint);
    this.entity.setPosition(resetPoint);

    this.entity.lookAt(lookAtPoint);

    var distance = OrbitCamera.distanceBetween;
    distance.sub2(lookAtPoint, resetPoint);
    this.distance = distance.length();

    this.pivotPoint.copy(lookAtPoint);

    var cameraQuat = this.entity.getRotation();
    this.yaw = this._calcYaw(cameraQuat);
    this.pitch = this._calcPitch(cameraQuat, this.yaw);

    this._removeInertia();
    this._updatePosition();
};


// Set camera position to a world position and look at an entity in the scene
// Useful if you have multiple models to swap between in a scene
OrbitCamera.prototype.resetAndLookAtEntity = function (resetPoint, entity) {
    this._buildAabb(entity);
    this.resetAndLookAtPoint(resetPoint, this._modelsAabb.center);
};


// Set the camera at a specific, yaw, pitch and distance without inertia (instant cut)
OrbitCamera.prototype.reset = function (yaw, pitch, distance) {
    this.pitch = pitch;
    this.yaw = yaw;
    this.distance = distance;

    this._removeInertia();
};

/////////////////////////////////////////////////////////////////////////////////////////////
// Private methods

OrbitCamera.prototype.initialize = function () {
    var self = this;
    var onWindowResize = function () {
        self._checkAspectRatio();
    };

    window.addEventListener('resize', onWindowResize, false);

    this._checkAspectRatio();

    // Find all the models in the scene that are under the focused entity
    this._modelsAabb = new pc.BoundingBox();
    this._buildAabb(this.focusEntity || this.app.root);

    this.entity.lookAt(this._modelsAabb.center);

    this._pivotPoint = new pc.Vec3();
    this._pivotPoint.copy(this._modelsAabb.center);

    // Calculate the camera euler angle rotation around x and y axes
    // This allows us to place the camera at a particular rotation to begin with in the scene
    var cameraQuat = this.entity.getRotation();

    // Preset the camera
    this._yaw = this._calcYaw(cameraQuat);
    this._pitch = this._clampPitchAngle(this._calcPitch(cameraQuat, this._yaw));
    this.entity.setLocalEulerAngles(this._pitch, this._yaw, 0);

    this._distance = 0;

    this._targetYaw = this._yaw;
    this._targetPitch = this._pitch;

    // If we have ticked focus on start, then attempt to position the camera where it frames
    // the focused entity and move the pivot point to entity's position otherwise, set the distance
    // to be between the camera position in the scene and the pivot point
    if (this.frameOnStart) {
        this.focus(this.focusEntity || this.app.root);
    } else {
        var distanceBetween = new pc.Vec3();
        distanceBetween.sub2(this.entity.getPosition(), this._pivotPoint);
        this._distance = this._clampDistance(distanceBetween.length());
    }

    this._targetDistance = this._distance;

    // Reapply the clamps if they are changed in the editor
    this.on('attr:distanceMin', function (value, prev) {
        this._distance = this._clampDistance(this._distance);
    });

    this.on('attr:distanceMax', function (value, prev) {
        this._distance = this._clampDistance(this._distance);
    });

    this.on('attr:pitchAngleMin', function (value, prev) {
        this._pitch = this._clampPitchAngle(this._pitch);
    });

    this.on('attr:pitchAngleMax', function (value, prev) {
        this._pitch = this._clampPitchAngle(this._pitch);
    });

    // Focus on the entity if we change the focus entity
    this.on('attr:focusEntity', function (value, prev) {
        if (this.frameOnStart) {
            this.focus(value || this.app.root);
        } else {
            this.resetAndLookAtEntity(this.entity.getPosition(), value || this.app.root);
        }
    });

    this.on('attr:frameOnStart', function (value, prev) {
        if (value) {
            this.focus(this.focusEntity || this.app.root);
        }
    });

    this.on('destroy', () => {
        window.removeEventListener('resize', onWindowResize, false);
    });
};


OrbitCamera.prototype.update = function (dt) {
    // Add inertia, if any
    var t = this.inertiaFactor === 0 ? 1 : Math.min(dt / this.inertiaFactor, 1);
    this._distance = pc.math.lerp(this._distance, this._targetDistance, t);
    this._yaw = pc.math.lerp(this._yaw, this._targetYaw, t);
    this._pitch = pc.math.lerp(this._pitch, this._targetPitch, t);

    this._updatePosition();
};


OrbitCamera.prototype._updatePosition = function () {
    // Work out the camera position based on the pivot point, pitch, yaw and distance
    this.entity.setLocalPosition(0, 0, 0);
    this.entity.setLocalEulerAngles(this._pitch, this._yaw, 0);

    var position = this.entity.getPosition();
    position.copy(this.entity.forward);
    position.mulScalar(-this._distance);
    position.add(this.pivotPoint);
    this.entity.setPosition(position);
};


OrbitCamera.prototype._removeInertia = function () {
    this._yaw = this._targetYaw;
    this._pitch = this._targetPitch;
    this._distance = this._targetDistance;
};


OrbitCamera.prototype._checkAspectRatio = function () {
    var height = this.app.graphicsDevice.height;
    var width = this.app.graphicsDevice.width;

    // Match the axis of FOV to match the aspect ratio of the canvas so
    // the focused entities is always in frame
    this.entity.camera.horizontalFov = height > width;
};


OrbitCamera.prototype._buildAabb = function (entity) {
    var i, m, meshInstances = [];

    var renders = entity.findComponents('render');
    for (i = 0; i < renders.length; i++) {
        var render = renders[i];
        for (m = 0; m < render.meshInstances.length; m++) {
            meshInstances.push(render.meshInstances[m]);
        }
    }

    var models = entity.findComponents('model');
    for (i = 0; i < models.length; i++) {
        var model = models[i];
        for (m = 0; m < model.meshInstances.length; m++) {
            meshInstances.push(model.meshInstances[m]);
        }
    }

    // additional world-space AABBs collected from gsplats (unified mode has no per-component
    // mesh instance, so we transform the gsplat's object-space AABB into world space here)
    var extraAabbs = [];

    var gsplats = entity.findComponents('gsplat');
    for (i = 0; i < gsplats.length; i++) {
        var gsplat = gsplats[i];
        if (gsplat.unified) {
            // unified gsplat: customAabb returns object-space (custom AABB, placement AABB, or
            // resource AABB) - transform it to world space using the entity's world transform
            var localAabb = gsplat.customAabb;
            if (localAabb) {
                var worldAabb = new pc.BoundingBox();
                worldAabb.setFromTransformedAabb(localAabb, gsplat.entity.getWorldTransform());
                extraAabbs.push(worldAabb);
            }
        } else {
            // legacy gsplat: mesh instance already exposes a world-space AABB
            var instance = gsplat.instance;
            if (instance?.meshInstance) {
                meshInstances.push(instance.meshInstance);
            }
        }
    }

    var first = true;
    for (i = 0; i < meshInstances.length; i++) {
        if (first) {
            this._modelsAabb.copy(meshInstances[i].aabb);
            first = false;
        } else {
            this._modelsAabb.add(meshInstances[i].aabb);
        }
    }
    for (i = 0; i < extraAabbs.length; i++) {
        if (first) {
            this._modelsAabb.copy(extraAabbs[i]);
            first = false;
        } else {
            this._modelsAabb.add(extraAabbs[i]);
        }
    }
};


OrbitCamera.prototype._calcYaw = function (quat) {
    var transformedForward = new pc.Vec3();
    quat.transformVector(pc.Vec3.FORWARD, transformedForward);

    return Math.atan2(-transformedForward.x, -transformedForward.z) * pc.math.RAD_TO_DEG;
};


OrbitCamera.prototype._clampDistance = function (distance) {
    if (this.distanceMax > 0) {
        return pc.math.clamp(distance, this.distanceMin, this.distanceMax);
    }
    return Math.max(distance, this.distanceMin);

};


OrbitCamera.prototype._clampPitchAngle = function (pitch) {
    // Negative due as the pitch is inversed since the camera is orbiting the entity
    return pc.math.clamp(pitch, -this.pitchAngleMax, -this.pitchAngleMin);
};


OrbitCamera.quatWithoutYaw = new pc.Quat();
OrbitCamera.yawOffset = new pc.Quat();

OrbitCamera.prototype._calcPitch = function (quat, yaw) {
    var quatWithoutYaw = OrbitCamera.quatWithoutYaw;
    var yawOffset = OrbitCamera.yawOffset;

    yawOffset.setFromEulerAngles(0, -yaw, 0);
    quatWithoutYaw.mul2(yawOffset, quat);

    var transformedForward = new pc.Vec3();

    quatWithoutYaw.transformVector(pc.Vec3.FORWARD, transformedForward);

    return Math.atan2(transformedForward.y, -transformedForward.z) * pc.math.RAD_TO_DEG;
};


////////////////////////////////////////////////////////////////////////////////
//                       Orbit Camera Mouse Input Script                      //
////////////////////////////////////////////////////////////////////////////////
var OrbitCameraInputMouse = pc.createScript('orbitCameraInputMouse');

OrbitCameraInputMouse.attributes.add('orbitSensitivity', {
    type: 'number',
    default: 0.3,
    title: 'Orbit Sensitivity',
    description: 'How fast the camera moves around the orbit. Higher is faster'
});

OrbitCameraInputMouse.attributes.add('distanceSensitivity', {
    type: 'number',
    default: 0.15,
    title: 'Distance Sensitivity',
    description: 'How fast the camera moves in and out. Higher is faster'
});

// initialize code called once per entity
OrbitCameraInputMouse.prototype.initialize = function () {
    this.orbitCamera = this.entity.script.orbitCamera;

    if (this.orbitCamera) {
        var self = this;

        var onMouseOut = function (e) {
            self.onMouseOut(e);
        };

        this.app.mouse.on(pc.EVENT_MOUSEDOWN, this.onMouseDown, this);
        this.app.mouse.on(pc.EVENT_MOUSEUP, this.onMouseUp, this);
        this.app.mouse.on(pc.EVENT_MOUSEMOVE, this.onMouseMove, this);
        this.app.mouse.on(pc.EVENT_MOUSEWHEEL, this.onMouseWheel, this);

        // Listen to when the mouse travels out of the window
        window.addEventListener('mouseout', onMouseOut, false);

        // Remove the listeners so if this entity is destroyed
        this.on('destroy', function () {
            this.app.mouse.off(pc.EVENT_MOUSEDOWN, this.onMouseDown, this);
            this.app.mouse.off(pc.EVENT_MOUSEUP, this.onMouseUp, this);
            this.app.mouse.off(pc.EVENT_MOUSEMOVE, this.onMouseMove, this);
            this.app.mouse.off(pc.EVENT_MOUSEWHEEL, this.onMouseWheel, this);

            window.removeEventListener('mouseout', onMouseOut, false);
        });
    }

    // Disabling the context menu stops the browser displaying a menu when
    // you right-click the page
    this.app.mouse.disableContextMenu();

    this.lookButtonDown = false;
    this.panButtonDown = false;
    this.lastPoint = new pc.Vec2();
};


OrbitCameraInputMouse.fromWorldPoint = new pc.Vec3();
OrbitCameraInputMouse.toWorldPoint = new pc.Vec3();
OrbitCameraInputMouse.worldDiff = new pc.Vec3();


OrbitCameraInputMouse.prototype.pan = function (screenPoint) {
    var fromWorldPoint = OrbitCameraInputMouse.fromWorldPoint;
    var toWorldPoint = OrbitCameraInputMouse.toWorldPoint;
    var worldDiff = OrbitCameraInputMouse.worldDiff;

    // For panning to work at any zoom level, we use screen point to world projection
    // to work out how far we need to pan the pivotEntity in world space
    var camera = this.entity.camera;
    var distance = this.orbitCamera.distance;

    camera.screenToWorld(screenPoint.x, screenPoint.y, distance, fromWorldPoint);
    camera.screenToWorld(this.lastPoint.x, this.lastPoint.y, distance, toWorldPoint);

    worldDiff.sub2(toWorldPoint, fromWorldPoint);

    this.orbitCamera.pivotPoint.add(worldDiff);
};


OrbitCameraInputMouse.prototype.onMouseDown = function (event) {
    switch (event.button) {
        case pc.MOUSEBUTTON_LEFT:
            this.lookButtonDown = true;
            break;
        case pc.MOUSEBUTTON_MIDDLE:
        case pc.MOUSEBUTTON_RIGHT:
            this.panButtonDown = true;
            break;
    }
};


OrbitCameraInputMouse.prototype.onMouseUp = function (event) {
    switch (event.button) {
        case pc.MOUSEBUTTON_LEFT:
            this.lookButtonDown = false;
            break;
        case pc.MOUSEBUTTON_MIDDLE:
        case pc.MOUSEBUTTON_RIGHT:
            this.panButtonDown = false;
            break;
    }
};


OrbitCameraInputMouse.prototype.onMouseMove = function (event) {
    if (this.lookButtonDown) {
        this.orbitCamera.pitch -= event.dy * this.orbitSensitivity;
        this.orbitCamera.yaw -= event.dx * this.orbitSensitivity;

    } else if (this.panButtonDown) {
        this.pan(event);
    }

    this.lastPoint.set(event.x, event.y);
};


OrbitCameraInputMouse.prototype.onMouseWheel = function (event) {
    if (this.entity.camera.projection === pc.PROJECTION_PERSPECTIVE) {
        this.orbitCamera.distance -= event.wheelDelta * -2 * this.distanceSensitivity * (this.orbitCamera.distance * 0.1);
    } else {
        this.orbitCamera.orthoHeight -= event.wheelDelta * -2 * this.distanceSensitivity;
    }
    event.event.preventDefault();
};


OrbitCameraInputMouse.prototype.onMouseOut = function (event) {
    this.lookButtonDown = false;
    this.panButtonDown = false;
};


////////////////////////////////////////////////////////////////////////////////
//                       Orbit Camera Touch Input Script                      //
////////////////////////////////////////////////////////////////////////////////
var OrbitCameraInputTouch = pc.createScript('orbitCameraInputTouch');

OrbitCameraInputTouch.attributes.add('orbitSensitivity', {
    type: 'number',
    default: 0.4,
    title: 'Orbit Sensitivity',
    description: 'How fast the camera moves around the orbit. Higher is faster'
});

OrbitCameraInputTouch.attributes.add('distanceSensitivity', {
    type: 'number',
    default: 0.2,
    title: 'Distance Sensitivity',
    description: 'How fast the camera moves in and out. Higher is faster'
});

// initialize code called once per entity
OrbitCameraInputTouch.prototype.initialize = function () {
    this.orbitCamera = this.entity.script.orbitCamera;

    // Store the position of the touch so we can calculate the distance moved
    this.lastTouchPoint = new pc.Vec2();
    this.lastPinchMidPoint = new pc.Vec2();
    this.lastPinchDistance = 0;

    if (this.orbitCamera && this.app.touch) {
        // Use the same callback for the touchStart, touchEnd and touchCancel events as they
        // all do the same thing which is to deal the possible multiple touches to the screen
        this.app.touch.on(pc.EVENT_TOUCHSTART, this.onTouchStartEndCancel, this);
        this.app.touch.on(pc.EVENT_TOUCHEND, this.onTouchStartEndCancel, this);
        this.app.touch.on(pc.EVENT_TOUCHCANCEL, this.onTouchStartEndCancel, this);

        this.app.touch.on(pc.EVENT_TOUCHMOVE, this.onTouchMove, this);

        this.on('destroy', function () {
            this.app.touch.off(pc.EVENT_TOUCHSTART, this.onTouchStartEndCancel, this);
            this.app.touch.off(pc.EVENT_TOUCHEND, this.onTouchStartEndCancel, this);
            this.app.touch.off(pc.EVENT_TOUCHCANCEL, this.onTouchStartEndCancel, this);

            this.app.touch.off(pc.EVENT_TOUCHMOVE, this.onTouchMove, this);
        });
    }
};


OrbitCameraInputTouch.prototype.getPinchDistance = function (pointA, pointB) {
    // Return the distance between the two points
    var dx = pointA.x - pointB.x;
    var dy = pointA.y - pointB.y;

    return Math.sqrt((dx * dx) + (dy * dy));
};


OrbitCameraInputTouch.prototype.calcMidPoint = function (pointA, pointB, result) {
    result.set(pointB.x - pointA.x, pointB.y - pointA.y);
    result.mulScalar(0.5);
    result.x += pointA.x;
    result.y += pointA.y;
};


OrbitCameraInputTouch.prototype.onTouchStartEndCancel = function (event) {
    // We only care about the first touch for camera rotation. As the user touches the screen,
    // we stored the current touch position
    var touches = event.touches;
    if (touches.length === 1) {
        this.lastTouchPoint.set(touches[0].x, touches[0].y);

    } else if (touches.length === 2) {
        // If there are 2 touches on the screen, then set the pinch distance
        this.lastPinchDistance = this.getPinchDistance(touches[0], touches[1]);
        this.calcMidPoint(touches[0], touches[1], this.lastPinchMidPoint);
    }
};


OrbitCameraInputTouch.fromWorldPoint = new pc.Vec3();
OrbitCameraInputTouch.toWorldPoint = new pc.Vec3();
OrbitCameraInputTouch.worldDiff = new pc.Vec3();


OrbitCameraInputTouch.prototype.pan = function (midPoint) {
    var fromWorldPoint = OrbitCameraInputTouch.fromWorldPoint;
    var toWorldPoint = OrbitCameraInputTouch.toWorldPoint;
    var worldDiff = OrbitCameraInputTouch.worldDiff;

    // For panning to work at any zoom level, we use screen point to world projection
    // to work out how far we need to pan the pivotEntity in world space
    var camera = this.entity.camera;
    var distance = this.orbitCamera.distance;

    camera.screenToWorld(midPoint.x, midPoint.y, distance, fromWorldPoint);
    camera.screenToWorld(this.lastPinchMidPoint.x, this.lastPinchMidPoint.y, distance, toWorldPoint);

    worldDiff.sub2(toWorldPoint, fromWorldPoint);

    this.orbitCamera.pivotPoint.add(worldDiff);
};


OrbitCameraInputTouch.pinchMidPoint = new pc.Vec2();

OrbitCameraInputTouch.prototype.onTouchMove = function (event) {
    var pinchMidPoint = OrbitCameraInputTouch.pinchMidPoint;

    // We only care about the first touch for camera rotation. Work out the difference moved since the last event
    // and use that to update the camera target position
    var touches = event.touches;
    if (touches.length === 1) {
        var touch = touches[0];

        this.orbitCamera.pitch -= (touch.y - this.lastTouchPoint.y) * this.orbitSensitivity;
        this.orbitCamera.yaw -= (touch.x - this.lastTouchPoint.x) * this.orbitSensitivity;

        this.lastTouchPoint.set(touch.x, touch.y);

    } else if (touches.length === 2) {
        // Calculate the difference in pinch distance since the last event
        var currentPinchDistance = this.getPinchDistance(touches[0], touches[1]);
        var diffInPinchDistance = currentPinchDistance - this.lastPinchDistance;
        this.lastPinchDistance = currentPinchDistance;

        this.orbitCamera.distance -= (diffInPinchDistance * this.distanceSensitivity * 0.1) * (this.orbitCamera.distance * 0.1);

        // Calculate pan difference
        this.calcMidPoint(touches[0], touches[1], pinchMidPoint);
        this.pan(pinchMidPoint);
        this.lastPinchMidPoint.copy(pinchMidPoint);
    }
};

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

