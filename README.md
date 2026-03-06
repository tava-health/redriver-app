# Redriver — Revenge of the Queue

A web UI for redriving messages from a dead-letter queue (DLQ) back to the target queue. Works with **AWS SQS** and **RabbitMQ**.

---

## Before you start

You need **Node.js** installed. Check by running:

```bash
node -v
```

If that prints nothing, install Node from [nodejs.org](https://nodejs.org) (LTS version is fine).

---

## Step 1 — Install dependencies

You only need to do this once.

```bash
cd redriver-app/backend && npm install
cd ../frontend && npm install
```

---

## Step 2 — Set up credentials

### Using RabbitMQ (most common for local dev)

1. Copy the example env file:

   ```bash
   cp redriver-app/backend/.env.example redriver-app/backend/.env
   ```

2. That's it. The only variable you need is `RABBITMQ_URL` — the management API URL is derived from it automatically. The default is already set for the Feather Docker RabbitMQ (`admin`/`admin` on `localhost`). If your RabbitMQ uses different credentials, just update that one line.

### Using AWS SQS

No `.env` needed. The app uses your existing AWS credentials automatically — the same ones the rest of your tools use. Make sure you're logged in (check with `aws sts get-caller-identity`).

---

## Step 3 — Start the app

From the `redriver-app/` folder, run:

```bash
make start
```

That builds the frontend and starts a single server. Then open your browser to:

```
http://localhost:1337
```

Press `Ctrl+C` to stop.

> **Developer mode** (hot-reload for frontend changes): run `make dev` instead — Vite serves the frontend on `http://localhost:1337` and the backend runs on port `3001`.

---

## Step 4 — Use the app

1. Pick the **RabbitMQ** or **AWS SQS** tab depending on where your queues are.
2. Select your **Dead-letter queue** (the broken one) and your **Target queue** (where messages should go).
3. Optional: check **Dry run** to preview without actually moving anything.
4. Click **Start**.
5. For each message, choose what to do:
   - **Resend** — sends it to the target queue and removes it from the DLQ
   - **Skip** — leaves it alone and moves to the next message
   - **Delete only** — removes it from the DLQ without redriving
   - **Quit** — stops the session

---

## Troubleshooting

**"Cannot connect to backend"** — make sure the backend is running (`make dev-backend`) and nothing else is using port 1337.

**No queues showing up (RabbitMQ)** — RabbitMQ needs the Management plugin enabled. If you're using the Feather Docker setup (`feather/docker`), it's already enabled.

**No queues showing up (SQS)** — check that your AWS credentials are valid and you're on VPN if required.
