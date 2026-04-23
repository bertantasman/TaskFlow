# Security Report

## Overview

This report summarizes the main security improvements implemented in the TaskFlow microservice system.  
The goal is to keep the project simple and beginner-friendly while improving practical security for authentication, authorization, and service protection.

## 1) Secure Authentication

Authentication is handled by the **Auth Service** with two endpoints:

- `POST /register`
- `POST /login`

Users must provide `username` and `password`.  
If credentials are missing or invalid, the system returns clear JSON error messages.  
Authentication logic is separated from business logic (task management), which improves maintainability and security boundaries.

## 2) Password Hashing

Passwords are no longer stored in plain text.

Implemented improvement:

- `bcrypt` is used in the Auth Service to hash passwords during registration.
- A salt-based hash is stored (`passwordHash`) instead of the original password.
- During login, plaintext password input is verified using `bcrypt.compare(...)`.

Security benefit:

- If in-memory user data is exposed, original passwords are not directly visible.
- This follows standard password storage best practices.

## 3) JWT Authentication and Token Expiration

After successful login, the Auth Service generates a JWT token.

Implemented behavior:

- JWT is signed using `JWT_SECRET` from environment variables.
- Token expiration is enabled (`expiresIn: '1h'`).
- Task Service verifies JWT before allowing access to protected task routes.

Security benefit:

- Tokens are time-limited, reducing the risk window if a token is leaked.
- Services can validate user identity without storing sessions.

## 4) Rate Limiting

Rate limiting is implemented in the **API Gateway** using `express-rate-limit`.

Two levels are applied:

- **General limiter** for all routes (protects system from excessive traffic)
- **Stricter limiter** for authentication routes:
  - `/auth/login`
  - `/auth/register`

When a limit is exceeded, the API returns clear JSON responses such as:

```json
{
  "message": "Too many authentication attempts, please try again later."
}
```

Security benefit:

- Reduces brute-force login attempts.
- Helps protect against simple abuse and request flooding.

## 5) Secrets Management Using Environment Variables

Sensitive and environment-specific values are managed through environment variables, not hardcoded in source code.

Managed values include:

- `JWT_SECRET`
- `AUTH_SERVICE_URL`
- `TASK_SERVICE_URL`
- `RABBITMQ_URL`
- service `PORT` values

Project improvements:

- `.env.example` is provided as a template.
- Hardcoded fallback secrets were removed from Docker Compose.
- Developers can define actual secrets in `.env` (ignored by git).

Security benefit:

- Prevents accidental secret exposure in source control.
- Makes configuration safer and easier across local/dev/test environments.

## 6) Protected Routes and Unauthorized Access Handling

Task-related routes are protected by authentication middleware in Gateway and Task Service.

Implemented responses:

- Missing token -> `401 Unauthorized` with JSON message
- Invalid `Authorization` header format -> `401 Unauthorized`
- Expired JWT -> `403 Forbidden`
- Invalid JWT -> `403 Forbidden`

Example JSON response:

```json
{
  "message": "Token expired"
}
```

Security benefit:

- Unauthorized requests are blocked consistently.
- Clients receive clear, predictable API error responses.

## Conclusion

The system now includes a stronger baseline security model for a university-level microservice project:

- safer credential handling with bcrypt
- JWT-based authentication with expiration
- route protection and clear unauthorized access handling
- API Gateway rate limiting
- environment-based secret management

These improvements increase security without adding unnecessary complexity.
