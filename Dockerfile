FROM node:20-slim
WORKDIR /app
RUN npm install -g @human.tech/waap-cli@latest
COPY morpho-yield-agent.js .
COPY .env .
CMD ["node", "morpho-yield-agent.js"]
