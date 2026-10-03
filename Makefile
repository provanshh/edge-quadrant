.PHONY: setup footage prepare run test test-sync cloud cloud-stop cloud-reset clean

setup:
	@command -v uv >/dev/null || (echo "uv not installed." && exit 1)
	@command -v ffmpeg >/dev/null || (echo "ffmpeg not installed." && exit 1)
	uv sync
	@echo "Downloading models (embedder, detector, captioner)..."
	@uv run python -c "from app.encoder import get_encoder; get_encoder().warm()"
	@uv run python -c "from app.detector import ObjectDetector; ObjectDetector().warm()"
	@uv run python -c "from app.captioner import Captioner; Captioner().warm()"
	@echo "Setup complete. Next: make footage prepare"

footage:
	@mkdir -p footage
	@cd footage && for id in 7578546 7578552 7578540 7578549 7578547 7578550 7578551 7578542 7578543; do \
		curl -sL -O "https://videos.pexels.com/video-files/$$id/$$id-hd_1920_1080_30fps.mp4"; \
	done
	@echo "Clips downloaded (Pexels License, free for commercial use)."

prepare:
	uv run python scripts/prepare_footage.py
	uv run python scripts/test_objects.py

# Central cloud memory: a Qdrant Server in Docker (persists across runs).
# Without it the app falls back to embedded local mode in ./cloud-data.
cloud:
	@docker start edgemind-qdrant 2>/dev/null || docker run -d --name edgemind-qdrant \
		-p 6333:6333 -p 6334:6334 -v edgemind_qdrant:/qdrant/storage qdrant/qdrant
	@echo "Qdrant Server: http://localhost:6333/dashboard"

cloud-stop:
	docker stop edgemind-qdrant

cloud-reset:
	curl -s -X DELETE http://localhost:6333/collections/edgemind_memories; echo
	rm -rf cloud-data

run:
	@rm -rf edge-data
	uv run uvicorn app.main:app --port 8000

test:
	uv run python scripts/smoke_test.py 160

test-sync:
	uv run python scripts/test_sync.py

clean:
	rm -rf edge-data cloud-data .venv footage/mission.mp4
