import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @vashistha/core ships TypeScript source (no build step), so Next must compile it.
  transpilePackages: ["@vashistha/core"],
};

export default nextConfig;
