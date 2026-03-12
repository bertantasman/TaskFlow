API Documentation - TaskFlow
============================

This document describes the main HTTP API endpoints of TaskFlow.
All requests are sent to the **API Gateway** at `http://localhost:4000`.

Authentication uses JSON Web Tokens (JWT). Protected endpoints require
an `Authorization` header in the form:

```http
Authorization: Bearer <jwt_token_here>
```

## Auth Service (via API Gateway)

Base path (through gateway): `http://localhost:4000/auth`

### 1. Register a new user

- **Method**: `POST`
- **URL**: `/auth/register`
- **Description**: Create a new user in the in-memory user store.

**Request body**

```json
{
  "username": "testuser",
  "password": "123456"
}
```

**Successful response (201)**

```json
{
  "message": "User registered successfully"
}
```

If the username already exists, a `400` response is returned:

```json
{
  "message": "User already exists"
}
```

### 2. Log in and obtain a JWT token

- **Method**: `POST`
- **URL**: `/auth/login`
- **Description**: Log in with username and password and receive a JWT token.

**Request body**

```json
{
  "username": "testuser",
  "password": "123456"
}
```

**Successful response (200)**

```json
{
  "token": "jwt_token_here"
}
```

If the credentials are invalid, a `401` response is returned:

```json
{
  "message": "Invalid username or password"
}
```

You will use the returned `token` value in the `Authorization` header
for all protected Task Service endpoints.

## Task Service (via API Gateway)

Base path (through gateway): `http://localhost:4000`

All Task Service endpoints are **protected** and require a valid JWT token.

### Authentication header example

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Replace the long string after `Bearer` with the actual token returned by `/auth/login`.

### 1. List tasks

- **Method**: `GET`
- **URL**: `/tasks`
- **Description**: Return the list of tasks for the system.
- **Authentication**: required (`Authorization: Bearer <token>`)

**Example request**

```http
GET /tasks HTTP/1.1
Host: localhost:4000
Authorization: Bearer <jwt_token_here>
```

**Example successful response (200)**

```json
[
  {
    "id": 1,
    "title": "Finish assignment"
  },
  {
    "id": 2,
    "title": "Review lecture notes"
  }
]
```

If the token is missing or invalid, a `401` response is returned:

```json
{
  "message": "Unauthorized"
}
```

### 2. Create a new task

- **Method**: `POST`
- **URL**: `/tasks`
- **Description**: Create a new task in the in-memory task store.
- **Authentication**: required (`Authorization: Bearer <token>`)

**Request body**

```json
{
  "title": "Finish assignment"
}
```

**Example successful response (201)**

```json
{
  "message": "Task created successfully",
  "task": {
    "id": 1,
    "title": "Finish assignment"
  }
}
```

If the `title` field is missing, a `400` response is returned:

```json
{
  "message": "title is required"
}
```

When a task is created, the Task Service also publishes a `task_created`
event to RabbitMQ. The Notification Service listens for this event and logs:

```text
Notification received: new task created
```

This demonstrates asynchronous, event-driven communication between services.

