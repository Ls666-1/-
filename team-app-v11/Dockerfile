# 零依赖 Node 服务镜像（适用于 Railway / Render / 阿里云 / 腾讯云容器等）
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
# 本项目零第三方依赖，install 仅为兼容标准流程
RUN npm install --omit=dev 2>/dev/null || true
COPY . .
RUN mkdir -p data
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
