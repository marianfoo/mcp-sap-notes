// Simple wrapper to start the HTTP MCP server
// This bypasses the isDirectRun check in the compiled code

import { HttpSapNoteMcpServer } from './dist/http-mcp-server.js';

const server = new HttpSapNoteMcpServer();

// Handle process termination gracefully
process.on('SIGINT', () => server.shutdown());
process.on('SIGTERM', () => server.shutdown());

// Start the server
server.start().catch((error) => {
  console.error('Failed to start HTTP server:', error);
  process.exit(1);
});


