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
import { Readable } from 'stream';
import JSZip from 'jszip';

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
  ssl: {
    rejectUnauthorized: false  // Accept self-signed certificates from DigitalOcean
  }
});

// Initialize Prisma client - we'll use this for metadata operations
// but use raw connections for the actual export processing
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL
    }
  }
});

// Middleware
app.use(cors({
  origin: [
    'https://nederland-nine.vercel.app',
    'https://contactbuddy.nl',
    'https://www.contactbuddy.nl',
    'http://localhost:3000'
  ],
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
  batchSize: z.coerce.number().int().min(1000).max(200000).default(200000),
});

// Helper to build SQL WHERE clause
function buildWhereClause(filters: z.infer<typeof ExportQuerySchema>) {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  // Sanitize incoming string filters to avoid whitespace-related mismatches
  const search = typeof filters.search === 'string' ? filters.search.trim() : undefined;
  const straat = typeof filters.straat === 'string' ? filters.straat.trim() : undefined;
  const woonplaats = typeof filters.woonplaats === 'string' ? filters.woonplaats.trim() : undefined;
  const adres_status = typeof filters.adres_status === 'string' ? filters.adres_status.trim() : undefined;
  const gebruiksdoel = typeof filters.gebruiksdoel === 'string' ? filters.gebruiksdoel.trim() : undefined;

  if (search) {
    conditions.push(`(
      ae.straat ILIKE $${paramIndex} OR
      ae.woonplaats ILIKE $${paramIndex + 1} OR
      ae.postcode ILIKE $${paramIndex + 2}
    )`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    paramIndex += 3;
  }

  if (filters.postcode) {
    // Use exact matching with cleaned postcode - consistent with frontend
    const cleanPostcode = filters.postcode.replace(/\s+/g, '').toUpperCase();
    if (cleanPostcode) {
      conditions.push(`ae.postcode = $${paramIndex}`);
      params.push(cleanPostcode);
      paramIndex++;
    }
  }

  // Normalize postcode range values (strip spaces, uppercase) and only apply when both are set
  const rangeFromRaw = filters.postcodeRange?.from;
  const rangeToRaw = filters.postcodeRange?.to;
  const rangeFrom = typeof rangeFromRaw === 'string' ? rangeFromRaw.replace(/\s+/g, '').toUpperCase() : undefined;
  const rangeTo = typeof rangeToRaw === 'string' ? rangeToRaw.replace(/\s+/g, '').toUpperCase() : undefined;
  if (rangeFrom && rangeTo) {
    conditions.push(`ae.postcode >= $${paramIndex} AND ae.postcode <= $${paramIndex + 1}`);
    params.push(rangeFrom, rangeTo);
    paramIndex += 2;
  }

  if (straat) {
    // Exact matching to align with frontend behavior
    conditions.push(`ae.straat = $${paramIndex}`);
    params.push(straat);
    paramIndex++;
  }

  if (woonplaats) {
    // Exact matching to align with frontend behavior
    conditions.push(`ae.woonplaats = $${paramIndex}`);
    params.push(woonplaats);
    paramIndex++;
  }

  if (filters.huisnummer) {
    conditions.push(`ae.huisnummer = $${paramIndex}`);
    params.push(filters.huisnummer);
    paramIndex++;
  }

  if (filters.isOppervlakteActive && filters.minOppervlakte !== undefined) {
    conditions.push(`ae.oppervlakte >= $${paramIndex}`);
    params.push(filters.minOppervlakte);
    paramIndex++;
  }

  if (filters.isOppervlakteActive && filters.maxOppervlakte !== undefined) {
    conditions.push(`ae.oppervlakte <= $${paramIndex}`);
    params.push(filters.maxOppervlakte);
    paramIndex++;
  }

  if (gebruiksdoel) {
    conditions.push(`$${paramIndex} = ANY(ae.gebruiksdoel)`);
    params.push(gebruiksdoel);
    paramIndex++;
  }

  if (filters.minBouwjaar !== undefined) {
    conditions.push(`ae."oorspronkelijkBouwjaar" >= $${paramIndex}`);
    params.push(filters.minBouwjaar);
    paramIndex++;
  }

  if (filters.maxBouwjaar !== undefined) {
    conditions.push(`ae."oorspronkelijkBouwjaar" <= $${paramIndex}`);
    params.push(filters.maxBouwjaar);
    paramIndex++;
  }

  if (adres_status) {
    conditions.push(`ae.adres_status = $${paramIndex}`);
    params.push(adres_status);
    paramIndex++;
  }

  if (filters.is_bruikbaar !== undefined) {
    conditions.push(`ae.is_bruikbaar = $${paramIndex}`);
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
      let countQuery = 'SELECT COUNT(*) as count FROM address_export ae';
      if (whereClause) {
        countQuery += ` WHERE ${whereClause}`;
      }
      
      const totalCount = await client.query(countQuery, params);
      const count = Number(totalCount.rows[0].count);
      
      console.log(`Found ${count} records to export`);
      
      // Check for rate limiting
      const MAX_RECORDS = 1000000; // 10 million records
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
    
    // Generate filename
    const filename = generateExportFilename(job.filters, job.format);
    
    try {
      // Process based on format
      if (job.format === 'csv') {
        await processCSVExport(job, whereClause, params, nextParamIndex, client, filename);
      } else if (job.format === 'zip') {
        await processZIPExport(job, whereClause, params, nextParamIndex, client, filename);
      } else {
        throw new Error(`Unsupported export format: ${job.format}`);
      }
      
      // Log performance metrics
      const totalTime = Date.now() - startTime;
      console.log(
        `Export ${jobId} completed successfully\n` +
        `Performance metrics:\n` +
        `- Total time: ${(totalTime/1000).toFixed(1)}s\n` +
        `- Total records: ${job.count.toLocaleString()}`
      );
      
    } catch (error) {
      console.error('Error in export processing:', error);
      
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

interface ExportJob {
  id: string;
  status: string;
  format: 'csv' | 'zip';
  count: number;
  filters: any;
  createdAt: Date;
}

interface Address {
  postcode: string;
  huisnummer: number;
  huisletter?: string;
  huisnummertoevoeging?: string;
  huisnummer_toevoeging_gecombineerd?: string | null;
  straat: string;
  woonplaats: string;
  oppervlakte?: number;
  gebruiksdoel?: string | string[];
  oorspronkelijkBouwjaar?: number;
  latitude?: number;
  longitude?: number;
  rd_x?: number;
  rd_y?: number;
  is_ligplaats?: boolean;
  is_standplaats?: boolean;
  is_verblijfsobject?: boolean;
  status?: string;
  [key: string]: any; // Add index signature
}

const EXPORT_COLUMNS = [
  { key: 'postcode', header: 'Postcode' },
  { key: 'huisnummer', header: 'Huisnummer' },
  { key: 'huisletter', header: 'Huisletter' },
  { key: 'huisnummertoevoeging', header: 'Nummer Toevoeging' },
  { key: 'huisnummer_toevoeging_gecombineerd', header: 'Huisnummertoevoeging' },
  { key: 'straat', header: 'Straat' },
  { key: 'woonplaats', header: 'Woonplaats' },
  { key: 'oppervlakte', header: 'Oppervlakte' },
  { key: 'gebruiksdoel', header: 'Gebruiksdoel' },
  { key: 'oorspronkelijkBouwjaar', header: 'Bouwjaar' },
  { key: 'energieklasse', header: 'Energielabel' },
  { key: 'woz_waarde', header: 'WOZ Waarde' },
  { key: 'woz_peildatum', header: 'WOZ Peildatum' },
  { key: 'latitude', header: 'Latitude' },
  { key: 'longitude', header: 'Longitude' },
  { key: 'rd_x', header: 'RD X' },
  { key: 'rd_y', header: 'RD Y' },
  { key: 'is_ligplaats', header: 'Is Ligplaats' },
  { key: 'is_standplaats', header: 'Is Standplaats' },
  { key: 'is_verblijfsobject', header: 'Is Verblijfsobject' },
  { key: 'status', header: 'Status' }
];

function processAddress(address: Address): Address {
  let huisnummer_toevoeging_gecombineerd = null;
  if (address.huisletter || address.huisnummertoevoeging) {
    const letter = address.huisletter?.trim() || '';
    const additionRaw = address.huisnummertoevoeging?.trim() || '';
    const addition = additionRaw.replace(/\s+/g, '');
    if (letter && addition) {
      huisnummer_toevoeging_gecombineerd = /^\d/.test(addition)
        ? `${letter}${addition}`
        : `${letter}-${addition}`;
    } else if (letter) {
      huisnummer_toevoeging_gecombineerd = letter;
    } else if (addition) {
      huisnummer_toevoeging_gecombineerd = addition;
    }
  }

  // Format WOZ peildatum as YYYY-MM-DD
  const woz_peildatum = address.woz_peildatum
    ? new Date(address.woz_peildatum).toISOString().split('T')[0]
    : null;

  return {
    ...address,
    gebruiksdoel: Array.isArray(address.gebruiksdoel)
      ? address.gebruiksdoel.join(', ')
      : address.gebruiksdoel,
    huisnummer_toevoeging_gecombineerd,
    woz_peildatum
  };
}

function addressToCSVRow(address: Address): string {
  return EXPORT_COLUMNS.map(col => {
    const value = address[col.key];
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }).join(',');
}

function buildCursorQuery(whereClause: string): string {
  return `
    SELECT
      ae."postcode",
      ae."huisnummer",
      ae."huisletter",
      ae."huisnummertoevoeging",
      ae."straat",
      ae."woonplaats",
      ae."oppervlakte",
      ae."gebruiksdoel",
      ae."oorspronkelijkBouwjaar",
      ae."latitude",
      ae."longitude",
      ae."rd_x",
      ae."rd_y",
      ae."is_ligplaats",
      ae."is_standplaats",
      ae."is_verblijfsobject",
      ae."adres_status" AS "status",
      el."energieKlasse" AS "energieklasse",
      woz."wozWaarde" AS "woz_waarde",
      woz."wozPeildatum" AS "woz_peildatum"
    FROM address_export ae
    LEFT JOIN energy_label_enrichment el
      ON el."verblijfsobjectId" = LPAD(REPLACE(ae.object_id, 'NL.IMBAG.Verblijfsobject.', ''), 16, '0')
    LEFT JOIN woz_address_enrichment woz
      ON woz."verblijfsobjectId" = ae.object_id
    ${whereClause ? `WHERE ${whereClause}` : ''}
    ORDER BY ae."postcode", ae."huisnummer",
             COALESCE(ae."huisletter", ''), COALESCE(ae."huisnummertoevoeging", '')
  `;
}

async function processCSVExport(
  job: ExportJob,
  whereClause: string,
  params: any[],
  nextParamIndex: number,
  client: any,
  filename: string
): Promise<void> {
  const CURSOR_BATCH = 5000;
  const CANCEL_CHECK_INTERVAL = 50000;

  // Use a separate connection for progress updates and cancellation checks
  // so they are visible outside the cursor transaction.
  const progressClient = await exportPool.connect();

  const chunks: Buffer[] = [];
  // Header row
  chunks.push(Buffer.from(EXPORT_COLUMNS.map(col => col.header).join(',') + '\n', 'utf-8'));

  // Use a server-side cursor for sequential scan (no OFFSET degradation)
  await client.query('BEGIN');
  try {
    const cursorQuery = buildCursorQuery(whereClause);
    await client.query(`DECLARE export_cursor CURSOR FOR ${cursorQuery}`, params);

    let totalProcessed = 0;
    let lastPercentReported = -1;
    let cancelled = false;

    while (true) {
      const result = await client.query(`FETCH ${CURSOR_BATCH} FROM export_cursor`);
      const rows = result.rows;
      if (rows.length === 0) break;

      // Convert batch to CSV lines and collect as Buffer
      const lines: string[] = [];
      for (const row of rows) {
        const processed = processAddress(row);
        lines.push(addressToCSVRow(processed));
      }
      chunks.push(Buffer.from(lines.join('\n') + '\n', 'utf-8'));

      totalProcessed += rows.length;

      // Progress update every 5% — via separate connection so it's immediately visible
      const percentComplete = Math.round((totalProcessed / job.count) * 100);
      if (percentComplete !== lastPercentReported && percentComplete % 5 === 0) {
        lastPercentReported = percentComplete;
        await progressClient.query(
          `UPDATE export_jobs
           SET "processedCount" = $1,
               "percentComplete" = $2
           WHERE id = $3 AND "percentComplete" < $2`,
          [totalProcessed, percentComplete, job.id]
        );
        console.log(`Export ${job.id}: ${percentComplete}% complete (${totalProcessed}/${job.count})`);
      }

      // Cancellation check every 50K rows — via separate connection
      if (totalProcessed % CANCEL_CHECK_INTERVAL < CURSOR_BATCH) {
        const jobStatusResult = await progressClient.query(
          'SELECT status FROM export_jobs WHERE id = $1',
          [job.id]
        );
        if (jobStatusResult.rows[0]?.status === 'cancelled') {
          console.log(`Export job ${job.id} was cancelled, stopping processing`);
          cancelled = true;
          break;
        }
      }
    }

    await client.query('CLOSE export_cursor');
    await client.query('COMMIT');

    if (cancelled) return;

    // Assemble final buffer with BOM
    const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
    const totalSize = BOM.length + chunks.reduce((sum, c) => sum + c.length, 0);
    const bufferWithBOM = Buffer.concat([BOM, ...chunks], totalSize);

    console.log(`CSV generation complete. Total size: ${bufferWithBOM.length} bytes`);

    const readableStream = Readable.from(bufferWithBOM);

    // Upload to Vercel Blob Storage
    console.log(`Uploading CSV to Vercel Blob Storage as ${filename}`);
    const blob = await put(filename, readableStream, {
      contentType: 'text/csv; charset=utf-8',
      access: 'public',
    });

    console.log(`Upload successful. URL: ${blob.url}`);

    await progressClient.query(
      `UPDATE export_jobs
       SET status = 'completed',
           "processedCount" = $1,
           "percentComplete" = 100,
           "completedAt" = NOW(),
           "blobUrl" = $2
       WHERE id = $3`,
      [totalProcessed, blob.url, job.id]
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    progressClient.release();
  }
}

async function processZIPExport(
  job: ExportJob,
  whereClause: string,
  params: any[],
  nextParamIndex: number,
  client: any,
  filename: string
): Promise<void> {
  const zip = new JSZip();
  const CURSOR_BATCH = 5000;
  const CANCEL_CHECK_INTERVAL = 50000;

  const progressClient = await exportPool.connect();

  const chunks: Buffer[] = [];
  chunks.push(Buffer.from(EXPORT_COLUMNS.map(col => col.header).join(',') + '\n', 'utf-8'));

  await client.query('BEGIN');
  try {
    const cursorQuery = buildCursorQuery(whereClause);
    await client.query(`DECLARE export_cursor CURSOR FOR ${cursorQuery}`, params);

    let totalProcessed = 0;
    let lastPercentReported = -1;
    let cancelled = false;

    while (true) {
      const result = await client.query(`FETCH ${CURSOR_BATCH} FROM export_cursor`);
      const rows = result.rows;
      if (rows.length === 0) break;

      const lines: string[] = [];
      for (const row of rows) {
        const processed = processAddress(row);
        lines.push(addressToCSVRow(processed));
      }
      chunks.push(Buffer.from(lines.join('\n') + '\n', 'utf-8'));

      totalProcessed += rows.length;

      const percentComplete = Math.round((totalProcessed / job.count) * 100);
      if (percentComplete !== lastPercentReported && percentComplete % 5 === 0) {
        lastPercentReported = percentComplete;
        await progressClient.query(
          `UPDATE export_jobs
           SET "processedCount" = $1,
               "percentComplete" = $2
           WHERE id = $3 AND "percentComplete" < $2`,
          [totalProcessed, percentComplete, job.id]
        );
        console.log(`Export ${job.id}: ${percentComplete}% complete (${totalProcessed}/${job.count})`);
      }

      if (totalProcessed % CANCEL_CHECK_INTERVAL < CURSOR_BATCH) {
        const jobStatusResult = await progressClient.query(
          'SELECT status FROM export_jobs WHERE id = $1',
          [job.id]
        );
        if (jobStatusResult.rows[0]?.status === 'cancelled') {
          console.log(`Export job ${job.id} was cancelled, stopping processing`);
          cancelled = true;
          break;
        }
      }
    }

    await client.query('CLOSE export_cursor');
    await client.query('COMMIT');

    if (cancelled) return;

    // Assemble CSV content as a single Buffer for ZIP
    const csvBuffer = Buffer.concat(chunks);
    console.log(`CSV generation complete. Total size: ${csvBuffer.length} bytes`);

    const csvFilename = filename.replace('.zip', '.csv');
    zip.file(csvFilename, csvBuffer);

    const readmeContent = `Export Details
Date: ${new Date().toISOString()}
Total Records: ${totalProcessed}
Filters: ${JSON.stringify(job.filters, null, 2)}

This file contains address data exported from ContactBuddy.nl.
`;
    zip.file('README.txt', readmeContent);

    console.log('Generating ZIP file...');
    const zipContent = await zip.generateAsync({ type: 'nodebuffer' });
    console.log(`ZIP generation complete. Total size: ${zipContent.length} bytes`);

    const readableStream = Readable.from(zipContent);

    console.log(`Uploading ZIP to Vercel Blob Storage as ${filename}`);
    const blob = await put(filename, readableStream, {
      contentType: 'application/zip',
      access: 'public',
    });

    console.log(`Upload successful. URL: ${blob.url}`);

    await progressClient.query(
      `UPDATE export_jobs
       SET status = 'completed',
           "processedCount" = $1,
           "percentComplete" = 100,
           "completedAt" = NOW(),
           "blobUrl" = $2
       WHERE id = $3`,
      [totalProcessed, blob.url, job.id]
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    progressClient.release();
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
