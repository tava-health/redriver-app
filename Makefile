.PHONY: start dev dev-backend dev-frontend install

# Build the frontend and start just the backend (serves everything on :1337)
start: install
	cd frontend && npm run build
	cd backend && node src/index.js

# Install all dependencies (run once)
install:
	cd backend && npm install
	cd frontend && npm install

# Dev mode: hot-reload frontend (Vite on :1337) + backend (on :3001) — Ctrl+C stops both
dev: install
	trap 'kill 0' SIGINT SIGTERM; \
	(cd backend && PORT=3001 npm run dev) & \
	(cd frontend && npm run dev) & \
	wait

# Start only the backend in dev mode
dev-backend:
	cd backend && PORT=3001 npm run dev

# Start only the frontend in dev mode
dev-frontend:
	cd frontend && npm run dev
