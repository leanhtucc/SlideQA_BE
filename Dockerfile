# pdfjs-dist 6 cần Node >= 22.13
FROM node:22-alpine

# Prisma trên Alpine cần openssl để chọn đúng engine
RUN apk add --no-cache openssl

# Tạo user non-root
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Copy file cần thiết trước để cache npm install
COPY package*.json ./

RUN npm install

# Copy source code
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

# Kho tệp PDF cục bộ (gắn volume ở đây khi deploy bằng Docker)
RUN mkdir -p /app/data/files && chown -R app:app /app/data
VOLUME ["/app/data"]

USER app

EXPOSE 3000

CMD ["npm", "start"]
