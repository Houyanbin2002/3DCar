import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import baseConfig from '../../vite.config';

export default mergeConfig(baseConfig, {
  build: {
    rollupOptions: {
      input: fileURLToPath(new URL('./index.html', import.meta.url)),
    },
  },
});
