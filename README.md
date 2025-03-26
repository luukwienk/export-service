# Address Export Server

A dedicated server for high-performance exports from your address database. This server maintains persistent database connections to eliminate the connection overhead in serverless environments, dramatically improving export performance.

## Features

- **High Performance**: Maintains persistent database connections
- **Streaming**: Uses streaming to minimize memory usage
- **Progress Tracking**: Provides real-time progress updates
- **API Compatibility**: Matches your existing API endpoints
- **Scalable**: Can handle millions of addresses efficiently
- **Vercel Blob Integration**: Uses Vercel Blob for storing export files

## Setup

### Prerequisites

- Node.js 18+ and npm
- Access to your Neon PostgreSQL database
- Vercel Blob storage account and token
- Docker and Docker Compose (for containerized deployment)

### Installation

1. Clone this repository:
   ```
   git clone <repository-url>
   cd address-export-server
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Copy your Prisma schema into the project:
   ```
   mkdir -p prisma
   cp /path/to/your/schema.prisma prisma/
   ```

4. Set up environment variables:
   ```
   cp .env.example .env
   ```
   Then edit `.env` to add your:
   - `DATABASE_URL`: Your Neon PostgreSQL connection string
   - `API_KEY`: A secret key for API authentication
   - `BLOB_READ_WRITE_TOKEN`: Your Vercel Blob storage token

5. Generate Prisma client:
   ```
   npx prisma generate
   ```

6. Build the application:
   ```
   npm run build
   ```

7. Start the server:
   ```
   npm start
   ```

## Deployment on DigitalOcean

### Option 1: Manual Deployment

1. Create a Droplet (recommended: Basic Droplet with 2GB RAM / 1 vCPU)
2. Connect to your Droplet via SSH
3. Install Docker and Docker Compose:
   ```
   sudo apt update
   sudo apt install -y docker.io docker-compose
   ```
4. Clone this repository and navigate to the project folder
5. Create a `.env` file with your environment variables
6. Start the server with Docker Compose:
   ```
   docker-compose up -d
   ```

### Option 2: Using DigitalOcean App Platform

1. Push your code to a GitHub repository
2. Go to DigitalOcean App Platform
3. Create a new app and select your GitHub repository
4. Choose "Docker" as the deployment method
5. Configure environment variables
6. Deploy the app

## API Endpoints

### Create Export Job

```
POST /api/addresses/export
```

Headers:
- `Authorization: Bearer <your-api-key>`

Body:
```json
{
  "search": "optional search term",
  "postcode": "optional postcode",
  "woonplaats": "optional city",
  "minOppervlakte": 50,
  "maxOppervlakte": 150,
  "gebruiksdoel": "optional purpose",
  "minBouwjaar": 1980,
  "maxBouwjaar": 2022,
  "format": "csv",
  "batchSize": 50000
}
```

Response:
```json
{
  "jobId": "clhj5r2y0000008l01234abcd",
  "status": "pending",
  "message": "Export of 25,000 addresses has been started. Check status at /api/addresses/export/status?jobId=clhj5r2y0000008l01234abcd"
}
```

### Check Export Status

```
GET /api/addresses/export/status?jobId=<job-id>
```

Response:
```json
{
  "jobId": "clhj5r2y0000008l01234abcd",
  "status": "processing",
  "message": "Export of 25,000 addresses is in progress (65% complete)",
  "downloadUrl": null,
  "percentComplete": 65
}
```

When completed:
```json
{
  "jobId": "clhj5r2y0000008l01234abcd",
  "status": "completed",
  "message": "Export of 25,000 addresses is ready for download",
  "downloadUrl": "https://public.blob.vercel-storage.com/address-export-abc123.csv",
  "percentComplete": 100
}
```

### Cancel Export Job

```
POST /api/addresses/export/cancel
```

Headers:
- `Authorization: Bearer <your-api-key>`

Body:
```json
{
  "jobId": "clhj5r2y0000008l01234abcd"
}
```

Response:
```json
{
  "message": "Export job cancelled successfully"
}
```

### Health Check

```
GET /health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2025-03-26T12:34:56.789Z"
}
```

## Integration with Your Frontend

To integrate with your existing frontend:

1. Update your frontend environment to point to your export server for export-related API calls
2. Keep the same API paths and formats as before
3. Use the Blob URL from the export job to download the exported file

## Performance Considerations

- **Connection Pooling**: The server maintains a pool of database connections for optimal performance
- **Batch Processing**: Data is fetched and processed in batches to manage memory usage
- **Progress Tracking**: The server tracks export progress and provides percentage complete
- **Memory Management**: Data is streamed to Vercel Blob without loading everything into memory

## Troubleshooting

- **Database Connection Issues**: Check your DATABASE_URL and ensure your Neon database allows connections from your server's IP
- **Slow Exports**: Consider increasing the batchSize parameter (up to 100,000)
- **Memory Problems**: Decrease the batchSize parameter if you encounter memory issues

## Maintenance

- **Logs**: Check server logs for detailed information about export processing
- **Monitoring**: Use the /health endpoint to monitor server health
- **Scaling**: Increase server resources if you need to handle larger exports

## Security

- **API Authentication**: All export endpoints require API key authentication
- **Database Security**: The server uses secure connections to your Neon database
- **Input Validation**: All input parameters are validated before processing