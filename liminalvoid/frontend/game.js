import * as THREE from 'three';
import { Renderer } from './renderer.js';

// ─── Session ─────────────────────────────────────────────────────────────────
const SESSION_ID = crypto.randomUUID();
document.getElementById('session-id').textContent = SESSION_ID.slice(0, 8);

// ─── Renderer ─────────────────────────────────────────────────────────────────
const renderer = new Renderer();
const cam      = renderer.camera;

// ─── Input ────────────────────────────────────────────────────────────────────
const keys = { w: false, a: false, s: false, d: false };
let yaw  = 0, pitch = 0;
let isLocked = false;

document.getElementById('enter-btn').addEventListener('click', () => {
    document.body.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
    isLocked = document.pointerLockElement === document.body;
    const overlay = document.getElementById('overlay');
    overlay.style.opacity = isLocked ? '0' : '1';
    overlay.style.pointerEvents = isLocked ? 'none' : 'auto';
});

document.addEventListener('keydown', e => {
    if (e.code === 'KeyW') keys.w = true;
    if (e.code === 'KeyA') keys.a = true;
    if (e.code === 'KeyS') keys.s = true;
    if (e.code === 'KeyD') keys.d = true;
    if (e.code === 'Escape') document.exitPointerLock();
});
document.addEventListener('keyup', e => {
    if (e.code === 'KeyW') keys.w = false;
    if (e.code === 'KeyA') keys.a = false;
    if (e.code === 'KeyS') keys.s = false;
    if (e.code === 'KeyD') keys.d = false;
});
document.addEventListener('mousemove', e => {
    if (!isLocked) return;
    yaw   -= e.movementX * 0.0018;
    pitch  = Math.max(-Math.PI * 0.44, Math.min(Math.PI * 0.44, pitch - e.movementY * 0.0018));
});

// ─── Room + movement state ────────────────────────────────────────────────────
let currentRoomType = 'normal';
let currentRoom     = null;
const EYE_HEIGHT    = 1.7;
let totalDist       = 0;

const ROOM_SPEED = {
    normal:   5.0,
    geometry: 5.5,   // slightly too fast, feels wrong
    loop:     5.0,
    physics:  3.5,   // heavy, resisting
    void:     3.0,   // space pushes back
};

// ─── Player tracking ─────────────────────────────────────────────────────────
let velocity        = 0;
let dirChanges      = 0;
let dwellTime       = 0;
let backtrackCount  = 0;
let pauseCount      = 0;
let wasMoving       = false;
let snapshotTimer   = 0;
let lastYaw         = 0;
const lastDir       = new THREE.Vector3();
const posHistory    = [];  // ring buffer of last ~60 positions

// ─── WebSocket ────────────────────────────────────────────────────────────────
let ws = null, wsReady = false;

function wsConnect() {
    ws = new WebSocket('ws://localhost:8000/ws/player');
    ws.onopen  = () => { wsReady = true;  setStatus('connected'); };
    ws.onclose = () => { wsReady = false; setStatus('reconnecting...'); setTimeout(wsConnect, 2000); };
    ws.onerror = () => ws.close();
    ws.onmessage = e => {
        try {
            const room = JSON.parse(e.data);
            if (!room.room_id) return;
            currentRoom     = room;
            currentRoomType = room.anomaly_type ?? 'normal';
            setRoomHUD(room);
            startTransition(() => renderer.applyRoom(room));
        } catch { /* ignore malformed */ }
    };
}

function wsSend(nearAnomaly, anomalyVisible, nearWall) {
    if (!wsReady || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
        session_id:         SESSION_ID,
        velocity:           +velocity.toFixed(3),
        direction_change:   dirChanges,
        dwell_time:         +dwellTime.toFixed(2),
        anamoly:            nearAnomaly    ? 1 : 0,
        anamoly_visibility: anomalyVisible ? 1 : 0,
        backtrack:          backtrackCount,
        wall_closer:        nearWall       ? 1 : 0,
        pause:              pauseCount
    }));
    dirChanges = backtrackCount = pauseCount = 0;
    dwellTime  = 0;
}

// ─── Room transition (fade) ───────────────────────────────────────────────────
const fadeEl = document.getElementById('fade');
fadeEl.style.opacity = '0';
let transitioning = false;

function startTransition(roomCallback) {
    if (transitioning) { roomCallback(); return; }
    transitioning = true;
    fadeEl.style.opacity = '1';
    setTimeout(() => {
        roomCallback();
        cam.position.set(0, EYE_HEIGHT, 10);
        setTimeout(() => {
            fadeEl.style.opacity = '0';
            setTimeout(() => { transitioning = false; }, 500);
        }, 120);
    }, 500);
}

renderer.onExitReached = () => {
    wsSend(false, false, false);  // trigger room generation from backend
};

// ─── HUD helpers ─────────────────────────────────────────────────────────────
function setStatus(txt) {
    document.getElementById('ws-status').textContent = txt;
}

function setRoomHUD(room) {
    const type      = room.anomaly_type ?? 'normal';
    const intensity = room.intensity    ?? 0;
    let narrative;

    if (type === 'normal') {
        narrative = intensity < 0.2 ? '(silence)' : 'something is slightly wrong';
    } else if (type === 'geometry') {
        narrative = intensity < 0.5 ? "the walls don't meet correctly" : 'the ceiling is the wrong height';
    } else if (type === 'loop') {
        narrative = 'you have been here before';
    } else if (type === 'physics') {
        narrative = intensity < 0.5 ? 'the air feels thick' : 'gravity is wrong';
    } else if (type === 'void') {
        narrative = intensity > 0.7 ? 'do not look at the door' : 'do not stop moving';
    } else {
        narrative = '(silence)';
    }

    document.getElementById('room-info').textContent = narrative;
}

// ─── Game loop ────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);
    snapshotTimer += dt;

    // Camera orientation
    cam.rotation.order = 'YXZ';
    cam.rotation.y = yaw;
    cam.rotation.x = pitch;

    // Movement vector in world space
    const moveDir = new THREE.Vector3();
    if (keys.w) moveDir.z -= 1;
    if (keys.s) moveDir.z += 1;
    if (keys.a) moveDir.x -= 1;
    if (keys.d) moveDir.x += 1;
    if (moveDir.lengthSq() > 0) {
        moveDir.normalize().applyEuler(new THREE.Euler(0, yaw, 0));
    }

    const prevPos   = cam.position.clone();
    const moveSpeed = ROOM_SPEED[currentRoomType] ?? 5.0;
    cam.position.addScaledVector(moveDir, moveSpeed * dt);
    renderer.clampToRoom(cam.position);

    const moved  = cam.position.distanceTo(prevPos);
    velocity     = moved / (dt + 0.0001);
    const moving = moved > 0.004;

    // Breathing (always) + head-bob (only when moving), applied after clampToRoom
    const eyeBase = Math.min(EYE_HEIGHT, (renderer.ceilingHeight ?? 3.5) - 0.15);
    cam.position.y = eyeBase + Math.sin(Date.now() * 0.0003) * 0.008;
    if (moving) {
        totalDist += moved;
        cam.position.y += Math.sin(totalDist * 8) * 0.025;
    }

    // Dwell + pause
    if (!moving) {
        dwellTime += dt;
        if (wasMoving) pauseCount++;
    }
    wasMoving = moving;

    // Direction changes
    if (moving && lastDir.lengthSq() > 0) {
        if (moveDir.dot(lastDir) < -0.4) {
            dirChanges++;
            if (posHistory.length > 15) {
                const toOld = new THREE.Vector3()
                    .subVectors(posHistory[15], cam.position)
                    .normalize();
                if (toOld.dot(moveDir) > 0.65) backtrackCount++;
            }
        }
    }
    // Yaw change also counts
    const dy = Math.abs(yaw - lastYaw);
    if (dy > 0.28 && dy < Math.PI) dirChanges++;
    lastYaw = yaw;
    if (moving) lastDir.copy(moveDir);

    // Position history
    posHistory.unshift(cam.position.clone());
    if (posHistory.length > 60) posHistory.pop();

    // Proximity queries
    const nearWall                    = renderer.isNearWall(cam.position);
    const { near: nearAnomaly,
            visible: anomalyVisible } = renderer.getAnomalyInfo(cam.position, cam);

    renderer.checkExits(cam.position);

    // Snapshot every 2 s
    if (snapshotTimer >= 2.0) {
        wsSend(nearAnomaly, anomalyVisible, nearWall);
        snapshotTimer = 0;
    }

    renderer.render(dt);
}

renderer.applyRoom({
    room_id: 'start', anomaly_type: 'normal',
    ceiling_height: 3.5, corridor_width: 6,
    lighting: 'dim', exit_count: 1, texture_repeat: 4,
    gravity: 1.0, loop_target: null, void_pull: 0.0
});

wsConnect();
loop();
