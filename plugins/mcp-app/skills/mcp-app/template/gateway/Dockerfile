# The gateway: the public door in front of the bridge, the web app and Supabase Auth.
# It has no dependencies. See server.mjs.
FROM node:22-alpine
WORKDIR /gateway
COPY server.mjs session.mjs consent.html consent.js consent.css style.css ./
ENV NODE_ENV=production
EXPOSE 9000
ENTRYPOINT ["node", "/gateway/server.mjs"]
