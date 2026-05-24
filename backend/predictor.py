import torch
import torch.nn as nn
import json
import redis 
import os
import numpy as np
import warnings



redis_host=os.environ.get("REDIS_HOST","127.0.0.1")
cache=redis.Redis(host=redis_host,port=6379,db=0)


SEQ_LEN    = 10   
N_FEATURES = 8       
N_HEADS    = 5      
D_MODEL    = 60    
THRESHOLD  = 0.5
N_CLASSES  = 5
anamoly=["normal", "geometry", "loop", "physics", "void"]



ARCHETYPES = {
    0: dict(  # normal
        velocity          =(0.7, 0.1),
        direction_change  =(1,   0.5),
        dwell_time        =(2.0, 0.5),
        anamoly           =(0,   0.1),
        anamoly_visibility=(0,   0.1),
        backtrack         =(0,   0.2),
        wall_closer       =(0,   0.1),
        pause             =(0,   0.2),
        intensity         =(0.1, 0.05),
    ),
    1: dict(  # geometry
        velocity          =(0.3, 0.1),
        direction_change  =(1,   0.5),
        dwell_time        =(6.0, 1.0),
        anamoly           =(1,   0.2),
        anamoly_visibility=(1,   0.3),
        backtrack         =(2,   0.5),
        wall_closer       =(1,   0.2),
        pause             =(1,   0.3),
        intensity         =(0.5, 0.1),
    ),
    2: dict(  # loop
        velocity          =(0.8, 0.15),
        direction_change  =(2,   0.5),
        dwell_time        =(4.0, 1.0),
        anamoly           =(0,   0.2),
        anamoly_visibility=(1,   0.3),
        backtrack         =(4,   0.5),
        wall_closer       =(0,   0.1),
        pause             =(1,   0.3),
        intensity         =(0.6, 0.1),
    ),
    3: dict(  # physics
        velocity          =(0.1, 0.05),
        direction_change  =(6,   1.0),
        dwell_time        =(9.0, 2.0),
        anamoly           =(1,   0.1),
        anamoly_visibility=(1,   0.2),
        backtrack         =(3,   0.5),
        wall_closer       =(1,   0.3),
        pause             =(2,   0.5),
        intensity         =(0.75, 0.1),
    ),
    4: dict(  # void
        velocity          =(0.05, 0.02),
        direction_change  =(0,    0.2),
        dwell_time        =(15.0, 3.0),
        anamoly           =(1,    0.1),
        anamoly_visibility=(1,    0.1),
        backtrack         =(0,    0.1),
        wall_closer       =(1,    0.1),
        pause             =(3,    0.5),
        intensity         =(0.95, 0.05),
    ),
}

FEATURE_KEYS = ["velocity", "direction_change", "dwell_time",
                "anamoly", "anamoly_visibility",
                "backtrack", "wall_closer", "pause"]

def generate_seq(label:int):
    arch=ARCHETYPES[label]
    seq=[]
    for _ in range(SEQ_LEN):
        row=[]
        for key in FEATURE_KEYS:
            mean,std=arch[key]
            value=np.random.normal(mean,std)
            value=max(0,value)
            row.append(value)
        seq.append(row)

    mean,std=arch["intensity"]
    intensity=np.random.normal(mean,std)
    intensity=max(0.0, min(1.0, intensity))

    return seq,intensity

class transformer(nn.Module):
    def __init__(self):
        super().__init__()

        self.input_ = nn.Linear(N_FEATURES,D_MODEL)

        self.postion_emb=nn.Embedding(num_embeddings=SEQ_LEN,embedding_dim=D_MODEL) ##this is done to give position awareness for each number
        
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            encoder=nn.TransformerEncoderLayer(d_model=D_MODEL,nhead=N_HEADS,dim_feedforward=128,dropout=0.1,batch_first=True)

            self.transformer=nn.TransformerEncoder(encoder_layer=encoder,num_layers=2)

        self.head_anamoly=nn.Linear(D_MODEL,N_CLASSES)

        self.head_intesity=nn.Sequential(nn.Linear(D_MODEL,1),nn.Sigmoid())
    def forward(self,x):
        batch=x.size(0)

        x=self.input_(x)
        positions = torch.arange(SEQ_LEN).unsqueeze(0).expand(batch, -1)
        x=x+self.postion_emb(positions)
        
        x=self.transformer(x)
        
        summary=x[:,-1,:]

        anomaly_type=self.head_anamoly(summary)
        intensity=self.head_intesity(summary)


        return anomaly_type, intensity



def dataset():
    x=[]
    y_class=[]
    y_intensity=[]
    for i  in range(5):
        for _ in range(1000):
            seq,intensity=generate_seq(i)
            y_class.append(i)
            x.append(seq)
            y_intensity.append(intensity)

    x          = torch.tensor(x,           dtype=torch.float32)
    y_class     = torch.tensor(y_class,     dtype=torch.long)## dtype is long because cross entropyloss cannot take floating
    y_intensity = torch.tensor(y_intensity, dtype=torch.float32) 


    return x, y_class, y_intensity

def train(epochs=30, save_path="spatial_transformer.pt"):
    X, y_class, y_intensity = dataset()
    n     = len(X)
    split = int(n * 0.8)
    X_train, X_val         = X[:split],          X[split:]
    y_class_train, y_class_val     = y_class[:split],    y_class[split:]
    y_int_train,   y_int_val       = y_intensity[:split], y_intensity[split:]

    model=transformer()
    optm=torch.optim.Adam(model.parameters(), lr=1e-3)
    cross_loss=nn.CrossEntropyLoss()
    mse_loss=nn.MSELoss()

    for e in range(1,epochs+1):
        model.train()
        optm.zero_grad()
        anomaly_pred, intensity_pred = model(X_train)
        loss_ce=cross_loss( anomaly_pred, y_class_train)
        loss_mse = mse_loss(intensity_pred.squeeze(), y_int_train)
        loss = loss_ce + loss_mse
        loss.backward()
        optm.step()
    torch.save(model.state_dict(), save_path)
    print(f"model saved → {save_path}")

def predict(session_id):
    key=f"session:{session_id}:snapshots"
    data=cache.get(key)
    if not data:
        return {"anomaly_type": "normal", "intensity": 0.0}
    snaps= json.loads(data)
    FEATURE_KEYS = ["velocity", "direction_change", "dwell_time",
                    "anamoly", "anamoly_visibility",
                    "backtrack", "wall_closer", "pause"]
    
    seq = [[s.get(k, 0) for k in FEATURE_KEYS] for s in snaps]

    while len(seq)<SEQ_LEN:
        seq.insert(0,[0.0]*N_FEATURES)
    x=torch.tensor([seq],dtype=torch.float32)
    path = "spatial_transformer.pt"
    if not os.path.exists(path):
        train(save_path=path)

    model = transformer()
    model.load_state_dict(torch.load(path, map_location="cpu", weights_only=True))

    with torch.no_grad():                         
        anomaly_pred, intensity_pred = model(x)

    label        = anomaly_pred.argmax(dim=1).item()
    intensity    = intensity_pred.item()

    return {
        "anomaly_type": anamoly[label],
        "intensity":    round(intensity, 3)
    }














        