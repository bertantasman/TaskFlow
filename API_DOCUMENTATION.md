API Documentation - TaskFlow
============================

All requests are sent to the API Gateway at `http://localhost:4000`.

For protected routes, include:

```http
Authorization: Bearer <jwt_token_here>
```

## Auth Endpoints

### `POST /auth/register`
Register user.

Request body:

```json
{
  "email": "user@example.com",
  "password": "123456"
}
```

### `POST /auth/login`
Login and receive JWT.

Request body:

```json
{
  "email": "user@example.com",
  "password": "123456"
}
```

Success response:

```json
{
  "token": "jwt_token_here"
}
```

### `GET /users` (protected)
Return safe user list for sharing UI.

Success response:

```json
[
  {
    "email": "user1@example.com",
    "role": "user"
  }
]
```

Passwords and password hashes are never returned.

## Task Model

Task objects include:

```json
{
  "id": 1,
  "title": "Prepare report",
  "description": "Write weekly summary",
  "status": "pending",
  "visibility": "selected",
  "createdBy": "user1@example.com",
  "createdAt": "2026-04-25T09:15:00.000Z",
  "allowedUsers": ["user2@example.com"],
  "cancelledReason": null,
  "cancelledAt": null,
  "cancelledBy": null,
  "progressStatus": "in_progress",
  "progressPercent": 50
}
```

## Task Endpoints (all protected)

### `GET /tasks`
List tasks user is allowed to see.

Query params:
- `filter=mine|public|visible` (default `visible`)
- `from=YYYY-MM-DD` (optional)
- `to=YYYY-MM-DD` (optional)

Access rules:
- creator always sees own tasks
- `public` tasks visible to all users
- `private` tasks visible only to creator
- `selected` tasks visible to creator and `allowedUsers`

### `POST /tasks`
Create task.

Request body:

```json
{
  "title": "Prepare report",
  "description": "Write weekly summary",
  "status": "pending",
  "visibility": "selected",
  "allowedUsers": ["user2@example.com"],
  "progressStatus": "not_started"
}
```

Notes:
- `createdBy` is always derived from JWT user, not request body.
- If `visibility` is `selected`, `allowedUsers` must be provided.

### `PATCH /tasks/:id`
Update task status and/or progress status.

Permissions:
- creator: allowed
- selected collaborator (`allowedUsers` on selected task): allowed
- other users: forbidden (`403`)
- changing sharing fields (`visibility`, `allowedUsers`) or `createdBy` via this endpoint is forbidden for non-creators

Request body examples:

```json
{
  "status": "completed"
}
```

```json
{
  "progressStatus": "in_progress"
}
```

### `PATCH /tasks/:id/cancel`
Cancel task with reason.

Permissions:
- creator: allowed
- selected collaborator (`allowedUsers` on selected task): allowed
- other users: forbidden (`403`)

Request body:

```json
{
  "reason": "Blocked by dependency"
}
```

On success:
- `status` becomes `cancelled`
- `cancelledReason`, `cancelledAt`, `cancelledBy` are set

### `DELETE /tasks/:id`
Delete task (creator only).

Selected collaborators cannot delete shared tasks.

## Status Codes and Error Shape

Common response shape:

```json
{
  "message": "..."
}
```

- `400` invalid request/body/query values
- `401` missing/invalid auth header
- `403` authenticated but forbidden action (non-owner operations)
- `404` task not found

