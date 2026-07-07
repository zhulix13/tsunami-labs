# Project Setup

This guide provides instructions on how to set up and run the `tsunami-lab` project using Docker.

## Prerequisites
- [Docker](https://docs.docker.com/get-docker/) installed on your machine.

## Setup Instructions

### 1. Build the Docker Image
To build the Docker image for the project, run the following command in the root directory (where the `Dockerfile` is located):

```bash
docker build -t tsunami-lab .
```

This will install all necessary dependencies and set up the Vite development server environment.

### 2. Run the Docker Container
Once the image is built, you can start the development server by running:

```bash
docker run -p 5173:5173 tsunami-lab
```

This maps port `5173` from the container to your local machine, allowing you to access the app.

### 3. Access the Application
Open your web browser and navigate to:

[http://localhost:5173](http://localhost:5173)

You should now see the application running.
