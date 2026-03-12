# TaskFlow - Project Context

## Project Name
TaskFlow

## Project Type
Distributed microservice-based backend system for a university assignment.

## Main Goal
TaskFlow is a simple distributed task management system created to demonstrate core distributed system concepts in practice.

The system must show:
- microservice architecture
- service-to-service communication
- API Gateway pattern
- basic authentication and authorization
- distributed system basics

## Assignment Requirements
Students must extend a microservice to work within a distributed system by doing the following:

1. Design two additional microservices
   - Example: Auth Service, Notification Service

2. Implement service-to-service communication using:
   - REST
   - or asynchronous messaging

3. Implement API Gateway pattern

4. Add basic authentication and authorization

## Concepts Covered
- Microservice architecture
- Service communication
- API gateway
- Authentication / Authorization
- Distributed system basics

## Suggested Technologies
- Node.js
- RabbitMQ
- Docker

## Required Deliverables
- Architecture diagram
- API documentation
- Working services
- README explaining communication design

---

# MVP Scope for Tomorrow

The goal is NOT to build a large production-ready platform.
The goal is to build a simple but working MVP that clearly demonstrates the assignment requirements.

## Services in MVP
The system must contain these services:

### 1. API Gateway
Responsibilities:
- single entry point for client requests
- route requests to correct services
- protect task-related routes

### 2. Auth Service
Responsibilities:
- register user
- login user
- generate JWT token

### 3. Task Service
Responsibilities:
- create task
- list tasks
- protect routes using JWT
- publish event when a task is created

### 4. Notification Service
Responsibilities:
- listen for task-created events
- log a notification message when event is received

### 5. RabbitMQ
Responsibilities:
- allow asynchronous communication between Task Service and Notification Service

---

# Communication Design

## Client to System
Client communicates only through API Gateway.

## API Gateway to Services
API Gateway communicates with:
- Auth Service via REST
- Task Service via REST

## Service-to-Service Communication
Task Service communicates with Notification Service using RabbitMQ asynchronous messaging.

When a task is created:
- Task Service publishes a `task_created` event
- Notification Service consumes the event
- Notification Service logs a message

---

# Authentication and Authorization

## Authentication
- Users can register
- Users can log in
- Login returns a JWT token

## Authorization
- Task endpoints are protected
- Only authenticated users can create and list tasks

## Roles
For now keep roles minimal:
- admin
- user

If role support is too much for the MVP, at minimum:
- implement authenticated vs unauthenticated access

---

# Technical Simplicity Rules

This project must stay simple and beginner-friendly.

## Important constraints
- use Node.js + Express
- use in-memory storage for users and tasks if needed
- do not over-engineer
- do not use advanced database setup for the MVP
- keep code readable
- include comments where useful
- prioritize working demo over complexity

---

# Proposed Ports

- API Gateway: 4000
- Auth Service: 4001
- Task Service: 4002
- Notification Service: 4003
- RabbitMQ: 5672
- RabbitMQ Management UI: 15672

---

# Folder Structure

TaskFlow/
- api-gateway/
- auth-service/
- task-service/
- notification-service/
- docker-compose.yml
- README.md

Each service should contain:
- package.json
- index.js
- Dockerfile

---

# API Requirements

## Auth Service
### POST /register
Request body:
```json
{
  "username": "testuser",
  "password": "123456"
}
Response:

{
  "message": "User registered successfully"
}
POST /login

Request body:

{
  "username": "testuser",
  "password": "123456"
}

Response:

{
  "token": "jwt_token_here"
}
Task Service
GET /tasks

Protected route.
Requires JWT token.

Response:

[
  {
    "id": 1,
    "title": "Finish assignment"
  }
]
POST /tasks

Protected route.
Requires JWT token.

Request body:

{
  "title": "Finish assignment"
}

Response:

{
  "message": "Task created successfully",
  "task": {
    "id": 1,
    "title": "Finish assignment"
  }
}