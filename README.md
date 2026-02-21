# Address Export Server

A dedicated server for high-performance exports and CSV enrichment from your address database. This server maintains persistent database connections to eliminate the connection overhead in serverless environments, dramatically improving export performance.

## Features

- **High Performance**: Maintains persistent database connections with connection pooling
- **Streaming**: Uses PostgreSQL server-side cursors to minimize memory usage
- **Progress Tracking**: Provides real-time progress updates for all async jobs
- **CSV Enrichment**: Upload a CSV of addresses and enrich it with BAG, energy label, WOZ, coordinate, and address data
- **Auto-Detection**: Automatically detects CSV columns and delimiters (comma or semicolon)
- **Category Filtering**: Choose which enrichment categories to include (bag, coordinaten, energielabel, woz, adres)
- **Energy Label & WOZ Data**: Exports include energy labels and WOZ property valuations
- **Scalable**: Can handle up to 1,000,000 addresses per export and 100,000 rows per enrichment
- **Vercel Blob Integration**: Uses Vercel Blob for storing export and enrichment files
- **Cancellation Support**: Running jobs can be cancelled at any time

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
   - `PORT`: Server port (default: `3001`)

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
  "postcodeRange": {
    "from": "1000AA",
    "to": "1999ZZ"
  },
  "woonplaats": "optional city",
  "straat": "optional street",
  "huisnummer": 42,
  "minOppervlakte": 50,
  "maxOppervlakte": 150,
  "isOppervlakteActive": true,
  "gebruiksdoel": "optional purpose",
  "minBouwjaar": 1980,
  "maxBouwjaar": 2022,
  "is_bruikbaar": true,
  "adres_status": "optional status",
  "begindatum": "optional start date",
  "einddatum": "optional end date",
  "object_id": "optional object ID",
  "format": "csv",
  "batchSize": 200000
}
```

All filter fields are optional. The `format` defaults to `csv` (also supports `zip`). The `batchSize` ranges from 1,000 to 200,000 (default: 200,000). A maximum of 1,000,000 records can be exported per job.

Response:
```json
{
  "jobId": "clhj5r2y0000008l01234abcd",
  "status": "pending",
  "message": "Export of 25,000 addresses has been started. Check status at /api/addresses/export/status?jobId=clhj5r2y0000008l01234abcd"
}
```

#### Export CSV Columns

Exported files include the following columns:

| Column | Description |
|---|---|
| Postcode | Postal code |
| Huisnummer | House number |
| Huisletter | House letter |
| Nummer Toevoeging | House number addition |
| Huisnummertoevoeging | Combined letter + addition |
| Straat | Street name |
| Woonplaats | City |
| Oppervlakte | Surface area (m²) |
| Gebruiksdoel | Usage purpose |
| Bouwjaar | Construction year |
| Energielabel | Energy label class |
| WOZ Waarde | WOZ property value |
| WOZ Peildatum | WOZ valuation date |
| Latitude | GPS latitude |
| Longitude | GPS longitude |
| RD X | Rijksdriehoek X coordinate |
| RD Y | Rijksdriehoek Y coordinate |
| Is Ligplaats | Is houseboat berth |
| Is Standplaats | Is mobile home pitch |
| Is Verblijfsobject | Is dwelling |
| Status | Address status |

### Check Export Status

```
GET /api/addresses/export/status?jobId=<job-id>
```

This endpoint is used for both export and enrichment jobs.

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

### CSV Enrichment

Upload a CSV file containing address data and enrich it with additional information from the database.

```
POST /api/addresses/enrich
```

Headers:
- `Authorization: Bearer <your-api-key>`
- `Content-Type: multipart/form-data`

Form data fields:
- `file` (required): CSV file to enrich (max 50 MB)
- `categories` (optional): JSON array of enrichment categories to include

**CSV requirements:**
- Must contain at least `postcode` and `huisnummer` columns
- Columns are auto-detected by name (supports common variations like `postal_code`, `house_number`, `zip`, `nr`, etc.)
- Delimiter is auto-detected (comma or semicolon)
- Maximum 100,000 rows

**Enrichment categories** (default: all):
- `bag` — Oppervlakte, Bouwjaar, Gebruiksdoel, Object ID
- `coordinaten` — Latitude, Longitude, RD X, RD Y
- `energielabel` — Energielabel
- `woz` — WOZ Waarde, WOZ Peildatum
- `adres` — Straat (BAG), Woonplaats (BAG)

Example with curl:
```bash
# Enrich with all categories
curl -X POST https://your-server/api/addresses/enrich \
  -H "Authorization: Bearer your-api-key" \
  -F "file=@addresses.csv"

# Enrich with specific categories only
curl -X POST https://your-server/api/addresses/enrich \
  -H "Authorization: Bearer your-api-key" \
  -F "file=@addresses.csv" \
  -F 'categories=["bag", "energielabel"]'
```

Response:
```json
{
  "jobId": "clhj5r2y0000008l01234abcd",
  "status": "pending",
  "rowCount": 5000,
  "columnsDetected": {
    "postcode": "Postcode",
    "huisnummer": "Huisnummer",
    "huisletter": "Huisletter",
    "huisnummertoevoeging": null
  },
  "message": "Enrichment of 5000 rows started. Check status at /api/addresses/export/status?jobId=clhj5r2y0000008l01234abcd"
}
```

The enrichment result is a CSV containing all original columns plus the enrichment columns for the selected categories. Track progress using the same `/api/addresses/export/status` endpoint.

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

- **Connection Pooling**: The server maintains a pool of 10 database connections for optimal performance
- **Server-Side Cursors**: Data is fetched using PostgreSQL cursors in batches of 5,000 rows, avoiding OFFSET degradation
- **Separate Progress Connection**: Progress updates use a dedicated connection so they are visible immediately outside the cursor transaction
- **Batch Processing**: Data is fetched and processed in batches to manage memory usage
- **Cancellation Checks**: Running jobs check for cancellation every 50,000 rows

## Troubleshooting

- **Database Connection Issues**: Check your DATABASE_URL and ensure your Neon database allows connections from your server's IP
- **Slow Exports**: Consider increasing the batchSize parameter (up to 200,000)
- **Memory Problems**: Decrease the batchSize parameter if you encounter memory issues
- **File Too Large**: The enrichment endpoint accepts CSV files up to 50 MB. Reduce the file size or split it into multiple uploads
- **Row Limit Exceeded**: Enrichment supports up to 100,000 rows per upload. Split larger files into batches

## Maintenance

- **Logs**: Check server logs for detailed information about export processing
- **Monitoring**: Use the /health endpoint to monitor server health
- **Scaling**: Increase server resources if you need to handle larger exports

## Security

- **API Authentication**: All export and enrichment endpoints require Bearer token authentication
- **Database Security**: The server uses secure SSL connections to your Neon database
- **Input Validation**: All input parameters are validated with Zod schemas before processing
- **File Validation**: Only CSV files are accepted for enrichment, with size limits enforced
