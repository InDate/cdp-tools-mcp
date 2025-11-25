# Simple Node.js app for testing Docker runner
FROM node:20-alpine

WORKDIR /app

# Create a simple HTTP server inline
RUN echo 'const http = require("http"); \
const server = http.createServer((req, res) => { \
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`); \
  res.writeHead(200, {"Content-Type": "application/json"}); \
  res.end(JSON.stringify({ message: "Hello from Docker!", timestamp: new Date().toISOString() })); \
}); \
server.listen(3000, () => console.log("Server running on port 3000"));' > server.js

EXPOSE 3000

CMD ["node", "server.js"]
