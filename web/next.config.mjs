// GitHub Pages build: a static export served under the repo's path. There is no analytics server there, so the
// Sectoral analysis and Option chain tabs read JSON files written by export_static.py (lib/derivs.ts). The Pages
// workflow sets PAGES_BASE_PATH; without it, dev and `next build` behave as before.
const base = process.env.PAGES_BASE_PATH;
const pages = base === undefined ? {} : {
  output: 'export',
  basePath: base,
  trailingSlash: true,
  env: { NEXT_PUBLIC_DERIVS_API: `${base}/derivs`, NEXT_PUBLIC_DERIVS_STATIC: '1' },
};

/** @type {import('next').NextConfig} */
const nextConfig = { reactStrictMode: true, ...pages };
export default nextConfig;
