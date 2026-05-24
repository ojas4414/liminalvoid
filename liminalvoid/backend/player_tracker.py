import json 
import redis
import os 
from kafka import KafkaConsumer,KafkaProducer
from backend.models import PlayerSnapshot

REDIS_HOST= os.environ.get("REDIS_HOST","127.0.0.1")
KAFKA_HOST= os.environ.get("KAFKA_HOST","127.0.0.1")

cache=redis.Redis(host=REDIS_HOST,port=6379, db=0 )
TOPIC = "player_behaviour_events"

def producer_():
    return KafkaProducer(
        bootstrap_servers=f"{KAFKA_HOST}:9092",
        value_serializer= lambda v: json.dumps(v).encode("utf-8")
    )

def publish(snapshot: PlayerSnapshot):
    producer=producer_()
    producer.send(TOPIC, snapshot.model_dump())
    producer.flush()
    producer.close()

def store(snap: PlayerSnapshot):
    key=f"session:{snap.session_id}:snapshots"
    exist=cache.get(key)
    if exist:
        snaps=json.loads(exist)
    else:
        snaps=[]
    snaps.append(snap.model_dump())

    snaps=snaps[-10:]
    cache.setex(key,1800,json.dumps(snaps))

def get_snaps(session_id:PlayerSnapshot):
    key=f"session:{session_id}:snapshots"
    data= cache.get(key)
    if not data:
        return []
    return json.loads(data)




