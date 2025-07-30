# SAP Note Search MCP Server – Specification & Roadmap  
*Version 0.0.1 — 2025-07-29*

## Overview

This MCP server provides direct access to SAP Notes and Knowledge Base articles using SAP Passport certificate authentication and Playwright browser automation. It connects to the SAP raw notes API (`me.sap.com/backend/raw/sapnotes`) to retrieve actual note content.

---

## 1. Roadmap (Future Work)

| Priority | Area | Task / Idea | Notes |
|----------|------|-------------|-------|
| **P1** | **Security** | Encrypt cached tokens with OS keychain | Mitigates token theft; align with MCP security recommendations |
| **P1** | **Performance** | Implement connection pooling for Playwright sessions | Reduce browser startup overhead |
| **P1** | **Robustness** | Add retry logic for authentication failures | Handle transient SAP service issues |
| **P2** | **Features** | Support for attachments and references | Extract linked documents and files |
| **P2** | **Search** | Implement keyword-based search beyond note IDs | Full-text search capabilities |
| **P2** | **Localization** | Support for multiple languages (DE, FR, etc.) | Currently EN-focused |
| **P3** | **Packaging** | Docker container with Playwright dependencies | Simplified deployment |
| **P3** | **Testing** | Comprehensive test suite with mocked authentication | CI/CD integration |
| **P3** | **CLI** | `npx sap-note 2744792` convenience wrapper | Standalone usage |
| **P4** | **Monitoring** | Metrics and health check endpoints | Production monitoring |

---

## 2. Architecture

### Authentication Flow
1. **SAP Passport Certificate** → mutual TLS authentication with SAP IAS
2. **Browser Automation** → Playwright handles complex SAP authentication flows
3. **Cookie Extraction** → authenticated session cookies used for API calls
4. **Token Caching** → authentication state cached locally (expires after MAX_JWT_AGE_H)

### API Integration
- **SAP Raw Notes API** → `me.sap.com/backend/raw/sapnotes/Detail`
- **JSON Response Parsing** → extracts structured note data from API responses
- **Fallback Handling** → graceful degradation if primary endpoints fail

### MCP Protocol Compliance
1. **JSON-RPC 2.0** → Standard MCP protocol over stdin/stdout
2. **Tool Schemas** → JSON Schema validation for all inputs
3. **Error Handling** → Proper HTTP status codes and error messages
4. **Capabilities** → Advertises available tools and resources

---

## 3. MCP Tool Specification

### Available Tools

#### `sap_note_search`
Search SAP Notes and KB articles by note ID or keywords.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "q": { 
      "type": "string", 
      "description": "Query string or Note ID (e.g. '2744792')" 
    },
    "lang": { 
      "type": "string", 
      "enum": ["EN", "DE"], 
      "default": "EN" 
    }
  },
  "required": ["q"],
  "additionalProperties": false
}
```

**Examples:**
- `{ "q": "2744792" }` - Find specific note by ID
- `{ "q": "OData gateway error" }` - Search by keywords

#### `sap_note_get`
Retrieve full content and metadata for a specific SAP Note.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "id": { 
      "type": "string", 
      "description": "SAP Note ID", 
      "pattern": "^[0-9]{6,8}$" 
    },
    "lang": { 
      "type": "string", 
      "enum": ["EN", "DE"], 
      "default": "EN" 
    }
  },
  "required": ["id"],
  "additionalProperties": false
}
```

**Examples:**
- `{ "id": "2744792" }` - Get complete note details

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PFX_PATH` | ✅ | - | Path to SAP Passport certificate (.pfx) |
| `PFX_PASSPHRASE` | ✅ | - | Certificate passphrase |
| `MAX_JWT_AGE_H` | ❌ | `12` | Token cache lifetime (hours) |
| `HEADFUL` | ❌ | `false` | Browser visibility (for debugging) |
| `LOG_LEVEL` | ❌ | `info` | Logging level (debug, info, warn, error) |

---

## 4. Quick Reference

| Aspect | Details |
|--------|---------|
| **Protocol** | JSON-RPC 2.0 over stdin/stdout |
| **Tools** | `sap_note_search`, `sap_note_get` |
| **Auth Flow** | SAP Passport → Browser Automation → Cookie Extraction |
| **API** | SAP Raw Notes API (`me.sap.com/backend/raw/sapnotes`) |
| **Caching** | Local token cache (configurable expiry) |
| **Dependencies** | Playwright (browser automation) |

### Common Usage Examples

| Task | Tool | Parameters |
|------|------|------------|
| Find note by ID | `sap_note_search` | `{ "q": "2744792" }` |
| Search by keywords | `sap_note_search` | `{ "q": "OData gateway error" }` |
| Get full note content | `sap_note_get` | `{ "id": "2744792" }` |

---

## 5. Development & Testing

### Build
```bash
npm run build     # TypeScript compilation
```

### Test Scripts
```bash
npm run test:auth   # Test authentication flow
npm run test:api    # Test SAP Notes API
npm run test:mcp    # Test complete MCP server
npm run test        # Run all tests
```

### Debug Mode
Set `HEADFUL=true` to run browser in visible mode for debugging authentication flows.

---

*This specification provides a complete technical overview of the SAP Note Search MCP Server implementation.* 