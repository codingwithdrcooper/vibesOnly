FROM node:20

# Install ffmpeg for audio processing
RUN apt-get update && apt-get install -y ffmpeg

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy app files
COPY . .

# Expose port
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
