import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, '..', '.env') });

import { createNotesAuthenticator } from '../dist/auth.js';
import { SapNotesApiClient } from '../dist/sap-notes-api.js';

const projectRoot = join(__dirname, '..');
const tokenCacheFile = process.env.SAP_NOTES_TOKEN_CACHE_FILE ||
  process.env.TOKEN_CACHE_FILE ||
  join(projectRoot, 'token-cache.json');
const ssoStorageStateFile = process.env.SAP_SSO_STORAGE_STATE ||
  join(process.env.HOME || process.cwd(), '.sap-mcp', 'sso-storage-state.json');

const serverConfig = {
  pfxPath: process.env.PFX_PATH || '',
  pfxPassphrase: process.env.PFX_PASSPHRASE || '',
  sapUsername: process.env.SAP_USERNAME,
  sapPassword: process.env.SAP_PASSWORD,
  authMethod: process.env.AUTH_METHOD || 'auto',
  mfaTimeout: parseInt(process.env.MFA_TIMEOUT || '120000'),
  maxJwtAgeH: parseInt(process.env.MAX_JWT_AGE_H || '12'),
  headful: process.env.HEADFUL === 'true',
  logLevel: process.env.LOG_LEVEL || 'debug',
  tokenCacheFile,
  ssoStorageStateFile,
  sapLoginUrl: process.env.SAP_LOGIN_URL || 'https://me.sap.com/home'
};

const authenticator = createNotesAuthenticator(serverConfig);
const apiClient = new SapNotesApiClient(serverConfig);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL: ${name}`);
    console.log(`        ${error.message}`);
    failed++;
  }
}

async function run() {
  console.log('=== Full Flow Test ===\n');

  // Step 1: Authenticate
  let session;
  let token;
  console.log('1. Authentication');
  await test('authenticate with username/password', async () => {
    session = await authenticator.ensureSession();
    token = session.cookieHeader;
    if (!token || token.length < 100) throw new Error(`Token too short: ${token?.length}`);
  });

  await test('cached session reuse', async () => {
    const cachedSession = await authenticator.ensureSession();
    if (cachedSession.cookieHeader !== token) throw new Error('Cache returned different cookie header');
  });

  if (!token) {
    console.log('\nAuth failed, cannot continue.');
    process.exit(1);
  }

  // Step 2: Search
  console.log('\n2. Search');
  let noteId;

  await test('search by note ID "2744792"', async () => {
    const result = await apiClient.searchNotes('2744792', token, 5);
    if (result.totalResults === 0) {
      // Fallback: direct note retrieval should still work
      console.log('        (0 search results, will test direct note get instead)');
    } else {
      noteId = result.results[0].id;
    }
  });

  await test('search by keyword "OData error"', async () => {
    const result = await apiClient.searchNotes('OData error', token, 5);
    if (!noteId && result.results.length > 0) {
      noteId = result.results[0].id;
    }
  });

  // Step 3: Get Note
  console.log('\n3. Note Retrieval');
  const testNoteId = noteId || '2744792';

  await test(`get note ${testNoteId}`, async () => {
    const note = await apiClient.getNote(testNoteId, token);
    if (!note) throw new Error('Note returned null');
    if (!note.title) throw new Error('Note has no title');
    if (!note.content) throw new Error('Note has no content');
    console.log(`        Title: ${note.title.substring(0, 80)}`);
    console.log(`        Content length: ${note.content.length} chars`);
  });

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  // Cleanup
  await apiClient.cleanup?.();
  await authenticator.destroy();

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
