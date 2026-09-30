import { solidStart } from "@solidjs/start/config";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    solidStart({
      ssr: false,
      routeDir: "./routes",
      appRoot: "./src",
    }),
  ],
  build: {
    outDir: "dist/site",
  },
});
