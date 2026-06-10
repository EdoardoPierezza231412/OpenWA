# Tiny image for the zero-dependency bot. No npm install needed.
FROM node:22-alpine

WORKDIR /app
COPY bot.mjs ./

ENV NODE_ENV=production
ENV BOT_PORT=3001
EXPOSE 3001
USER node

# Liveness probe used by the stack / Portainer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.BOT_PORT||3001)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "bot.mjs"]
