jest.mock('amqplib', () => {
  return {
    connect: jest.fn(async () => {
      return {
        createChannel: jest.fn(async () => {
          return {
            assertExchange: jest.fn(async () => {}),
            publish: jest.fn()
          };
        })
      };
    })
  };
});

const request = require('supertest');
const { startServer } = require('./testUtils');

describe('Task API (via API Gateway)', () => {
  let gatewayApp;
  let authServer;
  let taskServer;

  beforeAll(async () => {
    jest.resetModules();

    process.env.JWT_SECRET = 'testsecret';
    process.env.RABBITMQ_URL = 'amqp://test';
    process.env.PORT = '0';

    // Start Auth Service
    const { app: authApp } = require('../auth-service/index.js');
    const startedAuth = await startServer(authApp);
    authServer = startedAuth.server;

    // Start Task Service (RabbitMQ publish is mocked)
    const { app: taskApp } = require('../task-service/index.js');
    const startedTask = await startServer(taskApp);
    taskServer = startedTask.server;

    // Configure API Gateway to forward to the running services
    process.env.AUTH_SERVICE_URL = `http://localhost:${startedAuth.port}`;
    process.env.TASK_SERVICE_URL = `http://localhost:${startedTask.port}`;
    process.env.PORT = '0';

    const { app: apiGatewayApp } = require('../api-gateway/index.js');
    gatewayApp = apiGatewayApp;
  });

  afterAll(async () => {
    if (authServer) {
      await new Promise((resolve) => authServer.close(resolve));
    }
    if (taskServer) {
      await new Promise((resolve) => taskServer.close(resolve));
    }
  });

  test('GET /tasks without Authorization returns 401', async () => {
    const res = await request(gatewayApp).get('/tasks');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized' });
  });

  test('Authorized request can create and list tasks', async () => {
    // Register
    await request(gatewayApp)
      .post('/auth/register')
      .send({ username: 'user1', password: 'pass1' });

    // Login -> get JWT
    const loginRes = await request(gatewayApp)
      .post('/auth/login')
      .send({ username: 'user1', password: 'pass1' });

    const token = loginRes.body.token;
    expect(token).toBeTruthy();

    // Create task
    const createRes = await request(gatewayApp)
      .post('/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Finish assignment' });

    expect(createRes.status).toBe(201);
    expect(createRes.body.message).toBe('Task created successfully');
    expect(createRes.body.task.title).toBe('Finish assignment');

    // List tasks
    const listRes = await request(gatewayApp)
      .get('/tasks')
      .set('Authorization', `Bearer ${token}`);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    const titles = listRes.body.map((t) => t.title);
    expect(titles).toContain('Finish assignment');
  });
});

