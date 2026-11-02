import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [react()],
  // Ganchos de prévia (window.heydeskPreview*) só em dev e no build de debug do Tauri.
  define: { __HEYDESK_DEBUG__: JSON.stringify(mode !== "production" || process.env.TAURI_ENV_DEBUG === "true") },

  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
