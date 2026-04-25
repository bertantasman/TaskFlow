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
const ALLOWED_VISIBILITY = new Set(['private', 'public', 'selected']);
const ALLOWED_STATUS = new Set(['pending', 'completed', 'cancelled']);
const ALLOWED_PROGRESS_STATUS = new Set(['not_started', 'in_progress', 'completed']);

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

function getCurrentUserIdentifiers(req) {
  const rawEmail = typeof req.user?.email === 'string' ? req.user.email.trim().toLowerCase() : '';
  const rawUsername = typeof req.user?.username === 'string' ? req.user.username.trim().toLowerCase() : '';
  const rawId = typeof req.user?.id === 'string' || typeof req.user?.id === 'number'
    ? String(req.user.id).trim().toLowerCase()
    : '';

  const identifiers = new Set([rawEmail, rawUsername, rawId].filter(Boolean));
  return {
    primary: rawEmail || rawUsername || rawId || '',
    all: identifiers
  };
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

function normalizeDateInput(value) {
  if (!value) {
    return null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function getDateRangeFromQuery(query) {
  const fromRaw = normalizeDateInput(query.from);
  const toRaw = normalizeDateInput(query.to);

  if (query.from && !fromRaw) {
    return { error: 'from must be in YYYY-MM-DD format' };
  }

  if (query.to && !toRaw) {
    return { error: 'to must be in YYYY-MM-DD format' };
  }

  const fromDate = fromRaw ? new Date(`${fromRaw}T00:00:00.000Z`) : null;
  const toDate = toRaw ? new Date(`${toRaw}T23:59:59.999Z`) : null;

  if (fromDate && Number.isNaN(fromDate.getTime())) {
    return { error: 'from must be a valid date' };
  }

  if (toDate && Number.isNaN(toDate.getTime())) {
    return { error: 'to must be a valid date' };
  }

  if (fromDate && toDate && fromDate > toDate) {
    return { error: 'from date cannot be after to date' };
  }

  return { fromDate, toDate };
}

function normalizeAllowedUsers(allowedUsers, currentUser) {
  if (!Array.isArray(allowedUsers)) {
    return [];
  }

  const normalized = allowedUsers
    .map((user) => (typeof user === 'string' ? user.trim().toLowerCase() : ''))
    .filter((user) => Boolean(user) && user !== currentUser);

  return [...new Set(normalized)];
}

function toProgressPercent(progressStatus) {
  if (progressStatus === 'completed') {
    return 100;
  }
  if (progressStatus === 'in_progress') {
    return 50;
  }
  return 0;
}

function taskToPublicShape(task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    visibility: task.visibility,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    allowedUsers: task.allowedUsers,
    cancelledReason: task.cancelledReason,
    cancelledAt: task.cancelledAt,
    cancelledBy: task.cancelledBy,
    progressStatus: task.progressStatus,
    progressPercent: toProgressPercent(task.progressStatus)
  };
}

function normalizeIdentityValue(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim().toLowerCase();
  }
  return '';
}

function isCreator(user, task) {
  const createdBy = normalizeIdentityValue(task.createdBy);
  if (!createdBy) {
    return false;
  }
  return user.all.has(createdBy);
}

function isAllowedUser(user, task) {
  if (!Array.isArray(task.allowedUsers)) {
    return false;
  }
  const normalizedAllowedUsers = new Set(task.allowedUsers.map(normalizeIdentityValue).filter(Boolean));
  for (const identifier of user.all) {
    if (normalizedAllowedUsers.has(identifier)) {
      return true;
    }
  }
  return false;
}

function canViewTask(user, task) {
  if (isCreator(user, task)) {
    return true;
  }
  if (task.visibility === 'selected') {
    return isAllowedUser(user, task);
  }
  return task.visibility === 'public';
}

function canCollaborateOnTask(user, task) {
  if (isCreator(user, task)) {
    return true;
  }
  return task.visibility === 'selected' && isAllowedUser(user, task);
}

function canDeleteTask(user, task) {
  return isCreator(user, task);
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

  const dateRange = getDateRangeFromQuery(req.query);
  if (dateRange.error) {
    return sendBadRequest(res, dateRange.error);
  }

  const currentUser = requireCurrentUserId(req, res);
  if (!currentUser) {
    return;
  }

  const filteredTasks = tasks.filter((task) => {
    const currentUserInfo = getCurrentUserIdentifiers(req);
    const isOwner = isCreator(currentUserInfo, task);
    const isPublic = task.visibility === 'public';
    const isSelectedForUser = task.visibility === 'selected' && isAllowedUser(currentUserInfo, task);

    let canSeeByFilter = false;
    if (filter === 'mine') canSeeByFilter = isOwner;
    if (filter === 'public') canSeeByFilter = isPublic;
    if (filter === 'visible') canSeeByFilter = isOwner || isPublic || isSelectedForUser;
    if (!canSeeByFilter) return false;

    if (!canViewTask(currentUserInfo, task)) {
      return false;
    }

    const createdAtDate = new Date(task.createdAt);
    if (dateRange.fromDate && createdAtDate < dateRange.fromDate) {
      return false;
    }
    if (dateRange.toDate && createdAtDate > dateRange.toDate) {
      return false;
    }

    return true;
  });

  const publicTasks = filteredTasks.map(taskToPublicShape);
  res.json(publicTasks);
});

// POST /tasks (protected)
app.post('/tasks', authenticate, asyncHandler(async (req, res) => {
  const { title, description, status, visibility, allowedUsers, progressStatus } = req.body || {};

  if (!title) {
    return sendBadRequest(res, 'title is required');
  }

  const normalizedStatus = String(status || 'pending').trim().toLowerCase();
  if (!ALLOWED_STATUS.has(normalizedStatus)) {
    return sendBadRequest(res, 'status must be pending, completed or cancelled');
  }

  const normalizedVisibility = String(visibility || 'private').trim().toLowerCase();
  if (!ALLOWED_VISIBILITY.has(normalizedVisibility)) {
    return sendBadRequest(res, 'visibility must be private, public or selected');
  }

  const normalizedProgressStatus = String(progressStatus || 'not_started').trim().toLowerCase();
  if (!ALLOWED_PROGRESS_STATUS.has(normalizedProgressStatus)) {
    return sendBadRequest(res, 'progressStatus must be not_started, in_progress or completed');
  }

  const currentUser = requireCurrentUserId(req, res);
  if (!currentUser) {
    return;
  }

  const normalizedAllowedUsers = normalizeAllowedUsers(allowedUsers, currentUser);
  if (normalizedVisibility === 'selected' && normalizedAllowedUsers.length === 0) {
    return sendBadRequest(res, 'allowedUsers is required when visibility is selected');
  }

  const now = new Date().toISOString();
  const taskStatus = normalizedStatus === 'cancelled'
    ? 'cancelled'
    : normalizedProgressStatus === 'completed'
      ? 'completed'
      : normalizedStatus;

  const task = {
    id: nextTaskId++,
    title,
    description: description || '',
    status: taskStatus,
    visibility: normalizedVisibility,
    createdBy: currentUser,
    createdAt: now,
    allowedUsers: normalizedVisibility === 'selected' ? normalizedAllowedUsers : [],
    cancelledReason: normalizedStatus === 'cancelled' ? 'Cancelled during creation' : null,
    cancelledAt: normalizedStatus === 'cancelled' ? now : null,
    cancelledBy: normalizedStatus === 'cancelled' ? currentUser : null,
    progressStatus: normalizedStatus === 'cancelled' ? 'not_started' : normalizedProgressStatus
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
      createdBy: task.createdBy,
      createdAt: task.createdAt,
      allowedUsers: task.allowedUsers,
      cancelledReason: task.cancelledReason,
      cancelledAt: task.cancelledAt,
      cancelledBy: task.cancelledBy,
      progressStatus: task.progressStatus
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
    task: taskToPublicShape(task)
  });
}));

// PATCH /tasks/:id (protected)
app.patch('/tasks/:id', authenticate, asyncHandler(async (req, res) => {
  const taskId = Number(req.params.id);
  const { status, progressStatus } = req.body || {};

  if (!Number.isInteger(taskId)) {
    return sendBadRequest(res, 'Invalid task id');
  }

  const hasStatus = Object.prototype.hasOwnProperty.call(req.body || {}, 'status');
  const hasProgressStatus = Object.prototype.hasOwnProperty.call(req.body || {}, 'progressStatus');
  const hasVisibility = Object.prototype.hasOwnProperty.call(req.body || {}, 'visibility');
  const hasAllowedUsers = Object.prototype.hasOwnProperty.call(req.body || {}, 'allowedUsers');
  const hasCreatedBy = Object.prototype.hasOwnProperty.call(req.body || {}, 'createdBy');
  if (hasVisibility || hasAllowedUsers || hasCreatedBy) {
    return sendForbidden(res, 'Only creator can change sharing settings or ownership');
  }
  if (!hasStatus && !hasProgressStatus) {
    return sendBadRequest(res, 'status or progressStatus is required');
  }

  const normalizedStatus = hasStatus ? String(status || '').trim().toLowerCase() : null;
  if (hasStatus && !ALLOWED_STATUS.has(normalizedStatus)) {
    return sendBadRequest(res, 'status must be pending, completed or cancelled');
  }

  const normalizedProgressStatus = hasProgressStatus
    ? String(progressStatus || '').trim().toLowerCase()
    : null;
  if (hasProgressStatus && !ALLOWED_PROGRESS_STATUS.has(normalizedProgressStatus)) {
    return sendBadRequest(res, 'progressStatus must be not_started, in_progress or completed');
  }

  const task = tasks.find((item) => item.id === taskId);
  if (!task) {
    return sendNotFound(res, 'Task not found');
  }

  const currentUser = requireCurrentUserId(req, res);
  if (!currentUser) {
    return;
  }

  const currentUserInfo = getCurrentUserIdentifiers(req);
  logInfo(
    `Permission check PATCH /tasks/${taskId}: user=${currentUserInfo.primary}, allowedUsers=${JSON.stringify(task.allowedUsers)}, canCollaborate=${canCollaborateOnTask(currentUserInfo, task)}`,
    req.correlationId
  );
  if (!canCollaborateOnTask(currentUserInfo, task)) {
    return sendForbidden(res, 'You do not have permission to update this task');
  }

  if (hasStatus) {
    task.status = normalizedStatus;
    if (normalizedStatus === 'cancelled') {
      task.cancelledReason = task.cancelledReason || 'Cancelled';
      task.cancelledAt = task.cancelledAt || new Date().toISOString();
      task.cancelledBy = currentUserInfo.primary;
    } else if (task.status !== 'cancelled') {
      task.cancelledReason = null;
      task.cancelledAt = null;
      task.cancelledBy = null;
    }
  }

  if (hasProgressStatus) {
    task.progressStatus = normalizedProgressStatus;
    if (normalizedProgressStatus === 'completed') {
      task.status = 'completed';
    }
    if (normalizedProgressStatus === 'not_started' && task.status === 'completed') {
      task.status = 'pending';
    }
  }

  logInfo(`Task status updated: id=${task.id}, status=${task.status}`, req.correlationId);

  return res.json({
    message: 'Task status updated successfully',
    task: taskToPublicShape(task)
  });
}));

app.patch('/tasks/:id/cancel', authenticate, asyncHandler(async (req, res) => {
  const taskId = Number(req.params.id);
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

  if (!Number.isInteger(taskId)) {
    return sendBadRequest(res, 'Invalid task id');
  }

  if (!reason) {
    return sendBadRequest(res, 'Cancellation reason is required');
  }

  const task = tasks.find((item) => item.id === taskId);
  if (!task) {
    return sendNotFound(res, 'Task not found');
  }

  const currentUser = requireCurrentUserId(req, res);
  if (!currentUser) {
    return;
  }
  const currentUserInfo = getCurrentUserIdentifiers(req);

  logInfo(
    `Permission check PATCH /tasks/${taskId}/cancel: user=${currentUserInfo.primary}, allowedUsers=${JSON.stringify(task.allowedUsers)}, canCollaborate=${canCollaborateOnTask(currentUserInfo, task)}`,
    req.correlationId
  );
  if (!canCollaborateOnTask(currentUserInfo, task)) {
    return sendForbidden(res, 'You do not have permission to cancel this task');
  }

  task.status = 'cancelled';
  task.cancelledReason = reason;
  task.cancelledAt = new Date().toISOString();
  task.cancelledBy = currentUserInfo.primary;
  task.progressStatus = 'not_started';

  logInfo(`Task cancelled: id=${task.id}`, req.correlationId);
  return res.json({
    message: 'Task cancelled successfully',
    task: taskToPublicShape(task)
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
  const currentUserInfo = getCurrentUserIdentifiers(req);

  if (!canDeleteTask(currentUserInfo, tasks[taskIndex])) {
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

