FROM node:22-bookworm-slim
WORKDIR /opt/validator
RUN npm install --ignore-scripts --save-exact eslint@9.39.5 typescript@5.9.3
COPY validate.mjs /opt/validator/validate.mjs
ENV PATH="/opt/validator/node_modules/.bin:${PATH}"
ENTRYPOINT ["node", "/opt/validator/validate.mjs"]
