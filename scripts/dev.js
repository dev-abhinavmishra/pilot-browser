#!/usr/bin/env node
// dev.js — build the renderer once, then launch Electron pointed at dist/.
// Set PILOT_RENDERER_URL=http://localhost:3000 to use a live vite dev server instead.

import { spawn } from 'child_process';
import { build as viteBuild } from 'vite';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

async function main() {
    if (process.env.PILOT_RENDERER_URL) {
        console.log(`Using dev server at ${process.env.PILOT_RENDERER_URL}`);
    } else {
        console.log('Building renderer…');
        await viteBuild({ configFile: path.join(rootDir, 'vite.config.js') });
    }
    const electronBin = require('electron');
    const child = spawn(electronBin, ['.'], {
        cwd: rootDir,
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'development' },
    });
    child.on('close', (code) => process.exit(code ?? 0));
}

main().catch((e) => { console.error(e); process.exit(1); });
