import { z } from 'zod';

/**
 * ============================================
 * SAP NOTE SEARCH SCHEMAS - ENHANCED VERSION
 * ============================================
 * 
 * These enhanced Zod schemas provide comprehensive descriptions,
 * validation constraints, and structured guidance to dramatically
 * improve LLM tool selection accuracy across weak, medium, and strong models.
 */

/**
 * Input schema shape for sap_note_search (for MCP SDK)
 * Enhanced with comprehensive descriptions, examples, and validation
 */
export const NoteSearchInputSchema = {
  q: z
    .string()
    .min(2, "Query must be at least 2 characters")
    .max(200, "Query must be less than 200 characters")
    .describe(
      `Search query: Specific error codes, transaction codes, component names, or issue descriptions. Use concise SAP terminology (2-6 words).

Examples of effective queries:
• "OData gateway error" - Specific error with context
• "MM02 material master dump" - Transaction + module + issue
• "ABAP CX_SY_ZERODIVIDE" - Specific exception class
• "S/4HANA migration performance" - Product + issue
• "Note 2744792" - Direct note ID lookup
• "error 415 CAP" - Error code + technology
• "Fiori launchpad not loading" - Specific symptom

Query construction tips:
• Include error codes, transaction codes, or component names
• Use SAP terminology (not generic terms)
• Be specific but concise (2-6 words typically)
• Format: [Error Code/Transaction] + [Module/Component] + [Issue Type]

Avoid vague queries like: "SAP problem", "not working", "help"`
    ),
  
  lang: z
    .enum(['EN', 'DE'])
    .default('EN')
    .describe(
      `Language code for search results and note content.
• EN (English) - Default and recommended, most comprehensive coverage
• DE (German) - Available for German-language notes

Use EN unless user specifically requests German content.`
    ),
};

/**
 * Output schema shape for individual note in search results
 */
export const NoteSearchResultSchema = {
  id: z
    .string()
    .min(1, "Note ID cannot be empty")
    .describe(
      `SAP Note ID (typically 6-8 digits, but may vary). Use this ID with sap_note_get() to fetch the complete note content with detailed solution steps.

Examples: "2744792", "438342", "3089413"`
    ),
  
  title: z
    .string()
    .describe(
      'Note title/subject summarizing the issue, problem, or topic the note addresses'
    ),
  
  summary: z
    .string()
    .describe(
      'Brief summary (1-3 sentences) describing what the note covers and what problem it solves'
    ),
  
  component: z
    .string()
    .nullable()
    .describe(
      `SAP component this note relates to (e.g., 'CA-UI5', 'MM-IM', 'FI-GL', 'BC-CST-IC').

Component format: [Application Area]-[Module]-[Submodule]
• CA = Cross-Application
• MM = Materials Management
• FI = Financial Accounting
• BC = Basis Components
• etc.

null if component is not specified.`
    ),
  
  releaseDate: z
    .string()
    .describe(
      'Date when the note was published or last updated, in ISO 8601 format (YYYY-MM-DD or full timestamp)'
    ),
  
  language: z
    .string()
    .describe('Language of the note content (EN for English, DE for German)'),
  
  url: z
    .string()
    .url()
    .describe(
      'Direct URL to view the full note on SAP Support Portal (requires S-user credentials to access)'
    ),
};

/**
 * Complete output schema shape for sap_note_search (for MCP SDK)
 */
export const NoteSearchOutputSchema = {
  totalResults: z
    .number()
    .int()
    .min(0)
    .describe(
      `Total number of SAP Notes found matching the search query.

• 0 results: Try different search terms or use sap_help_search instead
• 1-5 results: High relevance, likely good matches
• 6+ results: Multiple relevant notes found

Results are ranked by relevance (best matches first).`
    ),
  
  query: z
    .string()
    .describe('The exact search query that was executed (for reference and debugging)'),
  
  results: z
    .array(z.object(NoteSearchResultSchema))
    .describe(
      `Array of matching SAP Notes, ranked by relevance (best matches first).

Typical workflow after getting results:
1. Review the first 2-5 results
2. Identify the most relevant note IDs based on title and summary
3. Use sap_note_get(id) to fetch full content for top 2-3 notes
4. Synthesize the solution from the detailed note content

Do NOT fetch all notes - only retrieve details for the most relevant ones.`
    ),
};

/**
 * ============================================
 * SAP NOTE GET SCHEMAS - ENHANCED VERSION
 * ============================================
 */

/**
 * Input schema shape for sap_note_get (for MCP SDK)
 * Enhanced with validation and examples
 */
export const NoteGetInputSchema = {
  id: z
    .string()
    .min(1, "Note ID cannot be empty")
    .regex(/^[0-9A-Za-z]+$/, "Note ID must contain only alphanumeric characters")
    .describe(
      `SAP Note ID: Typically 6-8 digits, but may include letters or vary in length.

Valid examples:
• "2744792" (7 digits)
• "438342" (6 digits)
• "12345678" (8 digits)
• "123ABC" (mixed alphanumeric)

Invalid examples:
• "Note 2744792" (contains text prefix - extract ID only)
• "" (empty)

If user input includes text (e.g., "Note 2744792" or "SAP Note 2744792"), extract only the ID portion before calling this tool.`
    ),
  
  lang: z
    .enum(['EN', 'DE'])
    .default('EN')
    .describe(
      `Language code for note content.
• EN (English) - Default, recommended for most cases
• DE (German) - Use if note exists in German and user requests it

Note: Not all notes are available in both languages.`
    ),
};

/**
 * Output schema shape for sap_note_get (for MCP SDK)
 */
export const NoteGetOutputSchema = {
  id: z
    .string()
    .describe('SAP Note ID (6-8 digits) that was fetched'),
  
  title: z
    .string()
    .describe('Full note title describing the issue, error, or topic'),
  
  summary: z
    .string()
    .describe(
      'Executive summary of the note content (high-level overview of the problem and solution)'
    ),
  
  component: z
    .string()
    .nullable()
    .describe(
      `SAP component code this note relates to (e.g., 'CA-UI5-CTR' for UI5 controls, 'MM-IM' for Inventory Management).

Format: [Area]-[Module]-[Submodule]

null if not specified.`
    ),
  
  priority: z
    .string()
    .nullable()
    .describe(
      `Note priority level indicating urgency:
• "Very High" - Critical issues, security vulnerabilities
• "High" - Important fixes, significant bugs
• "Medium" - Standard corrections and improvements
• "Low" - Minor issues, cosmetic fixes
• "Recommendation" - Best practices, optimization tips

null if priority is not assigned.`
    ),
  
  category: z
    .string()
    .nullable()
    .describe(
      `Note category/type indicating the nature of the note:
• "Correction" - Bug fixes, error corrections
• "Consulting" - Implementation guidance, best practices
• "Performance" - Performance optimization tips
• "Security" - Security patches, vulnerability fixes
• "Master Data" - Data migration, master data issues
• etc.

null if category is not specified.`
    ),
  
  releaseDate: z
    .string()
    .describe(
      'Date when note was published or last updated (ISO 8601 format: YYYY-MM-DD or full timestamp)'
    ),
  
  language: z
    .string()
    .describe('Language of the note content (EN or DE)'),
  
  url: z
    .string()
    .url()
    .describe(
      'Direct URL to view the note on SAP Support Portal. Share this link with users so they can access the official source.'
    ),
  
  content: z
    .string()
    .describe(
      `Full HTML content of the SAP Note including all sections:

Typical sections in note content:
• Symptom - Description of the problem/error
• Reason and Prerequisites - Root cause analysis
• Solution - Detailed step-by-step instructions to resolve the issue
• Affected Releases - Which SAP versions are impacted
• Related Notes - Links to other relevant notes
• Additional Information - Extra context, warnings, or tips

Important: This is raw HTML content. You should:
1. Parse the HTML to extract key sections
2. Summarize the Symptom and Solution for the user
3. Keep technical details but make them readable
4. Preserve any code snippets, configuration steps, or warnings
5. If content is very long (>5000 chars), focus on Symptom and Solution sections

Do not return raw HTML to the user - extract and format the relevant information.`
    ),
};

/**
 * ============================================
 * COMPREHENSIVE TOOL DESCRIPTIONS
 * ============================================
 * 
 * These are the comprehensive descriptions that will be exposed
 * to LLMs via the MCP protocol to improve tool selection accuracy.
 */

export const SAP_NOTE_SEARCH_DESCRIPTION = `Search SAP Knowledge Base (SAP Notes) for troubleshooting articles, bug fixes, patches, corrections, and known issues. Returns a ranked list of matching notes with metadata.

SAP Notes are official support articles that document:
• Known bugs and their fixes
• Patches and corrections for SAP software
• Troubleshooting guides for specific errors
• Performance optimization tips
• Security vulnerabilities and patches
• Missing or incorrect functionality

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
USE WHEN:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• User mentions "error", "issue", "bug", "problem", "not working"
• User asks about "fixes", "patches", "corrections"
• User reports unexpected behavior or incorrect functionality
• User mentions specific error codes (e.g., "error 415", "dump ABAP_EXCEPTION")
• User asks "why isn't this working?" or "how to fix?"
• User references a specific Note ID (e.g., "Note 2744792")

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DO NOT USE WHEN:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• User asks "how to configure" or "how to set up" → use sap_help_search instead
• User wants implementation guides or best practices → use sap_help_search instead
• User asks about product features or capabilities → use sap_help_search instead
• User wants training materials or tutorials → use sap_community_search instead
• User asks general "what is" questions → use sap_help_search instead

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUERY CONSTRUCTION:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Effective queries should:
1. Include specific error codes, messages, or transaction codes
2. Use SAP terminology (not generic terms)
3. Be concise (2-6 words typically)
4. Include product/module context if known

Query Formula: [Error Code/Transaction] + [Module/Component] + [Issue Type]

Examples:
  ✓ GOOD:
    • "error 415 CAP action" (specific error + context)
    • "MM02 material master dump" (transaction + module + issue)
    • "ABAP CX_SY_ZERODIVIDE" (specific exception class)
    • "S/4HANA migration performance" (product + issue)
    • "Note 2744792" (direct note ID lookup)
  
  ✗ BAD:
    • "how to configure SAP" (too vague, use sap_help_search)
    • "mm22" (transaction only, no issue context)
    • "I have a problem" (no specifics)
    • "SAP not working" (too generic)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW PATTERN:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Call sap_note_search(q="your query") to find relevant notes
2. Review results array for relevant note IDs
3. Call sap_note_get(id="note_id") for detailed content of top 2-3 notes
4. Synthesize answer from fetched note content

Example Chain:
  sap_note_search(q="OData gateway error")
  → Returns: [{id: "2744792", title: "OData Gateway 415 Error"}, ...]
  → Then call: sap_note_get(id="2744792")
  → Returns: Full note content with solution

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IMPORTANT NOTES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• SAP Notes require S-user credentials to access full content
• Note IDs are typically alphanumeric (e.g., "2744792", "438342", "123ABC")
• Results are ranked by relevance (best matches first)
• Empty results suggest trying sap_help_search instead
• Language parameter defaults to English (EN)`;

export const SAP_NOTE_GET_DESCRIPTION = `Fetch complete content and metadata for a specific SAP Note by ID. Returns full HTML content, solution details, and all metadata.

SAP Notes contain:
• Detailed problem description
• Step-by-step solution instructions
• Root cause analysis
• Affected releases/versions
• Related notes and references
• Corrections and patches
• Implementation guides

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
USE WHEN:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• You have a Note ID from sap_note_search results
• User asks for details about a specific note (e.g., "get details for note 2744792")
• You need full solution steps, not just the summary
• User wants to see the complete note content
• You're following the search → get workflow pattern

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DO NOT USE WHEN:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• You don't have a specific Note ID (use sap_note_search first)
• User hasn't asked for detailed note content (summaries may suffice)
• Note ID is invalid (contains spaces or special characters)
• You're just browsing/searching (use sap_note_search instead)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PARAMETER REQUIREMENTS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Note ID Format:
• Typically alphanumeric characters only
• No spaces, no prefixes
• Valid examples: "2744792", "438342", "3089413", "123ABC"
• Invalid examples: "Note 2744792", "SAP Note 2744792", ""

If user input includes text, extract the ID only:
  "Note 2744792" → "2744792"
  "SAP Note 438342" → "438342"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW PATTERN:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Typical usage flow:

1. Search for relevant notes:
   sap_note_search(q="OData 415 error")
   
2. Review search results, identify relevant note IDs:
   Results: [{id: "2744792", ...}, {id: "438342", ...}]
   
3. Fetch full content for top 2-3 relevant notes:
   sap_note_get(id="2744792")
   sap_note_get(id="438342")
   
4. Synthesize solution from full note content

Do NOT fetch all notes - only get details for the most relevant 2-3.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ERROR HANDLING:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Common errors and solutions:

• "Note ID must contain only alphanumeric characters"
  → Validate ID format before calling
  → Extract alphanumeric ID only from user input
  
• "Note not found"
  → Note ID doesn't exist or is invalid
  → Try searching again with different terms
  
• "Access denied"
  → Some notes require special S-user permissions
  → Inform user to access directly on SAP Support Portal

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BEST PRACTICES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Always validate Note ID format (alphanumeric) before calling
2. Only fetch notes that are clearly relevant from search results
3. Limit to 2-3 note fetches per user query
4. Parse and summarize the HTML content field for users
5. Include the note URL in your response
6. Extract key sections: Symptom, Solution, Affected Releases`;

/**
 * ============================================
 * TYPE EXPORTS (for TypeScript type inference)
 * ============================================
 */

export type NoteSearchInput = z.infer<z.ZodObject<typeof NoteSearchInputSchema>>;
export type NoteSearchOutput = z.infer<z.ZodObject<typeof NoteSearchOutputSchema>>;
export type NoteSearchResult = z.infer<z.ZodObject<typeof NoteSearchResultSchema>>;
export type NoteGetInput = z.infer<z.ZodObject<typeof NoteGetInputSchema>>;
export type NoteGetOutput = z.infer<z.ZodObject<typeof NoteGetOutputSchema>>;
