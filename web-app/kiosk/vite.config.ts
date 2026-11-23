import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The device client serves this build from any directory on loopback, so every asset path is relative.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: '../dist/kiosk', emptyOutDir: true },
});
