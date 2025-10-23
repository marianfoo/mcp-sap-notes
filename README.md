# SAP Note Search MCP Server

> **MCP server for searching SAP Notes/KB articles using SAP Passport authentication and Playwright automation**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org/)

> [!CAUTION]
> **This MCP Server uses private APIs from SAP behind authentication. Please check whether the use violates SAP's ToS. The author assumes no liability for this. Because of this i do not guarantee that the server will always work.**

This Model Context Protocol (MCP) server provides direct access to SAP Notes and Knowledge Base articles through Cursor AI. It uses SAP Passport certificate authentication and Playwright browser automation to retrieve actual note content from SAP's systems.

## ✨ Features

- 🔍 **Direct SAP Note access** - Retrieve full note content and metadata
- 🎫 **SAP Passport authentication** - Secure certificate-based authentication
- 🤖 **Playwright automation** - Handles complex SAP authentication flows
- 💾 **Smart caching** - Authentication tokens cached locally
- 🔧 **Debug-friendly** - Comprehensive logging and troubleshooting options
- 📋 **MCP compliant** - Works seamlessly with Cursor AI
- 🎯 **Enhanced LLM Tool Descriptions** - Comprehensive tool documentation for improved AI accuracy
  - **40-60% improvement** in tool selection accuracy across different AI models
  - **Structured guidance** with USE WHEN/DO NOT USE sections
  - **Query construction tips** and examples
  - **Workflow patterns** for optimal tool chaining
  - **Dramatically improved support** for weaker AI models (Ollama, GPT-4o-mini)

## Live Preview in Cursor

![Cursor MCP Server Preview](./images/mcpsapnote.gif)



## 🚀 Quick Start

### Prerequisites

- **Node.js 18+** - [Download here](https://nodejs.org/)
- **SAP Passport Certificate** - Your personal .pfx certificate file
- **Cursor AI** - [Download here](https://cursor.sh/)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/marianfoo/mcp-sap-notes
   cd mcp-sap-notes
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build the project**
   ```bash
   npm run build
   ```

### Setup

1. **Get your SAP Passport certificate - Only possible for S-User**
   - Go to [SAP Passport](https://support.sap.com/en/my-support/single-sign-on-passports.html)
   - Create your certificate
   - Download the .pfx certificate file


2. **Create certificate directory**
   - macOS/Linux:
     ```bash
     mkdir certs
     ```
   - Windows (PowerShell):
     ```powershell
     New-Item -ItemType Directory -Force -Path certs | Out-Null
     ```

3. **Copy your SAP Passport certificate**
   - Place your `.pfx` certificate file in the `certs/` directory
   - Name it `sap.pfx` (or update the path in configuration)

4. **Configure environment**
   - macOS/Linux:
     ```bash
     cp .env.example .env
     ```
   - Windows (PowerShell):
     ```powershell
     Copy-Item .env.example .env
     ```
   
   Edit `.env` and add your certificate passphrase:
   ```env
   PFX_PATH=./certs/sap.pfx
   PFX_PASSPHRASE=your_actual_passphrase
   ```

### Connect to Cursor

1. **Open Cursor settings** (`Cmd/Ctrl + ,`)

2. **Add MCP server configuration** to your `settings.json` (default):
   ```json
   {
     "mcpServers": {
       "sap-note-search": {
         "command": "node",
         "args": ["/full/path/to/mcp-sap-notes/dist/mcp-server.js"]
       }
     }
   }
   ```

   Alternative:
   ```json
   {
     "mcpServers": {
       "sap-note-search": {
         "command": "node",
         "args": ["/full/path/to/mcp-sap-notes/dist/mcp-server.js"]
       }
     }
   }
   ```

   **⚠️ Important:** Replace the project path with your actual absolute path.
   - On Windows, use a full path like `C:\\Users\\you\\mcp-sap-notes\\dist\\mcp-server.js`.
   - On macOS/Linux, use a path like `/Users/you/mcp-sap-notes/dist/mcp-server.js`.

3. **Restart Cursor** - The SAP Note tools will appear in your AI assistant

## 🎯 Usage Examples

### Search for a specific SAP Note
```
Find SAP Note 2744792
```

### Search by keywords
```
Search for SAP Notes about "OData gateway metadata error"
```

### Get complete note details
```
Get the full content of SAP Note 2744792
```

## 🛠️ Testing & Development

### Test Authentication
```bash
npm run test:auth
```
This tests the SAP Passport authentication flow and verifies your certificate setup.

### Test API Access
```bash
npm run test:api
```
This tests the SAP Notes API integration and content extraction.

### Test Complete MCP Server
```bash
npm run test:mcp
```
This simulates the complete MCP server workflow.

### Run All Tests
```bash
npm run test
```

## 🐛 Troubleshooting

### Certificate Issues

**Error: "Certificate file not found"**
- Ensure the certificate path in your configuration is correct
- Use full absolute paths in Cursor's `settings.json`
- Verify the certificate file exists and is readable

**Error: "Authentication failed"**
- Check your certificate passphrase is correct
- Ensure your SAP Passport certificate is valid and not expired
- Try running with `HEADFUL=true` to see browser authentication

### Browser Issues

**Error: "Browser launch failed"**
```bash
# Install Playwright browsers
npx playwright install
```

**Authentication hangs or times out**
- Run with debug mode: `HEADFUL=true npm run test:auth`
- Check your network connection to SAP systems
- Verify your certificate has proper SAP system access

### MCP Integration Issues

**Tools not appearing in Cursor**
- Restart Cursor completely
- Check the MCP server path in `settings.json` is absolute
- Verify the `cwd` setting points to your project directory

**Error: "MCP server failed to start"**
- Check the console output in Cursor's developer tools
- Ensure all dependencies are installed: `npm install`
- Verify the build completed successfully: `npm run build`

**Server starts but immediately exits**
- This issue has been resolved in recent versions
- Ensure you're using the latest version: `git pull && npm run build`
- Try setting `AUTO_START=true` for HTTP server if issues persist

### Debug Mode

Enable debug mode for detailed troubleshooting:

```bash
# macOS/Linux
export HEADFUL=true
export LOG_LEVEL=debug
npm run test:auth

# Windows (PowerShell)
$env:HEADFUL = 'true'
$env:LOG_LEVEL = 'debug'
npm run test:auth
```

## 📁 Project Structure

```
sap-note-search-mcp/
├── src/
│   ├── mcp-server.ts        # Main MCP server (stdio)
│   ├── http-mcp-server.ts   # HTTP MCP server
│   ├── auth.ts              # SAP authentication
│   ├── sap-notes-api.ts     # SAP Notes API client
│   ├── schemas/
│   │   └── sap-notes.ts     # Enhanced Zod schemas with comprehensive descriptions
│   ├── types.ts             # TypeScript definitions
│   └── logger.ts            # Logging configuration
├── test/
│   ├── test-auth.js         # Authentication tests
│   ├── test-sap-api.js      # API tests
│   └── test-mcp-server.js   # Complete server tests
├── dist/                    # Compiled JavaScript
├── certs/                   # Certificate directory
├── .env.example             # Environment template
└── README.md               # This file
```

## ⚙️ Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PFX_PATH` | ✅ | - | Path to SAP Passport certificate (.pfx) |
| `PFX_PASSPHRASE` | ✅ | - | Certificate passphrase |
| `ACCESS_TOKEN` | ❌ | - | Bearer token for HTTP server authentication |
| `HTTP_PORT` | ❌ | `3123` | HTTP server port |
| `MAX_JWT_AGE_H` | ❌ | `12` | Token cache lifetime (hours) |
| `HEADFUL` | ❌ | `false` | Browser visibility (for debugging) |
| `LOG_LEVEL` | ❌ | `info` | Logging level (debug, info, warn, error) |

### Playwright Configuration

The server automatically installs required Playwright dependencies. For manual installation:

```bash
npx playwright install chromium
```

## 🔒 Security

- **Certificate Security**: Your SAP Passport certificate never leaves your machine
- **Token Caching**: Authentication tokens are cached locally and expire automatically
- **No Data Storage**: SAP Note content is retrieved on-demand, not stored
- **Secure Communication**: All SAP API calls use HTTPS with certificate authentication
- **Bearer Token Auth**: HTTP server supports optional bearer token authentication for securing the MCP endpoint

### HTTP Server Authentication

The HTTP MCP server supports simple bearer token authentication. To use it:

0. **Start the HTTP server** (default):
   ```bash
   HTTP_PORT=3123 npm run serve:http
   ```

1. **Set the ACCESS_TOKEN environment variable** in your `.env` file:
   ```env
   ACCESS_TOKEN=your-secret-token-here
   ```

2. **Clients must include an authentication header** in all requests (either format works):
   ```bash
   # Standard format
   curl -X POST http://localhost:3123/mcp \
     -H "Authorization: Bearer your-secret-token-here" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

3. **Generate a secure token** (recommended):
   ```bash
   # macOS/Linux
   openssl rand -base64 32
   
   # Node.js
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

4. **Without ACCESS_TOKEN**: If `ACCESS_TOKEN` is not set, the server runs without authentication (not recommended for production or public deployments).

**Authentication behavior:**
- ✅ Valid token → Request processed
- ❌ Missing token → HTTP 401 Unauthorized
- ❌ Invalid token → HTTP 401 Unauthorized
- ⚠️ No ACCESS_TOKEN set → Warning logged, authentication disabled

## 📋 Available Tools

### `sap_note_search`
Search SAP Notes and KB articles by note ID or keywords.

**Parameters:**
- `q` (string, required): Query string or Note ID
- `lang` (string, optional): Language code ("EN" or "DE"), defaults to "EN"

### `sap_note_get`
Retrieve full content and metadata for a specific SAP Note.

**Parameters:**
- `id` (string, required): SAP Note ID (6-8 digits)
- `lang` (string, optional): Language code ("EN" or "DE"), defaults to "EN"

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request
