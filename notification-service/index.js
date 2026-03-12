require('dotenv').config();
const express = require('express');
const amqp = require('amqplib');

const app = express();
const PORT = process.env.PORT || 4003;

// In Docker we pass RABBITMQ_URL=amqp://rabbitmq:5672.
// Here we also provide a localhost default for simple local testing.
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const TASK_EXCHANGE = 'task_events';

// Keep trying to connect to RabbitMQ until it is ready.
// This helps when RabbitMQ starts slower than this service.
async function connectWithRetry() {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();

    // Make sure we use the same exchange as the Task Service.
    await channel.assertExchange(TASK_EXCHANGE, 'fanout', { durable: false });

    // Create a temporary, exclusive queue just for this service instance.
    const { queue } = await channel.assertQueue('', { exclusive: true });
    await channel.bindQueue(queue, TASK_EXCHANGE, '');

    console.log('Connected to RabbitMQ');
    console.log('Notification Service waiting for task_created events...');

    channel.consume(
      queue,
      (msg) => {
        if (!msg) return;

        try {
          const content = msg.content.toString();
          const payload = JSON.parse(content);

          // We could check payload.type === 'task_created' here.
          console.log('Notification received: new task created');

          if (payload && payload.task) {
            console.log(
              `Task details -> id: ${payload.task.id}, title: ${payload.task.title}`
            );
          }
        } catch (err) {
          console.error('Failed to handle notification message:', err.message);
        }
      },
      { noAck: true }
    );
  } catch (err) {
    // If RabbitMQ is not ready yet, log and try again after 3 seconds.
    console.error('RabbitMQ not ready, retrying...', err.message);
    setTimeout(connectWithRetry, 3000);
  }
}

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'notification-service' });
});

app.listen(PORT, () => {
  console.log(`Notification Service listening on port ${PORT}`);

  // Start listening for task_created events after the HTTP server is up.
  connectWithRetry();
});

