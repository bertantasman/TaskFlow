require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const amqp = require('amqplib');
const client = require('prom-client');

const app = express();
const PORT = process.env.PORT;
if (!PORT) {
  throw new Error('PORT is required (set process.env.PORT)');
}
const SERVICE_NAME = 'task-service';
function logInfo(message, correlationId = 'system') {
  console.log(JSON.stringify({
    service: SERVICE_NAME,
    level: 'info',
    message,
    correlationId,
    timestamp: new Date().toISOString()
  }));
}

function logError(message, correlationId = 'system') {
  console.error(JSON.stringify({
    service: SERVICE_NAME,
    level: 'error',
    message,
    correlationId,
    timestamp: new Date().toISOString()
  }));
}

// In a real system these values should come from
// environment variables and be kept secret.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required (set process.env.JWT_SECRET)');
}

const RABBITMQ_URL = process.env.RABBITMQ_URL;
if (!RABBITMQ_URL) {
  throw new Error('RABBITMQ_URL is required (set process.env.RABBITMQ_URL)');
}

// Simple in-memory task storage.
// Data will be lost every time the service restarts.
const tasks = [];
let nextTaskId = 1;

// We keep a single RabbitMQ channel and reuse it.
let rabbitChannel = null;
const TASK_EXCHANGE = 'task_events';
const ALLOWED_FILTERS = new Set(['mine', 'public', 'visible']);
const ALLOWED_VISIBILITY = new Set(['private', 'public']);
const ALLOWED_STATUS = new Set(['pending', 'completed']);

function getCurrentUserId(req) {
  if (!req.user) {
    return null;
  }

  const rawUserId = req.user.email || req.user.username;
  if (typeof rawUserId !== 'string') {
    return null;
  }

  const normalizedUserId = rawUserId.trim().toLowerCase();
  return normalizedUserId || null;
}

function requireCurrentUserId(req, res) {
  const currentUser = getCurrentUserId(req);
  if (!currentUser) {
    res.status(401).json({ message: 'Invalid user identity' });
    return null;
  }

  return currentUser;
}

function sendBadRequest(res, message) {
  return res.status(400).json({ message });
}

function sendForbidden(res, message) {
  return res.status(403).json({ message });
}

function sendNotFound(res, message) {
  return res.status(404).json({ message });
}

async function getRabbitChannel() {
  if (rabbitChannel) {
    return rabbitChannel;
  }

  let attempt = 0;
  // Keep trying to connect to RabbitMQ until it is ready.
  // This avoids failures when RabbitMQ starts slower than this service.
  while (!rabbitChannel) {
    attempt += 1;
    try {
      // Minimal, beginner-friendly setup for RabbitMQ.
      const connection = await amqp.connect(RABBITMQ_URL);
      const channel = await connection.createChannel();

      // fanout means: broadcast messages to all queues bound to this exchange.
      await channel.assertExchange(TASK_EXCHANGE, 'fanout', { durable: false });

      rabbitChannel = channel;
      logInfo(`Connected to RabbitMQ on attempt ${attempt}`);
    } catch (err) {
      logError(`RabbitMQ connection retry attempt ${attempt} failed: ${err.message}`);

      // Wait 3 seconds before trying again.
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  return rabbitChannel;
}

// Very small authentication middleware.
// It expects a header like: Authorization: Bearer <token>
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return res.status(401).json({ message: 'Authorization token is required' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ message: 'Invalid authorization header format' });
  }

  const token = parts[1];

  try {
    // This will throw if the token is invalid or expired.
    const decoded = jwt.verify(token, JWT_SECRET);

    // Make the decoded user data available to the route handlers.
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(403).json({ message: 'Token expired' });
    }

    return res.status(403).json({ message: 'Invalid token' });
  }
}

app.use(express.json());
function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'task_service_http_requests_total',
  help: 'Total HTTP requests received by task-service',
  labelNames: ['method', 'route'],
  registers: [register]
});

const httpErrorsTotal = new client.Counter({
  name: 'task_service_http_errors_total',
  help: 'Total HTTP error responses from task-service',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

const serviceUptimeSeconds = new client.Gauge({
  name: 'task_service_uptime_seconds',
  help: 'Uptime in seconds for task-service',
  registers: [register]
});

serviceUptimeSeconds.set(process.uptime());
setInterval(() => {
  serviceUptimeSeconds.set(process.uptime());
}, 5000).unref();

app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || 'unknown';
  logInfo(`Request received: ${req.method} ${req.originalUrl}`, req.correlationId);

  res.on('finish', () => {
    const route = req.route && req.route.path
      ? `${req.baseUrl || ''}${req.route.path}`
      : req.path;

    httpRequestsTotal.inc({
      method: req.method,
      route
    });

    if (res.statusCode >= 400) {
      httpErrorsTotal.inc({
        method: req.method,
        route,
        status_code: String(res.statusCode)
      });
      logError(
        `Request failed: ${req.method} ${req.originalUrl} -> ${res.statusCode}`,
        req.correlationId
      );
    }
  });

  next();
});

app.get('/metrics', asyncHandler(async (req, res) => {
  serviceUptimeSeconds.set(process.uptime());
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}));

// Health check endpoint
app.get('/health', (req, res) => {
  logInfo('Health endpoint hit', req.correlationId);
  res.json({ status: 'ok', service: SERVICE_NAME });
});

// GET /tasks (protected)
app.get('/tasks', authenticate, (req, res) => {
  const filter = req.query.filter || 'visible';
  if (!ALLOWED_FILTERS.has(filter)) {
    return sendBadRequest(res, 'Invalid filter value');
  }

  const currentUser = requireCurrentUserId(req, res);
  if (!currentUser) {
    return;
  }

  const filteredTasks = tasks.filter((task) => {
    const isOwner = task.createdBy === currentUser;
    const isPublic = task.visibility === 'public';

    if (filter === 'mine') return isOwner;
    if (filter === 'public') return isPublic;
    return isOwner || isPublic;
  });

  const publicTasks = filteredTasks.map(({ id, title, description, status, visibility, createdBy }) => ({
    id,
    title,
    description,
    status,
    visibility,
    createdBy
  }));
  res.json(publicTasks);
});

// POST /tasks (protected)
app.post('/tasks', authenticate, asyncHandler(async (req, res) => {
  const { title, description, status, visibility } = req.body || {};

  if (!title) {
    return sendBadRequest(res, 'title is required');
  }

  const normalizedStatus = String(status || 'pending').trim().toLowerCase();
  if (!ALLOWED_STATUS.has(normalizedStatus)) {
    return sendBadRequest(res, 'status must be pending or completed');
  }

  const normalizedVisibility = String(visibility || 'private').trim().toLowerCase();
  if (!ALLOWED_VISIBILITY.has(normalizedVisibility)) {
    return sendBadRequest(res, 'visibility must be private or public');
  }

  const currentUser = requireCurrentUserId(req, res);
  if (!currentUser) {
    return;
  }

  const task = {
    id: nextTaskId++,
    title,
    description: description || '',
    status: normalizedStatus,
    visibility: normalizedVisibility,
    // Optional: store who created the task so we can show it later.
    createdBy: currentUser
  };

  tasks.push(task);
  logInfo(`Task created: id=${task.id}, title=${task.title}`, req.correlationId);

  // Prepare the event that will be sent to RabbitMQ.
  const eventPayload = {
    type: 'task_created',
    correlationId: req.correlationId,
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      visibility: task.visibility,
      createdBy: task.createdBy
    }
  };

  // Try to publish the event, but do not fail the request if RabbitMQ is down.
  try {
    const channel = await getRabbitChannel();
    channel.publish(
      TASK_EXCHANGE,
      '',
      Buffer.from(JSON.stringify(eventPayload)),
      { correlationId: req.correlationId }
    );
    logInfo(
      `Published task_created event to RabbitMQ for task id=${task.id}`,
      req.correlationId
    );
  } catch (err) {
    logError(`Failed to publish task_created event: ${err.message}`, req.correlationId);
  }

  res.status(201).json({
    message: 'Task created successfully',
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      visibility: task.visibility,
      createdBy: task.createdBy
    }
  });
}));

// PATCH /tasks/:id (protected)
app.patch('/tasks/:id', authenticate, asyncHandler(async (req, res) => {
  const taskId = Number(req.params.id);
  const { status } = req.body || {};

  if (!Number.isInteger(taskId)) {
    return sendBadRequest(res, 'Invalid task id');
  }

  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (normalizedStatus !== 'pending' && normalizedStatus !== 'completed') {
    return sendBadRequest(res, 'status must be pending or completed');
  }

  const task = tasks.find((item) => item.id === taskId);
  if (!task) {
    return sendNotFound(res, 'Task not found');
  }

  const currentUser = requireCurrentUserId(req, res);
  if (!currentUser) {
    return;
  }

  if (task.createdBy !== currentUser) {
    return sendForbidden(res, 'You can only update your own tasks');
  }

  task.status = normalizedStatus;
  logInfo(`Task status updated: id=${task.id}, status=${task.status}`, req.correlationId);

  return res.json({
    message: 'Task status updated successfully',
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      visibility: task.visibility,
      createdBy: task.createdBy
    }
  });
}));

// DELETE /tasks/:id (protected)
app.delete('/tasks/:id', authenticate, asyncHandler(async (req, res) => {
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId)) {
    return sendBadRequest(res, 'Invalid task id');
  }

  const taskIndex = tasks.findIndex((item) => item.id === taskId);
  if (taskIndex === -1) {
    return sendNotFound(res, 'Task not found');
  }

  const currentUser = requireCurrentUserId(req, res);
  if (!currentUser) {
    return;
  }

  if (tasks[taskIndex].createdBy !== currentUser) {
    return sendForbidden(res, 'You can only delete your own tasks');
  }

  const deletedTask = tasks.splice(taskIndex, 1)[0];
  logInfo(`Task deleted: id=${deletedTask.id}`, req.correlationId);
  return res.json({ message: 'Task deleted successfully' });
}));

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const correlationId = req && req.correlationId ? req.correlationId : 'unknown';
  logError(`Unhandled error: ${err.message}`, correlationId);
  return res.status(500).json({ message: 'Internal Server Error' });
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logError(`Unhandled promise rejection: ${message}`);
});

process.on('uncaughtException', (err) => {
  logError(`Uncaught exception: ${err.message}`);
});

if (require.main === module) {
  app.listen(PORT, () => {
    logInfo(`Task Service listening on port ${PORT}`);
  });
}

module.exports = { app };

