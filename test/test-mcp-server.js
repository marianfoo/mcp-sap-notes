import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🧪 Testing MCP Server Communication...\n');

const serverProcess = spawn('node', [join(__dirname, '..', 'dist/mcp-server.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, HEADFUL: 'true', LOG_LEVEL: 'debug' }
});

// Handle server logs (stderr)
serverProcess.stderr.on('data', (data) => {
  console.log('📋 Server Log:', data.toString().trim());
});

// Handle server responses (stdout)
let responseBuffer = '';
serverProcess.stdout.on('data', (data) => {
  responseBuffer += data.toString();
  
  // Try to parse complete JSON-RPC messages
  const lines = responseBuffer.split('\n');
  responseBuffer = lines.pop() || ''; // Keep incomplete line in buffer
  
  for (const line of lines) {
    if (line.trim()) {
      try {
        const response = JSON.parse(line.trim());
        console.log('📤 Server Response:', JSON.stringify(response, null, 2));
      } catch (e) {
        console.log('📋 Server Output:', line.trim());
      }
    }
  }
});

function sendMessage(message) {
  const messageStr = JSON.stringify(message);
  console.log('📥 Sending:', JSON.stringify(message, null, 2));
  serverProcess.stdin.write(messageStr + '\n');
}

// Test sequence
setTimeout(() => {
  console.log('🔧 Step 1: Initialize MCP server...');
  sendMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
      },
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    }
  });
}, 1000);

setTimeout(() => {
  console.log('\n🔧 Step 2: Send initialized notification...');
  sendMessage({
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  });
}, 2000);

setTimeout(() => {
  console.log('\n🔧 Step 3: List available tools...');
  sendMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list'
  });
}, 3000);

setTimeout(() => {
  console.log('\n🔧 Step 4: Test SAP Note search with known note ID (this will trigger authentication)...');
  sendMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'sap_note_search',
      arguments: {
        q: '2744792'
      }
    }
  });
}, 4000);

setTimeout(() => {
  console.log('\n🔧 Step 5: Test SAP Note get details...');
  sendMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'sap_note_get',
      arguments: {
        id: '2744792'
      }
    }
  });
}, 8000);

// Cleanup after test
setTimeout(() => {
  console.log('\n✅ Test completed. Shutting down server...');
  serverProcess.kill('SIGTERM');
  setTimeout(() => {
    process.exit(0);
  }, 2000);
}, 12000);

// Handle process cleanup
process.on('SIGINT', () => {
  console.log('\n🛑 Stopping test...');
  serverProcess.kill('SIGTERM');
  process.exit(0);
});

serverProcess.on('close', (code) => {
  console.log(`\n📋 Server process exited with code ${code}`);
  process.exit(0);
}); 