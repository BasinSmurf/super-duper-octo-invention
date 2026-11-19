const { copyFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '..');
mkdirSync(resolve(root, 'dist/services'), { recursive: true });
copyFileSync(resolve(root, 'src/services/qbwc.wsdl'), resolve(root, 'dist/services/qbwc.wsdl'));
