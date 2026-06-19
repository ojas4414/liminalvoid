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
    document.getElementById('overlay').style.display = isLocked ? 'none' : 'flex';
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

// ─── Player tracking ──────────────────────────────────────────────────────────
// Kept for feel/HUD purposes only — in the full build these snapshots get
// streamed to the FastAPI backend over WebSocket, where a Transformer scores
// anomaly exposure. There's no backend on GitHub Pages, so nothing reads
// these right now, but they're harmless and ready to wire up if you add a
// hosted backend later.
let wasMoving       = false;
const lastDir       = new THREE.Vector3();
const posHistory    = [];  // ring buffer of last ~60 positions

// ─── STATIC-DEMO ROOM GENERATOR ────────────────────────────────────────────────
// WHAT: produces the same room-config shape the renderer already consumes
// (room_id, anomaly_type, ceiling_height, corridor_width, lighting,
// exit_count, texture_repeat, gravity, loop_target, void_pull).
// WHY: the real pipeline generates this server-side (predictor.py's
// Transformer + the Kafka event stream) after scoring player behaviour.
// This build has no server, so reaching an exit generates the next room
// locally instead — same contract, no backend required.
let roomCounter = 0;
const ANOMALY_TYPES  = ['none', 'loop', 'entity', 'geometry'];
const LIGHTING_MODES = ['normal', 'dim', 'flicker'];

function generateRoom() {
    roomCounter++;
    return {
        room_id:        `room_${String(roomCounter).padStart(3, '0')}`,
        anomaly_type:   ANOMALY_TYPES[Math.floor(Math.random() * ANOMALY_TYPES.length)],
        ceiling_height: 3 + Math.random() * 2.5,                  // 3.0 – 5.5
        corridor_width: 4 + Math.random() * 4,                    // 4.0 – 8.0
        lighting:       LIGHTING_MODES[Math.floor(Math.random() * LIGHTING_MODES.length)],
        exit_count:     Math.random() < 0.7 ? 1 : 2,              // mostly single exit
        texture_repeat: 3 + Math.floor(Math.random() * 4),        // 3 – 6
        gravity:        9.8,
        loop_target:    null,
        void_pull:      Math.random() < 0.4 ? 0.1 + Math.random() * 0.8 : 0  // 40% of rooms pull
    };
}

// ─── Room transition (fade) ───────────────────────────────────────────────────
const fadeEl   = document.getElementById('fade');
let transitioning = false;

function startTransition(roomCallback) {
    if (transitioning) { roomCallback(); return; }
    transitioning = true;
    fadeEl.style.opacity = '1';
    setTimeout(() => {
        roomCallback();
        cam.position.set(0, 1.7, 10);
        setTimeout(() => {
            fadeEl.style.opacity = '0';
            setTimeout(() => { transitioning = false; }, 500);
        }, 120);
    }, 500);
}

// Reaching an exit generates the next room locally instead of asking a server.
renderer.onExitReached = () => {
    const room = generateRoom();
    setRoomHUD(room);
    startTransition(() => renderer.applyRoom(room));
};

// ─── HUD helpers ─────────────────────────────────────────────────────────────
function setStatus(txt) {
    document.getElementById('ws-status').textContent = txt;
}
function setRoomHUD(room) {
    document.getElementById('room-info').textContent =
        `${room.room_id}  ·  ${room.anomaly_type}  ·  void ${(room.void_pull ?? 0).toFixed(2)}  ·  ${room.lighting}`;
}

setStatus('local demo · no server');
setRoomHUD(renderer.currentRoom ?? { room_id: 'start', anomaly_type: 'none', void_pull: 0, lighting: 'dim' });

// ─── Game loop ────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);

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

    const prevPos = cam.position.clone();
    cam.position.addScaledVector(moveDir, 5.0 * dt);
    renderer.clampToRoom(cam.position);

    const moved  = cam.position.distanceTo(prevPos);
    const moving = moved > 0.004;

    if (!moving) {
        if (wasMoving) { /* paused after moving — kept for future local HUD use */ }
    }
    wasMoving = moving;
    if (moving) lastDir.copy(moveDir);

    posHistory.unshift(cam.position.clone());
    if (posHistory.length > 60) posHistory.pop();

    renderer.checkExits(cam.position);
    renderer.render(dt);
}

loop();
