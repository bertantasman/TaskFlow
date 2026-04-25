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
  let selectedTaskId;
  let datedTaskId;

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
    expect(normalizedTask.createdAt).toBeTruthy();
    expect(normalizedTask.progressStatus).toBeTruthy();
  });

  test('GET /users returns safe user list without passwords', async () => {
    const res = await request(gatewayApp)
      .get('/users')
      .set('Authorization', `Bearer ${user1Token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((user) => user.email === 'user1@example.com')).toBe(true);
    expect(res.body.every((user) => !Object.prototype.hasOwnProperty.call(user, 'passwordHash'))).toBe(true);
  });

  test('selected visibility task is only visible to allowed users', async () => {
    const createRes = await request(gatewayApp)
      .post('/tasks')
      .set('Authorization', `Bearer ${user1Token}`)
      .send({
        title: 'Selected Shared Task',
        description: 'Only selected users can view this',
        visibility: 'selected',
        allowedUsers: ['user2@example.com']
      });

    expect(createRes.status).toBe(201);
    selectedTaskId = createRes.body.task.id;

    const visibleForAllowed = await request(gatewayApp)
      .get('/tasks?filter=visible')
      .set('Authorization', `Bearer ${user2Token}`);

    expect(visibleForAllowed.status).toBe(200);
    expect(visibleForAllowed.body.map((task) => task.id)).toContain(selectedTaskId);

    const user3Register = await request(gatewayApp)
      .post('/auth/register')
      .send({ email: 'user3@example.com', password: 'pass3' });
    expect([201, 400]).toContain(user3Register.status);

    const user3Login = await request(gatewayApp)
      .post('/auth/login')
      .send({ email: 'user3@example.com', password: 'pass3' });
    expect(user3Login.status).toBe(200);

    const hiddenForOthers = await request(gatewayApp)
      .get('/tasks?filter=visible')
      .set('Authorization', `Bearer ${user3Login.body.token}`);
    expect(hiddenForOthers.status).toBe(200);
    expect(hiddenForOthers.body.map((task) => task.id)).not.toContain(selectedTaskId);
  });

  test('date filter returns tasks in requested range and validates format', async () => {
    const createRes = await request(gatewayApp)
      .post('/tasks')
      .set('Authorization', `Bearer ${user1Token}`)
      .send({
        title: 'Date Filter Task',
        description: 'Task with createdAt for date filtering',
        visibility: 'public'
      });
    expect(createRes.status).toBe(201);
    datedTaskId = createRes.body.task.id;

    const today = new Date().toISOString().slice(0, 10);
    const inRangeRes = await request(gatewayApp)
      .get(`/tasks?filter=visible&from=${today}&to=${today}`)
      .set('Authorization', `Bearer ${user1Token}`);
    expect(inRangeRes.status).toBe(200);
    expect(inRangeRes.body.map((task) => task.id)).toContain(datedTaskId);

    const invalidRes = await request(gatewayApp)
      .get('/tasks?filter=visible&from=2026-13-99')
      .set('Authorization', `Bearer ${user1Token}`);
    expect(invalidRes.status).toBe(400);
  });

  test('Creator can cancel own public task with reason', async () => {
    const ownerCancelRes = await request(gatewayApp)
      .patch(`/tasks/${user1PublicTaskId}/cancel`)
      .set('Authorization', `Bearer ${user1Token}`)
      .send({ reason: 'No longer needed' });
    expect(ownerCancelRes.status).toBe(200);
    expect(ownerCancelRes.body.task.status).toBe('cancelled');
    expect(ownerCancelRes.body.task.cancelledReason).toBe('No longer needed');

    const missingReasonRes = await request(gatewayApp)
      .patch(`/tasks/${selectedTaskId}/cancel`)
      .set('Authorization', `Bearer ${user1Token}`)
      .send({ reason: '   ' });
    expect(missingReasonRes.status).toBe(400);

  });

  test('selected collaborator can update progressStatus', async () => {
    const ownerProgressRes = await request(gatewayApp)
      .patch(`/tasks/${selectedTaskId}`)
      .set('Authorization', `Bearer ${user2Token}`)
      .send({ progressStatus: 'in_progress' });
    expect(ownerProgressRes.status).toBe(200);
    expect(ownerProgressRes.body.task.progressStatus).toBe('in_progress');
  });

  test('public viewer cannot update public task unless selected', async () => {
    const user3Login = await request(gatewayApp)
      .post('/auth/login')
      .send({ email: 'user3@example.com', password: 'pass3' });
    expect(user3Login.status).toBe(200);

    const publicViewerUpdateRes = await request(gatewayApp)
      .patch(`/tasks/${user1PublicTaskId}`)
      .set('Authorization', `Bearer ${user3Login.body.token}`)
      .send({ progressStatus: 'completed' });
    expect(publicViewerUpdateRes.status).toBe(403);
  });

  test('selected collaborator can cancel selected task with reason', async () => {
    const collaboratorCancelRes = await request(gatewayApp)
      .patch(`/tasks/${selectedTaskId}/cancel`)
      .set('Authorization', `Bearer ${user2Token}`)
      .send({ reason: 'Completed externally' });
    expect(collaboratorCancelRes.status).toBe(200);
    expect(collaboratorCancelRes.body.task.status).toBe('cancelled');
    expect(collaboratorCancelRes.body.task.cancelledReason).toBe('Completed externally');
  });

  test('selected collaborator can patch status on selected task', async () => {
    const recreateRes = await request(gatewayApp)
      .post('/tasks')
      .set('Authorization', `Bearer ${user1Token}`)
      .send({
        title: 'Selected Status Task',
        description: 'For collaborator status patch',
        visibility: 'selected',
        allowedUsers: ['user2@example.com']
      });
    expect(recreateRes.status).toBe(201);
    const selectedStatusTaskId = recreateRes.body.task.id;

    const collaboratorUpdateRes = await request(gatewayApp)
      .patch(`/tasks/${selectedStatusTaskId}`)
      .set('Authorization', `Bearer ${user2Token}`)
      .send({ status: 'completed' });

    expect(collaboratorUpdateRes.status).toBe(200);
    expect(collaboratorUpdateRes.body.task.status).toBe('completed');
  });

  test('private task remains creator-only for modifications', async () => {
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
    expect(nonOwnerUpdateRes.body).toEqual({ message: 'You do not have permission to update this task' });
  });

  test('non-creator cannot change sharing settings via patch', async () => {
    const sharingPatchRes = await request(gatewayApp)
      .patch(`/tasks/${selectedTaskId}`)
      .set('Authorization', `Bearer ${user2Token}`)
      .send({ visibility: 'public' });

    expect(sharingPatchRes.status).toBe(403);
    expect(sharingPatchRes.body).toEqual({ message: 'Only creator can change sharing settings or ownership' });
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

