// src/index.ts
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import { PrismaClient } from '@prisma/client';
import { put } from '@vercel/blob';
import { stringify } from 'csv-stringify';
import { z } from 'zod';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const port = process.env.PORT || 3001;

// Create a dedicated connection pool for exports
const exportPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
});

// Initialize Prisma client - we'll use this for metadata operations
// but use raw connections for the actual export processing
const prisma = new PrismaClient();

// Middleware
app.use(cors({
  origin: ['https://nederland-nine.vercel.app', 'http://localhost:3000'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Authentication middleware
const authenticate = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const apiKey = req.headers.authorization;
  
  if (!apiKey || apiKey !== `Bearer ${process.env.API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
};

// Define the ExportQuerySchema
const ExportQuerySchema = z.object({
  search: z.string().optional(),
  postcode: z.string().optional(),
  postcodeRange: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
  }).optional(),
  woonplaats: z.string().optional(),
  straat: z.string().optional(),
  minOppervlakte: z.coerce.number().int().optional(),
  maxOppervlakte: z.coerce.number().int().optional(),
  isOppervlakteActive: z.boolean().optional(),
  gebruiksdoel: z.string().optional(),
  minBouwjaar: z.coerce.number().int().optional(),
  maxBouwjaar: z.coerce.number().int().optional(),
  huisnummer: z.coerce.number().int().optional(),
  is_bruikbaar: z.boolean().optional(),
  adres_status: z.string().optional(),
  begindatum: z.string().optional(),
  einddatum: z.string().optional(),
  object_id: z.string().optional(),
  format: z.enum(['csv', 'zip']).default('csv'),
  batchSize: z.coerce.number().int().min(1000).max(100000).default(50000),
});

// Helper to build SQL WHERE clause
function buildWhereClause(filters: z.infer<typeof ExportQuerySchema>) {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;
  
  if (filters.search) {
    conditions.push(`(
      straat ILIKE $${paramIndex} OR
      woonplaats ILIKE $${paramIndex+1} OR
      postcode ILIKE $${paramIndex+2}
    )`);
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
    paramIndex += 3;
  }

  if (filters.postcode) {
    const cleanPostcode = filters.postcode.trim().toUpperCase();
    if (cleanPostcode) {
      conditions.push(`postcode ILIKE $${paramIndex}`);
      params.push(cleanPostcode + '%');
      paramIndex++;
    }
  }

  if (filters.postcodeRange?.from && filters.postcodeRange?.to) {
    conditions.push(`postcode >= $${paramIndex} AND postcode <= $${paramIndex+1}`);
    params.push(filters.postcodeRange.from, filters.postcodeRange.to);
    paramIndex += 2;
  }
  
  if (filters.straat) {
    conditions.push(`straat ILIKE $${paramIndex}`);
    params.push(`%${filters.straat}%`);
    paramIndex++;
  }

  if (filters.woonplaats) {
    conditions.push(`woonplaats ILIKE $${paramIndex}`);
    params.push(`%${filters.woonplaats}%`);
    paramIndex++;
  }

  if (filters.huisnummer) {
    conditions.push(`huisnummer = $${paramIndex}`);
    params.push(filters.huisnummer);
    paramIndex++;
  }

  if (filters.isOppervlakteActive && filters.minOppervlakte !== undefined) {
    conditions.push(`oppervlakte >= $${paramIndex}`);
    params.push(filters.minOppervlakte);
    paramIndex++;
  }
  
  if (filters.isOppervlakteActive && filters.maxOppervlakte !== undefined) {
    conditions.push(`oppervlakte <= $${paramIndex}`);
    params.push(filters.maxOppervlakte);
    paramIndex++;
  }

  if (filters.gebruiksdoel) {
    conditions.push(`$${paramIndex} = ANY(gebruiksdoel)`);
    params.push(filters.gebruiksdoel);
    paramIndex++;
  }

  if (filters.minBouwjaar !== undefined) {
    conditions.push(`"oorspronkelijkBouwjaar" >= $${paramIndex}`);
    params.push(filters.minBouwjaar);
    paramIndex++;
  }
  
  if (filters.maxBouwjaar !== undefined) {
    conditions.push(`"oorspronkelijkBouwjaar" <= $${paramIndex}`);
    params.push(filters.maxBouwjaar);
    paramIndex++;
  }
  
  if (filters.adres_status) {
    conditions.push(`adres_status = $${paramIndex}`);
    params.push(filters.adres_status);
    paramIndex++;
  }

  if (filters.is_bruikbaar !== undefined) {
    conditions.push(`is_bruikbaar = $${paramIndex}`);
    params.push(filters.is_bruikbaar);
    paramIndex++;
  }

  return {
    whereClause: conditions.length ? conditions.join(' AND ') : '',
    params,
    nextParamIndex: paramIndex
  };
}

// Generate a descriptive filename
function generateExportFilename(filters: z.infer<typeof ExportQuerySchema>, format: 'csv' | 'zip'): string {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  let filename = `addresses_${date}`;
  
  try {
    if (filters.search && typeof filters.search === 'string' && filters.search.trim()) {
      const cleanSearch = filters.search.trim().replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20);
      if (cleanSearch) filename += `_${cleanSearch}`;
    }
    
    if (filters.woonplaats && typeof filters.woonplaats === 'string' && filters.woonplaats.trim()) {
      const cleanCity = filters.woonplaats.trim().replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20);
      if (cleanCity) filename += `_${cleanCity}`;
    }
    
    if (filters.postcode && typeof filters.postcode === 'string' && filters.postcode.trim()) {
      filename += `_${filters.postcode.trim()}`;
    }
    
    if (typeof filters.minBouwjaar === 'number' && typeof filters.maxBouwjaar === 'number') {
      filename += `_${filters.minBouwjaar}-${filters.maxBouwjaar}`;
    }
  } catch (e) {
    console.error('Error generating filename:', e);
  }
  
  // Add extension
  filename += `.${format}`;
  return filename;
}

// API endpoint to create export job
app.post('/api/addresses/export', authenticate, async (req, res) => {
  try {
    let filters;
    try {
      filters = ExportQuerySchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          error: 'Invalid query parameters', 
          details: error.errors 
        });
      }
      throw error;
    }

    console.log('Export filters:', filters);
    
    // Build WHERE clause to count records
    const { whereClause, params } = buildWhereClause(filters);
    
    // Count records to be exported
    const client = await exportPool.connect();
    
    try {
      let countQuery = 'SELECT COUNT(*) as count FROM address_view_materialized';
      if (whereClause) {
        countQuery += ` WHERE ${whereClause}`;
      }
      
      const totalCount = await client.query(countQuery, params);
      const count = Number(totalCount.rows[0].count);
      
      console.log(`Found ${count} records to export`);
      
      // Check for rate limiting
      const MAX_RECORDS = 10000000; // 10 million records
      if (count > MAX_RECORDS) {
        return res.status(400).json({
          error: `Too many addresses found (${count.toLocaleString('nl-NL')}). Maximum is ${MAX_RECORDS.toLocaleString('nl-NL')} addresses. Use filters to reduce the number of results.`
        });
      }
      
      // For small exports (< 1000 records), we could process immediately
      // But for consistency with your existing API, we'll always use the job approach
      
      // Create job in database
      const jobId = createId();
      const job = await prisma.exportJob.create({
        data: {
          id: jobId,
          status: 'pending',
          format: filters.format,
          count,
          filters: filters as any, // JSON field in Prisma
          createdAt: new Date(),
        }
      });
      
      // Start processing in the background
      processExport(job.id).catch(error => {
        console.error('Error in export processing:', error);
        prisma.exportJob.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            error: error instanceof Error ? error.message : 'Unknown error processing export',
            completedAt: new Date()
          }
        }).catch(updateError => {
          console.error('Error updating job status after processing error:', updateError);
        });
      });
      
      return res.status(200).json({
        jobId: job.id,
        status: 'pending',
        message: `Export of ${count} addresses has been started. Check status at /api/addresses/export/status?jobId=${job.id}`
      });
      
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error creating export job:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// API endpoint to check export status
app.get('/api/addresses/export/status', async (req, res) => {
  try {
    const jobId = req.query.jobId as string;
    
    if (!jobId) {
      return res.status(400).json({ error: 'Missing jobId parameter' });
    }
    
    const job = await prisma.exportJob.findUnique({
      where: { id: jobId }
    });
    
    if (!job) {
      return res.status(404).json({ error: 'Export job not found' });
    }
    
    return res.status(200).json({
      jobId: job.id,
      status: job.status,
      message: getStatusMessage(job),
      downloadUrl: job.blobUrl,
      percentComplete: job.percentComplete,
    });
  } catch (error) {
    console.error('Error checking export status:', error);
    return res.status(500).json({ error: 'Error checking export status' });
  }
});

// API endpoint to cancel export job
app.post('/api/addresses/export/cancel', authenticate, async (req, res) => {
  try {
    const { jobId } = req.body;
    
    if (!jobId) {
      return res.status(400).json({ error: 'Missing jobId parameter' });
    }
    
    const job = await prisma.exportJob.findUnique({
      where: { id: jobId }
    });
    
    if (!job) {
      return res.status(404).json({ error: 'Export job not found' });
    }
    
    // Only allow cancellation of pending or processing jobs
    if (job.status !== 'pending' && job.status !== 'processing') {
      return res.status(400).json({ 
        error: `Cannot cancel job with status: ${job.status}`
      });
    }
    
    // Mark the job as cancelled
    await prisma.exportJob.update({
      where: { id: jobId },
      data: {
        status: 'cancelled',
        completedAt: new Date(),
        error: 'Cancelled by user'
      }
    });
    
    return res.status(200).json({ 
      message: 'Export job cancelled successfully' 
    });
  } catch (error) {
    console.error('Error cancelling export job:', error);
    return res.status(500).json({ error: 'Error cancelling export job' });
  }
});

// Helper function for status messages
function getStatusMessage(job: any) {
  switch (job.status) {
    case 'pending':
      return `Export of ${job.count.toLocaleString()} addresses is queued`;
    case 'processing':
      return `Export of ${job.count.toLocaleString()} addresses is in progress (${job.percentComplete || 0}% complete)`;
    case 'completed':
      return `Export of ${job.count.toLocaleString()} addresses is ready for download`;
    case 'failed':
      return `Export failed: ${job.error || 'Unknown error'}`;
    case 'cancelled':
      return 'Export was cancelled';
    default:
      return 'Unknown status';
  }
}

// Process export in the background
async function processExport(jobId: string): Promise<void> {
  const startTime = Date.now();
  let totalQueryTime = 0;
  let totalProcessingTime = 0;
  let totalStreamingTime = 0;
  
  // Acquire a client for the entire export process
  const client = await exportPool.connect();
  
  try {
    // Get job details from database
    const jobResult = await client.query(
      'SELECT * FROM export_jobs WHERE id = $1',
      [jobId]
    );
    
    const job = jobResult.rows[0];
    if (!job) {
      throw new Error('Export job not found');
    }
    
    // Update status to processing
    await client.query(
      `UPDATE export_jobs 
       SET status = 'processing', 
           "startedAt" = NOW(), 
           "processedCount" = 0, 
           "percentComplete" = 0 
       WHERE id = $1`,
      [jobId]
    );
    
    console.log('Export filters:', job.filters);
    
    // Build WHERE clause from filters
    const { whereClause, params, nextParamIndex } = buildWhereClause(job.filters);
    
    console.log('Export WHERE clause:', whereClause);
    
    // Create a stream for uploading directly to blob
    const filename = generateExportFilename(job.filters, job.format);
    const { readable, writable } = new TransformStream();
    
    // Start upload to Blob storage asynchronously
    const uploadPromise = put(filename, readable, {
      contentType: 'text/csv; charset=utf-8',
      access: 'public',
    });
    
    // Get a writer to stream data to Blob
    const writer = writable.getWriter();
    
    // Define columns
    const columns = [
      { key: 'postcode', header: 'Postcode' },
      { key: 'huisnummer', header: 'Huisnummer' },
      { key: 'huisletter', header: 'Huisletter' },
      { key: 'huisnummertoevoeging', header: 'Toevoeging' },
      { key: 'straat', header: 'Straat' },
      { key: 'woonplaats', header: 'Woonplaats' },
      { key: 'oppervlakte', header: 'Oppervlakte' },
      { key: 'gebruiksdoel', header: 'Gebruiksdoel' },
      { key: 'oorspronkelijkBouwjaar', header: 'Bouwjaar' },
      { key: 'latitude', header: 'Latitude' },
      { key: 'longitude', header: 'Longitude' },
      { key: 'rd_x', header: 'RD X' },
      { key: 'rd_y', header: 'RD Y' },
      { key: 'is_ligplaats', header: 'Is Ligplaats' },
      { key: 'is_standplaats', header: 'Is Standplaats' },
      { key: 'is_verblijfsobject', header: 'Is Verblijfsobject' },
      { key: 'status', header: 'Status' }
    ];
    
    try {
      // Write CSV header first
      const headerRow = columns.map(col => col.header).join(',') + '\n';
      await writer.write(new TextEncoder().encode(headerRow));
      
      // Process in batches
      const batchSize = job.filters.batchSize || 100000;
      const chunkSize = 10000;  // Process in smaller chunks for memory efficiency
      let lastPostcode = '';
      let lastHuisnummer = 0;
      let hasMoreRecords = true;
      let totalProcessed = 0;
      let batchCount = 0;
      
      while (hasMoreRecords) {
        const batchStart = Date.now();
        
        // Check if job was cancelled
        const jobStatusResult = await client.query(
          'SELECT status FROM export_jobs WHERE id = $1',
          [jobId]
        );
        
        if (jobStatusResult.rows[0]?.status === 'cancelled') {
          console.log(`Export job ${jobId} was cancelled, stopping processing`);
          break;
        }
        
        // Fetch data for this batch
        const queryStart = Date.now();
        
        // Build the query with the correct parameter positions
        let query = `
          SELECT 
            "postcode",
            "huisnummer",
            "huisletter",
            "huisnummertoevoeging",
            "straat",
            "woonplaats",
            "oppervlakte",
            "gebruiksdoel",
            "oorspronkelijkBouwjaar",
            "latitude",
            "longitude",
            "rd_x",
            "rd_y",
            "is_ligplaats",
            "is_standplaats",
            "is_verblijfsobject",
            "adres_status" AS "status"
          FROM address_view_materialized
        `;
        
        // Add WHERE clause if needed
        const allParams = [...params];
        
        if (whereClause) {
          query += ` WHERE ${whereClause}`;
          
          // Add the pagination condition
          query += ` AND (
            "postcode" > $${nextParamIndex} OR 
            ("postcode" = $${nextParamIndex+1} AND "huisnummer" > $${nextParamIndex+2})
          )`;
        } else {
          // No filters, just add the pagination condition
          query += ` WHERE (
            "postcode" > $${nextParamIndex} OR 
            ("postcode" = $${nextParamIndex+1} AND "huisnummer" > $${nextParamIndex+2})
          )`;
        }
        
        // Add pagination parameters
        allParams.push(lastPostcode, lastPostcode, lastHuisnummer);
        
        // Add ORDER BY and LIMIT
        query += ` ORDER BY "postcode", "huisnummer" LIMIT $${nextParamIndex+3}`;
        allParams.push(batchSize);
        
        const addressesResult = await client.query(query, allParams);
        const addresses = addressesResult.rows;
        const queryTime = Date.now() - queryStart;
        totalQueryTime += queryTime;
        
        console.log(`Batch query took ${queryTime}ms for ${addresses.length} addresses`);
        
        // If we got fewer records than batch size, we've reached the end
        if (addresses.length < batchSize) {
          hasMoreRecords = false;
        }
        
        if (addresses.length > 0) {
          // Update pagination cursor
          lastPostcode = addresses[addresses.length - 1].postcode;
          lastHuisnummer = addresses[addresses.length - 1].huisnummer;
          
          // Process in smaller chunks to avoid memory issues
          for (let i = 0; i < addresses.length; i += chunkSize) {
            const chunkStart = Date.now();
            const chunk = addresses.slice(i, i + chunkSize);
            
            // Process the gebruiksdoel array to a comma-separated string
            const processingStart = Date.now();
            const processedAddresses = chunk.map(address => ({
              ...address,
              gebruiksdoel: Array.isArray(address.gebruiksdoel) 
                ? address.gebruiksdoel.join(', ') 
                : address.gebruiksdoel,
            }));
            
            // Convert to CSV and write to stream
            const csvChunk = stringify(processedAddresses, { header: false }).toString();
            const processingTime = Date.now() - processingStart;
            totalProcessingTime += processingTime;
            
            const streamStart = Date.now();
            await writer.write(new TextEncoder().encode(csvChunk));
            const streamTime = Date.now() - streamStart;
            totalStreamingTime += streamTime;
            
            // Update counters
            totalProcessed += chunk.length;
            
            // Calculate percentage complete
            const percentComplete = Math.round((totalProcessed / job.count) * 100);
            
            // Only update database every 5% progress to reduce updates
            if (percentComplete % 5 === 0 || i + chunkSize >= addresses.length) {
              await client.query(
                `UPDATE export_jobs 
                 SET "processedCount" = $1, 
                     "percentComplete" = $2 
                 WHERE id = $3 AND "percentComplete" < $2`,
                [totalProcessed, percentComplete, jobId]
              );
              
              console.log(`Export ${jobId}: ${percentComplete}% complete (${totalProcessed}/${job.count})`);
            }
          }
          
          batchCount++;
        }
      }
      
      // Close the writer to signal we're done
      await writer.close();
      
      // Wait for the upload to complete
      const uploadStart = Date.now();
      const blob = await uploadPromise;
      const uploadTime = Date.now() - uploadStart;
      
      // Update job to completed
      await client.query(
        `UPDATE export_jobs 
         SET status = 'completed',
             "processedCount" = $1,
             "percentComplete" = 100,
             "completedAt" = NOW(),
             "blobUrl" = $2
         WHERE id = $3`,
        [totalProcessed, blob.url, jobId]
      );
      
      // Log performance metrics
      const totalTime = Date.now() - startTime;
      console.log(
        `Export ${jobId} completed successfully\n` +
        `Performance metrics:\n` +
        `- Total time: ${(totalTime/1000).toFixed(1)}s\n` +
        `- Records per second: ${Math.round((totalProcessed / totalTime) * 1000)}\n` +
        `- Total records: ${totalProcessed.toLocaleString()}`
      );
      
    } catch (error) {
      // Make sure to close the writer on error
      try {
        await writer.abort(error as Error);
      } catch (abortError) {
        console.error('Error aborting writer:', abortError);
      }
      
      console.error('Error in processExport:', error);
      
      // Update job with error status
      await client.query(
        `UPDATE export_jobs 
         SET status = 'failed',
             error = $1,
             "completedAt" = NOW()
         WHERE id = $2`,
        [error instanceof Error ? error.message : 'Unknown error during export processing', jobId]
      );
      
      // Re-throw the error
      throw error;
    }
  } catch (error) {
    console.error('Error in processExport:', error);
    
    // Update job with error status
    await client.query(
      `UPDATE export_jobs 
       SET status = 'failed',
           error = $1,
           "completedAt" = NOW()
       WHERE id = $2`,
      [error instanceof Error ? error.message : 'Unknown error during export processing', jobId]
    );
    
    throw error;
  } finally {
    // Release the client when done
    client.release();
  }
}

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Check database connection
    await prisma.$queryRaw`SELECT 1`;
    
    return res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Health check failed:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Database connection failed'
    });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Export server running on port ${port}`);
});