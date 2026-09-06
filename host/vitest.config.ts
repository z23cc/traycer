import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@traycer\/protocol\/utils\/(.*)$/,
        replacement: path.resolve(__dirname, "../protocol/utils/$1"),
      },
      {
        find: /^@traycer\/protocol\/(.*)$/,
        replacement: path.resolve(__dirname, "../protocol/src/$1"),
      },
    ],
  },
  test: {
    server: { deps: { inline: [/[\\/]node_modules[\\/]zod[\\/]/] } },
    include: ["**/__tests__/**/*.test.ts"],
    globals: false,
  },
});
