require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const client = require('prom-client');

const app = express();
const PORT = process.env.PORT;
if (!PORT) {
  throw new Error('PORT is required (set process.env.PORT)');
}
const SERVICE_NAME = 'auth-service';
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

// In a real application this secret must come from
// a secure environment variable and NEVER be hard-coded.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required (set process.env.JWT_SECRET)');
}

// Very simple in-memory user storage.
// This is reset every time the service restarts and
// is only suitable for demos or university projects.
const users = [];
const SALT_ROUNDS = 10;

app.use(express.json());
function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'auth_service_http_requests_total',
  help: 'Total HTTP requests received by auth-service',
  labelNames: ['method', 'route'],
  registers: [register]
});

const httpErrorsTotal = new client.Counter({
  name: 'auth_service_http_errors_total',
  help: 'Total HTTP error responses from auth-service',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

const serviceUptimeSeconds = new client.Gauge({
  name: 'auth_service_uptime_seconds',
  help: 'Uptime in seconds for auth-service',
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

// POST /register
// Expected body: { "username": "testuser", "password": "123456" }
app.post('/register', asyncHandler(async (req, res) => {
  const { email, username, password } = req.body || {};
  const identifier = email || username;

  // Basic validation: both fields are required
  if (!identifier || !password) {
    return res.status(400).json({
      message: 'email and password are required'
    });
  }

  // Check if the user already exists in our in-memory array
  const existingUser = users.find((user) => user.email === identifier);
  if (existingUser) {
    return res.status(400).json({
      message: 'User already exists'
    });
  }

  // Hash the password before storing it.
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  users.push({ email: identifier, passwordHash, role: 'user' });
  logInfo(`User registered: ${identifier}`, req.correlationId);

  // Response shape matches PROJECT.md
  return res.status(201).json({
    message: 'User registered successfully'
  });
}));

// POST /login
// Expected body: { "username": "testuser", "password": "123456" }
app.post('/login', asyncHandler(async (req, res) => {
  const { email, username, password } = req.body || {};
  const identifier = email || username;

  if (!identifier || !password) {
    return res.status(400).json({
      message: 'email and password are required'
    });
  }

  const user = users.find((u) => u.email === identifier);

  // Keep a generic message for all invalid credentials cases.
  if (!user) {
    return res.status(401).json({
      message: 'Invalid username or password'
    });
  }

  const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
  if (!isPasswordValid) {
    return res.status(401).json({
      message: 'Invalid username or password'
    });
  }

  // Payload can contain any data we want to use later.
  // Here we keep it very small and beginner-friendly.
  const payload = {
    username: user.email,
    email: user.email,
    role: user.role
  };

  // Generate a JWT token that expires in 1 hour.
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
  logInfo(`User logged in: ${identifier}`, req.correlationId);

  // Response shape matches PROJECT.md
  return res.json({
    token
  });
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
    logInfo(`Auth Service listening on port ${PORT}`);
  });
}

module.exports = { app };

