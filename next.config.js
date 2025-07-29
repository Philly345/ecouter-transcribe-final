/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  trailingSlash: true,
  experimental: {
    serverComponentsExternalPackages: ['formidable'],
  },
  async redirects() {
    return [
      {
        source: '/',
        destination: '/home/',
        permanent: false,
      },
    ]
  },
}

module.exports = nextConfig
