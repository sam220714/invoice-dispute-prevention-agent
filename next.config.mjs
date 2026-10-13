/** @type {import('next').NextConfig} */
const nextConfig = {
  // The app reads dataset/ and prompts/ at runtime with computed paths, which Next's file tracer cannot see.
  // Without these the deployment has no data. dataset/qa (the answer key) is deliberately not listed: it
  // never ships, which is the same guarantee the loader gives in code.
  outputFileTracingIncludes: {
    "/**": ["./dataset/*.json", "./dataset/*.txt", "./prompts/*.md"],
  },
  outputFileTracingExcludes: {
    "/**": ["./dataset/qa/**", "./state/**", "./fixtures/**", "./claude/**", "./design/**"],
  },
};

export default nextConfig;
