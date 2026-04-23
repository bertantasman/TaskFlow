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
  let user1Token;
  let user2Token;
  let user1PrivateTaskId;
  let user1PublicTaskId;
  let user2PrivateTaskId;
  let user2PublicTaskId;

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
    expect(res.body).toEqual({ message: 'Authorization token is required' });
  });

  test('Create two users and task visibility fixtures', async () => {
    // Register user1
    await request(gatewayApp)
      .post('/auth/register')
      .send({ email: 'user1@example.com', password: 'pass1' });

    // Register user2
    await request(gatewayApp)
      .post('/auth/register')
      .send({ email: 'user2@example.com', password: 'pass2' });

    // Login user1
    const loginResUser1 = await request(gatewayApp)
      .post('/auth/login')
      .send({ email: 'user1@example.com', password: 'pass1' });

    user1Token = loginResUser1.body.token;
    expect(user1Token).toBeTruthy();

    // Login user2
    const loginResUser2 = await request(gatewayApp)
      .post('/auth/login')
      .send({ email: 'user2@example.com', password: 'pass2' });

    user2Token = loginResUser2.body.token;
    expect(user2Token).toBeTruthy();

    // user1 private
    const user1PrivateRes = await request(gatewayApp)
      .post('/tasks')
      .set('Authorization', `Bearer ${user1Token}`)
      .send({
        title: 'User1 Private Task',
        description: 'Private task owned by user1',
        visibility: 'private'
      });

    expect(user1PrivateRes.status).toBe(201);
    user1PrivateTaskId = user1PrivateRes.body.task.id;

    // user1 public
    const user1PublicRes = await request(gatewayApp)
      .post('/tasks')
      .set('Authorization', `Bearer ${user1Token}`)
      .send({
        title: 'User1 Public Task',
        description: 'Public task owned by user1',
        visibility: 'public'
      });

    expect(user1PublicRes.status).toBe(201);
    user1PublicTaskId = user1PublicRes.body.task.id;

    // user2 private
    const user2PrivateRes = await request(gatewayApp)
      .post('/tasks')
      .set('Authorization', `Bearer ${user2Token}`)
      .send({
        title: 'User2 Private Task',
        description: 'Private task owned by user2',
        visibility: 'private'
      });

    expect(user2PrivateRes.status).toBe(201);
    user2PrivateTaskId = user2PrivateRes.body.task.id;

    // user2 public
    const user2PublicRes = await request(gatewayApp)
      .post('/tasks')
      .set('Authorization', `Bearer ${user2Token}`)
      .send({
        title: 'User2 Public Task',
        description: 'Public task owned by user2',
        visibility: 'public'
      });

    expect(user2PublicRes.status).toBe(201);
    user2PublicTaskId = user2PublicRes.body.task.id;
  });

  test('GET /tasks?filter=mine returns only current user tasks', async () => {
    const res = await request(gatewayApp)
      .get('/tasks?filter=mine')
      .set('Authorization', `Bearer ${user1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.every((task) => task.createdBy === 'user1@example.com')).toBe(true);
    const titles = res.body.map((task) => task.title);
    expect(titles).toContain('User1 Private Task');
    expect(titles).toContain('User1 Public Task');
    expect(titles).not.toContain('User2 Private Task');
  });

  test('GET /tasks?filter=public returns only public tasks', async () => {
    const res = await request(gatewayApp)
      .get('/tasks?filter=public')
      .set('Authorization', `Bearer ${user1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.every((task) => task.visibility === 'public')).toBe(true);
    const titles = res.body.map((task) => task.title);
    expect(titles).toContain('User1 Public Task');
    expect(titles).toContain('User2 Public Task');
    expect(titles).not.toContain('User2 Private Task');
  });

  test('GET /tasks?filter=visible returns own tasks + others public tasks', async () => {
    const res = await request(gatewayApp)
      .get('/tasks?filter=visible')
      .set('Authorization', `Bearer ${user1Token}`);

    expect(res.status).toBe(200);
    const titles = res.body.map((task) => task.title);
    expect(titles).toContain('User1 Private Task');
    expect(titles).toContain('User1 Public Task');
    expect(titles).toContain('User2 Public Task');
    expect(titles).not.toContain('User2 Private Task');
  });

  test('GET /tasks without filter behaves like filter=visible and does not leak private tasks', async () => {
    const res = await request(gatewayApp)
      .get('/tasks')
      .set('Authorization', `Bearer ${user1Token}`);

    expect(res.status).toBe(200);
    const titles = res.body.map((task) => task.title);
    expect(titles).toContain('User1 Private Task');
    expect(titles).toContain('User1 Public Task');
    expect(titles).toContain('User2 Public Task');
    expect(titles).not.toContain('User2 Private Task');
  });

  test('POST /tasks normalizes status and visibility values', async () => {
    const createRes = await request(gatewayApp)
      .post('/tasks')
      .set('Authorization', `Bearer ${user1Token}`)
      .send({
        title: 'Normalization Task',
        description: 'Normalize status and visibility',
        status: ' Completed ',
        visibility: ' Public '
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.task.status).toBe('completed');
    expect(createRes.body.task.visibility).toBe('public');

    const listRes = await request(gatewayApp)
      .get('/tasks?filter=mine')
      .set('Authorization', `Bearer ${user1Token}`);

    expect(listRes.status).toBe(200);
    const normalizedTask = listRes.body.find((task) => task.id === createRes.body.task.id);
    expect(normalizedTask).toBeTruthy();
    expect(normalizedTask.status).toBe('completed');
    expect(normalizedTask.visibility).toBe('public');
  });

  test('Owner can patch own task and non-owner gets 403', async () => {
    const ownerUpdateRes = await request(gatewayApp)
      .patch(`/tasks/${user1PrivateTaskId}`)
      .set('Authorization', `Bearer ${user1Token}`)
      .send({ status: 'completed' });

    expect(ownerUpdateRes.status).toBe(200);
    expect(ownerUpdateRes.body.task.status).toBe('completed');

    const nonOwnerUpdateRes = await request(gatewayApp)
      .patch(`/tasks/${user1PrivateTaskId}`)
      .set('Authorization', `Bearer ${user2Token}`)
      .send({ status: 'pending' });

    expect(nonOwnerUpdateRes.status).toBe(403);
    expect(nonOwnerUpdateRes.body).toEqual({ message: 'You can only update your own tasks' });
  });

  test('Owner can delete own task and non-owner gets 403', async () => {
    const nonOwnerDeleteRes = await request(gatewayApp)
      .delete(`/tasks/${user2PrivateTaskId}`)
      .set('Authorization', `Bearer ${user1Token}`);

    expect(nonOwnerDeleteRes.status).toBe(403);
    expect(nonOwnerDeleteRes.body).toEqual({ message: 'You can only delete your own tasks' });

    const ownerDeleteRes = await request(gatewayApp)
      .delete(`/tasks/${user2PrivateTaskId}`)
      .set('Authorization', `Bearer ${user2Token}`);

    expect(ownerDeleteRes.status).toBe(200);
    expect(ownerDeleteRes.body).toEqual({ message: 'Task deleted successfully' });

    const checkDeletedRes = await request(gatewayApp)
      .get('/tasks?filter=mine')
      .set('Authorization', `Bearer ${user2Token}`);

    const ids = checkDeletedRes.body.map((task) => task.id);
    expect(ids).not.toContain(user2PrivateTaskId);
    expect(ids).toContain(user2PublicTaskId);
  });
});

