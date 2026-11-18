from pydantic import BaseModel


class PlayerSnapshot(BaseModel):
    session_id: str
    velocity: float
    direction_change: int
    dwell_time: float
    anomaly: int
    anomaly_visibility: int
    backtrack: int
    wall_closer: int
    pause: int
    

    