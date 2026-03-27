const request = require('supertest');
const { startServer } = require('./testUtils');

describe('Auth API (via API Gateway)', () => {
  let gatewayApp;
  let authServer;

  beforeAll(async () => {
    jest.resetModules();

    process.env.JWT_SECRET = 'testsecret';
    process.env.PORT = '0';

    // Start Auth Service on a random local port
    const { app: authApp } = require('../auth-service/index.js');
    const startedAuth = await startServer(authApp);
    authServer = startedAuth.server;

    const authPort = startedAuth.port;

    // Configure API Gateway to forward to the running Auth Service
    process.env.AUTH_SERVICE_URL = `http://localhost:${authPort}`;
    process.env.TASK_SERVICE_URL = 'http://localhost:9999';
    process.env.PORT = '0';

    const { app: apiGatewayApp } = require('../api-gateway/index.js');
    gatewayApp = apiGatewayApp;
  });

  afterAll(async () => {
    if (authServer) {
      await new Promise((resolve) => authServer.close(resolve));
    }
  });

  test('POST /auth/register returns 201', async () => {
    const res = await request(gatewayApp)
      .post('/auth/register')
      .send({ username: 'testuser', password: '123456' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ message: 'User registered successfully' });
  });

  test('POST /auth/login returns a JWT token', async () => {
    // Log in using the same credentials as register
    const res = await request(gatewayApp)
      .post('/auth/login')
      .send({ username: 'testuser', password: '123456' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(typeof res.body.token).toBe('string');
  });
});

