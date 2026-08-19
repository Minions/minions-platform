#!/usr/bin/env node
import { cp } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const frontendDist = path.resolve(__dirname, '../src/frontend/dist');
const destDir = path.resolve(__dirname, '../dist/frontend');

try {
  await cp(frontendDist, destDir, { recursive: true });
  console.log('✓ Frontend copied to dist/frontend');
} catch (err) {
  if (err.code === 'ENOENT') {
    console.warn('Frontend dist not found — skipping copy. Run build:frontend first.');
  } else {
    throw err;
  }
}
