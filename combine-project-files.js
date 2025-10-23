#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_FILE = 'combined-project-files.txt';

// Only include these specific root files
const INCLUDE_ROOT_FILES = [
  'package.json',
  'env.example', 
  'ecosystem.config.cjs',
  'README.md',
  'tsconfig.json'
];

// Exclude these directories completely
const EXCLUDE_DIRS = ['node_modules', 'dist', 'certs', 'images', '.git', 'test'];

// General files to exclude
const EXCLUDE_FILES = ['.DS_Store', OUTPUT_FILE, 'package-lock.json', '.npmrc', '.gitignore', '.editorconfig'];

// Patterns for sensitive files that should never be included
const SENSITIVE_PATTERNS = [
  /\.env(\.|$)/i,           // .env, .env.local, .env.production, etc.
  /\.key$/i,                // Private keys
  /\.pem$/i,                // Certificates
  /\.p12$/i,                // Certificates
  /\.pfx$/i,                // Certificates
  /secrets?/i,              // Any file containing "secret" or "secrets"
  /password/i,              // Any file containing "password"
  /credentials?/i,          // Any file containing "credential" or "credentials"
  /config\.local/i,         // Local config files
  /\.backup$/i,             // Backup files
  /\.log$/i,                // Log files (might contain sensitive data)
  /\.tmp$/i,                // Temporary files
];

/**
 * Check if a path should be excluded
 */
function shouldExclude(filePath, stats, isRootLevel = false) {
  const basename = path.basename(filePath);
  const relativePath = path.relative(process.cwd(), filePath);

  // For root level files, only include specific ones
  if (isRootLevel && stats.isFile()) {
    return !INCLUDE_ROOT_FILES.includes(basename);
  }

  // Exclude specific files
  if (EXCLUDE_FILES.includes(basename)) {
    return true;
  }

  // Exclude directories in the exclude list
  if (stats.isDirectory() && EXCLUDE_DIRS.includes(basename)) {
    return true;
  }

  // Check for sensitive file patterns
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(basename) || pattern.test(filePath)) {
      console.log(`⚠️  Skipping sensitive file: ${relativePath}`);
      return true;
    }
  }

  return false;
}

/**
 * Check if a file is binary
 */
function isBinaryFile(filePath) {
  const binaryExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg',
    '.woff', '.woff2', '.ttf', '.eot',
    '.zip', '.tar', '.gz',
    '.pdf', '.exe', '.dll', '.so', '.dylib',
    '.mp3', '.mp4', '.avi', '.mov',
    '.map' // source maps can be very large
  ];

  const ext = path.extname(filePath).toLowerCase();
  return binaryExtensions.includes(ext);
}

/**
 * Check if we should process a directory
 */
function shouldProcessDirectory(dirPath, rootDir) {
  const relativePath = path.relative(rootDir, dirPath);
  
  // Always process the src directory
  if (relativePath === 'src' || relativePath.startsWith('src/')) {
    return true;
  }
  
  // Don't process other directories at root level (except src)
  if (relativePath && !relativePath.includes(path.sep)) {
    return false;
  }
  
  return true;
}

/**
 * Recursively collect all files from a directory
 */
function collectFiles(dir, rootDir, fileList = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const isRootLevel = (dir === rootDir);

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const stats = fs.statSync(fullPath);

    if (shouldExclude(fullPath, stats, isRootLevel)) {
      continue;
    }

    if (entry.isDirectory()) {
      // Only process src directory and its subdirectories
      if (shouldProcessDirectory(fullPath, rootDir)) {
        collectFiles(fullPath, rootDir, fileList);
      }
    } else if (entry.isFile()) {
      // Skip binary files
      if (!isBinaryFile(fullPath)) {
        fileList.push(fullPath);
      }
    }
  }

  return fileList;
}

/**
 * Combine all files into a single output file
 */
function combineFiles(options) {
  const { rootDir, outputPath } = options;

  console.log(`Starting to combine project files from: ${rootDir}`);
  console.log(`Output file: ${outputPath}`);
  console.log(`Including: src/ directory + root files: ${INCLUDE_ROOT_FILES.join(', ')}`);
  console.log(`Excluding directories: ${EXCLUDE_DIRS.join(', ')}`);
  console.log(`🔒 Security: Automatically excluding sensitive files (.env, keys, secrets, etc.)`);
  console.log('');

  // Collect all files
  const files = collectFiles(rootDir, rootDir);
  console.log(`Found ${files.length} files to process`);
  console.log('');

  // Create write stream for output
  const writeStream = fs.createWriteStream(outputPath, { encoding: 'utf-8' });

  // Write header
  writeStream.write(`Combined Project Files Report\n`);
  writeStream.write(`Generated: ${new Date().toISOString()}\n`);
  writeStream.write(`Root Directory: ${rootDir}\n`);
  writeStream.write(`Total Files: ${files.length}\n`);
  writeStream.write(`Included: src/ directory + root files (${INCLUDE_ROOT_FILES.join(', ')})\n`);
  writeStream.write(`Excluded: ${EXCLUDE_DIRS.join(', ')} directories\n`);
  writeStream.write(`${'='.repeat(80)}\n\n`);

  // Process each file
  files.forEach((filePath, index) => {
    const relativePath = path.relative(rootDir, filePath);
    console.log(`Processing (${index + 1}/${files.length}): ${relativePath}`);

    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      // Write file header
      writeStream.write(`\n${'='.repeat(80)}\n`);
      writeStream.write(`FILE: ${relativePath}\n`);
      writeStream.write(`${'='.repeat(80)}\n\n`);

      // Write file content
      writeStream.write(content);
      writeStream.write('\n\n');
    } catch (error) {
      console.error(`Error reading file ${relativePath}:`, error);
      writeStream.write(`ERROR: Could not read file\n\n`);
    }
  });

  // Write footer
  writeStream.write(`\n${'='.repeat(80)}\n`);
  writeStream.write(`End of Combined Project Files\n`);
  writeStream.write(`${'='.repeat(80)}\n`);

  writeStream.end();

  console.log('');
  console.log(`✓ Successfully combined ${files.length} files`);
  console.log(`Output saved to: ${outputPath}`);
}

// Main execution
const rootDir = path.resolve(__dirname);
const outputPath = path.join(rootDir, OUTPUT_FILE);

combineFiles({ rootDir, outputPath });
