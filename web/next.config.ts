import type { NextConfig } from "next";

const config: NextConfig = {
  // The browser never talks to the API directly: every call goes through a Server Component or a
  // Server Action, which forwards the session cookie. Nothing here needs CORS.
  reactStrictMode: true,
};

export default config;
