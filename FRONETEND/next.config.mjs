/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: '.build',
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
