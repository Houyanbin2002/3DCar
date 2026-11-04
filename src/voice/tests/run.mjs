import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const result = await build({
  entryPoints: [fileURLToPath(new URL('./voice.test.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  define: { 'import.meta.env': '{}' },
  write: false,
});

await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
