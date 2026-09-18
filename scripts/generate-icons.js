/**
 * generate-icons.js
 *
 * Creates placeholder PWA icon PNGs for the Sundog app.
 * These are minimal valid 1x1 pixel PNGs (solid #0f172a / slate-900).
 * They will be replaced with real branded icons before field deployment.
 */
const fs = require('fs');
const path = require('path');

// Minimal valid 1x1 pixel PNG - solid dark color (#0f172a)
function createMinimalPNG() {
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4' +
    '2mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';
  return Buffer.from(base64, 'base64');
}

const outDir = path.join(__dirname, '..', 'client', 'public');
fs.mkdirSync(outDir, { recursive: true });

const icon192Path = path.join(outDir, 'icon-192.png');
const icon512Path = path.join(outDir, 'icon-512.png');

fs.writeFileSync(icon192Path, createMinimalPNG());
fs.writeFileSync(icon512Path, createMinimalPNG());

console.log('Placeholder PWA icons created:');
console.log('  ' + icon192Path);
console.log('  ' + icon512Path);
console.log('');
console.log('NOTE: These are 1x1 pixel placeholders. Replace with real');
console.log('192x192 and 512x512 branded icons before field deployment.');
