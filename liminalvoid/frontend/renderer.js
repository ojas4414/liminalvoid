import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass }     from 'three/addons/postprocessing/ShaderPass.js';

const MAX_PORTALS = 4;

// ─── Lensing shaders ────────────────────────────────────────────────────────
const LENSING_VERT = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const LENSING_FRAG = `
uniform sampler2D tDiffuse;
uniform int       uPortalCount;
uniform vec2      uPortalPositions[4];
uniform float     uVoidPulls[4];
uniform float     uPortalRadii[4];
uniform vec2      uResolution;
varying vec2 vUv;

void main() {
    vec2 pixelCoord  = vUv * uResolution;
    vec2 warpedCoord = pixelCoord;

    for (int i = 0; i < 4; i++) {
        float vp = uVoidPulls[i];
        if (vp < 0.001) continue;
        vec2  center  = uPortalPositions[i];
        float radius  = uPortalRadii[i];
        vec2  delta   = pixelCoord - center;
        float dist    = length(delta);
        if (dist > radius * 4.0) continue;
        float rs      = radius * 0.22 * vp;
        float falloff = 1.0 - smoothstep(0.0, radius * 4.0, dist);
        float strength = vp * radius * radius * 0.12;
        float denom    = dist * dist + rs * rs + 0.001;
        warpedCoord   -= normalize(delta) * (strength / denom) * falloff;
    }

    for (int i = 0; i < 4; i++) {
        float vp   = uVoidPulls[i];
        if (vp < 0.001) continue;
        float rs   = uPortalRadii[i] * 0.22 * vp;
        float dist = length(pixelCoord - uPortalPositions[i]);
        if (dist < rs) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
        }
        float glowR = rs * 1.6;
        if (dist < glowR) {
            float t = 1.0 - (dist - rs) / (glowR - rs);
            gl_FragColor = vec4(0.55 * t, 0.08 * t * t, 0.0, 1.0);
            return;
        }
    }

    gl_FragColor = texture2D(tDiffuse, clamp(warpedCoord / uResolution, 0.001, 0.999));
}`;

// ─── Vignette shader ────────────────────────────────────────────────────────
const VIGNETTE_VERT = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const VIGNETTE_FRAG = `
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float uStrength;
void main() {
    vec4 color = texture2D(tDiffuse, vUv);
    vec2 center = vUv - 0.5;
    float dist = length(center);
    float vignette = smoothstep(0.8, 0.2, dist * uStrength * 2.0);
    gl_FragColor = vec4(color.rgb * vignette, color.a);
}`;

// ─── Helpers ────────────────────────────────────────────────────────────────
function makeCanvasTex(w, h, draw) {
    const cv  = document.createElement('canvas');
    cv.width  = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
}

function wallTexForType(type, repeat) {
    let base, line;
    switch (type) {
        case 'normal':  base = '#c8b560'; line = '#a08a40'; break;
        case 'void':    base = '#0d0d0d'; line = '#0d000d'; break;
        case 'physics': base = '#c8d0d8'; line = '#a0a8b0'; break;
        default:        base = '#2a2520'; line = '#0e0d0c'; break;
    }
    const t = makeCanvasTex(256, 256, (ctx) => {
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, 256, 256);
        ctx.strokeStyle = line;
        ctx.lineWidth = 1.5;
        for (let i = 0; i <= 4; i++) {
            const p = i * 64;
            ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 256); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(256, p); ctx.stroke();
        }
        if (type !== 'void') {
            for (let i = 0; i < 1200; i++) {
                const a = Math.random() * 0.025;
                ctx.fillStyle = `rgba(0,0,0,${a})`;
                ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
            }
        }
    });
    t.repeat.set(repeat, 1);
    return t;
}

function floorTexForType(type, repeat) {
    let base, line;
    switch (type) {
        case 'normal':  base = '#5c3a2e'; line = '#3d2820'; break;
        case 'void':    base = '#080808'; line = '#050505'; break;
        case 'physics': base = '#b8b8b8'; line = '#a0a0a0'; break;
        default:        base = '#1a1815'; line = '#080706'; break;
    }
    const t = makeCanvasTex(256, 256, (ctx) => {
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, 256, 256);
        ctx.strokeStyle = line;
        ctx.lineWidth = 2;
        for (let i = 0; i <= 4; i++) {
            const p = i * 64;
            ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 256); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(256, p); ctx.stroke();
        }
    });
    t.repeat.set(repeat, repeat);
    return t;
}

function ceilTexForType(type) {
    const t = makeCanvasTex(128, 128, (ctx) => {
        switch (type) {
            case 'normal':
                ctx.fillStyle = '#d8d0c0';
                ctx.fillRect(0, 0, 128, 128);
                ctx.strokeStyle = '#b0a898';
                ctx.lineWidth = 1.5;
                for (let i = 0; i <= 4; i++) {
                    const p = i * 32;
                    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 128); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(128, p); ctx.stroke();
                }
                for (let i = 0; i < 600; i++) {
                    ctx.globalAlpha = Math.random() * 0.12;
                    ctx.fillStyle = '#b0a898';
                    ctx.fillRect(Math.random() * 128, Math.random() * 128, 3, 3);
                }
                ctx.globalAlpha = 1.0;
                break;
            case 'void':
                ctx.fillStyle = '#050505';
                ctx.fillRect(0, 0, 128, 128);
                break;
            case 'physics':
                ctx.fillStyle = '#e0e0e0';
                ctx.fillRect(0, 0, 128, 128);
                break;
            default:
                ctx.fillStyle = '#070707';
                ctx.fillRect(0, 0, 128, 128);
                break;
        }
    });
    t.repeat.set(2, 2);
    return t;
}

// ─── Renderer ───────────────────────────────────────────────────────────────
export class Renderer {
    constructor() {
        this.scene  = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0d0d0d);
        this.scene.fog = new THREE.FogExp2(0x0d0d0d, 0.025);

        this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 150);
        this.camera.position.set(0, 1.7, 10);

        this.gl = new THREE.WebGLRenderer({ antialias: false });
        this.gl.setSize(innerWidth, innerHeight);
        this.gl.setPixelRatio(Math.min(devicePixelRatio, 2));
        document.body.appendChild(this.gl.domElement);

        this._setupLights();
        this._setupPostFX();

        // Room state
        this.currentRoom     = null;
        this.roomMeshes      = [];
        this.exitPortals     = [];
        this.anomalyMesh     = null;
        this.entityMesh      = null;
        this.entityIntensity = 0;
        this.bounds          = { minX: -3, maxX: 3, minZ: -14, maxZ: 14 };
        this.hasExitFront    = false;
        this.hasExitBack     = false;

        // Lighting state
        this.lightMode    = 'normal';
        this.flickerTimer = 0;
        this.flickerOn    = true;

        // Palette tracking for loop rooms
        this._lastRoomType = null;

        // Callbacks (set by game.js)
        this.onExitReached = null;
        this.onRoomChange  = null;

        this._buildRoom(this._defaultRoom());
        window.addEventListener('resize', () => this._onResize());
    }

    _defaultRoom() {
        return {
            room_id: 'start', anomaly_type: 'none',
            ceiling_height: 3.5, corridor_width: 6,
            lighting: 'dim', exit_count: 1, texture_repeat: 4,
            gravity: 9.8, loop_target: null, void_pull: 0.0
        };
    }

    _setupLights() {
        this.ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
        this.scene.add(this.ambientLight);

        this.mainLight = new THREE.PointLight(0xfff5e8, 60, 0);
        this.mainLight.position.set(0, 2.8, 0);
        this.scene.add(this.mainLight);

        // Purple void atmosphere — only active in 'none' lighting mode
        this.eerieLight = new THREE.PointLight(0x220033, 0, 30);
        this.eerieLight.position.set(0, 1.5, -10);
        this.scene.add(this.eerieLight);

        // Warm fill for normal rooms — second point at corridor far end
        this.warmLight = new THREE.PointLight(0xc8b030, 0, 30);
        this.warmLight.position.set(0, 2.0, -10);
        this.scene.add(this.warmLight);
    }

    _setupPostFX() {
        this.composer = new EffectComposer(this.gl);
        this.composer.addPass(new RenderPass(this.scene, this.camera));

        this.lensingUniforms = {
            tDiffuse:          { value: null },
            uPortalCount:      { value: 0 },
            uPortalPositions:  { value: Array.from({ length: MAX_PORTALS }, () => new THREE.Vector2()) },
            uVoidPulls:        { value: [0, 0, 0, 0] },
            uPortalRadii:      { value: [0, 0, 0, 0] },
            uResolution:       { value: new THREE.Vector2(innerWidth, innerHeight) }
        };

        this.lensingPass = new ShaderPass({
            uniforms:       this.lensingUniforms,
            vertexShader:   LENSING_VERT,
            fragmentShader: LENSING_FRAG
        });
        this.composer.addPass(this.lensingPass);

        this.vignetteUniforms = {
            tDiffuse:  { value: null },
            uStrength: { value: 0.3 }
        };

        this.vignettePass = new ShaderPass({
            uniforms:       this.vignetteUniforms,
            vertexShader:   VIGNETTE_VERT,
            fragmentShader: VIGNETTE_FRAG
        });
        this.composer.addPass(this.vignettePass);
    }

    _clearRoom() {
        for (const m of this.roomMeshes) {
            this.scene.remove(m);
            m.geometry.dispose();
            if (Array.isArray(m.material)) m.material.forEach(mat => mat.dispose());
            else m.material.dispose();
        }
        this.roomMeshes   = [];
        this.exitPortals  = [];
        this.hasExitFront = false;
        this.hasExitBack  = false;
        this.anomalyMesh  = null; // was in roomMeshes, already disposed by loop above

        if (this.entityMesh) {
            this.scene.remove(this.entityMesh);
            this.entityMesh.geometry.dispose();
            this.entityMesh.material.dispose();
            this.entityMesh = null;
        }
    }

    _buildRoom(data) {
        this._clearRoom();
        this.currentRoom = data;

        const type = data.anomaly_type ?? 'normal';
        // Loop rooms are visually identical to the previous room — intentional horror
        const paletteType = (type === 'loop') ? (this._lastRoomType ?? 'normal') : type;

        const W  = Math.max(0.4, data.corridor_width ?? 6);
        const H  = Math.max(0.9, data.ceiling_height ?? 3.5);
        const D  = 30;
        // Geometry rooms get amplified repeat so tiles look wrong and tiled
        let R    = data.texture_repeat ?? 4;
        if (type === 'geometry') R = Math.min(R * 1.5, 8);
        const hw = W / 2;
        const hd = D / 2;
        const vp = data.void_pull ?? 0;

        this.ceilingHeight   = H;
        this.currentVoidPull = vp;
        this._lastRoomType   = paletteType;

        this.bounds = {
            minX: -hw + 0.35, maxX: hw - 0.35,
            minZ: -hd + 0.35, maxZ: hd - 0.35
        };

        const wMat = new THREE.MeshLambertMaterial({ map: wallTexForType(paletteType, R) });
        const fMat = new THREE.MeshLambertMaterial({ map: floorTexForType(paletteType, R) });
        const cMat = new THREE.MeshLambertMaterial({ map: ceilTexForType(paletteType) });

        const addMesh = (geo, mat, pos, rotY = 0) => {
            const m = new THREE.Mesh(geo, mat);
            m.position.set(...pos);
            if (rotY) m.rotation.y = rotY;
            this.scene.add(m);
            this.roomMeshes.push(m);
            return m;
        };

        // Floor & ceiling
        const fg = new THREE.PlaneGeometry(W, D);
        fg.rotateX(-Math.PI / 2);
        addMesh(fg, fMat, [0, 0, 0]);

        const cg = new THREE.PlaneGeometry(W, D);
        cg.rotateX(Math.PI / 2);
        addMesh(cg, cMat, [0, H, 0]);

        // Side walls
        addMesh(new THREE.PlaneGeometry(D, H), wMat, [-hw, H / 2, 0], Math.PI / 2);
        addMesh(new THREE.PlaneGeometry(D, H), wMat, [ hw, H / 2, 0], -Math.PI / 2);

        // End walls — front (z=-hd) gets exit if exit_count >= 1
        const exitCount = data.exit_count ?? 1;
        const exits = [];
        if (exitCount >= 1) exits.push({ face: 'front', z: -hd, rotY: 0, dir: -1 });
        if (exitCount >= 2) exits.push({ face: 'back',  z:  hd, rotY: Math.PI, dir: 1 });

        const DOOR_W = Math.min(1.6, hw * 0.55);
        const DOOR_H = Math.min(H - 0.2, 2.8);

        const faceSet = new Set(exits.map(e => e.face));
        this.hasExitFront = faceSet.has('front');
        this.hasExitBack  = faceSet.has('back');

        for (const end of [{ face: 'front', z: -hd, rotY: 0, dir: -1 },
                           { face: 'back',  z:  hd, rotY: Math.PI, dir: 1 }]) {
            if (faceSet.has(end.face)) {
                this._buildEndWallWithDoor(W, H, end.z, end.rotY, end.dir, DOOR_W, DOOR_H, wMat, vp);
            } else {
                addMesh(new THREE.PlaneGeometry(W, H), wMat, [0, H / 2, end.z], end.rotY);
            }
        }

        // Lights
        this._applyLighting(data.lighting ?? 'normal');
        this.mainLight.position.set(0, H - 0.5, 0);
        this.eerieLight.position.set(0, H / 2, -hd * 0.5);
        this.warmLight.position.set(0, H * 0.8, -10);

        // Anomaly
        if (data.anomaly_type && data.anomaly_type !== 'none') {
            this._addAnomaly(data.anomaly_type, W, H, D);
        }

        // Far corridor entity — tall thin silhouette at corridor end
        this.entityIntensity = data.intensity ?? 0;
        this.entityMesh = null;
        if (this.entityIntensity > 0.6) {
            const eGeo = new THREE.CylinderGeometry(0.15, 0.2, 2.2, 6);
            const eMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
            this.entityMesh = new THREE.Mesh(eGeo, eMat);
            this.entityMesh.position.set(0, 1.1, -12);
            this.scene.add(this.entityMesh);
        }

        this._syncLensingUniforms();
    }

    _buildEndWallWithDoor(W, H, z, rotY, dir, doorW, doorH, mat, voidPull) {
        const hw = W / 2;
        const sideW = (hw - doorW / 2);

        const addPanel = (geo, px, py) => {
            const m = new THREE.Mesh(geo, mat);
            m.position.set(px, py, z);
            m.rotation.y = rotY;
            this.scene.add(m);
            this.roomMeshes.push(m);
        };

        if (sideW > 0.01) {
            addPanel(new THREE.PlaneGeometry(sideW * 2, H), -hw + sideW, H / 2);
            addPanel(new THREE.PlaneGeometry(sideW * 2, H),  hw - sideW, H / 2);
        }
        const topH = H - doorH;
        if (topH > 0.01) {
            addPanel(new THREE.PlaneGeometry(doorW, topH), 0, doorH + topH / 2);
        }

        // Portal plane (black void)
        const portalGeo = new THREE.PlaneGeometry(doorW, doorH);
        const portalMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
        const portal    = new THREE.Mesh(portalGeo, portalMat);
        portal.position.set(0, doorH / 2, z);
        portal.rotation.y = rotY;
        this.scene.add(portal);
        this.roomMeshes.push(portal);

        // Faint frame glow
        const frameGeo = new THREE.EdgesGeometry(portalGeo);
        const frameMat = new THREE.LineBasicMaterial({ color: 0x220033 });
        const frame    = new THREE.LineSegments(frameGeo, frameMat);
        frame.position.copy(portal.position);
        frame.rotation.copy(portal.rotation);
        frame.position.z += dir * 0.01;
        this.scene.add(frame);
        this.roomMeshes.push(frame);

        this.exitPortals.push({
            worldPos:  new THREE.Vector3(0, doorH / 2, z),
            dir, width: doorW, height: doorH,
            voidPull, triggered: false
        });
    }

    _applyLighting(mode) {
        this.lightMode = mode;
        // Reset secondary lights; each case opts in
        this.warmLight.intensity  = 0;
        this.eerieLight.intensity = 0;

        switch (mode) {
            case 'normal':
                this.ambientLight.color.set(0xc8b030);
                this.ambientLight.intensity = 0.8;
                this.mainLight.intensity    = 60;
                this.mainLight.color.set(0xfff5e0);
                this.warmLight.intensity    = 20;
                break;
            case 'dim':
                this.ambientLight.color.set(0xffffff);
                this.ambientLight.intensity = 0.4;
                this.mainLight.intensity    = 30;
                this.mainLight.color.set(0xffeedd);
                break;
            case 'flicker':
                this.ambientLight.color.set(0xffffff);
                this.ambientLight.intensity = 0.3;
                this.mainLight.intensity    = 60;
                this.mainLight.color.set(0xfff8f0);
                break;
            case 'none':
                this.ambientLight.color.set(0xffffff);
                this.ambientLight.intensity = 0.02;
                this.mainLight.intensity    = 0.0;
                this.eerieLight.color.set(0x1a0028);
                this.eerieLight.intensity   = 5;
                this.eerieLight.distance    = 15;
                break;
        }
    }

    _addAnomaly(type, W, H, D) {
        let geo, mat;
        const z = -D * 0.25;

        switch (type) {
            case 'normal': return;
            case 'loop':
                geo = new THREE.TorusGeometry(0.55, 0.04, 8, 48);
                mat = new THREE.MeshBasicMaterial({ color: 0x330044, wireframe: false, transparent: true, opacity: 0.7 });
                break;
            case 'entity':
                geo = new THREE.ConeGeometry(0.25, 1.9, 5);
                mat = new THREE.MeshBasicMaterial({ color: 0x110008 });
                break;
            default:
                geo = new THREE.OctahedronGeometry(0.28);
                mat = new THREE.MeshBasicMaterial({ color: 0x0d000d, wireframe: true });
        }

        this.anomalyMesh = new THREE.Mesh(geo, mat);
        this.anomalyMesh.position.set(0, H * 0.5, z);
        this.scene.add(this.anomalyMesh);
        this.roomMeshes.push(this.anomalyMesh);
    }

    _syncLensingUniforms() {
        const count = Math.min(this.exitPortals.length, MAX_PORTALS);
        this.lensingUniforms.uPortalCount.value = count;
    }

    _updatePortalScreenSpace() {
        const count = Math.min(this.exitPortals.length, MAX_PORTALS);
        const W = innerWidth, H = innerHeight;
        const tmp = new THREE.Vector3();

        this.camera.updateMatrixWorld();

        for (let i = 0; i < MAX_PORTALS; i++) {
            if (i >= count) {
                this.lensingUniforms.uVoidPulls.value[i] = 0;
                continue;
            }
            const p = this.exitPortals[i];

            tmp.copy(p.worldPos);
            tmp.project(this.camera);

            if (tmp.z > 1.0) {
                this.lensingUniforms.uVoidPulls.value[i] = 0;
                continue;
            }

            const sx = (tmp.x *  0.5 + 0.5) * W;
            const sy = (tmp.y *  0.5 + 0.5) * H;
            this.lensingUniforms.uPortalPositions.value[i].set(sx, sy);

            const dist  = this.camera.position.distanceTo(p.worldPos);
            const fovRad = this.camera.fov * Math.PI / 180;
            const projR  = (p.height * 0.5 * H) / (2 * dist * Math.tan(fovRad * 0.5));
            this.lensingUniforms.uPortalRadii.value[i]  = Math.max(8, projR);
            this.lensingUniforms.uVoidPulls.value[i]    = p.voidPull;
        }
    }

    _onResize() {
        this.camera.aspect = innerWidth / innerHeight;
        this.camera.updateProjectionMatrix();
        this.gl.setSize(innerWidth, innerHeight);
        this.composer.setSize(innerWidth, innerHeight);
        this.lensingUniforms.uResolution.value.set(innerWidth, innerHeight);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    applyRoom(data) {
        this._buildRoom(data);
        const eyeY = Math.min(1.7, this.ceilingHeight - 0.15);
        this.camera.position.set(0, eyeY, 10);
        if (this.onRoomChange) this.onRoomChange();
    }

    clampToRoom(pos) {
        const b = this.bounds;
        pos.x = Math.max(b.minX, Math.min(b.maxX, pos.x));
        pos.y = Math.min(1.7, (this.ceilingHeight ?? 3.5) - 0.15);
        if (!this.hasExitFront) pos.z = Math.max(b.minZ, pos.z);
        if (!this.hasExitBack)  pos.z = Math.min(b.maxZ, pos.z);
    }

    isNearWall(pos) {
        const b = this.bounds, t = 0.9;
        return pos.x < b.minX + t || pos.x > b.maxX - t ||
               pos.z < b.minZ + t || pos.z > b.maxZ - t;
    }

    getAnomalyInfo(pos, cam) {
        if (!this.anomalyMesh) return { near: false, visible: false };
        const dist = pos.distanceTo(this.anomalyMesh.position);
        if (dist > 6) return { near: false, visible: false };

        const frustum = new THREE.Frustum();
        frustum.setFromProjectionMatrix(
            new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
        );
        return { near: true, visible: frustum.containsPoint(this.anomalyMesh.position) };
    }

    checkExits(pos) {
        for (const exit of this.exitPortals) {
            if (exit.triggered) continue;
            const dx = pos.x - exit.worldPos.x;
            const dz = pos.z - exit.worldPos.z;
            if (Math.sqrt(dx * dx + dz * dz) < 1.2) {
                exit.triggered = true;
                if (this.onExitReached) this.onExitReached(exit);
            }
        }
    }

    render(dt) {
        // Animate anomaly
        if (this.anomalyMesh) {
            this.anomalyMesh.rotation.y += dt * 0.7;
            this.anomalyMesh.rotation.x += dt * 0.35;
        }

        // Flicker
        if (this.lightMode === 'flicker') {
            this.flickerTimer += dt;
            if (this.flickerTimer > Math.random() * 0.25 + 0.04) {
                this.flickerOn = !this.flickerOn;
                this.flickerTimer = 0;
                this.mainLight.intensity = this.flickerOn ? 40 + Math.random() * 20 : 0;
            }
        }

        // Far corridor entity — vanish on approach, track player when very intense
        if (this.entityMesh) {
            const dist = this.camera.position.distanceTo(this.entityMesh.position);
            if (dist < 4) {
                this.scene.remove(this.entityMesh);
                this.entityMesh.geometry.dispose();
                this.entityMesh.material.dispose();
                this.entityMesh = null;
            } else if (this.entityIntensity > 0.8) {
                const dx = this.camera.position.x - this.entityMesh.position.x;
                const dz = this.camera.position.z - this.entityMesh.position.z;
                this.entityMesh.rotation.y += (Math.atan2(dx, dz) - this.entityMesh.rotation.y) * 0.02;
            }
        }

        // Vignette: always present, strength scales with void_pull
        const vp = this.currentVoidPull ?? 0;
        this.vignetteUniforms.uStrength.value = 0.3 + vp * (2.0 / 3.0);

        // Lensing: only active for void rooms with pull > 0.1
        if (vp > 0.1) {
            this._updatePortalScreenSpace();
        } else {
            for (let i = 0; i < MAX_PORTALS; i++) {
                this.lensingUniforms.uVoidPulls.value[i] = 0;
            }
        }

        this.composer.render();
    }
}
