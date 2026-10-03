import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent.absolute()

FOOTAGE_DIR = PROJECT_ROOT / "footage"
MISSION_VIDEO = FOOTAGE_DIR / "mission.mp4"
PROJECTION_FILE = FOOTAGE_DIR / "projection.npz"
UPLOADS_DIR = FOOTAGE_DIR / "uploads"
MAX_UPLOAD_MB = 1024
MAX_UPLOAD_SECONDS = 600     # uploads are trimmed to the first 10 minutes

DATA_DIR = PROJECT_ROOT / "edge-data"
SHARD_DIR = DATA_DIR / "shard"
THUMBS_DIR = DATA_DIR / "thumbs"

# "siglip2" (better retrieval, 768d) or "clip" (smaller/faster, 512d).
# Thresholds below are calibrated per backend; change them together.
ENCODER_BACKEND = "siglip2"
VISION_MODEL_NAME = "Qdrant/clip-ViT-B-32-vision"
TEXT_MODEL_NAME = "Qdrant/clip-ViT-B-32-text"
VECTOR_DIMENSION = 768 if ENCODER_BACKEND == "siglip2" else 512
VECTOR_NAME = "vision"
SPARSE_VECTOR_NAME = "caption"

INGEST_FPS = 3.0          # detection + frame embedding ticks per second of mission time

# ---------------------------------------------------------------------------
# Object detection (YOLOE-11L-seg, open vocabulary via text prompts).
# The vocabulary is embedded once at startup with MobileCLIP and can be
# extended live ("teach a concept") in ~300 ms.
# ---------------------------------------------------------------------------
DETECTOR_WEIGHTS = "yoloe-11l-seg.pt"
DETECTOR_VOCAB = [
    "sofa", "armchair", "dining chair", "bar stool", "bench", "ottoman",
    "coffee table", "dining table", "nightstand", "dresser",
    "kitchen island", "bookshelf", "cabinet",
    "bed", "pillow", "blanket", "rug",
    "floor lamp", "table lamp", "pendant light", "chandelier",
    "framed picture", "mirror", "houseplant", "vase", "flowers",
    "television", "fireplace", "pool table",
    "wine bottle", "wine glass", "bowl", "tray", "candle", "book", "basket",
    "faucet", "kitchen sink", "range hood", "stove", "refrigerator", "oven",
    "bathtub", "shower", "toilet", "towel", "bathroom vanity",
    "staircase", "window", "curtains",
    "patio chair", "patio sofa", "outdoor table", "grill",
]
DETECT_CONF = 0.32        # YOLOE open-vocab confidences run low; tuned on footage
DETECT_IMGSZ = 640
DETECT_MAX_DET = 32
MAX_VOCAB = 80            # cap on live-taught concepts

# Object identity: a track becomes a remembered object after N sightings.
CONFIRM_SIGHTINGS = 3
REID_THRESHOLD = 0.90     # cosine sim to merge a new track into a known object
MIN_BOX_AREA = 0.004      # ignore detections smaller than 0.4% of the frame
MAX_CROP_EMBEDS_PER_TICK = 4
CROP_PAD = 0.22           # context margin around the box before embedding/captioning

# Caption enrichment (Florence-2-base, async, on-device).
CAPTIONER_MODEL = "florence-community/Florence-2-base"
CAPTIONER_DEVICE = "mps"  # falls back to cpu automatically if MPS is missing
CAPTION_MAX_TOKENS = 48

THUMB_WIDTH = 320
CROP_THUMB_WIDTH = 192
JPEG_QUALITY = 72

OBJECT_SEARCH_LIMIT = 4
MOMENT_SEARCH_LIMIT = 3
RRF_K = 60
MMR_LAMBDA = 0.9          # 1.0 = pure relevance, 0.0 = pure diversity
MMR_MAX_CANDIDATES = 100

# SigLIP2 cosine bands on object crops are higher than on full frames:
# real object hits 0.12-0.45, absent concepts < 0.10.
WEAK_OBJECT_SCORE = 0.10

# ---------------------------------------------------------------------------
# EdgeMind: edge <-> cloud memory sync.
# The device keeps working with the Edge shard alone; the cloud is a Qdrant
# Server it reconciles with whenever the link is up.
# ---------------------------------------------------------------------------
DEVICE_ID = os.environ.get("EDGEMIND_DEVICE_ID", "edge-01")
SYNC_DB = DATA_DIR / "sync.db"   # device-local ledger, wiped with the shard
CLOUD_URL = os.environ.get("EDGEMIND_CLOUD_URL", "http://localhost:6333")
CLOUD_API_KEY = os.environ.get("EDGEMIND_CLOUD_API_KEY") or None
CLOUD_COLLECTION = os.environ.get("EDGEMIND_CLOUD_COLLECTION", "edgemind_memories")
# Used only if no Qdrant Server answers at CLOUD_URL: qdrant-client local mode.
CLOUD_FALLBACK_DIR = PROJECT_ROOT / "cloud-data"
CLOUD_TIMEOUT_S = 3

SYNC_INTERVAL_S = 1.0     # sync worker tick
SYNC_BATCH = 3            # memories per upload batch
# Uploads to a local Qdrant take a few ms; pacing batches keeps the queue
# drain visible on screen. Set to 0 for full speed.
SYNC_BATCH_PACING_S = 0.4
PULL_INTERVAL_S = 4.0     # how often the device pulls cloud-side edits
MAX_SYNC_RETRIES = 5

# Sync policy: what stays on the device and what becomes fleet knowledge.
# Objects seen in these classes imply a sensitive room; they stay local
# unless an operator explicitly shares them.
PRIVATE_CLASSES = {"toilet", "shower", "bathtub", "bathroom vanity", "bed", "towel"}
SEMANTIC_FIELDS = ("caption", "note")   # versioned, conflict-checked
TELEMETRY_FIELDS = ("t_last", "sightings")  # merged with max(), never conflict
