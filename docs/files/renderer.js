import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass }     from 'three/addons/postprocessing/ShaderPass.js';

const MAX_PORTALS = 4;

// ─── Lensing shaders (mirrors shaders/lensing.glsl) ────────────────────────
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

// ─── Helpers ────────────────────────────────────────────────────────────────
function makeCanvasTex(w, h, draw) {
    const cv  = document.createElement('canvas');
    cv.width  = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
}

function wallTex(repeat) {
    const t = makeCanvasTex(256, 256, (ctx) => {
        ctx.fillStyle = '#191614';
        ctx.fillRect(0, 0, 256, 256);
        ctx.strokeStyle = '#0e0d0c';
        ctx.lineWidth = 1.5;
        for (let i = 0; i <= 4; i++) {
            const p = i * 64;
            ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 256); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(256, p); ctx.stroke();
        }
        // stain noise
        for (let i = 0; i < 1200; i++) {
            const a = Math.random() * 0.025;
            ctx.fillStyle = `rgba(0,0,0,${a})`;
            ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
        }
    });
    t.repeat.set(repeat, 1);
    return t;
}

function floorTex(repeat) {
    const t = makeCanvasTex(256, 256, (ctx) => {
        ctx.fillStyle = '#0e0d0b';
        ctx.fillRect(0, 0, 256, 256);
        ctx.strokeStyle = '#080706';
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

function ceilTex() {
    const t = makeCanvasTex(128, 128, (ctx) => {
        ctx.fillStyle = '#070707';
        ctx.fillRect(0, 0, 128, 128);
    });
    t.repeat.set(2, 2);
    return t;
}

// ─── Renderer ───────────────────────────────────────────────────────────────
export class Renderer {
    constructor() {
        this.scene  = new THREE.Scene();
        this.scene.background = new THREE.Color(0x000000);
        this.scene.fog = new THREE.FogExp2(0x000000, 0.055);

        this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 150);
        this.camera.position.set(0, 1.7, 10);

        this.gl = new THREE.WebGLRenderer({ antialias: false });
        this.gl.setSize(innerWidth, innerHeight);
        this.gl.setPixelRatio(Math.min(devicePixelRatio, 2));
        document.body.appendChild(this.gl.domElement);

        this._setupLights();
        this._setupPostFX();

        // Room state
        this.currentRoom   = null;
        this.roomMeshes    = [];
        this.exitPortals   = [];   // { mesh, worldPos, dir, width, height, voidPull, triggered }
        this.anomalyMesh   = null;
        this.bounds        = { minX: -3, maxX: 3, minZ: -14, maxZ: 14 };
        this.hasExitFront  = false;
        this.hasExitBack   = false;

        // Lighting state
        this.lightMode     = 'normal';
        this.flickerTimer  = 0;
        this.flickerOn     = true;

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
        this.ambientLight = new THREE.AmbientLight(0x111111, 0.6);
        this.scene.add(this.ambientLight);

        this.mainLight = new THREE.PointLight(0xfff5e8, 1.2, 40);
        this.mainLight.position.set(0, 2.8, 0);
        this.scene.add(this.mainLight);

        this.eerieLight = new THREE.PointLight(0x1a0028, 0.8, 25);
        this.eerieLight.position.set(0, 1.5, -10);
        this.scene.add(this.eerieLight);
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
    }

    _clearRoom() {
        for (const m of this.roomMeshes) {
            this.scene.remove(m);
            m.geometry.dispose();
            if (Array.isArray(m.material)) m.material.forEach(mat => mat.dispose());
            else m.material.dispose();
        }
        this.roomMeshes  = [];
        this.exitPortals = [];
        this.hasExitFront = false;
        this.hasExitBack  = false;
        if (this.anomalyMesh) {
            this.scene.remove(this.anomalyMesh);
            this.anomalyMesh = null;
        }
    }

    _buildRoom(data) {
        this._clearRoom();
        this.currentRoom = data;

        const W = Math.max(3, data.corridor_width   ?? 6);
        const H = Math.max(2, data.ceiling_height   ?? 3.5);
        const D = 30;
        const R = data.texture_repeat ?? 4;
        const hw = W / 2;
        const hd = D / 2;
        const vp = data.void_pull ?? 0;

        this.bounds = {
            minX: -hw + 0.35, maxX: hw - 0.35,
            minZ: -hd + 0.35, maxZ: hd - 0.35
        };

        const wMat  = new THREE.MeshLambertMaterial({ map: wallTex(R) });
        const fMat  = new THREE.MeshLambertMaterial({ map: floorTex(R) });
        const cMat  = new THREE.MeshLambertMaterial({ map: ceilTex() });

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

        // Anomaly
        if (data.anomaly_type && data.anomaly_type !== 'none') {
            this._addAnomaly(data.anomaly_type, W, H, D);
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
        switch (mode) {
            case 'normal':
                this.ambientLight.intensity = 0.45;
                this.mainLight.intensity    = 1.2;
                this.mainLight.color.set(0xfff5e0);
                break;
            case 'dim':
                this.ambientLight.intensity = 0.05;
                this.mainLight.intensity    = 0.35;
                this.mainLight.color.set(0xffeedd);
                break;
            case 'flicker':
                this.ambientLight.intensity = 0.04;
                this.mainLight.intensity    = 1.1;
                this.mainLight.color.set(0xfff8f0);
                break;
            case 'none':
                this.ambientLight.intensity = 0.008;
                this.mainLight.intensity    = 0.0;
                break;
        }
    }

    _addAnomaly(type, W, H, D) {
        let geo, mat;
        const z = -D * 0.25;

        switch (type) {
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
        // Radii and voidPulls will be updated each frame with projected sizes
    }

    // Called every frame just before composer.render()
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

            // Cull portals behind camera
            if (tmp.z > 1.0) {
                this.lensingUniforms.uVoidPulls.value[i] = 0;
                continue;
            }

            const sx = (tmp.x *  0.5 + 0.5) * W;
            const sy = (tmp.y *  0.5 + 0.5) * H;  // bottom-left origin
            this.lensingUniforms.uPortalPositions.value[i].set(sx, sy);

            // Approximate screen radius
            const dist = this.camera.position.distanceTo(p.worldPos);
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
        this.camera.position.set(0, 1.7, 10);  // reset to back of room
        if (this.onRoomChange) this.onRoomChange();
    }

    clampToRoom(pos) {
        const b = this.bounds;
        pos.x = Math.max(b.minX, Math.min(b.maxX, pos.x));
        pos.y = 1.7;
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
                this.mainLight.intensity = this.flickerOn ? 0.9 + Math.random() * 0.6 : 0;
            }
        }

        this._updatePortalScreenSpace();
        this.composer.render();
    }
}
