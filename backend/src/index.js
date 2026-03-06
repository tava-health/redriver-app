import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import amqp from "amqplib";
import {
  SQSClient,
  GetQueueUrlCommand,
  ListQueuesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";

const REGION = "us-west-2";

// Uses default credential provider chain (env vars, ~/.aws/credentials, IAM role)
const sqs = new SQSClient({ region: REGION });

// RabbitMQ: set RABBITMQ_URL in .env (e.g. amqp://admin:admin@127.0.0.1:5672)
// The management API URL is derived automatically (same credentials, port 15672).
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://guest:guest@localhost:5672";

function getManagementUrl() {
  try {
    const u = new URL(RABBITMQ_URL);
    const host = u.hostname || "localhost";
    const user = u.username ? decodeURIComponent(u.username) : "guest";
    const pass = u.password ? decodeURIComponent(u.password) : "guest";
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:15672/api`;
  } catch {
    return "http://guest:guest@localhost:15672/api";
  }
}
const RABBITMQ_MANAGEMENT_URL = getManagementUrl();

function getVhost() {
  try {
    const path = new URL(RABBITMQ_URL).pathname?.replace(/^\//, "");
    return path ? encodeURIComponent(decodeURIComponent(path)) : "%2F";
  } catch {
    return "%2F";
  }
}

/** @type {Map<string, { connection: import("amqplib").Connection; channel: import("amqplib").Channel; dlqName: string; targetName: string }>} */
const rabbitSessions = new Map();

function normalizeRabbitMessage(msg) {
  const body = msg.content ? msg.content.toString("utf8") : "";
  const attrs = {};
  if (msg.properties?.messageId) attrs.messageId = msg.properties.messageId;
  if (msg.properties?.correlationId) attrs.correlationId = msg.properties.correlationId;
  if (msg.properties?.contentType) attrs.contentType = msg.properties.contentType;
  if (msg.fields?.deliveryTag != null) attrs.deliveryTag = String(msg.fields.deliveryTag);
  if (msg.fields?.redelivered != null) attrs.redelivered = String(msg.fields.redelivered);
  return {
    MessageId: msg.properties?.messageId ?? `delivery-${msg.fields?.deliveryTag}`,
    ReceiptHandle: String(msg.fields?.deliveryTag),
    Body: body,
    Attributes: attrs,
    _raw: {
      fields: msg.fields,
      properties: msg.properties,
    },
  };
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/queues", async (_req, res) => {
  try {
    const queues = [];
    let nextToken;
    do {
      const out = await sqs.send(
        new ListQueuesCommand({ MaxResults: 1000, NextToken: nextToken })
      );
      const urls = out.QueueUrls || [];
      for (const url of urls) {
        const name = url.split("/").pop() || url;
        queues.push({ name, url });
      }
      nextToken = out.NextToken;
    } while (nextToken);
    queues.sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ queues });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to list queues" });
  }
});

app.post("/api/setup", async (req, res) => {
  const { dlqName, targetName } = req.body || {};
  if (!dlqName || !targetName) {
    return res.status(400).json({ error: "dlqName and targetName required" });
  }
  try {
    const [dlq, target] = await Promise.all([
      sqs.send(new GetQueueUrlCommand({ QueueName: dlqName })),
      sqs.send(new GetQueueUrlCommand({ QueueName: targetName })),
    ]);
    return res.json({
      dlqUrl: dlq.QueueUrl,
      targetUrl: target.QueueUrl,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Failed to resolve queues" });
  }
});

app.get("/api/receive", async (req, res) => {
  const dlqUrl = req.query.dlqUrl;
  if (!dlqUrl) return res.status(400).json({ error: "dlqUrl required" });
  try {
    const out = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
        VisibilityTimeout: 60,
        AttributeNames: ["All"],
        MessageAttributeNames: ["All"],
      })
    );
    const messages = out.Messages || [];
    return res.json({ messages });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Receive failed" });
  }
});

app.post("/api/resend", async (req, res) => {
  const {
    dlqUrl,
    targetUrl,
    body,
    receiptHandle,
    messageGroupId,
    messageDeduplicationId,
    messageAttributes,
    dryRun,
  } = req.body || {};
  if (!dlqUrl || !targetUrl || body == null || !receiptHandle) {
    return res.status(400).json({ error: "dlqUrl, targetUrl, body, receiptHandle required" });
  }
  if (dryRun) {
    return res.json({ ok: true, dryRun: true });
  }
  try {
    const params = {
      QueueUrl: targetUrl,
      MessageBody: body,
      MessageGroupId: messageGroupId || undefined,
      MessageDeduplicationId: messageDeduplicationId || undefined,
      MessageAttributes: messageAttributes || undefined,
    };
    await sqs.send(new SendMessageCommand(params));
    await sqs.send(
      new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: receiptHandle })
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Resend failed" });
  }
});

app.post("/api/delete", async (req, res) => {
  const { dlqUrl, receiptHandle, dryRun } = req.body || {};
  if (!dlqUrl || !receiptHandle) {
    return res.status(400).json({ error: "dlqUrl and receiptHandle required" });
  }
  if (dryRun) {
    return res.json({ ok: true, dryRun: true });
  }
  try {
    await sqs.send(
      new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: receiptHandle })
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Delete failed" });
  }
});

// ----- RabbitMQ (mirrors SQS usage) -----

// Node fetch() rejects URLs that contain credentials; use a URL without userinfo + Basic auth header.
function managementFetchConfig(managementUrl) {
  const u = new URL(managementUrl);
  const user = decodeURIComponent(u.username || "");
  const pass = decodeURIComponent(u.password || "");
  u.username = "";
  u.password = "";
  const urlWithoutAuth = u.toString();
  const headers = { Accept: "application/json" };
  if (user || pass) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }
  return { urlWithoutAuth, headers };
}

app.get("/api/rabbitmq/queues", async (_req, res) => {
  try {
    const base = RABBITMQ_MANAGEMENT_URL.replace(/\/api\/?$/, "");
    const vhost = getVhost();
    const queuesUrl = `${base}/api/queues/${vhost}`;
    const { urlWithoutAuth, headers } = managementFetchConfig(queuesUrl);
    const resp = await fetch(urlWithoutAuth, { headers });
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(502).json({ error: `Management API error: ${resp.status} ${text.slice(0, 200)}` });
    }
    const list = await resp.json();
    const queues = (Array.isArray(list) ? list : [])
      .map((q) => ({ name: q.name, url: q.name }))
      .filter((q) => q.name);
    queues.sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ queues });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to list RabbitMQ queues" });
  }
});

function cleanupRabbitSession(sessionId) {
  const session = rabbitSessions.get(sessionId);
  if (!session) return;
  session.channel?.removeAllListeners?.();
  session.connection?.removeAllListeners?.();
  session.channel?.close?.().catch(() => {});
  session.connection?.close?.().catch(() => {});
  rabbitSessions.delete(sessionId);
}

app.post("/api/rabbitmq/start", async (req, res) => {
  const { dlqName, targetName } = req.body || {};
  if (!dlqName || !targetName) {
    return res.status(400).json({ error: "dlqName and targetName required" });
  }
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();
    const sessionId = `rmq-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const session = { connection, channel, dlqName, targetName };
    rabbitSessions.set(sessionId, session);

    const onChannelError = (err) => {
      console.error(`[RabbitMQ] session ${sessionId} channel error:`, err.message);
      cleanupRabbitSession(sessionId);
    };
    const onConnectionError = (err) => {
      console.error(`[RabbitMQ] session ${sessionId} connection error:`, err.message);
      cleanupRabbitSession(sessionId);
    };
    channel.on("error", onChannelError);
    connection.on("error", onConnectionError);

    await channel.checkQueue(dlqName);
    await channel.checkQueue(targetName);
    return res.json({ sessionId, dlqName, targetName });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Failed to connect or verify queues" });
  }
});

function isQuorumSingleConsumerError(err) {
  const msg = err?.message || "";
  return (
    err?.code === 405 ||
    msg.includes("RESOURCE_LOCKED") ||
    msg.includes("quorum queues with single active consumer") ||
    msg.includes("basic.get operations are not supported")
  );
}

app.get("/api/rabbitmq/receive", async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  const session = rabbitSessions.get(sessionId);
  if (!session) return res.status(400).json({ error: "Invalid or expired session" });
  const { channel, dlqName } = session;
  try {
    const msg = await channel.get(dlqName, { noAck: false });
    if (msg === false) {
      return res.json({ messages: [] });
    }
    const normalized = normalizeRabbitMessage(msg);
    return res.json({ messages: [normalized] });
  } catch (err) {
    if (isQuorumSingleConsumerError(err)) {
      cleanupRabbitSession(sessionId);
      return res.status(400).json({
        error:
          "This queue is a quorum queue with single active consumer; it does not support basic.get (pull). Use a classic queue or a quorum queue without single active consumer for DLQ redrive.",
      });
    }
    return res.status(500).json({ error: err.message || "Receive failed" });
  }
});

app.post("/api/rabbitmq/resend", async (req, res) => {
  const {
    sessionId,
    dlqName,
    targetName,
    body,
    receiptHandle,
    dryRun,
    headers,
  } = req.body || {};
  if (!sessionId || !dlqName || !targetName || body == null || receiptHandle == null) {
    return res.status(400).json({ error: "sessionId, dlqName, targetName, body, receiptHandle required" });
  }
  if (dryRun) return res.json({ ok: true, dryRun: true });
  const session = rabbitSessions.get(sessionId);
  if (!session) return res.status(400).json({ error: "Invalid or expired session" });
  const { channel } = session;
  try {
    const deliveryTag = Number(receiptHandle);
    channel.sendToQueue(targetName, Buffer.from(body, "utf8"), {
      persistent: true,
      headers: headers || undefined,
    });
    // amqplib ack(message, allUpTo) expects message.fields.deliveryTag
    channel.ack({ fields: { deliveryTag } });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Resend failed" });
  }
});

app.post("/api/rabbitmq/delete", async (req, res) => {
  const { sessionId, dlqName, receiptHandle, dryRun } = req.body || {};
  if (!sessionId || !dlqName || receiptHandle == null) {
    return res.status(400).json({ error: "sessionId, dlqName and receiptHandle required" });
  }
  if (dryRun) return res.json({ ok: true, dryRun: true });
  const session = rabbitSessions.get(sessionId);
  if (!session) return res.status(400).json({ error: "Invalid or expired session" });
  const { channel } = session;
  try {
    // amqplib ack(message, allUpTo) expects message.fields.deliveryTag
    channel.ack({ fields: { deliveryTag: Number(receiptHandle) } });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Delete failed" });
  }
});

app.post("/api/rabbitmq/skip", async (req, res) => {
  const { sessionId, receiptHandle } = req.body || {};
  if (!sessionId || receiptHandle == null) {
    return res.status(400).json({ error: "sessionId and receiptHandle required" });
  }
  const session = rabbitSessions.get(sessionId);
  if (!session) return res.status(400).json({ error: "Invalid or expired session" });
  const { channel } = session;
  try {
    // amqplib nack(message, allUpTo, requeue) expects message.fields.deliveryTag, not a raw number
    const deliveryTag = Number(receiptHandle);
    channel.nack({ fields: { deliveryTag } }, false, true);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Skip failed" });
  }
});

app.post("/api/rabbitmq/quit", async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  cleanupRabbitSession(sessionId);
  return res.json({ ok: true });
});

// Serve the built frontend (only when it exists — `make start` builds it first)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, "../../frontend/dist");
app.use(express.static(distPath));
// SPA fallback — must be after all /api routes
app.get("*", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

const PORT = process.env.PORT || 1337;
app.listen(PORT, () => {
  console.log(`DLQ redrive app at http://localhost:${PORT}`);
});
