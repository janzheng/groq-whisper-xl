import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { STATIC_FILES } from './static-web.js';

// ============================================================================
// UNIFIED LOGGING SYSTEM
// ============================================================================

/**
 * Standardized logging system for consistent output across CLI, Web, and API
 * Provides emoji-based categorization and multiple log levels
 */
class UnifiedLogger {
  static levels = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
  };

  static emojis = {
    // Process states
    start: '🚀',
    processing: '🔄',
    complete: '✅',
    failed: '❌',
    
    // File operations
    upload: '📤',
    download: '📥',
    file: '📁',
    delete: '🗑️',
    
    // Audio/transcription
    audio: '🎵',
    transcribe: '🎤',
    chunk: '🧩',
    stream: '🌊',
    llm: '🧠',
    
    // Network/API
    api: '📡',
    webhook: '🔗',
    url: '🌐',
    
    // Status/info
    info: 'ℹ️',
    warning: '⚠️',
    error: '❌',
    debug: '🔍',
    stats: '📊',
    time: '⏱️',
    progress: '📈'
  };

  constructor(context = 'SYSTEM', level = UnifiedLogger.levels.INFO) {
    this.context = context;
    this.level = level;
    this.isServer = typeof window === 'undefined';
  }

  _formatMessage(emoji, message, data = null) {
    const timestamp = new Date().toISOString();
    const prefix = `${emoji} [${this.context}]`;
    
    if (data) {
      return `${prefix} ${message} | ${JSON.stringify(data)}`;
    }
    return `${prefix} ${message}`;
  }

  debug(message, data = null) {
    if (this.level <= UnifiedLogger.levels.DEBUG) {
      const formatted = this._formatMessage(UnifiedLogger.emojis.debug, message, data);
      console.log(formatted);
    }
  }

  info(emoji, message, data = null) {
    if (this.level <= UnifiedLogger.levels.INFO) {
      const emojiSymbol = UnifiedLogger.emojis[emoji] || emoji;
      const formatted = this._formatMessage(emojiSymbol, message, data);
      console.log(formatted);
    }
  }

  warn(message, data = null) {
    if (this.level <= UnifiedLogger.levels.WARN) {
      const formatted = this._formatMessage(UnifiedLogger.emojis.warning, message, data);
      console.warn(formatted);
    }
  }

  error(message, error = null, data = null) {
    if (this.level <= UnifiedLogger.levels.ERROR) {
      const errorData = error ? { 
        message: error.message, 
        stack: error.stack?.substring(0, 200),
        ...data 
      } : data;
      const formatted = this._formatMessage(UnifiedLogger.emojis.error, message, errorData);
      console.error(formatted);
    }
  }

  // Convenience methods for common operations
  upload(message, data = null) { this.info('upload', message, data); }
  download(message, data = null) { this.info('download', message, data); }
  processing(message, data = null) { this.info('processing', message, data); }
  complete(message, data = null) { this.info('complete', message, data); }
  chunk(message, data = null) { this.info('chunk', message, data); }
  transcribe(message, data = null) { this.info('transcribe', message, data); }
  llm(message, data = null) { this.info('llm', message, data); }
  api(message, data = null) { this.info('api', message, data); }
  stats(message, data = null) { this.info('stats', message, data); }
}

// Create loggers for different contexts
const apiLogger = new UnifiedLogger('API', UnifiedLogger.levels.INFO);
const processingLogger = new UnifiedLogger('PROCESSING', UnifiedLogger.levels.INFO);
const streamLogger = new UnifiedLogger('STREAM', UnifiedLogger.levels.INFO);

// Helper function to format bytes consistently
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ============================================================================
// MAIN CLOUDFLARE WORKER EXPORT
// ============================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Serve static files for the web interface
    if (request.method === 'GET') {
      // Serve the main page for root and unknown paths
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(STATIC_FILES['/'], {
          headers: { 'Content-Type': 'text/html' }
        });
      }
      
      // Serve JS file
      if (url.pathname === '/assets/app.js') {
        return new Response(STATIC_FILES['/assets/app.js'], {
          headers: { 'Content-Type': 'application/javascript' }
        });
      }
    }
    
    // Direct Upload API - Simple one-step uploads
    if (url.pathname === '/upload' && request.method === 'POST') {
      return handleDirectUpload(request, env);
    } else if (url.pathname === '/upload-url' && request.method === 'POST') {
      return handleUrlUpload(request, env);
    }
    
    // Presigned Upload API - Two-step process for more control
    else if (url.pathname === '/get-presigned-url' && request.method === 'POST') {
      return handleGetPresignedUrl(request, env);
    } else if (url.pathname === '/start' && request.method === 'POST') {
      return handleStartProcessing(request, env);
    } 
    
    // Streaming API
    else if (url.pathname === '/stream' && request.method === 'POST') {
      return handleStreamingTranscription(request, env);
    }
    
    // Status and Management
    else if (url.pathname === '/status' && request.method === 'GET') {
      return handleStatus(request, env);
    } else if (url.pathname === '/result' && request.method === 'GET') {
      return handleResult(request, env);
    } else if (url.pathname === '/jobs' && request.method === 'GET') {
      return handleListJobs(request, env);
    } else if (url.pathname === '/delete-job' && request.method === 'POST') {
      return handleDeleteJob(request, env);
    } else if (url.pathname === '/save-streaming-job' && request.method === 'POST') {
      return handleSaveStreamingJob(request, env);
    } else if (url.pathname === '/process' && request.method === 'POST') {
      return handleManualProcess(request, env);
    } else if (url.pathname === '/health' && request.method === 'GET') {
      return handleHealth(request, env);
    }
    
    // For any other GET request, serve the main page (SPA fallback)
    if (request.method === 'GET') {
      return new Response(STATIC_FILES['/'], {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    return new Response('Not found', { status: 404 });
  },

  async queue(batch, env) {
    for (const msg of batch.messages) {
      await processJob(msg.body.job_id, env);
    }
  },
};

// Helper function to create S3 client with env
function createS3Client(env) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
}

// ============================================================================
// DIRECT UPLOAD API - Simple one-step uploads
// ============================================================================

/**
 * Direct file upload via FormData or JSON
 * curl -X POST http://localhost:8787/upload \
 *   -F "file=@audio.mp3" \
 *   -F "use_llm=true"
 * 
 * OR with JSON:
 * curl -X POST http://localhost:8787/upload \
 *   -H "Content-Type: application/json" \
 *   -d '{"filename": "audio.mp3", "file_data": "base64encodeddata", "use_llm": true}'
 */
async function handleDirectUpload(request, env) {
  const contentType = request.headers.get('content-type') || '';
  let filename, fileData, use_llm = false, webhook_url = null;
  
  try {
    if (contentType.includes('multipart/form-data')) {
      // Handle FormData upload
      const formData = await request.formData();
      const file = formData.get('file');
      
      if (!file || !file.name) {
        return new Response(JSON.stringify({ 
          error: 'No file provided in FormData' 
        }), { status: 400 });
      }
      
      filename = file.name;
      fileData = await file.arrayBuffer();
      use_llm = formData.get('use_llm') === 'true';
      webhook_url = formData.get('webhook_url') || null;
      
    } else if (contentType.includes('application/json')) {
      // Handle JSON upload with base64 data
      const body = await request.json();
      filename = body.filename;
      use_llm = body.use_llm || false;
      webhook_url = body.webhook_url || null;
      
      if (!body.file_data) {
        return new Response(JSON.stringify({ 
          error: 'No file_data provided in JSON' 
        }), { status: 400 });
      }
      
      // Decode base64 data
      try {
        fileData = Uint8Array.from(atob(body.file_data), c => c.charCodeAt(0)).buffer;
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: 'Invalid base64 file_data' 
        }), { status: 400 });
      }
      
    } else {
      return new Response(JSON.stringify({ 
        error: 'Content-Type must be multipart/form-data or application/json' 
      }), { status: 400 });
    }
    
    if (!filename) {
      return new Response(JSON.stringify({ 
        error: 'Filename is required' 
      }), { status: 400 });
    }
    
    // Create job and store file
    const job_id = crypto.randomUUID();
    const key = `uploads/${job_id}/${filename}`;
    const bucketName = env.R2_BUCKET_NAME || (env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');
    
    // Store file in R2
    const s3Client = createS3Client(env);
    const putCmd = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: fileData,
      ContentType: 'audio/*'
    });
    await s3Client.send(putCmd);
    
    // Store job metadata
    const job = {
      status: 'uploaded',
      filename,
      size: fileData.byteLength,
      actual_size: fileData.byteLength,
      key,
      use_llm,
      webhook_url,
      created_at: new Date().toISOString(),
      uploaded_at: new Date().toISOString()
    };
    
    await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });

    // Queue processing in background instead of awaiting
    await env.GROQ_PROCESSING_QUEUE.send({ job_id });
    
    return new Response(JSON.stringify({
      message: 'File uploaded and queued for processing',
      job_id,
      filename,
      file_size: fileData.byteLength,
      processing_method: fileData.byteLength > 15 * 1024 * 1024 ? 'chunked' : 'direct',
      status_url: `/status?job_id=${job_id}`,
      result_url: `/result?job_id=${job_id}`
    }), { 
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    apiLogger.error('Direct upload failed', error);
    return new Response(JSON.stringify({ 
      error: 'Upload failed', 
      message: error.message 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Upload from URL - fetch audio from a URL and process it
 * curl -X POST http://localhost:8787/upload-url \
 *   -H "Content-Type: application/json" \
 *   -d '{"url": "https://example.com/audio.mp3", "use_llm": true}'
 */
async function handleUrlUpload(request, env) {
  try {
    const { url: audioUrl, filename = null, use_llm = false, webhook_url = null } = await request.json();
    
    if (!audioUrl) {
      return new Response(JSON.stringify({ 
        error: 'URL is required' 
      }), { status: 400 });
    }
    
    // Validate and normalize URL
    let parsedUrl;
    let finalUrl;
    try {
      // Handle URLs with special characters and encoding
      const normalizedUrl = audioUrl.trim();
      
      // For signed URLs like Libsyn, we need to be careful with encoding
      // Don't double-encode already encoded characters
      finalUrl = normalizedUrl;
      parsedUrl = new URL(finalUrl);
      
      // Log the parsed URL for debugging
      apiLogger.debug('URL parsing details', {
        original: audioUrl,
        final: finalUrl,
        host: parsedUrl.host,
        pathname: parsedUrl.pathname,
        search: parsedUrl.search
      });
      
    } catch (error) {
      apiLogger.error('URL parsing failed', error, { provided_url: audioUrl });
      return new Response(JSON.stringify({ 
        error: 'Invalid URL provided',
        details: error.message,
        provided_url: audioUrl
      }), { status: 400 });
    }
    
    // Extract filename from URL if not provided
    const extractedFilename = filename || parsedUrl.pathname.split('/').pop() || 'audio.mp3';
    
    apiLogger.download(`Fetching audio from URL`, { url: finalUrl });
    
    // Fetch the file with better error handling and headers
    let response;
    try {
      // Use the properly parsed URL
      response = await fetch(finalUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Groq-Whisper-XL/1.0)',
          'Accept': 'audio/*, video/*, */*',
          'Accept-Encoding': 'identity'
        },
        redirect: 'follow',
        // Add timeout to prevent hanging
        signal: AbortSignal.timeout(30000) // 30 second timeout
      });
    } catch (fetchError) {
      apiLogger.error('Failed to fetch audio from URL', fetchError, { url: finalUrl });
      
      // Provide more specific error messages
      let errorDetails = fetchError.message;
      if (fetchError.name === 'AbortError') {
        errorDetails = 'Request timed out after 30 seconds';
      } else if (fetchError.name === 'TypeError') {
        errorDetails = 'Network error or invalid URL';
      }
      
      return new Response(JSON.stringify({ 
        error: 'Failed to fetch audio from URL',
        details: errorDetails,
        error_type: fetchError.name,
        url: finalUrl,
        original_url: audioUrl
      }), { status: 400 });
    }
    
    if (!response.ok) {
      apiLogger.error('HTTP error from audio URL', null, { 
        status: response.status, 
        statusText: response.statusText,
        url: finalUrl 
      });
              return new Response(JSON.stringify({ 
          error: 'Failed to fetch audio from URL',
          status: response.status,
          statusText: response.statusText,
          url: finalUrl,
          original_url: audioUrl,
          headers: Object.fromEntries(response.headers.entries())
        }), { status: 400 });
    }
    
    // Check content type
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('audio/') && !contentType.startsWith('video/')) {
      apiLogger.warn(`Unexpected content type, proceeding anyway`, { 
        contentType, 
        url: finalUrl 
      });
    }
    
    // Get file data
    const fileData = await response.arrayBuffer();
    const fileSize = fileData.byteLength;
    
    // Check file size (optional limit)
    const maxSize = 1024 * 1024 * 1024; // 1GB limit
    if (fileSize > maxSize) {
      return new Response(JSON.stringify({ 
        error: 'File too large',
        max_size: '1GB',
        actual_size: formatBytes(fileSize)
      }), { status: 400 });
    }
    
    apiLogger.complete(`Downloaded file from URL`, { 
      filename: extractedFilename, 
      size: formatBytes(fileSize),
      bytes: fileSize 
    });
    
    // Create job and store file
    const job_id = crypto.randomUUID();
    const key = `uploads/${job_id}/${extractedFilename}`;
    const bucketName = env.R2_BUCKET_NAME || (env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');
    
    // Store file in R2
    const s3Client = createS3Client(env);
    const putCmd = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: fileData,
      ContentType: contentType || 'audio/*'
    });
    await s3Client.send(putCmd);
    
    // Store job metadata
    const job = {
      status: 'uploaded',
      filename: extractedFilename,
      source_url: audioUrl,
      size: fileSize,
      actual_size: fileSize,
      key,
      use_llm,
      webhook_url,
      created_at: new Date().toISOString(),
      uploaded_at: new Date().toISOString()
    };
    
    await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });

    // Queue processing in background
    await env.GROQ_PROCESSING_QUEUE.send({ job_id });
    
    return new Response(JSON.stringify({
      message: 'File downloaded from URL and queued for processing',
      job_id,
      filename: extractedFilename,
      source_url: audioUrl,
      file_size: fileSize,
      processing_method: fileSize > 15 * 1024 * 1024 ? 'chunked' : 'direct',
      status_url: `/status?job_id=${job_id}`,
      result_url: `/result?job_id=${job_id}`
    }), { 
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    apiLogger.error('URL upload failed', error);
    return new Response(JSON.stringify({ 
      error: 'URL upload failed', 
      message: error.message 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ============================================================================
// PRESIGNED UPLOAD API - Two-step process for more control
// ============================================================================

/**
 * Step 1: Get a presigned URL for direct upload
 * curl -X POST http://localhost:8787/get-presigned-url \
 *   -H "Content-Type: application/json" \
 *   -d '{"filename": "audio.mp3", "use_llm": true}'
 */
async function handleGetPresignedUrl(request, env) {
  const { filename, size = null, use_llm = false, webhook_url = null } = await request.json();
  const job_id = crypto.randomUUID();
  const key = `uploads/${job_id}/${filename}`;
  const bucketName = env.R2_BUCKET_NAME || (env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');

  // Create presigned URL for direct upload
  const s3Client = createS3Client(env);
  const putCmd = new PutObjectCommand({ 
    Bucket: bucketName, 
    Key: key,
    ContentType: 'audio/*'
  });
  
  const signedUrl = await getSignedUrl(s3Client, putCmd, { expiresIn: 3600 });

  // Store job metadata
  await env.GROQ_JOBS_KV.put(job_id, JSON.stringify({
    status: 'awaiting_upload',
    filename,
    size,
    key,
    use_llm,
    webhook_url,
    created_at: new Date().toISOString(),
    upload_url: signedUrl
  }), { expirationTtl: 86400 });

  return new Response(JSON.stringify({ 
    job_id, 
    upload_url: signedUrl,
    instructions: {
      step1: "Upload your file using: curl -X PUT '<upload_url>' --data-binary @your-file.mp3",
      step2: "Then call: curl -X POST /start -d '{\"job_id\": \"" + job_id + "\"}'",
      step3: "Check status: curl '/status?job_id=" + job_id + "'",
      step4: "Get result: curl '/result?job_id=" + job_id + "'"
    }
  }), { 
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Step 2: Trigger processing after upload
 * curl -X POST http://localhost:8787/start \
 *   -H "Content-Type: application/json" \
 *   -d '{"job_id": "your-job-id"}'
 */
async function handleStartProcessing(request, env) {
  const { job_id } = await request.json();
  
  // Get job metadata
  const jobData = await env.GROQ_JOBS_KV.get(job_id);
  if (!jobData) {
    return new Response(JSON.stringify({ error: 'Job not found' }), { status: 404 });
  }

  const job = JSON.parse(jobData);
  if (job.status !== 'awaiting_upload') {
    return new Response(JSON.stringify({ 
      error: 'Invalid job status', 
      current_status: job.status 
    }), { status: 400 });
  }

  // Verify file was uploaded
  const bucketName = env.R2_BUCKET_NAME || (env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');
  const s3Client = createS3Client(env);
  
  try {
    const headCmd = new HeadObjectCommand({ Bucket: bucketName, Key: job.key });
    const response = await s3Client.send(headCmd);
    
    // Update job status and start processing
    job.status = 'uploaded';
    job.actual_size = response.ContentLength;
    job.uploaded_at = new Date().toISOString();
    
    await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });

    // Queue processing
    await env.GROQ_PROCESSING_QUEUE.send({ job_id });
    
    return new Response(JSON.stringify({ 
      message: 'File uploaded successfully, queued for processing',
      job_id,
      file_size: response.ContentLength,
      processing_method: response.ContentLength > 15 * 1024 * 1024 ? 'chunked' : 'direct'
    }), { status: 200 });
    
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: 'File not found or upload incomplete',
      details: error.message 
    }), { status: 400 });
  }
}

async function handleStatus(request, env) {
  const url = new URL(request.url);
  const job_id = url.searchParams.get('job_id');
  const state = JSON.parse(await env.GROQ_JOBS_KV.get(job_id));
  if (!state) return new Response('Job not found', { status: 404 });
  return new Response(JSON.stringify({ 
    status: state.status, 
    progress: state.progress, 
    error: state.error || null 
  }), { status: 200 });
}

async function handleResult(request, env) {
  const url = new URL(request.url);
  const job_id = url.searchParams.get('job_id');
  const state = JSON.parse(await env.GROQ_JOBS_KV.get(job_id));
  if (!state) return new Response('Job not found', { status: 404 });
  
  // Check if job is complete
  const isComplete = state.status === 'done' || (state.final_transcript && state.transcripts);
  
  if (!isComplete) {
    return new Response(JSON.stringify({ 
      error: 'Not ready', 
      status: state.status, 
      progress: state.progress || 0 
    }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return new Response(JSON.stringify({ 
    partials: state.transcripts || [], 
    final: state.final_transcript || 'No transcript available' 
  }), { 
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleManualProcess(request, env) {
  const { job_id } = await request.json();
  try {
    await processJob(job_id, env);
    return new Response('Processing initiated', { status: 200 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}

/**
 * Health check endpoint for monitoring and connectivity testing
 * curl http://localhost:8787/health
 */
async function handleHealth(request, env) {
  try {
    // Basic health check - verify the service is running
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'groq-whisper-xl',
      version: '1.0.0',
      uptime: Date.now(),
      endpoints: {
        upload: '/upload',
        upload_url: '/upload-url',
        presigned: '/get-presigned-url',
        status: '/status',
        result: '/result',
        jobs: '/jobs',
        delete: '/delete-job'
      }
    };

    // Optional: Test KV connectivity if available
    if (env.GROQ_JOBS_KV) {
      try {
        // Try a simple KV operation to verify connectivity
        await env.GROQ_JOBS_KV.list({ limit: 1 });
        health.kv_status = 'connected';
      } catch (error) {
        health.kv_status = 'error';
        health.kv_error = error.message;
      }
    }

    // Optional: Test R2 connectivity if available
    if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
      try {
        const s3Client = createS3Client(env);
        const bucketName = env.R2_BUCKET_NAME || (env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');
        // Just test the client creation, don't actually make a request to avoid costs
        health.r2_status = 'configured';
        health.r2_bucket = bucketName;
      } catch (error) {
        health.r2_status = 'error';
        health.r2_error = error.message;
      }
    }

    // Test Groq API key presence (don't test actual API to avoid costs)
    if (env.GROQ_API_KEY) {
      health.groq_api = 'configured';
    } else {
      health.groq_api = 'missing';
    }

    return new Response(JSON.stringify(health, null, 2), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ============================================================================
// STREAMING API - Emulates Groq's streaming chat completion format
// ============================================================================

/**
 * Streaming transcription that processes audio in tiny chunks and returns results as SSE stream
 * Similar to Groq's chat completion streaming API
 * 
 * curl -X POST http://localhost:8787/stream \
 *   -H "Content-Type: application/json" \
 *   -d '{"url": "https://example.com/audio.mp3", "chunk_size_mb": 1, "use_llm": true}'
 * 
 * Or with file upload:
 * curl -X POST http://localhost:8787/stream \
 *   -F "file=@audio.mp3" \
 *   -F "chunk_size_mb=1" \
 *   -F "use_llm=true"
 * 
 * Note: LLM correction is disabled by default for streaming. Set use_llm=true to enable.
 */
async function handleStreamingTranscription(request, env) {
  const contentType = request.headers.get('content-type') || '';
  let audioData, filename, chunkSizeMB = 0.25, use_llm = false, llm_mode = 'per_chunk';
  
  try {
    // Parse request data
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file');
      
      if (!file || !file.name) {
        return new Response('data: {"error": "No file provided"}\n\n', { 
          status: 400,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
      
      filename = file.name;
      audioData = await file.arrayBuffer();
      chunkSizeMB = parseFloat(formData.get('chunk_size_mb')) || 0.25;
      use_llm = formData.get('use_llm') === 'true'; // Explicitly false by default
      llm_mode = formData.get('llm_mode') || 'per_chunk'; // 'per_chunk' or 'post_process'
      
    } else if (contentType.includes('application/json')) {
      const body = await request.json();
      
      if (body.url) {
        // Download from URL
        try {
          const response = await fetch(body.url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; Groq-Whisper-XL/1.0)',
              'Accept': 'audio/*, video/*, */*'
            },
            signal: AbortSignal.timeout(30000)
          });
          
          if (!response.ok) {
            return createStreamError(`Failed to fetch audio: ${response.status}`);
          }
          
          audioData = await response.arrayBuffer();
          filename = body.url.split('/').pop() || 'audio.mp3';
          
        } catch (error) {
          return createStreamError(`URL fetch failed: ${error.message}`);
        }
        
      } else if (body.file_data) {
        // Base64 encoded data
        try {
          audioData = Uint8Array.from(atob(body.file_data), c => c.charCodeAt(0)).buffer;
          filename = body.filename || 'audio.mp3';
        } catch (error) {
          return createStreamError('Invalid base64 file_data');
        }
        
      } else {
        return createStreamError('Either url or file_data is required');
      }
      
      chunkSizeMB = body.chunk_size_mb || 0.25;
      use_llm = body.use_llm === true; // Explicitly require true, default false
      llm_mode = body.llm_mode || 'per_chunk'; // 'per_chunk' or 'post_process'
      
    } else {
      return createStreamError('Content-Type must be multipart/form-data or application/json');
    }
    
    // Create job record for streaming transcription
    const job_id = crypto.randomUUID();
    const job = {
      status: 'streaming',
      filename,
      size: audioData.byteLength,
      actual_size: audioData.byteLength,
      processing_method: 'streaming',
      use_llm,
      llm_mode,
      chunk_size_mb: chunkSizeMB,
      created_at: new Date().toISOString(),
      processing_started_at: new Date().toISOString()
    };
    
    // Store initial job state
    await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });
    
        // Create a ReadableStream for Server-Sent Events with aggressive flushing
    const stream = new ReadableStream({
      async start(controller) {
        try {
          await processAudioStreamChunks(
            new Uint8Array(audioData), 
            filename, 
            chunkSizeMB, 
            use_llm, 
            llm_mode,
            controller, 
            env,
            job_id  // Pass job_id for progress tracking
          );
        } catch (error) {
          const errorData = createStreamChunk('error', { error: error.message });
          controller.enqueue(new TextEncoder().encode(errorData));
          
          // Update job status to failed
          const failedJob = { ...job, status: 'failed', error: error.message, failed_at: new Date().toISOString() };
          await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(failedJob), { expirationTtl: 86400 });
        } finally {
          controller.close();
        }
      }
    });
    
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
    
  } catch (error) {
    return createStreamError(`Streaming setup failed: ${error.message}`);
  }
}

async function processAudioStreamChunks(audioBuffer, filename, chunkSizeMB, use_llm, llm_mode, controller, env, job_id = null) {
  const chunkSize = chunkSizeMB * 1024 * 1024; // Convert MB to bytes
  const ext = filename.split('.').pop() || 'mp3';
  
  // Send initial status
  streamLogger.info('stream', 'Starting streaming transcription', {
    filename,
    total_size: formatBytes(audioBuffer.length),
    chunk_size: formatBytes(chunkSize),
    estimated_chunks: Math.ceil(audioBuffer.length / chunkSize),
    llm_mode: use_llm ? llm_mode : 'disabled'
  });
  
  controller.enqueue(new TextEncoder().encode(
    createStreamChunk('status', { 
      message: 'Starting transcription',
      job_id,
      filename,
      total_size: audioBuffer.length,
      chunk_size: chunkSize,
      estimated_chunks: Math.ceil(audioBuffer.length / chunkSize),
      llm_mode: use_llm ? llm_mode : 'disabled'
    })
  ));
  
  // Create tiny chunks for streaming
  const chunks = createTinyChunks(audioBuffer, chunkSize);
  let fullTranscript = '';
  let correctedTranscript = '';
  const segments = [];
  
  // Send chunk info
  controller.enqueue(new TextEncoder().encode(
    createStreamChunk('chunk_info', { 
      total_chunks: chunks.length,
      chunk_size_mb: chunkSizeMB,
      llm_correction: use_llm ? llm_mode : 'disabled'
    })
  ));
  
  // Process each chunk and stream results
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    try {
      // Send chunk start event  
      const chunkStartData = createStreamChunk('chunk_start', { 
        chunk_index: i,
        chunk_size: chunk.data.length,
        progress: Math.round((i / chunks.length) * 100)
      });
      controller.enqueue(new TextEncoder().encode(chunkStartData));
      
      // Transcribe chunk
      const transcript = await transcribeChunk(chunk.data, ext, env.GROQ_API_KEY);
      
      if (transcript.text) {
        let correctedText = transcript.text;
        
        // Apply per-chunk LLM correction if enabled
        if (use_llm && llm_mode === 'per_chunk') {
          try {
            correctedText = await applyPerChunkLLMCorrection(transcript.text, env.GROQ_API_KEY);
            
            // Send delta with both raw and corrected text
            controller.enqueue(new TextEncoder().encode(
              createStreamChunk('delta', { 
                chunk_index: i,
                raw_text: transcript.text,
                corrected_text: correctedText,
                segments: transcript.segments || [],
                llm_applied: true
              })
            ));
            
          } catch (llmError) {
            // LLM failed, send raw text only with error info
            controller.enqueue(new TextEncoder().encode(
              createStreamChunk('delta', { 
                chunk_index: i,
                raw_text: transcript.text,
                corrected_text: transcript.text, // fallback to raw
                segments: transcript.segments || [],
                llm_applied: false,
                llm_error: llmError.message
              })
            ));
            correctedText = transcript.text; // use raw text as fallback
          }
        } else {
          // No LLM correction requested
          controller.enqueue(new TextEncoder().encode(
            createStreamChunk('delta', { 
              chunk_index: i,
              text: transcript.text, // backward compatibility
              raw_text: transcript.text,
              segments: transcript.segments || [],
              llm_applied: false
            })
          ));
        }
        
        fullTranscript += (fullTranscript ? ' ' : '') + transcript.text;
        correctedTranscript += (correctedTranscript ? ' ' : '') + correctedText;
        
        if (transcript.segments) {
          segments.push(...transcript.segments);
        }
      }
      
      // Send chunk completion
      controller.enqueue(new TextEncoder().encode(
        createStreamChunk('chunk_done', { 
          chunk_index: i,
          progress: Math.round(((i + 1) / chunks.length) * 100)
        })
      ));
      
      // Send heartbeat to force stream flush  
      controller.enqueue(new TextEncoder().encode('\n'));
      
      // Force immediate streaming with minimal delay
      await new Promise(resolve => setTimeout(resolve, 100));
      
    } catch (error) {
      // Send chunk error but continue
      controller.enqueue(new TextEncoder().encode(
        createStreamChunk('chunk_error', { 
          chunk_index: i,
          error: error.message
        })
      ));
    }
  }
  
  // Apply post-processing LLM correction if requested
  let finalTranscript = fullTranscript;
  
  if (use_llm && llm_mode === 'post_process') {
    controller.enqueue(new TextEncoder().encode(
      createStreamChunk('llm_processing', { 
        message: 'Applying LLM corrections to full transcript...',
        mode: 'post_process'
      })
    ));
    
    try {
      finalTranscript = await applyLLMCorrection(fullTranscript, env.GROQ_API_KEY);
      
      controller.enqueue(new TextEncoder().encode(
        createStreamChunk('llm_done', { 
          corrected_text: finalTranscript,
          mode: 'post_process'
        })
      ));
    } catch (error) {
      controller.enqueue(new TextEncoder().encode(
        createStreamChunk('llm_error', { 
          error: error.message,
          fallback_text: fullTranscript,
          mode: 'post_process'
        })
      ));
    }
  } else if (use_llm && llm_mode === 'per_chunk') {
    finalTranscript = correctedTranscript;
  }
  
  // Send final completion
  controller.enqueue(new TextEncoder().encode(
    createStreamChunk('done', { 
      job_id,
      final_transcript: finalTranscript,
      raw_transcript: fullTranscript,
      corrected_transcript: use_llm && llm_mode === 'per_chunk' ? correctedTranscript : null,
      total_segments: segments.length,
      processing_completed: true,
      llm_correction_applied: use_llm,
      llm_mode: use_llm ? llm_mode : 'disabled'
    })
  ));
  
  // Update job status to completed if job_id provided
  if (job_id && env.GROQ_JOBS_KV) {
    try {
      const jobData = await env.GROQ_JOBS_KV.get(job_id);
      if (jobData) {
        const job = JSON.parse(jobData);
        job.status = 'done';
        job.final_transcript = finalTranscript;
        job.raw_transcript = fullTranscript;
        job.corrected_transcript = use_llm && llm_mode === 'per_chunk' ? correctedTranscript : null;
        job.total_segments = segments.length;
        job.completed_at = new Date().toISOString();
        job.llm_correction_applied = use_llm;
        job.transcripts = [{ 
          text: finalTranscript, 
          raw_text: fullTranscript,
          segments: segments,
          start: 0,
          duration: audioBuffer.length,
          chunk_index: 'streaming'
        }];
        
        await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });
        streamLogger.complete('Streaming job completed and saved', { 
          job_id, 
          filename,
          transcript_length: finalTranscript?.length || 0
        });
      }
    } catch (error) {
      streamLogger.error('Failed to update streaming job completion', error, { job_id });
    }
  }
}

function createTinyChunks(buffer, chunkSize) {
  const chunks = [];
  const minOverlap = Math.min(1024 * 50, Math.floor(chunkSize * 0.02)); // 50KB or 2% overlap
  
  for (let start = 0; start < buffer.length; start += chunkSize - minOverlap) {
    const end = Math.min(start + chunkSize, buffer.length);
    const chunkData = buffer.slice(start, end);
    
    chunks.push({
      start,
      end,
      data: chunkData,
      size: chunkData.length
    });
    
    if (end >= buffer.length) break;
  }
  
  return chunks;
}

function createStreamChunk(type, data) {
  return `data: ${JSON.stringify({ type, ...data })}\n\n`;
}

function createStreamError(message) {
  return new Response(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`, {
    status: 400,
    headers: { 'Content-Type': 'text/plain' }
  });
}

// ============================================================================
// PROCESSING ENGINE
// ============================================================================

/**
 * Legacy queue processor - kept for compatibility
 */
async function processJob(job_id, env) {
  await processFileIntelligently(job_id, env);
}

/**
 * Intelligent processing that automatically decides chunking strategy
 */
async function processFileIntelligently(job_id, env) {
  const jobData = await env.GROQ_JOBS_KV.get(job_id);
  const job = JSON.parse(jobData);
  
  // Update status
  job.status = 'processing';
  job.processing_started_at = new Date().toISOString();
  await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });
  
  try {
    const bucketName = env.R2_BUCKET_NAME || (env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');
    const s3Client = createS3Client(env);
    
    // Get file
    const getObjectCmd = new GetObjectCommand({ Bucket: bucketName, Key: job.key });
    const response = await s3Client.send(getObjectCmd);
    const fileSize = response.ContentLength;
    
    processingLogger.processing(`Starting processing`, {
      filename: job.filename,
      size: formatBytes(fileSize),
      bytes: fileSize,
      job_id: job_id
    });
    
    // Decide processing strategy
    const CHUNK_THRESHOLD = 15 * 1024 * 1024; // 15MB
    const MAX_CHUNK_SIZE = 20 * 1024 * 1024;  // 20MB chunks
    
    if (fileSize <= CHUNK_THRESHOLD) {
      processingLogger.info('transcribe', 'Using direct processing (small file)');
      await processDirectly(job_id, response, env);
    } else {
      processingLogger.info('chunk', 'Using chunked processing (large file)');
      await processInChunks(job_id, response, fileSize, MAX_CHUNK_SIZE, env);
    }
    
  } catch (error) {
    processingLogger.error('Processing failed', error, { job_id, filename: job.filename });
    job.status = 'failed';
    job.error = error.message;
    job.failed_at = new Date().toISOString();
    await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });
  }
}

/**
 * Process small files directly
 */
async function processDirectly(job_id, fileResponse, env) {
  const jobData = await env.GROQ_JOBS_KV.get(job_id);
  const job = JSON.parse(jobData);
  
  // Convert stream to buffer
  const chunks = [];
  const reader = fileResponse.Body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  
  // Create blob for transcription
  const ext = job.filename.split('.').pop() || 'mp3';
  
  processingLogger.transcribe(`Starting direct transcription`, { 
    filename: job.filename, 
    extension: ext 
  });
  const transcript = await transcribeChunk(combined, ext, env.GROQ_API_KEY);
  
  // Apply LLM correction if requested
  let finalTranscript = transcript.text;
  if (job.use_llm && transcript.text) {
    processingLogger.llm('Applying LLM corrections to transcript');
    finalTranscript = await applyLLMCorrection(transcript.text, env.GROQ_API_KEY);
  }
  
  // Update job with results
  job.status = 'done';
  job.transcripts = [{ 
    text: transcript.text, 
    segments: transcript.segments,
    start: 0,
    duration: totalLength,
    chunk_index: 0
  }];
  job.final_transcript = finalTranscript;
  job.completed_at = new Date().toISOString();
  job.processing_method = 'direct';
  
  await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });
  
  // Send webhook if configured
  if (job.webhook_url) {
    await sendWebhook(job.webhook_url, job_id, job);
  }
  
  processingLogger.complete('Direct processing completed', { 
    job_id, 
    filename: job.filename,
    transcript_length: finalTranscript?.length || 0
  });
}

/**
 * Process large files in intelligent chunks
 */
async function processInChunks(job_id, fileResponse, fileSize, chunkSize, env) {
  const jobData = await env.GROQ_JOBS_KV.get(job_id);
  const job = JSON.parse(jobData);
  
  // Read entire file into memory (for chunking)
  const chunks = [];
  const reader = fileResponse.Body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const fileBuffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    fileBuffer.set(chunk, offset);
    offset += chunk.length;
  }
  
  // Create intelligent chunks with overlap
  const audioChunks = createChunks(fileBuffer, chunkSize);
  processingLogger.stats(`Created chunks for processing`, { 
    total_chunks: audioChunks.length,
    chunk_size: formatBytes(chunkSize),
    job_id
  });
  
  job.total_chunks = audioChunks.length;
  job.processed_chunks = 0;
  await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });
  
  const transcripts = [];
  const ext = job.filename.split('.').pop() || 'mp3';
  
  // Process chunks sequentially to avoid rate limits
  for (let i = 0; i < audioChunks.length; i++) {
    const chunk = audioChunks[i];
    processingLogger.chunk(`Processing chunk ${i + 1}/${audioChunks.length}`, {
      chunk_index: i + 1,
      chunk_size: formatBytes(chunk.data.length),
      job_id
    });
    
    try {
      const transcript = await transcribeChunk(chunk.data, ext, env.GROQ_API_KEY);
      transcripts.push({
        text: transcript.text,
        segments: transcript.segments,
        start: chunk.start,
        duration: chunk.data.length,
        chunk_index: i
      });
      
      // Update progress
      job.processed_chunks = i + 1;
      job.progress = Math.round((i + 1) / audioChunks.length * 100);
      await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });
      
      processingLogger.complete(`Chunk ${i + 1} completed`, { 
        progress: job.progress,
        job_id
      });
      
      // Small delay to avoid rate limiting
      if (i < audioChunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
    } catch (error) {
      processingLogger.error(`Chunk ${i + 1} failed`, error, { 
        chunk_index: i + 1,
        job_id
      });
      // Continue with other chunks
    }
  }
  
  if (transcripts.length === 0) {
    throw new Error('All chunks failed to process');
  }
  
  // Merge transcripts intelligently
  processingLogger.processing('Merging transcripts from chunks', { 
    chunk_count: transcripts.length,
    job_id
  });
  let mergedText = transcripts.map(t => t.text).join(' ');
  
  // Apply LLM correction if requested
  if (job.use_llm && mergedText) {
    processingLogger.llm('Applying LLM corrections to merged transcript');
    mergedText = await applyLLMCorrection(mergedText, env.GROQ_API_KEY);
  }
  
  // Update job with final results
  job.status = 'done';
  job.transcripts = transcripts;
  job.final_transcript = mergedText;
  job.completed_at = new Date().toISOString();
  job.processing_method = 'chunked';
  job.success_rate = Math.round((transcripts.length / audioChunks.length) * 100);
  
  await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });
  
  // Send webhook if configured
  if (job.webhook_url) {
    await sendWebhook(job.webhook_url, job_id, job);
  }
  
  processingLogger.complete('Chunked processing completed', { 
    job_id,
    successful_chunks: transcripts.length,
    total_chunks: audioChunks.length,
    success_rate: job.success_rate,
    transcript_length: mergedText?.length || 0
  });
}

async function transcribeChunk(data, ext, apiKey) {
  const formData = new FormData();
  formData.append('file', new Blob([data]), `chunk.${ext}`);
  formData.append('model', 'whisper-large-v3');
  formData.append('response_format', 'verbose_json');
  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  return await response.json();
}

/**
 * Create intelligent chunks with minimal overlap
 */
function createChunks(buffer, chunkSize) {
  const chunks = [];
  const overlapSize = Math.floor(chunkSize * 0.05); // 5% overlap
  
  for (let start = 0; start < buffer.length; start += chunkSize - overlapSize) {
    const end = Math.min(start + chunkSize, buffer.length);
    const chunkData = buffer.slice(start, end);
    
    chunks.push({
      start,
      end,
      data: chunkData,
      hasOverlap: start > 0
    });
    
    if (end >= buffer.length) break;
  }
  
  return chunks;
}

/**
 * Simple LLM correction using Groq (for post-processing)
 */
async function applyLLMCorrection(text, apiKey) {
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${apiKey}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{
          role: 'user',
          content: `Fix speech recognition errors, improve punctuation, and make this transcript more readable while preserving the original meaning and style. Output ONLY the corrected transcript with no preamble, introduction, or explanatory text:\n\n${text}`
        }],
        temperature: 0.1,
        max_tokens: 131072
      })
    });
    
    const result = await response.json();
    return result.choices[0].message.content;
  } catch (error) {
    processingLogger.error('LLM correction failed', error, { 
      original_length: text?.length || 0 
    });
    return text; // Return original if correction fails
  }
}

/**
 * Per-chunk LLM correction using Llama 3.1 8B Instant for real-time streaming
 * Optimized for speed and cost-effectiveness with shorter, focused prompts
 */
async function applyPerChunkLLMCorrection(text, apiKey) {
  try {
    // Skip LLM for very short chunks (not worth the API call)
    if (text.trim().length < 10) {
      return text;
    }
    
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${apiKey}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{
          role: 'user',
          content: `Fix punctuation and obvious errors in this audio transcript chunk. Output ONLY the corrected text with no preamble or explanatory text:\n\n"${text}"`
        }],
        temperature: 0.1,
        max_tokens: 150, // Smaller limit for chunks
        stream: false
      })
    });
    
    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status}`);
    }
    
    const result = await response.json();
    const correctedText = result.choices[0].message.content.trim();
    
    // Remove quotes if LLM added them
    return correctedText.replace(/^["']|["']$/g, '');
    
  } catch (error) {
    streamLogger.error('Per-chunk LLM correction failed', error, { 
      text_length: text?.length || 0 
    });
    throw error; // Let the caller handle the error
  }
}

/**
 * Send webhook notification
 */
async function sendWebhook(webhookUrl, jobId, job) {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: jobId,
        status: job.status,
        filename: job.filename,
        final_transcript: job.final_transcript,
        processing_method: job.processing_method,
        completed_at: job.completed_at
      })
    });
  } catch (error) {
    apiLogger.error('Webhook notification failed', error, { 
      webhook_url: webhookUrl,
      job_id: jobId 
    });
  }
}

// ============================================================================
// JOB MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * List all jobs with their status (without full results to keep response small)
 * curl http://localhost:8787/jobs
 */
async function handleListJobs(request, env) {
  try {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    const status = url.searchParams.get('status'); // Optional filter by status
    
    // Get all keys from KV
    const listResult = await env.GROQ_JOBS_KV.list({ limit: 1000 });
    const jobs = [];
    
    for (const key of listResult.keys) {
      // Only process job IDs (not other KV entries)
      if (!key.name.includes('/') && key.name.length === 36) { // UUID format
        try {
          const jobData = await env.GROQ_JOBS_KV.get(key.name);
          if (jobData) {
            const job = JSON.parse(jobData);
            
            // Filter by status if provided
            if (status && job.status !== status) {
              continue;
            }
            
            // Create summary without large transcript data
            const jobSummary = {
              job_id: key.name,
              filename: job.filename || 'Unknown',
              status: job.status,
              progress: job.progress || 0,
              file_size: job.actual_size || job.size || 0,
              processing_method: job.processing_method || (job.actual_size > 15 * 1024 * 1024 ? 'chunked' : 'direct'),
              upload_method: job.source_url ? 'url' : (job.processing_method === 'streaming' ? 'streaming' : 'direct'),
              created_at: job.created_at,
              uploaded_at: job.uploaded_at,
              processing_started_at: job.processing_started_at,
              completed_at: job.completed_at || job.failed_at,
              error: job.error || null,
              use_llm: job.use_llm || false,
              llm_mode: job.llm_mode || null,
              chunk_size_mb: job.chunk_size_mb || null,
              source_url: job.source_url || null,
              total_segments: job.total_segments || 0,
              success_rate: job.success_rate || null,
              expires_at: key.expiration ? new Date(key.expiration * 1000).toISOString() : null
            };
            
            // Include transcript data for completed streaming jobs so they persist across reloads
            if (job.processing_method === 'streaming' && job.status === 'done') {
              jobSummary.final_transcript = job.final_transcript || '';
              jobSummary.raw_transcript = job.raw_transcript || '';
              jobSummary.corrected_transcript = job.corrected_transcript || '';
              jobSummary.transcripts = job.transcripts || [];
            }
            
            jobs.push(jobSummary);
          }
        } catch (error) {
          apiLogger.warn(`Failed to parse job data`, { 
            job_key: key.name, 
            error: error.message 
          });
        }
      }
    }
    
    // Sort by creation date (newest first)
    jobs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    // Apply limit
    const limitedJobs = jobs.slice(0, limit);
    
    return new Response(JSON.stringify({
      jobs: limitedJobs,
      total: jobs.length,
      showing: limitedJobs.length,
      filters: status ? { status } : null
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: 'Failed to list jobs', 
      message: error.message 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Delete a job and its associated files
 * curl -X POST http://localhost:8787/delete-job -H "Content-Type: application/json" -d '{"job_id": "your-job-id"}'
 */
async function handleDeleteJob(request, env) {
  try {
    const { job_id } = await request.json();
    
    if (!job_id) {
      return new Response(JSON.stringify({ 
        error: 'Missing job_id' 
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Get job data first
    const jobData = await env.GROQ_JOBS_KV.get(job_id);
    if (!jobData) {
      return new Response(JSON.stringify({ 
        error: 'Job not found' 
      }), { 
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const job = JSON.parse(jobData);
    const bucketName = env.R2_BUCKET_NAME || (env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');
    
    // Delete from R2 if file exists
    if (job.key) {
      try {
        const s3Client = createS3Client(env);
        const deleteCmd = new DeleteObjectCommand({ 
          Bucket: bucketName, 
          Key: job.key 
        });
        await s3Client.send(deleteCmd);
        apiLogger.info('delete', `Deleted R2 file`, { key: job.key });
              } catch (error) {
          apiLogger.warn(`Failed to delete R2 file`, { 
            key: job.key, 
            error: error.message 
          });
          // Continue with KV deletion even if R2 deletion fails
        }
    }
    
    // Delete from KV
    await env.GROQ_JOBS_KV.delete(job_id);
    
    return new Response(JSON.stringify({
      message: 'Job deleted successfully',
      job_id,
      deleted_file: job.key || null,
      filename: job.filename || 'Unknown'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: 'Failed to delete job', 
      message: error.message 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Save a completed streaming job to KV storage
 * This allows streaming jobs to be accessible from other systems (CLI, etc.)
 */
async function handleSaveStreamingJob(request, env) {
  try {
    const data = await request.json();
    
    if (!data.job_id || !data.filename) {
      return new Response(JSON.stringify({ 
        error: 'Missing required fields: job_id, filename' 
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Create a job object compatible with regular jobs
    const jobData = {
      job_id: data.job_id,
      filename: data.filename,
      status: 'done',
      file_size: data.file_size || 0,
      processing_method: 'streaming',
      upload_method: 'streaming',
      created_at: data.created_at || new Date().toISOString(),
      completed_at: data.completed_at || new Date().toISOString(),
      
      // Transcription results
      final_transcript: data.final_transcript || '',
      raw_transcript: data.raw_transcript || '',
      corrected_transcript: data.corrected_transcript || '',
      total_segments: data.total_segments || 0,
      
      // Add transcripts array to match direct/chunked upload format
      // Use provided transcripts if available, otherwise create fallback
      transcripts: data.transcripts && data.transcripts.length > 0 ? data.transcripts : [{
        text: data.final_transcript || '',
        raw_text: data.raw_transcript || '',
        segments: [], // Streaming doesn't provide detailed segments unless passed from client
        start: 0,
        duration: data.file_size || 0,
        chunk_index: 'streaming'
      }],
      
      // Processing settings
      use_llm: data.use_llm || false,
      llm_mode: data.llm_mode || 'disabled',
      chunk_size_mb: data.chunk_size_mb || 1,
      
      // Additional metadata
      progress: 100,
      source_url: data.source_url || null,
      
      // No file key since streaming jobs don't upload files to R2
      key: null
    };

    // Save to KV storage
    await env.GROQ_JOBS_KV.put(data.job_id, JSON.stringify(jobData));
    
    apiLogger.info('complete', 'Saved streaming job to KV', { 
      job_id: data.job_id, 
      filename: data.filename,
      transcript_length: data.final_transcript?.length || 0
    });
    
    return new Response(JSON.stringify({
      message: 'Streaming job saved successfully',
      job_id: data.job_id
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    apiLogger.error('Failed to save streaming job', error);
    return new Response(JSON.stringify({ 
      error: 'Failed to save streaming job', 
      message: error.message 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}