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
2. **Tool Schemas** → Enhanced Zod schemas with comprehensive descriptions and validation
3. **Enhanced Tool Descriptions** → 3000+ character descriptions with structured guidance
4. **Error Handling** → Proper HTTP status codes and error messages
5. **Capabilities** → Advertises available tools and resources

---

## 3. MCP Tool Specification

### Available Tools

#### `sap_note_search`
Search SAP Notes and KB articles by note ID or keywords.

**Enhanced Description:** This tool includes comprehensive documentation (3,228 characters) with:
- USE WHEN / DO NOT USE WHEN guidance
- Query construction best practices
- Workflow patterns for tool chaining
- Good vs bad query examples
- Expected output structure

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "q": { 
      "type": "string",
      "minLength": 2,
      "maxLength": 200,
      "description": "Search query with SAP-specific terminology and error codes"
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
- `{ "q": "error 415 CAP action" }` - Search with specific error code
- `{ "q": "MM02 material master dump" }` - Transaction + module + issue

#### `sap_note_get`
Retrieve full content and metadata for a specific SAP Note.

**Enhanced Description:** This tool includes comprehensive documentation (2,911 characters) with:
- USE WHEN / DO NOT USE WHEN guidance
- Parameter validation requirements
- Workflow patterns (search → get chaining)
- Error handling guidance
- Best practices for content extraction

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "id": { 
      "type": "string",
      "minLength": 1,
      "pattern": "^[0-9A-Za-z]+$",
      "description": "SAP Note ID (typically 6-8 digits, alphanumeric)"
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
- `{ "id": "438342" }` - Retrieve note content

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
| **Protocol** | JSON-RPC 2.0 over stdin/stdout or HTTP |
| **Tools** | `sap_note_search`, `sap_note_get` (with enhanced descriptions) |
| **Tool Descriptions** | 3000+ chars with structured guidance, examples, and validation |
| **Schema Validation** | Zod schemas with comprehensive constraints |
| **Auth Flow** | SAP Passport → Browser Automation → Cookie Extraction |
| **API** | SAP Raw Notes API (`me.sap.com/backend/raw/sapnotes`) |
| **Caching** | Local token cache (configurable expiry) |
| **Dependencies** | Playwright (browser automation), Zod (validation) |

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