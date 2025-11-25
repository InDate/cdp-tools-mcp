# Docker Runner Examples

This directory contains examples for testing the Docker and Docker Compose runners.

## Files

- `Dockerfile` - Simple Node.js HTTP server for testing Docker runner
- `docker-compose.yml` - Compose file for testing Docker Compose runner
- `Dockerfile.env-test` - Test image for environment variable passing

## Usage

### Docker Runner

```bash
# Build the image
docker build -t cdp-tools-example .

# Start via cdp-tools (auto-detected as docker runner)
server({
  action: "start",
  id: "my-docker-app",
  command: "docker run -p 3001:3000 cdp-tools-example",
  cwd: "/path/to/examples/docker"
})

# With environment variables
server({
  action: "start",
  id: "my-docker-app",
  command: "docker run -p 3001:3000 cdp-tools-env-test",
  cwd: "/path/to/examples/docker",
  env: { MY_VAR: "hello", ANOTHER_VAR: "world" }
})
```

### Docker Compose Runner

```bash
# Start via cdp-tools (auto-detected as docker-compose runner)
server({
  action: "start",
  id: "my-compose-stack",
  command: "docker compose up",
  cwd: "/path/to/examples/docker"
})
```

## Security

Server IDs are validated to prevent command injection:
- Only alphanumeric, dash, underscore allowed
- Maximum 64 characters
- Cannot start with dash

Examples of invalid IDs:
- `my-app; rm -rf /` - Contains semicolon
- `app/name` - Contains slash
- `app name` - Contains space

## Features Tested

✅ Auto-detection of runner type from command
✅ Port detection from container inspection
✅ Environment variable passing
✅ Logs via `docker logs` / `docker compose logs`
✅ Container lifecycle (start, stop, restart)
✅ Security validation of server IDs
✅ Sanitization of container/project names

## Limitations

### Docker Logs Type Filter
Docker CLI's `logs` command returns stdout and stderr interleaved in chronological order. There's no way to separate them without using the Docker API directly. The `type` parameter for logs is ignored for Docker runners.

### Docker Compose Logs
Similarly, `docker compose logs` returns logs from all services interleaved. The `type` filter doesn't work for compose either.

## Testing Environment Variables

Build and run the env test:
```bash
docker build -f Dockerfile.env-test -t cdp-tools-env-test .

server({
  action: "start",
  id: "env-test",
  command: "docker run -p 3002:3000 cdp-tools-env-test",
  cwd: "/path/to/examples/docker",
  env: { MY_VAR: "test-value", ANOTHER_VAR: "another-value" }
})

# Check the response
curl http://localhost:3002
# {"MY_VAR":"test-value","ANOTHER_VAR":"another-value"}
```
