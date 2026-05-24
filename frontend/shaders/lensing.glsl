// Gravitational lensing post-processing fragment shader
// Simulates Schwarzschild black-hole distortion around exit portals.
// void_pull (0→1) controls warp intensity; 1.0 = full event horizon.

uniform sampler2D tDiffuse;
uniform int       uPortalCount;
uniform vec2      uPortalPositions[4];
uniform float     uVoidPulls[4];
uniform float     uPortalRadii[4];
uniform vec2      uResolution;

varying vec2 vUv;

void main() {
    vec2 pixelCoord = vUv * uResolution;
    vec2 warpedCoord = pixelCoord;

    // Accumulate lensing from all active portals
    for (int i = 0; i < 4; i++) {
        float vp = uVoidPulls[i];
        if (vp < 0.001) continue;

        vec2  center = uPortalPositions[i];
        float radius = uPortalRadii[i];
        vec2  delta  = pixelCoord - center;
        float dist   = length(delta);

        if (dist > radius * 4.0) continue;

        float rs = radius * 0.22 * vp;               // Schwarzschild radius
        float falloff = 1.0 - smoothstep(0.0, radius * 4.0, dist);
        float strength = vp * radius * radius * 0.12;
        float denom    = dist * dist + rs * rs + 0.001;

        // Pull warp toward portal center
        warpedCoord -= normalize(delta) * (strength / denom) * falloff;
    }

    // Event horizon: pixels inside rs render black (+ thin accretion glow)
    for (int i = 0; i < 4; i++) {
        float vp = uVoidPulls[i];
        if (vp < 0.001) continue;

        float rs    = uPortalRadii[i] * 0.22 * vp;
        float glowR = rs * 1.6;
        float dist  = length(pixelCoord - uPortalPositions[i]);

        if (dist < rs) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
        }
        if (dist < glowR) {
            float t = 1.0 - (dist - rs) / (glowR - rs);
            // Warm accretion-disk tint
            gl_FragColor = vec4(0.55 * t, 0.08 * t * t, 0.0, 1.0);
            return;
        }
    }

    gl_FragColor = texture2D(tDiffuse, clamp(warpedCoord / uResolution, 0.001, 0.999));
}
