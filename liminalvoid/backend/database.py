import sqlite3
import json
import os
import time

db="liminal.db"

def init_db():
    conn=sqlite3.connect(db)
    cursor=conn.cursor()
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS sessions(
        id TEXT PRIMARY KEY,
        started_at REAL)
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS snapshots(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        timestamp REAL,
        velocity REAL,
        direction_changes INTEGER,
        dwell_time REAL,
        look_at_anomaly INTEGER,
        anomaly_exposure INTEGER,
        backtrack_count INTEGER,
        wall_proximity REAL,
        pause_frequency INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS room_history(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_history_id INTEGER,
            head_velocity REAL,
            head_exploration REAL,
            head_fear REAL,
            head_longrange REAL,
            head_void REAL,
            FOREIGN KEY (room_history_id) REFERENCES room_history(id)
        )
    """)

    conn.commit()
    conn.close()

def insert_session(session_id:str):
    conn=sqlite3.connect(db)
    cursor=conn.cursor()
    cursor.execute(
        "INSERT OR IGNORE INTO sessions(id, started_at) VALUES(?,?)",
        (session_id, time.time())
    )
    conn.commit()
    conn.close()

def insert_snapshot(snap:dict):
    conn=sqlite3.connect(db)
    cursor=conn.cursor()
    cursor.execute("""
        INSERT INTO snapshots(session_id, timestamp, velocity, direction_changes,
         dwell_time, look_at_anomaly, anomaly_exposure,
         backtrack_count, wall_proximity, pause_frequency)
        VALUES (?,?,?,?,?,?,?,?,?,?)
    """, (
        snap["session_id"],
        time.time(),
        snap["velocity"],
        snap["direction_change"],
        snap["dwell_time"],
        snap["anamoly"],
        snap["anamoly_visibility"],
        snap["backtrack"],
        snap["wall_closer"],
        snap["pause"],
    ))

    conn.commit()
    conn.close()

def get_all_snapshots(session_id: str):
    conn = sqlite3.connect(db)
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM snapshots WHERE session_id=? ORDER BY timestamp",
        (session_id,)
    )
    rows = cursor.fetchall()
    conn.close()
    return rows
