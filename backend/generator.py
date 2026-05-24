import uuid
import random
from typing import Optional

# ── HELPER ────────────────────────────────────────────────────────────────────
def _room_id() -> str:
    return "r_" + uuid.uuid4().hex[:8]


# ── 5 ROOM FUNCTIONS ──────────────────────────────────────────────────────────

def _normal_room(intensity: float) -> dict:
    # almost right. barely noticeable wrongness.
    return {
        "room_id":        _room_id(),
        "anomaly_type":   "normal",
        "intensity":      intensity,
        "ceiling_height": round(random.uniform(2.6, 2.9), 2),
        "corridor_width": round(random.uniform(1.8, 2.2), 2),
        "lighting":       "normal",
        "exit_count":     random.choice([1, 2]),
        "texture_repeat": round(1.0 + intensity * 0.3, 2),
        "gravity":        1.0,
        "loop_target":    None,
        "void_pull":      0.0,
    }


def _geometry_room(intensity: float) -> dict:
    # ceiling wrong, angles off, texture tiles too many times
    ceiling = round(3.0 - (intensity * 1.5), 2)
    width   = round(2.0 + random.uniform(-intensity, intensity), 2)
    return {
        "room_id":        _room_id(),
        "anomaly_type":   "geometry",
        "intensity":      intensity,
        "ceiling_height": max(0.9, ceiling),
        "corridor_width": max(0.4, width),
        "lighting":       "flicker" if intensity > 0.4 else "normal",
        "exit_count":     random.choice([1, 2, 3]),
        "texture_repeat": round(1.0 + intensity * 2.5, 2),
        "gravity":        1.0,
        "loop_target":    None,
        "void_pull":      round(intensity * 0.2, 3),
    }


def _loop_room(intensity: float, last_room_id: Optional[str] = None) -> dict:
    # one exit that teleports back to a previous room
    target = last_room_id if last_room_id else _room_id()
    return {
        "room_id":        _room_id(),
        "anomaly_type":   "loop",
        "intensity":      intensity,
        "ceiling_height": round(random.uniform(2.2, 2.8), 2),
        "corridor_width": round(random.uniform(1.6, 2.0), 2),
        "lighting":       "flicker" if intensity > 0.4 else "normal",
        "exit_count":     1,
        "texture_repeat": round(1.0 + intensity * 1.2, 2),
        "gravity":        1.0,
        "loop_target":    target,
        "void_pull":      0.0,
    }


def _physics_room(intensity: float) -> dict:
    # gravity is wrong — randomly floaty or heavy
    if random.random() > 0.5:
        gravity = round(1.0 - (intensity * 0.95), 3)   # floaty
    else:
        gravity = round(1.0 + intensity, 3)             # heavy
    return {
        "room_id":        _room_id(),
        "anomaly_type":   "physics",
        "intensity":      intensity,
        "ceiling_height": round(random.uniform(2.0, 4.5), 2),
        "corridor_width": round(random.uniform(1.5, 3.0), 2),
        "lighting":       "flicker",
        "exit_count":     random.choice([1, 2]),
        "texture_repeat": round(1.0 + intensity * 0.8, 2),
        "gravity":        gravity,
        "loop_target":    None,
        "void_pull":      0.0,
    }


def _void_room(intensity: float) -> dict:
    # space barely exists. void_pull feeds the GLSL lensing shader.
    void_pull = round(intensity * 0.95, 3)
    return {
        "room_id":        _room_id(),
        "anomaly_type":   "void",
        "intensity":      intensity,
        "ceiling_height": round(max(0.8, 2.5 - intensity * 1.8), 2),
        "corridor_width": round(max(0.3, 1.5 - intensity), 2),
        "lighting":       "none" if intensity > 0.7 else "dim",
        "exit_count":     1,
        "texture_repeat": round(1.0 + intensity * 4.0, 2),
        "gravity":        round(1.0 + intensity * 0.5, 3),
        "loop_target":    None,
        "void_pull":      void_pull,
    }


# ── DISPATCHER ────────────────────────────────────────────────────────────────
# main.py calls only this function
# reads anomaly_type, routes to the right room generator

_GENERATORS = {
    "normal":   _normal_room,
    "geometry": _geometry_room,
    "physics":  _physics_room,
    "void":     _void_room,
}

def generate_room(prediction: dict, last_room_id: Optional[str] = None) -> dict:
    anomaly_type = prediction.get("anomaly_type", "normal")
    intensity    = float(prediction.get("intensity", 0.1))
    intensity    = max(0.0, min(1.0, intensity))

    if anomaly_type == "loop":
        return _loop_room(intensity, last_room_id)

    generator_fn = _GENERATORS.get(anomaly_type, _normal_room)
    return generator_fn(intensity)