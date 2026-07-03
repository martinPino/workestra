import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // Los paquetes @core/* del monorepo son CommonJS y resuelven fuera de node_modules;
  // hay que transformarlos con el plugin commonjs para que sus named exports sean visibles.
  optimizeDeps: {
    include: ['@core/domain', '@core/contracts'],
  },
  build: {
    commonjsOptions: {
      include: [/packages\/[^/]+\/dist/, /node_modules/],
    },
  },
});
