require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const amqp = require('amqplib');

const app = express();
const PORT = process.env.PORT;
if (!PORT) {
  throw new Error('PORT is required (set process.env.PORT)');
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

async function getRabbitChannel() {
  if (rabbitChannel) {
    return rabbitChannel;
  }

  // Keep trying to connect to RabbitMQ until it is ready.
  // This avoids failures when RabbitMQ starts slower than this service.
  while (!rabbitChannel) {
    try {
      // Minimal, beginner-friendly setup for RabbitMQ.
      const connection = await amqp.connect(RABBITMQ_URL);
      const channel = await connection.createChannel();

      // fanout means: broadcast messages to all queues bound to this exchange.
      await channel.assertExchange(TASK_EXCHANGE, 'fanout', { durable: false });

      rabbitChannel = channel;
      console.log('Connected to RabbitMQ');
    } catch (err) {
      console.error('RabbitMQ not ready, retrying...', err.message);

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
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const token = parts[1];

  try {
    // This will throw if the token is invalid or expired.
    const decoded = jwt.verify(token, JWT_SECRET);

    // Make the decoded user data available to the route handlers.
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
}

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'task-service' });
});

// GET /tasks (protected)
app.get('/tasks', authenticate, (req, res) => {
  // We only return id and title to keep the example simple.
  const publicTasks = tasks.map(({ id, title }) => ({ id, title }));
  res.json(publicTasks);
});

// POST /tasks (protected)
app.post('/tasks', authenticate, async (req, res) => {
  const { title } = req.body || {};

  if (!title) {
    return res.status(400).json({
      message: 'title is required'
    });
  }

  const task = {
    id: nextTaskId++,
    title,
    // Optional: store who created the task so we can show it later.
    createdBy: req.user && req.user.username ? req.user.username : 'unknown'
  };

  tasks.push(task);

  // Prepare the event that will be sent to RabbitMQ.
  const eventPayload = {
    type: 'task_created',
    task: {
      id: task.id,
      title: task.title,
      createdBy: task.createdBy
    }
  };

  // Try to publish the event, but do not fail the request if RabbitMQ is down.
  try {
    const channel = await getRabbitChannel();
    channel.publish(
      TASK_EXCHANGE,
      '',
      Buffer.from(JSON.stringify(eventPayload))
    );
    console.log('Published task_created event to RabbitMQ:', eventPayload);
  } catch (err) {
    console.error('Failed to publish task_created event:', err.message);
  }

  res.status(201).json({
    message: 'Task created successfully',
    task: {
      id: task.id,
      title: task.title
    }
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Task Service listening on port ${PORT}`);
  });
}

module.exports = { app };

