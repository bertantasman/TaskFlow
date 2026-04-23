# Reliability Report

## 1) Logging Strategy

All services use structured JSON logging to improve readability, filtering, and machine processing.

Each log entry includes:

- `service`: service identifier (for example, `api-gateway`, `task-service`)
- `level`: severity (`info` or `error`)
- `message`: human-readable event description
- `correlationId`: request/event trace identifier
- `timestamp`: ISO-8601 timestamp

Logging behavior:

- Every HTTP request is logged at receipt time.
- Failed HTTP responses (`status >= 400`) are logged as errors.
- Domain actions are logged, such as:
  - user registration/login in `auth-service`
  - task creation and event publish in `task-service`
  - event consumption in `notification-service`
- Infrastructure events are logged, including RabbitMQ connection attempts and retries.

This strategy enables consistent diagnostics across services and supports search/aggregation in centralized log platforms.

## 2) Metrics Monitoring (Prometheus)

Prometheus metrics are exposed by each service via `GET /metrics` in Prometheus format.

Instrumentation includes:

- Request counter: `*_http_requests_total`
  - increments for every HTTP response
  - labels: `method`, `route`
- Error counter: `*_http_errors_total`
  - increments when HTTP status code is `>= 400`
  - labels: `method`, `route`, `status_code`
- Uptime gauge: `*_uptime_seconds`
  - periodically updated from process uptime

Prometheus scrape targets are configured for:

- `api-gateway:4000/metrics`
- `auth-service:4001/metrics`
- `task-service:4002/metrics`
- `notification-service:4003/metrics`

This provides baseline service-level observability for traffic, failures, and runtime availability.

## 3) Dashboard (Grafana)

Grafana is integrated in Docker Compose and provisioned automatically with:

- a Prometheus datasource
- a dashboard provider
- a preloaded dashboard (`TaskFlow Service Metrics`)

The dashboard includes:

- **Total Requests** panel (sum of all `*_http_requests_total`)
- **Total Errors** panel (sum of all `*_http_errors_total`)
- **Uptime Per Service** time series:
  - `api_gateway_uptime_seconds`
  - `auth_service_uptime_seconds`
  - `task_service_uptime_seconds`
  - `notification_service_uptime_seconds`

This gives immediate visibility into throughput, error volume, and service health trends.

## 4) Distributed Tracing (Correlation IDs)

A simple distributed tracing model is implemented using correlation IDs.

Flow:

1. `api-gateway` generates a correlation ID per incoming request (or reuses existing `x-correlation-id`).
2. The ID is attached to:
   - request context
   - outgoing HTTP headers (`x-correlation-id`) to downstream services
   - response header back to clients
3. Downstream services (`auth-service`, `task-service`, `notification-service`) read and propagate the ID in logs.
4. `task-service` includes correlation ID in RabbitMQ event payload and AMQP properties.
5. `notification-service` reads correlation ID from event payload/properties and logs it during event handling.

Result:

One identifier can trace a transaction across HTTP boundaries and asynchronous messaging boundaries.

## 5) Health Checks

Each service exposes a health endpoint:

- `GET /health`

Response format:

```json
{
  "status": "ok",
  "service": "<service-name>"
}
```

Behavior:

- Returns `200 OK` when the service process is running and able to handle requests.
- Logs health endpoint access as part of operational observability.

These endpoints are suitable for container orchestration probes, uptime checks, and quick diagnostics.

## 6) Failure Handling Strategies

The platform uses multiple resilience mechanisms to reduce service disruption and improve failure visibility.

### RabbitMQ connection resilience

- `task-service` and `notification-service` retry RabbitMQ connection attempts indefinitely.
- Retry logs include attempt counters (for example, `attempt 3 failed`).
- Services continue running during broker unavailability instead of terminating.

### Safe error responses

- Services include centralized Express error middleware.
- Unexpected errors return a consistent payload:

```json
{
  "message": "Internal Server Error"
}
```

- This prevents leaking internal details while keeping API behavior predictable.

### Critical operation protection

- Critical async handlers are wrapped so rejected promises are routed to error middleware.
- Targeted `try/catch` blocks remain in critical integration points (for example, gateway forwarding and RabbitMQ publish).

### Process-level guards

- `unhandledRejection` and `uncaughtException` handlers log unexpected failures.
- This increases visibility of runtime faults and reduces silent process failures.

## Summary

The system now includes a reliability baseline composed of structured logs, service metrics, dashboard visualization, correlation-based tracing, health checks, and fault-tolerant handling of external dependency failures. Together, these mechanisms improve observability, incident response speed, and operational stability for the microservice environment.
