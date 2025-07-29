/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  trailingSlash: true,
  experimental: {
    serverComponentsExternalPackages: ['formidable'],
  },
}

module.exports = nextConfig
