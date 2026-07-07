# Use an official Node.js runtime as a parent image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker cache
COPY package*.json ./

# Install project dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the default Vite port
EXPOSE 5173

# Start the development server
# The --host flag is required to expose the server outside the Docker container
CMD ["npm", "run", "dev", "--", "--host"]
