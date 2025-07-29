/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['formidable'],
  },
  // Optimize for Cloudflare Pages
  webpack: (config, { dev, isServer }) => {
    if (!dev && !isServer) {
      // Disable webpack cache to avoid large files
      config.cache = false;
    }
    return config;
  },
  // Ensure all API routes are properly handled in /pages/api
  rewrites: async () => {
    return [
      {
        source: '/api/:path*',
        destination: '/api/:path*',
      }
    ];
  },
  async redirects() {
    return [
      {
        source: '/',
        destination: '/home',
        permanent: false,
      },
    ]
  },
}

module.exports = nextConfig
