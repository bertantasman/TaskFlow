require('dotenv').config();
const express = require('express');
const axios = require('axios');
const client = require('prom-client');
const { randomUUID } = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT;
if (!PORT) {
  throw new Error('PORT is required (set process.env.PORT)');
}
const SERVICE_NAME = 'api-gateway';
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

// These URLs point to the other services inside Docker.
// For local testing you can override them using environment variables.
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL;
if (!AUTH_SERVICE_URL) {
  throw new Error('AUTH_SERVICE_URL is required (set process.env.AUTH_SERVICE_URL)');
}
const TASK_SERVICE_URL = process.env.TASK_SERVICE_URL;
if (!TASK_SERVICE_URL) {
  throw new Error('TASK_SERVICE_URL is required (set process.env.TASK_SERVICE_URL)');
}

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-correlation-id');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});
function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const generalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many requests, please try again later.'
  }
});

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many authentication attempts, please try again later.'
  }
});

app.use(generalRateLimiter);
app.use('/auth/login', authRateLimiter);
app.use('/auth/register', authRateLimiter);

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'api_gateway_http_requests_total',
  help: 'Total HTTP requests received by api-gateway',
  labelNames: ['method', 'route'],
  registers: [register]
});

const httpErrorsTotal = new client.Counter({
  name: 'api_gateway_http_errors_total',
  help: 'Total HTTP error responses from api-gateway',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

const serviceUptimeSeconds = new client.Gauge({
  name: 'api_gateway_uptime_seconds',
  help: 'Uptime in seconds for api-gateway',
  registers: [register]
});

serviceUptimeSeconds.set(process.uptime());
setInterval(() => {
  serviceUptimeSeconds.set(process.uptime());
}, 5000).unref();

app.use((req, res, next) => {
  const incomingCorrelationId = req.headers['x-correlation-id'];
  const correlationId = typeof incomingCorrelationId === 'string' && incomingCorrelationId
    ? incomingCorrelationId
    : randomUUID();

  req.correlationId = correlationId;
  req.headers['x-correlation-id'] = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  logInfo(`Request received: ${req.method} ${req.originalUrl}`, correlationId);

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

// Very small auth middleware for task routes.
// It only checks that a Bearer token exists and then
// lets the Task Service do the real JWT validation.
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return res.status(401).json({ message: 'Authorization token is required' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ message: 'Invalid authorization header format' });
  }

  next();
}

// Forward a request to the Auth Service.
// Example: /auth/register -> http://auth-service:4001/register
async function forwardToAuth(req, res) {
  try {
    const path = req.path.replace(/^\/auth/, '') || '/';
    const url = AUTH_SERVICE_URL + path;

    const response = await axios({
      method: req.method,
      url,
      params: req.query,
      data: req.body,
      // Forward a few important headers.
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        Authorization: req.headers['authorization'],
        'x-correlation-id': req.correlationId
      },
      // Small timeout so requests fail fast in demos.
      timeout: 5000
    });

    return res.status(response.status).json(response.data);
  } catch (err) {
    // If the downstream service responded with an error, pass it through.
    if (err.response) {
      return res.status(err.response.status).json(err.response.data);
    }

    logError(`Error forwarding request from API Gateway (auth): ${err.message}`, req.correlationId);
    return res.status(502).json({ message: 'Upstream service error' });
  }
}

// Forward a request to the Task Service.
// We keep the /tasks path so it matches the Task Service routes.
async function forwardToTasks(req, res) {
  try {
    const url = TASK_SERVICE_URL + req.path;

    const response = await axios({
      method: req.method,
      url,
      params: req.query,
      data: req.body,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        Authorization: req.headers['authorization'],
        'x-correlation-id': req.correlationId
      },
      timeout: 5000
    });

    return res.status(response.status).json(response.data);
  } catch (err) {
    if (err.response) {
      return res.status(err.response.status).json(err.response.data);
    }

    logError(`Error forwarding request from API Gateway (tasks): ${err.message}`, req.correlationId);
    return res.status(502).json({ message: 'Upstream service error' });
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  logInfo('Health endpoint hit', req.correlationId);
  res.json({ status: 'ok', service: SERVICE_NAME });
});

// Forward all /auth/* routes to the Auth Service.
app.all('/auth/*', asyncHandler(async (req, res) => {
  await forwardToAuth(req, res);
}));

// Forward /tasks routes to the Task Service, but require a token first.
app.all('/tasks', authenticate, asyncHandler(async (req, res) => {
  await forwardToTasks(req, res);
}));

// Also handle any sub-paths under /tasks (if needed later).
app.all('/tasks/*', authenticate, asyncHandler(async (req, res) => {
  await forwardToTasks(req, res);
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
    logInfo(`API Gateway listening on port ${PORT}`);
  });
}

module.exports = { app };

