import type { NextConfig } from 'next';

/**
 * Next config (T5.1).
 *
 * `transpilePackages: ['@getbeyond/shared']` is required because the shared
 * package ships raw TypeScript (no build step). Next's compiler handles it
 * inline. The same pattern will apply to ext-client / personality-client
 * when they land.
 *
 * No remote-image config, no experimental flags — keep the surface boring
 * until we hit a need.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@getbeyond/shared'],
};

export default nextConfig;
