"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/index.ts
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const pg_1 = require("pg");
const cuid2_1 = require("@paralleldrive/cuid2");
const client_1 = require("@prisma/client");
const blob_1 = require("@vercel/blob");
const zod_1 = require("zod");
const stream_1 = require("stream");
const jszip_1 = __importDefault(require("jszip"));
const multer_1 = __importDefault(require("multer"));
const sync_1 = require("csv-parse/sync");
// Load environment variables
dotenv_1.default.config();
// Initialize Express app
const app = (0, express_1.default)();
const port = process.env.PORT || 3001;
// Create a dedicated connection pool for exports
const exportPool = new pg_1.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 30000,
    ssl: {
        rejectUnauthorized: false // Accept self-signed certificates from DigitalOcean
    }
});
// Initialize Prisma client - we'll use this for metadata operations
// but use raw connections for the actual export processing
const prisma = new client_1.PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL
        }
    }
});
// Middleware
app.use((0, cors_1.default)({
    origin: [
        'https://nederland-nine.vercel.app',
        'https://contactbuddy.nl',
        'https://www.contactbuddy.nl',
        'http://localhost:3000'
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express_1.default.json());
// Authentication middleware
const authenticate = (req, res, next) => {
    const apiKey = req.headers.authorization;
    if (!apiKey || apiKey !== `Bearer ${process.env.API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};
// Multer setup for CSV file uploads
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (_req, file, cb) => {
        if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
            cb(null, true);
        }
        else {
            cb(new Error('Only CSV files are allowed'));
        }
    }
});
function detectColumns(headers) {
    const mapping = {
        postcode: null,
        huisnummer: null,
        huisletter: null,
        huisnummertoevoeging: null,
    };
    const patterns = {
        postcode: /^(postcode|postal_?code|zip_?code|zip|pc|pcode)$/i,
        huisnummer: /^(huisnummer|house_?number|huisnr|nr|number|huis_?nr)$/i,
        huisletter: /^(huisletter|house_?letter|letter)$/i,
        huisnummertoevoeging: /^(huisnummertoevoeging|toevoeging|addition|house_?number_?addition|suffix|huis_?nr_?toev)$/i,
    };
    for (const header of headers) {
        const trimmed = header.trim();
        for (const [key, pattern] of Object.entries(patterns)) {
            if (pattern.test(trimmed) && !mapping[key]) {
                mapping[key] = trimmed;
            }
        }
    }
    return mapping;
}
// Define the ExportQuerySchema
const ExportQuerySchema = zod_1.z.object({
    search: zod_1.z.string().optional(),
    postcode: zod_1.z.string().optional(),
    postcodeRange: zod_1.z.object({
        from: zod_1.z.string().optional(),
        to: zod_1.z.string().optional(),
    }).optional(),
    woonplaats: zod_1.z.string().optional(),
    straat: zod_1.z.string().optional(),
    minOppervlakte: zod_1.z.coerce.number().int().optional(),
    maxOppervlakte: zod_1.z.coerce.number().int().optional(),
    isOppervlakteActive: zod_1.z.boolean().optional(),
    gebruiksdoel: zod_1.z.string().optional(),
    minBouwjaar: zod_1.z.coerce.number().int().optional(),
    maxBouwjaar: zod_1.z.coerce.number().int().optional(),
    huisnummer: zod_1.z.coerce.number().int().optional(),
    is_bruikbaar: zod_1.z.boolean().optional(),
    adres_status: zod_1.z.string().optional(),
    begindatum: zod_1.z.string().optional(),
    einddatum: zod_1.z.string().optional(),
    object_id: zod_1.z.string().optional(),
    format: zod_1.z.enum(['csv', 'zip']).default('csv'),
    batchSize: zod_1.z.coerce.number().int().min(1000).max(200000).default(200000),
});
// Helper to build SQL WHERE clause
function buildWhereClause(filters) {
    const conditions = [];
    const params = [];
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
function generateExportFilename(filters, format) {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    let filename = `addresses_${date}`;
    try {
        if (filters.search && typeof filters.search === 'string' && filters.search.trim()) {
            const cleanSearch = filters.search.trim().replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20);
            if (cleanSearch)
                filename += `_${cleanSearch}`;
        }
        if (filters.woonplaats && typeof filters.woonplaats === 'string' && filters.woonplaats.trim()) {
            const cleanCity = filters.woonplaats.trim().replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20);
            if (cleanCity)
                filename += `_${cleanCity}`;
        }
        if (filters.postcode && typeof filters.postcode === 'string' && filters.postcode.trim()) {
            filename += `_${filters.postcode.trim()}`;
        }
        if (typeof filters.minBouwjaar === 'number' && typeof filters.maxBouwjaar === 'number') {
            filename += `_${filters.minBouwjaar}-${filters.maxBouwjaar}`;
        }
    }
    catch (e) {
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
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
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
            const jobId = (0, cuid2_1.createId)();
            const job = await prisma.exportJob.create({
                data: {
                    id: jobId,
                    status: 'pending',
                    format: filters.format,
                    count,
                    filters: filters, // JSON field in Prisma
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
        }
        finally {
            client.release();
        }
    }
    catch (error) {
        console.error('Error creating export job:', error);
        return res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});
// API endpoint to check export status
app.get('/api/addresses/export/status', async (req, res) => {
    try {
        const jobId = req.query.jobId;
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
    }
    catch (error) {
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
    }
    catch (error) {
        console.error('Error cancelling export job:', error);
        return res.status(500).json({ error: 'Error cancelling export job' });
    }
});
// Helper function for status messages
function getStatusMessage(job) {
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
async function processExport(jobId) {
    const startTime = Date.now();
    // Acquire a client for the entire export process
    const client = await exportPool.connect();
    try {
        // Get job details from database
        const jobResult = await client.query('SELECT * FROM export_jobs WHERE id = $1', [jobId]);
        const job = jobResult.rows[0];
        if (!job) {
            throw new Error('Export job not found');
        }
        // Update status to processing
        await client.query(`UPDATE export_jobs 
       SET status = 'processing', 
           "startedAt" = NOW(), 
           "processedCount" = 0, 
           "percentComplete" = 0 
       WHERE id = $1`, [jobId]);
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
            }
            else if (job.format === 'zip') {
                await processZIPExport(job, whereClause, params, nextParamIndex, client, filename);
            }
            else {
                throw new Error(`Unsupported export format: ${job.format}`);
            }
            // Log performance metrics
            const totalTime = Date.now() - startTime;
            console.log(`Export ${jobId} completed successfully\n` +
                `Performance metrics:\n` +
                `- Total time: ${(totalTime / 1000).toFixed(1)}s\n` +
                `- Total records: ${job.count.toLocaleString()}`);
        }
        catch (error) {
            console.error('Error in export processing:', error);
            // Update job with error status
            await client.query(`UPDATE export_jobs 
         SET status = 'failed',
             error = $1,
             "completedAt" = NOW()
         WHERE id = $2`, [error instanceof Error ? error.message : 'Unknown error during export processing', jobId]);
            // Re-throw the error
            throw error;
        }
    }
    catch (error) {
        console.error('Error in processExport:', error);
        // Update job with error status
        await client.query(`UPDATE export_jobs 
       SET status = 'failed',
           error = $1,
           "completedAt" = NOW()
       WHERE id = $2`, [error instanceof Error ? error.message : 'Unknown error during export processing', jobId]);
        throw error;
    }
    finally {
        // Release the client when done
        client.release();
    }
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
function processAddress(address) {
    let huisnummer_toevoeging_gecombineerd = null;
    if (address.huisletter || address.huisnummertoevoeging) {
        const letter = address.huisletter?.trim() || '';
        const additionRaw = address.huisnummertoevoeging?.trim() || '';
        const addition = additionRaw.replace(/\s+/g, '');
        if (letter && addition) {
            huisnummer_toevoeging_gecombineerd = /^\d/.test(addition)
                ? `${letter}${addition}`
                : `${letter}-${addition}`;
        }
        else if (letter) {
            huisnummer_toevoeging_gecombineerd = letter;
        }
        else if (addition) {
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
function addressToCSVRow(address) {
    return EXPORT_COLUMNS.map(col => {
        const value = address[col.key];
        if (value === null || value === undefined)
            return '';
        if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
            return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
    }).join(',');
}
function buildCursorQuery(whereClause) {
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
async function processCSVExport(job, whereClause, params, nextParamIndex, client, filename) {
    const CURSOR_BATCH = 5000;
    const CANCEL_CHECK_INTERVAL = 50000;
    // Use a separate connection for progress updates and cancellation checks
    // so they are visible outside the cursor transaction.
    const progressClient = await exportPool.connect();
    const chunks = [];
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
            if (rows.length === 0)
                break;
            // Convert batch to CSV lines and collect as Buffer
            const lines = [];
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
                await progressClient.query(`UPDATE export_jobs
           SET "processedCount" = $1,
               "percentComplete" = $2
           WHERE id = $3 AND "percentComplete" < $2`, [totalProcessed, percentComplete, job.id]);
                console.log(`Export ${job.id}: ${percentComplete}% complete (${totalProcessed}/${job.count})`);
            }
            // Cancellation check every 50K rows — via separate connection
            if (totalProcessed % CANCEL_CHECK_INTERVAL < CURSOR_BATCH) {
                const jobStatusResult = await progressClient.query('SELECT status FROM export_jobs WHERE id = $1', [job.id]);
                if (jobStatusResult.rows[0]?.status === 'cancelled') {
                    console.log(`Export job ${job.id} was cancelled, stopping processing`);
                    cancelled = true;
                    break;
                }
            }
        }
        await client.query('CLOSE export_cursor');
        await client.query('COMMIT');
        if (cancelled)
            return;
        // Assemble final buffer with BOM
        const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
        const totalSize = BOM.length + chunks.reduce((sum, c) => sum + c.length, 0);
        const bufferWithBOM = Buffer.concat([BOM, ...chunks], totalSize);
        console.log(`CSV generation complete. Total size: ${bufferWithBOM.length} bytes`);
        const readableStream = stream_1.Readable.from(bufferWithBOM);
        // Upload to Vercel Blob Storage
        console.log(`Uploading CSV to Vercel Blob Storage as ${filename}`);
        const blob = await (0, blob_1.put)(filename, readableStream, {
            contentType: 'text/csv; charset=utf-8',
            access: 'public',
        });
        console.log(`Upload successful. URL: ${blob.url}`);
        await progressClient.query(`UPDATE export_jobs
       SET status = 'completed',
           "processedCount" = $1,
           "percentComplete" = 100,
           "completedAt" = NOW(),
           "blobUrl" = $2
       WHERE id = $3`, [totalProcessed, blob.url, job.id]);
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
    finally {
        progressClient.release();
    }
}
async function processZIPExport(job, whereClause, params, nextParamIndex, client, filename) {
    const zip = new jszip_1.default();
    const CURSOR_BATCH = 5000;
    const CANCEL_CHECK_INTERVAL = 50000;
    const progressClient = await exportPool.connect();
    const chunks = [];
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
            if (rows.length === 0)
                break;
            const lines = [];
            for (const row of rows) {
                const processed = processAddress(row);
                lines.push(addressToCSVRow(processed));
            }
            chunks.push(Buffer.from(lines.join('\n') + '\n', 'utf-8'));
            totalProcessed += rows.length;
            const percentComplete = Math.round((totalProcessed / job.count) * 100);
            if (percentComplete !== lastPercentReported && percentComplete % 5 === 0) {
                lastPercentReported = percentComplete;
                await progressClient.query(`UPDATE export_jobs
           SET "processedCount" = $1,
               "percentComplete" = $2
           WHERE id = $3 AND "percentComplete" < $2`, [totalProcessed, percentComplete, job.id]);
                console.log(`Export ${job.id}: ${percentComplete}% complete (${totalProcessed}/${job.count})`);
            }
            if (totalProcessed % CANCEL_CHECK_INTERVAL < CURSOR_BATCH) {
                const jobStatusResult = await progressClient.query('SELECT status FROM export_jobs WHERE id = $1', [job.id]);
                if (jobStatusResult.rows[0]?.status === 'cancelled') {
                    console.log(`Export job ${job.id} was cancelled, stopping processing`);
                    cancelled = true;
                    break;
                }
            }
        }
        await client.query('CLOSE export_cursor');
        await client.query('COMMIT');
        if (cancelled)
            return;
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
        const readableStream = stream_1.Readable.from(zipContent);
        console.log(`Uploading ZIP to Vercel Blob Storage as ${filename}`);
        const blob = await (0, blob_1.put)(filename, readableStream, {
            contentType: 'application/zip',
            access: 'public',
        });
        console.log(`Upload successful. URL: ${blob.url}`);
        await progressClient.query(`UPDATE export_jobs
       SET status = 'completed',
           "processedCount" = $1,
           "percentComplete" = 100,
           "completedAt" = NOW(),
           "blobUrl" = $2
       WHERE id = $3`, [totalProcessed, blob.url, job.id]);
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
    finally {
        progressClient.release();
    }
}
// ============================================================
// CSV Enrichment endpoint
// ============================================================
const MAX_ENRICHMENT_ROWS = 100000;
const ALL_ENRICHMENT_COLUMNS = [
    { key: 'oppervlakte', header: 'Oppervlakte', category: 'bag' },
    { key: 'oorspronkelijkBouwjaar', header: 'Bouwjaar', category: 'bag' },
    { key: 'gebruiksdoel', header: 'Gebruiksdoel', category: 'bag' },
    { key: 'energieklasse', header: 'Energielabel', category: 'energielabel' },
    { key: 'woz_waarde', header: 'WOZ Waarde', category: 'woz' },
    { key: 'woz_peildatum', header: 'WOZ Peildatum', category: 'woz' },
    { key: 'latitude', header: 'Latitude', category: 'coordinaten' },
    { key: 'longitude', header: 'Longitude', category: 'coordinaten' },
    { key: 'rd_x', header: 'RD X', category: 'coordinaten' },
    { key: 'rd_y', header: 'RD Y', category: 'coordinaten' },
    { key: 'object_id', header: 'Object ID', category: 'bag' },
    { key: 'straat', header: 'Straat (BAG)', category: 'adres' },
    { key: 'woonplaats', header: 'Woonplaats (BAG)', category: 'adres' },
];
const ALL_CATEGORIES = ['bag', 'coordinaten', 'energielabel', 'woz', 'adres'];
app.post('/api/addresses/enrich', authenticate, (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'Bestand is te groot. Maximum is 50 MB.' });
            }
            return res.status(400).json({ error: err.message || 'Fout bij uploaden van bestand' });
        }
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No CSV file uploaded. Send as multipart form-data with field name "file".' });
        }
        // Strip BOM if present and parse CSV
        let csvContent = req.file.buffer.toString('utf-8');
        if (csvContent.charCodeAt(0) === 0xFEFF) {
            csvContent = csvContent.slice(1);
        }
        // Auto-detect delimiter from first line
        const firstLine = csvContent.split(/\r?\n/)[0] || '';
        const semicolonCount = (firstLine.match(/;/g) || []).length;
        const commaCount = (firstLine.match(/,/g) || []).length;
        const delimiter = semicolonCount > commaCount ? ';' : ',';
        let records;
        try {
            records = (0, sync_1.parse)(csvContent, {
                columns: true,
                delimiter,
                skip_empty_lines: true,
                trim: true,
                bom: true,
                relax_column_count: true,
            });
        }
        catch (parseError) {
            return res.status(400).json({
                error: 'Failed to parse CSV file',
                details: parseError instanceof Error ? parseError.message : 'Unknown parse error'
            });
        }
        if (records.length === 0) {
            return res.status(400).json({ error: 'CSV file is empty (no data rows)' });
        }
        if (records.length > MAX_ENRICHMENT_ROWS) {
            return res.status(400).json({
                error: `CSV has ${records.length.toLocaleString()} rows. Maximum is ${MAX_ENRICHMENT_ROWS.toLocaleString()}.`
            });
        }
        // Parse enrichment categories
        let categories = ALL_CATEGORIES;
        const categoriesParam = req.body?.categories || req.body?.categories;
        if (typeof categoriesParam === 'string') {
            try {
                const parsed = JSON.parse(categoriesParam);
                if (Array.isArray(parsed) && parsed.every((c) => ALL_CATEGORIES.includes(c))) {
                    categories = parsed;
                }
            }
            catch { }
        }
        // Detect columns
        const allHeaders = Object.keys(records[0]);
        const columnMapping = detectColumns(allHeaders);
        if (!columnMapping.postcode || !columnMapping.huisnummer) {
            return res.status(400).json({
                error: 'Could not detect required columns: postcode and huisnummer',
                detectedHeaders: allHeaders,
                columnMapping,
                hint: 'Ensure your CSV has columns named "postcode" and "huisnummer" (or common variations like "postal_code", "house_number")'
            });
        }
        // Create job
        const jobId = (0, cuid2_1.createId)();
        const job = await prisma.exportJob.create({
            data: {
                id: jobId,
                status: 'pending',
                format: 'csv',
                count: records.length,
                filters: { type: 'enrichment', columnMapping, allHeaders },
                createdAt: new Date(),
            }
        });
        // Fire and forget
        processEnrichment(job.id, records, allHeaders, columnMapping, delimiter, categories).catch(error => {
            console.error('Error in enrichment processing:', error);
            prisma.exportJob.update({
                where: { id: job.id },
                data: {
                    status: 'failed',
                    error: error instanceof Error ? error.message : 'Unknown error processing enrichment',
                    completedAt: new Date()
                }
            }).catch(updateError => {
                console.error('Error updating job status after enrichment error:', updateError);
            });
        });
        return res.status(200).json({
            jobId: job.id,
            status: 'pending',
            rowCount: records.length,
            columnsDetected: columnMapping,
            message: `Enrichment of ${records.length} rows started. Check status at /api/addresses/export/status?jobId=${job.id}`
        });
    }
    catch (error) {
        console.error('Error creating enrichment job:', error);
        return res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});
async function processEnrichment(jobId, records, allHeaders, columnMapping, delimiter = ',', categories = ALL_CATEGORIES) {
    const startTime = Date.now();
    const client = await exportPool.connect();
    const progressClient = await exportPool.connect();
    try {
        // Update status to processing
        await progressClient.query(`UPDATE export_jobs
       SET status = 'processing',
           "startedAt" = NOW(),
           "processedCount" = 0,
           "percentComplete" = 0
       WHERE id = $1`, [jobId]);
        // Phase 1: Load CSV rows into temp table (0-30%)
        console.log(`Enrichment ${jobId}: Phase 1 - Loading ${records.length} rows into temp table`);
        await client.query('BEGIN');
        await client.query(`
      CREATE TEMP TABLE csv_input (
        row_num INT,
        postcode TEXT,
        huisnummer INT,
        huisletter TEXT,
        huisnummertoevoeging TEXT
      ) ON COMMIT DROP
    `);
        // Batch insert rows into temp table
        const BATCH_SIZE = 1000;
        for (let i = 0; i < records.length; i += BATCH_SIZE) {
            const batch = records.slice(i, i + BATCH_SIZE);
            const values = [];
            const params = [];
            let paramIdx = 1;
            for (let j = 0; j < batch.length; j++) {
                const row = batch[j];
                const rowNum = i + j;
                const postcode = (row[columnMapping.postcode] || '').replace(/\s+/g, '').toUpperCase();
                const huisnummerRaw = row[columnMapping.huisnummer] || '';
                const huisnummer = parseInt(huisnummerRaw, 10);
                if (!postcode || isNaN(huisnummer))
                    continue; // skip rows with missing key fields
                const huisletter = columnMapping.huisletter ? (row[columnMapping.huisletter] || '').trim() || null : null;
                const toevoeging = columnMapping.huisnummertoevoeging ? (row[columnMapping.huisnummertoevoeging] || '').trim() || null : null;
                values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4})`);
                params.push(rowNum, postcode, huisnummer, huisletter, toevoeging);
                paramIdx += 5;
            }
            if (values.length > 0) {
                await client.query(`INSERT INTO csv_input (row_num, postcode, huisnummer, huisletter, huisnummertoevoeging) VALUES ${values.join(', ')}`, params);
            }
            // Progress update for phase 1 (0-30%)
            const phase1Percent = Math.round(((i + batch.length) / records.length) * 30);
            await progressClient.query(`UPDATE export_jobs SET "percentComplete" = $1 WHERE id = $2 AND "percentComplete" < $1`, [phase1Percent, jobId]);
        }
        await client.query('CREATE INDEX ON csv_input (postcode, huisnummer)');
        console.log(`Enrichment ${jobId}: Phase 1 complete`);
        // Phase 2: Enrich via JOIN (30-90%)
        console.log(`Enrichment ${jobId}: Phase 2 - Enrichment query (categories: ${categories.join(', ')})`);
        // Filter columns based on selected categories
        const activeColumns = ALL_ENRICHMENT_COLUMNS.filter(c => categories.includes(c.category));
        const needsAe = categories.some(c => ['bag', 'coordinaten', 'adres'].includes(c));
        const needsEl = categories.includes('energielabel');
        const needsWoz = categories.includes('woz');
        // Build SELECT columns dynamically
        const selectColumns = ['ci.row_num'];
        if (needsAe) {
            if (categories.includes('bag'))
                selectColumns.push('ae."oppervlakte"', 'ae."gebruiksdoel"', 'ae."oorspronkelijkBouwjaar"', 'ae."object_id"');
            if (categories.includes('coordinaten'))
                selectColumns.push('ae."latitude"', 'ae."longitude"', 'ae."rd_x"', 'ae."rd_y"');
            if (categories.includes('adres'))
                selectColumns.push('ae."straat"', 'ae."woonplaats"');
        }
        if (needsEl)
            selectColumns.push('el."energieKlasse" AS "energieklasse"');
        if (needsWoz)
            selectColumns.push('woz."wozWaarde" AS "woz_waarde"', 'woz."wozPeildatum" AS "woz_peildatum"');
        // Build JOINs dynamically
        const joins = [];
        if (needsAe || needsEl || needsWoz) {
            joins.push(`LEFT JOIN address_export ae
        ON ae.postcode = ci.postcode AND ae.huisnummer = ci.huisnummer
        AND COALESCE(ae.huisletter, '') = COALESCE(ci.huisletter, '')
        AND COALESCE(ae.huisnummertoevoeging, '') = COALESCE(ci.huisnummertoevoeging, '')`);
        }
        if (needsEl) {
            joins.push(`LEFT JOIN energy_label_enrichment el
        ON el."verblijfsobjectId" = LPAD(REPLACE(ae.object_id, 'NL.IMBAG.Verblijfsobject.', ''), 16, '0')`);
        }
        if (needsWoz) {
            joins.push(`LEFT JOIN woz_address_enrichment woz
        ON woz."verblijfsobjectId" = ae.object_id`);
        }
        const enrichmentQuery = `
      SELECT ${selectColumns.join(', ')}
      FROM csv_input ci
      ${joins.join('\n      ')}
      ORDER BY ci.row_num
    `;
        await client.query(`DECLARE enrich_cursor CURSOR FOR ${enrichmentQuery}`);
        // Build enrichment lookup: rowNum -> enrichment data (may have multiple matches)
        const enrichmentMap = new Map();
        const CURSOR_BATCH = 5000;
        let fetched = 0;
        while (true) {
            const result = await client.query(`FETCH ${CURSOR_BATCH} FROM enrich_cursor`);
            if (result.rows.length === 0)
                break;
            for (const row of result.rows) {
                const rowNum = row.row_num;
                if (!enrichmentMap.has(rowNum)) {
                    enrichmentMap.set(rowNum, []);
                }
                enrichmentMap.get(rowNum).push(row);
            }
            fetched += result.rows.length;
            // Progress for phase 2 (30-90%)
            // We don't know the total enrichment rows upfront, so estimate based on input count
            const phase2Percent = Math.min(90, 30 + Math.round((fetched / Math.max(records.length, 1)) * 60));
            await progressClient.query(`UPDATE export_jobs SET "percentComplete" = $1 WHERE id = $2 AND "percentComplete" < $1`, [phase2Percent, jobId]);
            // Cancellation check
            if (fetched % 50000 < CURSOR_BATCH) {
                const statusResult = await progressClient.query('SELECT status FROM export_jobs WHERE id = $1', [jobId]);
                if (statusResult.rows[0]?.status === 'cancelled') {
                    console.log(`Enrichment ${jobId} cancelled`);
                    await client.query('CLOSE enrich_cursor');
                    await client.query('COMMIT');
                    return;
                }
            }
        }
        await client.query('CLOSE enrich_cursor');
        await client.query('COMMIT');
        console.log(`Enrichment ${jobId}: Phase 2 complete. ${enrichmentMap.size} rows matched, ${fetched} total result rows`);
        // Phase 3: Assemble output CSV and upload (90-100%)
        console.log(`Enrichment ${jobId}: Phase 3 - Assembling CSV`);
        const enrichmentHeaders = activeColumns.map(c => c.header);
        const outputHeaders = [...allHeaders, ...enrichmentHeaders];
        // Helper to get the value for an enrichment column from a result row
        function getEnrichmentValue(enrichment, key) {
            if (key === 'gebruiksdoel') {
                return Array.isArray(enrichment.gebruiksdoel)
                    ? enrichment.gebruiksdoel.join(', ')
                    : enrichment.gebruiksdoel || '';
            }
            if (key === 'woz_peildatum') {
                return enrichment.woz_peildatum
                    ? new Date(enrichment.woz_peildatum).toISOString().split('T')[0]
                    : '';
            }
            return String(enrichment[key] ?? '');
        }
        const csvLines = [];
        // Header row
        csvLines.push(outputHeaders.map(h => escapeCSVField(h, delimiter)).join(delimiter));
        for (let i = 0; i < records.length; i++) {
            const originalRow = records[i];
            const enrichments = enrichmentMap.get(i);
            if (!enrichments || enrichments.length === 0) {
                // No match: original columns + empty enrichment columns
                const line = allHeaders.map(h => escapeCSVField(originalRow[h] || '', delimiter))
                    .concat(activeColumns.map(() => ''))
                    .join(delimiter);
                csvLines.push(line);
            }
            else {
                // One or more matches: emit a row per match
                for (const enrichment of enrichments) {
                    const enrichmentValues = activeColumns.map(col => getEnrichmentValue(enrichment, col.key));
                    const line = allHeaders.map(h => escapeCSVField(originalRow[h] || '', delimiter))
                        .concat(enrichmentValues.map(v => escapeCSVField(v, delimiter)))
                        .join(delimiter);
                    csvLines.push(line);
                }
            }
        }
        const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
        const csvBuffer = Buffer.concat([BOM, Buffer.from(csvLines.join('\n') + '\n', 'utf-8')]);
        console.log(`Enrichment ${jobId}: CSV assembled (${csvBuffer.length} bytes). Uploading...`);
        await progressClient.query(`UPDATE export_jobs SET "percentComplete" = 95 WHERE id = $1`, [jobId]);
        const date = new Date().toISOString().split('T')[0];
        const filename = `enriched_${date}_${records.length}rows.csv`;
        const blob = await (0, blob_1.put)(filename, stream_1.Readable.from(csvBuffer), {
            contentType: 'text/csv; charset=utf-8',
            access: 'public',
        });
        console.log(`Enrichment ${jobId}: Upload complete. URL: ${blob.url}`);
        const totalTime = Date.now() - startTime;
        const outputRowCount = csvLines.length - 1; // minus header
        await progressClient.query(`UPDATE export_jobs
       SET status = 'completed',
           "processedCount" = $1,
           "percentComplete" = 100,
           "completedAt" = NOW(),
           "blobUrl" = $2
       WHERE id = $3`, [outputRowCount, blob.url, jobId]);
        console.log(`Enrichment ${jobId} completed successfully\n` +
            `- Total time: ${(totalTime / 1000).toFixed(1)}s\n` +
            `- Input rows: ${records.length}\n` +
            `- Output rows: ${outputRowCount}\n` +
            `- Matched rows: ${enrichmentMap.size}`);
    }
    catch (error) {
        try {
            await client.query('ROLLBACK');
        }
        catch (_) { /* ignore rollback error */ }
        await progressClient.query(`UPDATE export_jobs
       SET status = 'failed',
           error = $1,
           "completedAt" = NOW()
       WHERE id = $2`, [error instanceof Error ? error.message : 'Unknown error', jobId]);
        throw error;
    }
    finally {
        client.release();
        progressClient.release();
    }
}
function escapeCSVField(value, delimiter = ',') {
    if (value === '' || value === null || value === undefined)
        return '';
    const str = String(value);
    if (str.includes(delimiter) || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}
// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        // Check database connection
        await prisma.$queryRaw `SELECT 1`;
        return res.status(200).json({
            status: 'ok',
            timestamp: new Date().toISOString()
        });
    }
    catch (error) {
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
