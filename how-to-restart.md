# Full wipe, fresh start:

```bash
docker compose down -v
docker rmi -f local-face-cluster-engine:latest
docker builder prune -af
```

# What this accomplishes:
down -v — kills container, removes named volume (db + thumbnails, all clusters gone)
rmi -f — deletes built image
builder prune -af — clears cached build layers, forces true clean rebuild (picks up model swap fresh, no stale layer reuse)

Photos folder untouched throughout, that mount's read-only regardless.

Then rebuild: docker compose up --build