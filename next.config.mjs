/** @type {import('next').NextConfig} */
const nextConfig = {
  // The app reads dataset/ and prompts/ at runtime with computed paths, which Next's file tracer cannot see.
  // Without these the deployment has no data. dataset/qa (the answer key) is deliberately not listed: it
  // never ships, which is the same guarantee the loader gives in code. fixtures/demo-0847.json is the one
  // recorded model reply the deployed demo replays (ANALYZE_DEMO_REPLAY); other fixtures stay local.
  outputFileTracingIncludes: {
    "/**": ["./dataset/*.json", "./dataset/*.txt", "./prompts/*.md", "./fixtures/demo-0847.json"],
  },
  outputFileTracingExcludes: {
    "/**": ["./dataset/qa/**", "./state/**", "./claude/**", "./design/**"],
  },
};

export default nextConfig;
