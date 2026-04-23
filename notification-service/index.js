require('dotenv').config();
const express = require('express');
const amqp = require('amqplib');
const client = require('prom-client');

const app = express();
const PORT = process.env.PORT;
if (!PORT) {
  throw new Error('PORT is required (set process.env.PORT)');
}
const SERVICE_NAME = 'notification-service';
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

// In Docker we pass RABBITMQ_URL=amqp://rabbitmq:5672.
const RABBITMQ_URL = process.env.RABBITMQ_URL;
if (!RABBITMQ_URL) {
  throw new Error('RABBITMQ_URL is required (set process.env.RABBITMQ_URL)');
}
const TASK_EXCHANGE = 'task_events';

// Keep trying to connect to RabbitMQ until it is ready.
// This helps when RabbitMQ starts slower than this service.
async function connectWithRetry(attempt = 1) {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();

    // Make sure we use the same exchange as the Task Service.
    await channel.assertExchange(TASK_EXCHANGE, 'fanout', { durable: false });

    // Create a temporary, exclusive queue just for this service instance.
    const { queue } = await channel.assertQueue('', { exclusive: true });
    await channel.bindQueue(queue, TASK_EXCHANGE, '');

    logInfo(`Connected to RabbitMQ on attempt ${attempt}`);
    logInfo('Notification Service waiting for task_created events');

    channel.consume(
      queue,
      (msg) => {
        if (!msg) return;

        try {
          const content = msg.content.toString();
          const payload = JSON.parse(content);
          const messageCorrelationId = (payload && payload.correlationId)
            || (msg.properties && msg.properties.correlationId)
            || 'unknown';

          // We could check payload.type === 'task_created' here.
          logInfo('Notification received: new task created', messageCorrelationId);

          if (payload && payload.task) {
            logInfo(
              `Task details received: id=${payload.task.id}, title=${payload.task.title}`,
              messageCorrelationId
            );
          }
        } catch (err) {
          logError(`Failed to handle notification message: ${err.message}`);
        }
      },
      { noAck: true }
    );
  } catch (err) {
    // If RabbitMQ is not ready yet, log and try again after 3 seconds.
    logError(`RabbitMQ connection retry attempt ${attempt} failed: ${err.message}`);
    setTimeout(() => {
      connectWithRetry(attempt + 1);
    }, 3000);
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
  name: 'notification_service_http_requests_total',
  help: 'Total HTTP requests received by notification-service',
  labelNames: ['method', 'route'],
  registers: [register]
});

const httpErrorsTotal = new client.Counter({
  name: 'notification_service_http_errors_total',
  help: 'Total HTTP error responses from notification-service',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

const serviceUptimeSeconds = new client.Gauge({
  name: 'notification_service_uptime_seconds',
  help: 'Uptime in seconds for notification-service',
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
    logInfo(`Notification Service listening on port ${PORT}`);

    // Start listening for task_created events after the HTTP server is up.
    connectWithRetry();
  });
}

module.exports = { app };

