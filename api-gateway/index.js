require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT;
if (!PORT) {
  throw new Error('PORT is required (set process.env.PORT)');
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

// Very small auth middleware for task routes.
// It only checks that a Bearer token exists and then
// lets the Task Service do the real JWT validation.
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ message: 'Unauthorized' });
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
        Authorization: req.headers['authorization']
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

    console.error('Error forwarding request from API Gateway (auth):', err.message);
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
        Authorization: req.headers['authorization']
      },
      timeout: 5000
    });

    return res.status(response.status).json(response.data);
  } catch (err) {
    if (err.response) {
      return res.status(err.response.status).json(err.response.data);
    }

    console.error('Error forwarding request from API Gateway (tasks):', err.message);
    return res.status(502).json({ message: 'Upstream service error' });
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'api-gateway' });
});

// Forward all /auth/* routes to the Auth Service.
app.all('/auth/*', async (req, res) => {
  await forwardToAuth(req, res);
});

// Forward /tasks routes to the Task Service, but require a token first.
app.all('/tasks', authenticate, async (req, res) => {
  await forwardToTasks(req, res);
});

// Also handle any sub-paths under /tasks (if needed later).
app.all('/tasks/*', authenticate, async (req, res) => {
  await forwardToTasks(req, res);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`API Gateway listening on port ${PORT}`);
  });
}

module.exports = { app };

