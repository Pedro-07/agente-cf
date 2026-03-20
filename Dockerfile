FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY server.js ./

# REMOVIDO: COPY .env ./
# Credenciais nunca devem ser embutidas na imagem Docker — qualquer pessoa
# com acesso à imagem teria acesso às chaves de API.
# As variáveis de ambiente são injetadas em runtime pelo docker-compose via
# a seção "environment", que lê do arquivo .env local do host.

EXPOSE 3000

CMD ["node", "server.js"]
