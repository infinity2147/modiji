import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // NEXT_DIST_DIR (e.g. `.next-p2`) gives a run its own build directory, so concurrent builds and e2e
  // runs in one checkout cannot replace each other's output. Default `.next`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // @vashistha/core ships TypeScript source (no build step), so Next must compile it.
  transpilePackages: ["@vashistha/core", "@vashistha/perception"],
};

export default nextConfig;
