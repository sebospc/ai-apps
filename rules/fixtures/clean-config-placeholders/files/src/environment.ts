export const environment = {
  apiUrl: "https://api.acme.com/occ/v2",
  clientSecret: process.env.ACME_CLIENT_SECRET,
  password: "${ACME_PASSWORD}",
  token: "changeme",
  production: true,
};
