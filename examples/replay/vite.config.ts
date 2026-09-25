import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { bridgeApi } from "./src/server/api.ts"

// Server-only settings (REPLAY_JEV, TYPESAFE_API_KEY) may live in .env.local. They reach the
// dev server's API, never the browser bundle: only VITE_-prefixed variables are exposed there.
export default defineConfig(({ mode }) => ({
  plugins: [react(), bridgeApi({ ...loadEnv(mode, import.meta.dirname, ""), ...process.env })]
}))
