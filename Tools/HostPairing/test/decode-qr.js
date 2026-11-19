// Test-only pipe: do not print an invitation to a terminal.
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { width, height, data } = PNG.sync.read(Buffer.concat(chunks));
const qr = jsQR(data, width, height);
if (!qr) process.exitCode = 1;
else process.stdout.write(qr.data);
