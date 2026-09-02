import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: true },
  build: {
    // The engine lives in public/ and is fetched at runtime; nothing to bundle.
    chunkSizeWarningLimit: 900,
  },
});
