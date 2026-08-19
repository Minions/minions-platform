#!/usr/bin/env node
import { cp, rm } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const throneRoomDist = path.resolve(__dirname, '../../throne-room/dist');
const cabinetDist = path.resolve(__dirname, '../dist/throne-room');

console.log(`Copying throne-room UI from ${throneRoomDist} to ${cabinetDist}`);

// Vite content-hashes chunk filenames, so a plain recursive copy merges each
// build's output on top of the last instead of replacing it — every prior
// build's hashed chunks stay behind forever, tripling (or worse) the UI
// bundle size over a few rebuilds. Clear the destination first so only the
// current build's files end up here.
// maxRetries/retryDelay ride out the transient EBUSY Windows sometimes
// throws on a directory an AV/indexer briefly touched right after the
// previous build's mass of small file writes.
await rm(cabinetDist, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
await cp(throneRoomDist, cabinetDist, { recursive: true });

console.log('✓ Throne-room UI copied successfully');
