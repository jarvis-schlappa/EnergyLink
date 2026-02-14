import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { buildInfoPlugin } from "./server/core/vite-plugin-build-info";

export default defineConfig({
  plugins: [
    react(),
    buildInfoPlugin(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
