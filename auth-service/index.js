require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT;
if (!PORT) {
  throw new Error('PORT is required (set process.env.PORT)');
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

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'auth-service' });
});

// POST /register
// Expected body: { "username": "testuser", "password": "123456" }
app.post('/register', (req, res) => {
  const { username, password } = req.body || {};

  // Basic validation: both fields are required
  if (!username || !password) {
    return res.status(400).json({
      message: 'username and password are required'
    });
  }

  // Check if the user already exists in our in-memory array
  const existingUser = users.find((user) => user.username === username);
  if (existingUser) {
    return res.status(400).json({
      message: 'User already exists'
    });
  }

  // NOTE: We store the password in plain text to keep the
  // example very simple. This is NOT safe for real-world use.
  users.push({ username, password, role: 'user' });

  // Response shape matches PROJECT.md
  return res.status(201).json({
    message: 'User registered successfully'
  });
});

// POST /login
// Expected body: { "username": "testuser", "password": "123456" }
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      message: 'username and password are required'
    });
  }

  const user = users.find((u) => u.username === username);

  // If user is not found or password does not match,
  // we return a generic error to keep it simple.
  if (!user || user.password !== password) {
    return res.status(401).json({
      message: 'Invalid username or password'
    });
  }

  // Payload can contain any data we want to use later.
  // Here we keep it very small and beginner-friendly.
  const payload = {
    username: user.username,
    role: user.role
  };

  // Generate a JWT token that expires in 1 hour.
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });

  // Response shape matches PROJECT.md
  return res.json({
    token
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Auth Service listening on port ${PORT}`);
  });
}

module.exports = { app };

