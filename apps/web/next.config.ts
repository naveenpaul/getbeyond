import type { NextConfig } from 'next';

/**
 * Next config (T5.1).
 *
 * `@getbeyond/shared` is intentionally NOT in `transpilePackages`: it now ships
 * a compiled CommonJS build (`dist/`), so Next consumes it as a normal prebuilt
 * dependency. Adding it to transpilePackages makes Next run its source loaders
 * (incl. React Fast Refresh, which injects `import.meta.webpackHot`) over the
 * already-compiled CJS and fails to parse it ("Cannot use 'import.meta' outside
 * a module"). If a future workspace package ships RAW TS (no build), that one
 * goes in transpilePackages; built packages do not.
 *
 * No remote-image config, no experimental flags — keep the surface boring.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
