# SAP Note Search Tool - How It Works

## Overview

The `sap_note_search` tool provides semantic search capabilities for SAP Notes and Knowledge Base articles using SAP's **Coveo Search API** - the same search infrastructure that powers SAP's official search interface.

## Tool Flow

### 1. **Entry Point: Tool Call Handler**

When a client calls `sap_note_search` with a query parameter:

```typescript
{
  "name": "sap_note_search",
  "arguments": {
    "q": "2744792"  // or any search term
  }
}
```

**File:** `src/http-mcp-server.ts:484-518` or `src/mcp-server.ts:312-346`

The handler:
1. Validates the input parameters against the JSON schema
2. Logs the search query: `🔎 [handleSapNoteSearch] Starting search for query: "..."`
3. Calls `sapNotesClient.searchNotes(query, token, 10)`
4. Formats results into readable text
5. Returns MCP-compatible response

---

### 2. **Search Strategy: Coveo API**

**File:** `src/sap-notes-api.ts:52-109`

The search uses SAP's **Coveo Search API** - the same powerful search engine that powers `me.sap.com/search`.

#### **How it works:**
1. **Extract Coveo Token:** First, get the Coveo bearer token from the SAP session
2. **Build Search Request:** Create a Coveo search body with:
   - Query string
   - Filters (documenttype = "SAP Note")
   - Fields to include (mh_id, mh_description, mh_category, etc.)
   - Sort criteria (relevancy)
3. **Send to Coveo:** POST to Coveo's search API
4. **Parse Results:** Extract SAP Note information from Coveo response

**URL queried:**
```
POST https://sapamericaproductiontyfzmfz0.org.coveo.com/rest/search/v2?organizationId=sapamericaproductiontyfzmfz0
```

**Request Body Example:**
```json
{
  "q": "authorization error",
  "numberOfResults": 10,
  "locale": "en-US",
  "searchHub": "SAP for Me",
  "sortCriteria": "relevancy",
  "facets": [
    {
      "field": "documenttype",
      "currentValues": [
        { "value": "SAP Note", "state": "selected" }
      ]
    }
  ],
  "fieldsToInclude": [
    "mh_id", "mh_description", "mh_category", 
    "mh_app_component", "mh_alt_url", "date"
  ]
}
```

---

### 3. **External URLs Queried**

#### **Primary Search URL:**
```
POST https://sapamericaproductiontyfzmfz0.org.coveo.com/rest/search/v2?organizationId=sapamericaproductiontyfzmfz0
```

#### **Token Extraction URL:**
```
GET https://me.sap.com/search
```
(Used to extract the Coveo bearer token from the SAP session)

#### **Note Detail URLs (for sap_note_get):**
- **Raw Notes API:** `https://me.sap.com/backend/raw/sapnotes/Detail?q={noteId}&t=E&isVTEnabled=false`
- **OData API:** `https://launchpad.support.sap.com/services/odata/svt/snogwscorr/KnowledgeBaseEntries?$filter=SapNote eq '{noteId}'&$format=json`

---

### 4. **Return Message Format**

The tool returns a formatted text response with this structure:

```
Found {N} SAP Note(s) for query: "{query}"

**SAP Note {id}**
Title: {title}
Summary: {summary}
Component: {component}
Release Date: {releaseDate}
Language: {language}
URL: https://launchpad.support.sap.com/#/notes/{id}

**SAP Note {id2}**
...
```

#### **Example Response:**

```
Found 1 SAP Note(s) for query: "2744792"

**SAP Note 2744792**
Title: Java Applications work with keystore "DEFAULT" and SAP Cloud Connector
Summary: Applications using SAP JCo or JDBC fail with security exceptions when connecting through SAP Cloud Connector
Component: BC-MID-CON-JCO
Release Date: 2019-03-15
Language: EN
URL: https://launchpad.support.sap.com/#/notes/2744792
```

---

## Debug Output

When running with `npm run start:http:debug`, the following debug logs are shown:

### **Search Initiation:**
```
[HH:MM:SS] INFO: 🔎 [handleSapNoteSearch] Starting search for query: "2744792"
[HH:MM:SS] INFO: 🔍 Searching SAP Notes for: "2744792"
[HH:MM:SS] DEBUG: 📊 Search parameters: query="2744792", maxResults=10
```

### **Coveo Token Extraction:**
```
[HH:MM:SS] DEBUG: 🔑 Fetching Coveo bearer token from SAP session
[HH:MM:SS] DEBUG: ✅ Successfully extracted Coveo token from SAP page
```

### **Coveo Search Request:**
```
[HH:MM:SS] DEBUG: 🌐 Coveo Search URL: https://sapamericaproductiontyfzmfz0.org.coveo.com/rest/search/v2?organizationId=sapamericaproductiontyfzmfz0
[HH:MM:SS] DEBUG: 📤 Coveo Search Body: {"q":"2744792","numberOfResults":10,"facets":[{"field":"documenttype","currentValues":[{"value":"SAP Note","state":"selected"}]}]...
[HH:MM:SS] DEBUG: 📊 Coveo Response: 200 OK
[HH:MM:SS] DEBUG: 📄 Coveo Results: 1 results found
[HH:MM:SS] INFO: ✅ Found 1 SAP Note(s) via Coveo
```

### **Results:**
```
[HH:MM:SS] DEBUG: 📄 Search results: [
  {
    "id": "2744792",
    "title": "Java Applications work with keystore \"DEFAULT\" and SAP Cloud Connector"
  }
]
[HH:MM:SS] DEBUG: 📤 [handleSapNoteSearch] Return message preview:
Found 1 SAP Note(s) for query: "2744792"

**SAP Note 2744792**
Title: Java Applications work with keystore "DEFAULT" and SAP Cloud Connector
Summary: Applications using SAP JCo or JDBC fail with security exceptions...
[HH:MM:SS] INFO: ✅ [handleSapNoteSearch] Successfully completed search, returning 1 results
```

### **Coveo Error Handling:**
```
[HH:MM:SS] DEBUG: 🔑 Fetching Coveo bearer token from SAP session
[HH:MM:SS] WARN: ⚠️ Could not extract Coveo token from page, using fallback
[HH:MM:SS] ERROR: ❌ Failed to get Coveo token: Unable to extract token
[HH:MM:SS] ERROR: ❌ SAP Notes search failed: Failed to get Coveo bearer token
```

**URLs Queried:**
- Token extraction: `https://me.sap.com/search`
- Coveo search: `https://sapamericaproductiontyfzmfz0.org.coveo.com/rest/search/v2`

---

## Running in Debug Mode

To enable comprehensive debug output:

```bash
npm run start:http:debug
```

This runs the server with:
- **Port:** 3123
- **Log Level:** debug (shows all debug/info/warn/error logs)
- **Debug Start:** true (shows startup diagnostics)

### **Testing the Tool:**

```bash
curl -X POST http://localhost:3123/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "sap_note_search",
      "arguments": {
        "q": "2744792"
      }
    }
  }'
```

---

## Authentication

Before any search can execute, the tool:
1. Checks for cached authentication token (in `token-cache.json`)
2. If expired or missing, launches Playwright browser
3. Authenticates with SAP using client certificate (PFX)
4. Captures authentication cookies
5. Caches token for future requests

**Debug logs show:**
```
[HH:MM:SS] 🔐 Starting authentication for tool call...
[HH:MM:SS] ✅ Authentication successful for tool call
```

---

## Summary

**Flow:**
1. Client → `sap_note_search` tool call
2. Handler → Validates & calls `searchNotes()`
3. Token → Extract Coveo bearer token from SAP session
4. Search → POST to Coveo API with search query and filters
5. Parse → Extract SAP Note data from Coveo response
6. Format → Create readable text response
7. Return → MCP response with formatted results

**Key URLs:**
- **Token:** `https://me.sap.com/search` (extract Coveo token)
- **Search:** `https://sapamericaproductiontyfzmfz0.org.coveo.com/rest/search/v2?organizationId=sapamericaproductiontyfzmfz0`
- **Note Details:** `https://me.sap.com/backend/raw/sapnotes/Detail?q={id}` (for sap_note_get)

**Why Coveo?**
- SAP's official search infrastructure
- Same API that powers me.sap.com/search
- Better relevancy and ranking
- Consistent with SAP's search experience
- Single unified search interface

**Debug Mode:**
- Run: `npm run start:http:debug`
- View: Detailed logs of Coveo token extraction, search requests, and results

