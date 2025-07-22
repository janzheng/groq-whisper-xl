import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { STATIC_FILES } from './static-web.js';
import { apiLogger, processingLogger, formatBytes, withExponentialRetry } from './core/logger.js';
import { handleStreamingTranscription, transcribeChunk } from './core/streaming.js';
import { withLLMLimits, getRateLimitStatus } from './core/rate-limiter.js';

// Chunked Upload Streaming imports
import {
  handleChunkedUploadStream,
  handleChunkedUploadStatus,
  handleChunkedUploadCancel,
  handleChunkedUploadRetry,
  handleChunkedStream,
  handleChunkedStreamOptions,
  handleChunkUploadComplete,
  handleBatchChunkUploadComplete,
  handleChunkedUploadQueue,
  enhanceJobListing
} from './chunked-streaming/index.js';

// ============================================================================
// MAIN CLOUDFLARE WORKER EXPORT
// ============================================================================

/**
 * Handle chunk upload through Worker (avoids CORS issues)
 * POST /chunk-upload
 * Content-Type: multipart/form-data
 * - chunk: File blob
 * - parent_job_id: string
 * - chunk_index: number
 * - expected_size: number
 */
async function handleChunkUpload(request, env) {
  try {
    const contentType = request.headers.get('content-type') || '';
    
    if (!contentType.includes('multipart/form-data')) {
      return new Response(JSON.stringify({
        error: 'Content-Type must be multipart/form-data'
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const formData = await request.formData();
    const chunk = formData.get('chunk');
    const parent_job_id = formData.get('parent_job_id');
    const chunk_index = parseInt(formData.get('chunk_index'));
    const expected_size = parseInt(formData.get('expected_size') || '0');

    if (!chunk || !parent_job_id || chunk_index === undefined) {
      return new Response(JSON.stringify({
        error: 'Missing required fields: chunk, parent_job_id, chunk_index'
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const chunkData = await chunk.arrayBuffer();
    const actual_size = chunkData.byteLength;

    // Check if debug mode is enabled for this job
    let debugSaveChunks = false;
    let parentJobData = null;
    try {
      const rawParentJobData = await env.GROQ_JOBS_KV.get(parent_job_id);
      if (rawParentJobData) {
        parentJobData = JSON.parse(rawParentJobData);
        debugSaveChunks = parentJobData.debug_save_chunks || false;
      }
    } catch (error) {
      apiLogger.warn('Could not get parent job for debug check', { parent_job_id });
    }

    // Enhanced validation and debugging for chunk integrity
    const isChunk0 = chunk_index === 0;
    
    if (isChunk0) {
      // Detailed analysis of chunk 0 on server side
      const uint8Array = new Uint8Array(chunkData);
      const first64Bytes = Array.from(uint8Array.slice(0, Math.min(64, uint8Array.length)));
      const zeroCount = first64Bytes.filter(byte => byte === 0).length;
      const zeroPercentage = (zeroCount / first64Bytes.length) * 100;
      
      apiLogger.info('chunk0_server', 'Chunk 0 received on server', {
        parent_job_id,
        actual_size,
        expected_size,
        size_match: actual_size === expected_size,
        first_64_bytes: first64Bytes.map(b => b.toString(16).padStart(2, '0')).join(' '),
        zero_count: zeroCount,
        zero_percentage: zeroPercentage.toFixed(1),
        suspicious: zeroPercentage > 25,
        original_chunk_name: chunk.name || 'unnamed',
        debug_save_enabled: debugSaveChunks
      });
      
      if (zeroPercentage > 25) {
        apiLogger.warn('chunk0_server', `Chunk 0 has ${zeroPercentage.toFixed(1)}% zeros on server - corruption detected!`, {
          parent_job_id,
          chunk_index,
          zero_percentage: zeroPercentage
        });
      }
    }

    // Save chunk to temporary folder if debug mode is enabled
    if (debugSaveChunks) {
      try {
        const debugFileName = `debug_chunk_${parent_job_id}_${chunk_index}.${parentJobData?.filename?.split('.').pop() || 'mp3'}`;
        const debugInfo = {
          parent_job_id,
          chunk_index,
          actual_size,
          expected_size,
          filename: debugFileName,
          saved_at: new Date().toISOString(),
          original_filename: parentJobData?.filename || 'unknown',
          chunk_name: chunk.name || 'unnamed'
        };

        // Save to R2 (Workers can't access local file system)
        const debugKey = `debug/${parent_job_id}/${debugFileName}`;
        const bucketName = env.R2_BUCKET_NAME || (env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');
        const s3Client = createS3Client(env);
        
        const debugPutCmd = new PutObjectCommand({
          Bucket: bucketName,
          Key: debugKey,
          Body: chunkData,
          ContentType: 'application/octet-stream',
          Metadata: {
            'debug-info': JSON.stringify(debugInfo),
            'parent-job-id': parent_job_id,
            'chunk-index': chunk_index.toString(),
            'original-filename': parentJobData?.filename || 'unknown'
          }
        });
        
        await s3Client.send(debugPutCmd);
        
        // Create full R2 URL for easy access
        const r2Url = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucketName}/${debugKey}`;
        const debugEndpointUrl = `/debug/chunk?parent_job_id=${parent_job_id}&chunk_index=${chunk_index}`;
        
        apiLogger.info('debug_save', `📁 Saved chunk ${chunk_index} to R2`, {
          parent_job_id,
          chunk_index,
          debug_key: debugKey,
          bucket: bucketName,
          size: formatBytes(actual_size),
          r2_url: r2Url,
          download_url: debugEndpointUrl,
          environment: env.ENVIRONMENT || 'production'
        });

        // Also save debug info to KV for easy retrieval
        const debugInfoKey = `debug_${parent_job_id}_chunk_${chunk_index}`;
        await env.GROQ_JOBS_KV.put(debugInfoKey, JSON.stringify({
          ...debugInfo,
          debug_key: debugKey,
          bucket: bucketName,
          r2_url: r2Url,
          download_url: debugEndpointUrl
        }), { expirationTtl: 86400 }); // Expire after 24 hours
        
      } catch (debugError) {
        apiLogger.error('Failed to save debug chunk', debugError, {
          parent_job_id,
          chunk_index
        });
        // Continue processing even if debug save fails
      }
    }

    // Validate chunk size if expected_size provided
    if (expected_size > 0 && actual_size !== expected_size) {
      apiLogger.warn('Chunk size mismatch', {
        parent_job_id,
        chunk_index,
        expected_size,
        actual_size,
        is_chunk_0: isChunk0
      });
    }

    // Store chunk in R2
    const bucketName = env.R2_BUCKET_NAME || (env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');
    const s3Client = createS3Client(env);
    
    // Get the filename extension from the parent job to maintain consistency
    let ext = 'mp3';
    try {
      const parentJobData = await env.GROQ_JOBS_KV.get(parent_job_id);
      if (parentJobData) {
        const parentJob = JSON.parse(parentJobData);
        ext = parentJob.filename?.split('.').pop() || 'mp3';
      }
    } catch (error) {
      apiLogger.warn('Could not get parent job for file extension', { parent_job_id });
    }

    const key = `uploads/${parent_job_id}/chunk.${chunk_index}.${ext}`;
    
    const putCmd = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: chunkData,
      ContentType: 'audio/*'
    });
    
    await s3Client.send(putCmd);

    apiLogger.info('upload', `Chunk ${chunk_index} uploaded via Worker`, {
      parent_job_id,
      chunk_index,
      actual_size: formatBytes(actual_size),
      key
    });

    // Automatically trigger processing completion notification
    try {
      const completeResult = await handleChunkUploadComplete(
        new Request('http://localhost/chunk-upload-complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parent_job_id,
            chunk_index,
            actual_size
          })
        }),
        env
      );

      // Extract the response data
      const completeData = await completeResult.json();

      return new Response(JSON.stringify({
        message: 'Chunk uploaded and processing started',
        parent_job_id,
        chunk_index,
        actual_size,
        key,
        processing_result: completeData
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (processingError) {
      apiLogger.error('Failed to start chunk processing after upload', processingError);
      
      return new Response(JSON.stringify({
        message: 'Chunk uploaded but processing failed to start',
        parent_job_id,
        chunk_index,
        actual_size,
        key,
        processing_error: processingError.message
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

  } catch (error) {
    apiLogger.error('Chunk upload failed', error);
    return new Response(JSON.stringify({
      error: 'Chunk upload failed',
      message: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

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
    } else if (url.pathname === '/rate-limit-status' && request.method === 'GET') {
      return handleRateLimitStatus(request, env);
    }
    
    // Chunked Upload Streaming API
    else if (url.pathname === '/chunked-upload-stream' && request.method === 'POST') {
      return handleChunkedUploadStream(request, env);
    } else if (url.pathname === '/chunked-upload-status' && request.method === 'GET') {
      return handleChunkedUploadStatus(request, env);
    } else if (url.pathname === '/chunked-upload-cancel' && request.method === 'POST') {
      return handleChunkedUploadCancel(request, env);
    } else if (url.pathname === '/chunked-upload-retry' && request.method === 'POST') {
      return handleChunkedUploadRetry(request, env);
    } else if (url.pathname === '/chunk-upload' && request.method === 'POST') {
      return handleChunkUpload(request, env);
    } else if (url.pathname === '/chunk-upload-complete' && request.method === 'POST') {
      return handleChunkUploadComplete(request, env);
    } else if (url.pathname === '/chunks-upload-complete' && request.method === 'POST') {
      return handleBatchChunkUploadComplete(request, env);
    } else if (url.pathname.startsWith('/chunked-stream/') && request.method === 'GET') {
      const parent_job_id = url.pathname.split('/chunked-stream/')[1];
      return handleChunkedStream(request, env, parent_job_id);
    } else if (url.pathname.startsWith('/chunked-stream/') && request.method === 'OPTIONS') {
      return handleChunkedStreamOptions(request);
    }
    
    // Debug endpoints for chunk inspection
    else if (url.pathname === '/debug/chunks' && request.method === 'GET') {
      return handleDebugChunksList(request, env);
    } else if (url.pathname === '/debug/chunk' && request.method === 'GET') {
      return handleDebugChunkDownload(request, env);
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
      const messageBody = msg.body;
      
      // Handle different queue message types
      if (messageBody.job_id && !messageBody.parent_job_id) {
        // Regular job processing
        await processJob(messageBody.job_id, env);
      } else if (messageBody.parent_job_id && messageBody.sub_job_id) {
        // Chunked upload streaming job processing
        await handleChunkedUploadQueue({ messages: [{ body: messageBody }] }, env);
      } else {
        apiLogger.warn('Unknown queue message format', { messageBody });
      }
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
 *   -F "use_llm=true" \
 *   -F "model=whisper-large-v3" \
 *   -F "chunk_size_mb=10"
 * 
 * OR with JSON:
 * curl -X POST http://localhost:8787/upload \
 *   -H "Content-Type: application/json" \
 *   -d '{"filename": "audio.mp3", "file_data": "base64encodeddata", "use_llm": true, "model": "whisper-large-v3", "chunk_size_mb": 10}'
 */
async function handleDirectUpload(request, env) {
  const contentType = request.headers.get('content-type') || '';
  let filename, fileData, use_llm = false, webhook_url = null, model = 'whisper-large-v3', chunk_size_mb = 10, debug_save_chunks = false;
  
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
      model = formData.get('model') || 'whisper-large-v3';
      chunk_size_mb = parseFloat(formData.get('chunk_size_mb')) || 10;
      debug_save_chunks = formData.get('debug_save_chunks') === 'true';
      
    } else if (contentType.includes('application/json')) {
      // Handle JSON upload with base64 data
      const body = await request.json();
      filename = body.filename;
      use_llm = body.use_llm || false;
      webhook_url = body.webhook_url || null;
      model = body.model || 'whisper-large-v3';
      chunk_size_mb = body.chunk_size_mb || 10;
      debug_save_chunks = body.debug_save_chunks || false;
      
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
      model,
      chunk_size_mb,
      webhook_url,
      created_at: new Date().toISOString(),
      uploaded_at: new Date().toISOString(),
      debug_save_chunks
    };
    
    await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });

    // Queue processing in background instead of awaiting
    await env.GROQ_PROCESSING_QUEUE.send({ job_id });
    
    return new Response(JSON.stringify({
      message: 'File uploaded and queued for processing',
      job_id,
      filename,
      file_size: fileData.byteLength,
      model,
      chunk_size_mb,
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
 *   -d '{"url": "https://example.com/audio.mp3", "use_llm": true, "model": "whisper-large-v3", "chunk_size_mb": 10}'
 */
async function handleUrlUpload(request, env) {
  try {
    const { url: audioUrl, filename = null, use_llm = false, webhook_url = null, model = 'whisper-large-v3', chunk_size_mb = 10, debug_save_chunks = false } = await request.json();
    
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
      model,
      chunk_size_mb,
      webhook_url,
      created_at: new Date().toISOString(),
      uploaded_at: new Date().toISOString(),
      debug_save_chunks
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
      model,
      chunk_size_mb,
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
 *   -d '{"filename": "audio.mp3", "use_llm": true, "model": "whisper-large-v3", "chunk_size_mb": 10}'
 */
async function handleGetPresignedUrl(request, env) {
  const { filename, size = null, use_llm = false, webhook_url = null, model = 'whisper-large-v3', chunk_size_mb = 10 } = await request.json();
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
    model,
    chunk_size_mb,
    webhook_url,
    created_at: new Date().toISOString(),
    upload_url: signedUrl
  }), { expirationTtl: 86400 });

  return new Response(JSON.stringify({ 
    job_id, 
    upload_url: signedUrl,
    model,
    chunk_size_mb,
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

// Streaming API is now handled by core/streaming.js module

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
      job_id: job_id,
      debug_save_chunks: job.debug_save_chunks || false
    });
    
    // Decide processing strategy
    const CHUNK_THRESHOLD = 15 * 1024 * 1024; // 15MB
    const chunkSizeMB = job.chunk_size_mb || 10; // Use job's chunk size or default to 10MB
    const MAX_CHUNK_SIZE = chunkSizeMB * 1024 * 1024;  // Convert to bytes
    
    if (fileSize <= CHUNK_THRESHOLD) {
      processingLogger.info('transcribe', 'Using direct processing (small file)');
      await processDirectly(job_id, response, env);
    } else {
      processingLogger.info('chunk', `Using chunked processing (large file) with ${chunkSizeMB}MB chunks`);
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
  const model = job.model || 'whisper-large-v3';
  
  processingLogger.transcribe(`Starting direct transcription`, { 
    filename: job.filename, 
    extension: ext,
    model
  });
  const transcript = await transcribeChunk(combined, ext, env.GROQ_API_KEY, model);
  
  // Apply LLM correction if requested
  let finalTranscript = transcript.text;
  if (job.use_llm && transcript.text) {
    processingLogger.llm('Applying LLM corrections to transcript');
    finalTranscript = await applyLLMCorrection(transcript.text, env.GROQ_API_KEY);
  }
  
  // Update job with results (preserve full Groq response)
  job.status = 'done';
  job.transcripts = [{ 
    text: transcript.text, 
    segments: transcript.segments,
    start: 0,
    duration: totalLength,
    chunk_index: 0,
    model,
    groq_response: transcript // Preserve full Groq API response
  }];
  job.final_transcript = finalTranscript;
  job.completed_at = new Date().toISOString();
  job.processing_method = 'direct';
  job.groq_traces = [transcript]; // Store all API traces for debugging
  
  await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });
  
  // Send webhook if configured
  if (job.webhook_url) {
    await sendWebhook(job.webhook_url, job_id, job);
  }
  
  processingLogger.complete('Direct processing completed', { 
    job_id, 
    filename: job.filename,
    model,
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
  
  // Create intelligent chunks with overlap - use audio-aware chunking for better debug chunks
  const audioChunks = createAudioAwareChunks(fileBuffer, chunkSize, job.filename);
  processingLogger.stats(`Created chunks for processing`, { 
    total_chunks: audioChunks.length,
    chunk_size: formatBytes(chunkSize),
    job_id,
    chunking_method: job.filename.toLowerCase().endsWith('.wav') ? 'wav_aware' : 'simple'
  });
  
  job.total_chunks = audioChunks.length;
  job.processed_chunks = 0;
  await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });
  
  const transcripts = [];
  const groqTraces = []; // Store all Groq API responses
  const ext = job.filename.split('.').pop() || 'mp3';
  const model = job.model || 'whisper-large-v3';
  
  // Process chunks sequentially to avoid rate limits
  for (let i = 0; i < audioChunks.length; i++) {
    const chunk = audioChunks[i];
    processingLogger.chunk(`Processing chunk ${i + 1}/${audioChunks.length}`, {
      chunk_index: i + 1,
      chunk_size: formatBytes(chunk.data.length),
      model,
      job_id
    });
    
    // Save debug chunk if enabled
    if (job.debug_save_chunks) {
      try {
        const debugFileName = `debug_chunk_${job_id}_${i}.${ext}`;
        const debugInfo = {
          parent_job_id: job_id,
          chunk_index: i,
          actual_size: chunk.data.length,
          expected_size: chunk.data.length,
          filename: debugFileName,
          saved_at: new Date().toISOString(),
          original_filename: job.filename,
          processing_method: 'direct_upload_chunked',
          is_playable: chunk.isPlayable || false,
          chunking_method: job.filename.toLowerCase().endsWith('.wav') ? 'wav_aware' : 'simple',
          audio_data_size: chunk.audioDataSize || chunk.data.length
        };

        // Save to R2 (Workers can't access local file system)
        const debugKey = `debug/${job_id}/${debugFileName}`;
        const bucketName = env.R2_BUCKET_NAME || (env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');
        const s3Client = createS3Client(env);
        
        const debugPutCmd = new PutObjectCommand({
          Bucket: bucketName,
          Key: debugKey,
          Body: chunk.data,
          ContentType: 'application/octet-stream',
          Metadata: {
            'debug-info': JSON.stringify(debugInfo),
            'job-id': job_id,
            'chunk-index': i.toString(),
            'original-filename': job.filename
          }
        });
        
        await s3Client.send(debugPutCmd);
        
        // Create full R2 URL for easy access
        const r2Url = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucketName}/${debugKey}`;
        const debugEndpointUrl = `/debug/chunk?job_id=${job_id}&chunk_index=${i}`;
        
        processingLogger.info('file', `Saved debug chunk ${i} to R2 - Download: ${debugEndpointUrl}`, {
          job_id,
          chunk_index: i,
          debug_key: debugKey,
          bucket: bucketName,
          size: formatBytes(chunk.data.length),
          download_url: debugEndpointUrl,
          environment: env.ENVIRONMENT || 'production',
          is_playable: chunk.isPlayable || false,
          chunking_method: job.filename.toLowerCase().endsWith('.wav') ? 'wav_aware' : 
                          job.filename.toLowerCase().endsWith('.mp3') ? 'mp3_aware' : 'simple',
          localhost_url: `http://localhost:8787${debugEndpointUrl}` // Full localhost URL for easy clicking
        });

        // Save debug info to KV for easy retrieval via UI
        const debugInfoKey = `debug_${job_id}_chunk_${i}`;
        await env.GROQ_JOBS_KV.put(debugInfoKey, JSON.stringify({
          ...debugInfo,
          debug_key: debugKey,
          bucket: bucketName,
          r2_url: r2Url,
          download_url: debugEndpointUrl
        }), { expirationTtl: 86400 });
        
      } catch (debugError) {
        processingLogger.error('Debug chunk save failed', debugError, {
          job_id,
          chunk_index: i
        });
        // Continue processing even if debug save fails
      }
    }
    
    try {
      const transcript = await transcribeChunk(chunk.data, ext, env.GROQ_API_KEY, model);
      groqTraces.push(transcript); // Store full API response
      
      transcripts.push({
        text: transcript.text,
        segments: transcript.segments,
        start: chunk.start,
        duration: chunk.data.length,
        chunk_index: i,
        model,
        groq_response: transcript // Preserve full Groq response per chunk
      });
      
      // Update progress
      job.processed_chunks = i + 1;
      job.progress = Math.round((i + 1) / audioChunks.length * 100);
      await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });
      
      processingLogger.complete(`Chunk ${i + 1} completed`, { 
        progress: job.progress,
        model,
        job_id
      });
      
      // Small delay to avoid rate limiting
      if (i < audioChunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
    } catch (error) {
      processingLogger.error(`Chunk ${i + 1} failed`, error, { 
        chunk_index: i + 1,
        model,
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
    model,
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
  job.groq_traces = groqTraces; // Store all API traces for debugging
  
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
    model,
    transcript_length: mergedText?.length || 0
  });
}

// transcribeChunk function moved to core/streaming.js

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
 * Audio-aware chunking that creates playable chunks with proper headers
 * CRITICAL: Each chunk must be a valid, independently playable audio file
 * for the Groq API to accept it.
 */
export function createAudioAwareChunks(buffer, chunkSize, filename = '') {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  
  try {
    switch (ext) {
      case 'wav':
        return createWAVChunks(buffer, chunkSize);
      case 'mp3':
        return createMP3Chunks(buffer, chunkSize);
      case 'mp4':
      case 'm4a':
        return createMP4Chunks(buffer, chunkSize);
      case 'flac':
        return createFLACChunks(buffer, chunkSize);
      case 'ogg':
        return createOGGChunks(buffer, chunkSize);
      default:
        // For unknown formats, try to detect and fall back gracefully
        processingLogger.warn(`Unknown audio format: ${ext}, using simple chunking (may cause API errors)`);
        return createChunks(buffer, chunkSize);
    }
  } catch (error) {
    processingLogger.error(`Audio-aware chunking failed for ${ext}:`, error);
    processingLogger.warn('Falling back to simple chunking (may cause API errors)');
    return createChunks(buffer, chunkSize);
  }
}

/**
 * Create WAV chunks with proper headers for playable debug files
 */
function createWAVChunks(buffer, chunkSize) {
  const chunks = [];
  
  // Parse WAV header
  const wavHeader = parseWAVHeader(buffer);
  if (!wavHeader) {
    // Not a valid WAV, fall back to simple chunking
    return createChunks(buffer, chunkSize);
  }
  
  const { headerSize, dataStart, audioFormat, channels, sampleRate, bitsPerSample } = wavHeader;
  const overlapSize = Math.floor(chunkSize * 0.05); // 5% overlap
  
  // Calculate bytes per sample to align chunks on sample boundaries
  const bytesPerSample = (bitsPerSample / 8) * channels;
  const alignedOverlapSize = Math.floor(overlapSize / bytesPerSample) * bytesPerSample;
  const alignedChunkSize = Math.floor(chunkSize / bytesPerSample) * bytesPerSample;
  
  for (let start = dataStart; start < buffer.length; start += alignedChunkSize - alignedOverlapSize) {
    const end = Math.min(start + alignedChunkSize, buffer.length);
    const audioData = buffer.slice(start, end);
    const audioDataSize = audioData.length;
    
    // Create new WAV chunk with proper header
    const chunkWithHeader = createWAVChunkWithHeader(
      audioData, 
      audioFormat, 
      channels, 
      sampleRate, 
      bitsPerSample
    );
    
    chunks.push({
      start: start - dataStart, // Relative to audio data start
      end: end - dataStart,
      data: chunkWithHeader,
      hasOverlap: start > dataStart,
      audioDataSize,
      isPlayable: true
    });
    
    if (end >= buffer.length) break;
  }
  
  return chunks;
}

/**
 * Parse WAV file header to extract format information
 */
function parseWAVHeader(buffer) {
  try {
    const view = new DataView(buffer.buffer || buffer);
    
    // Check RIFF header
    const riff = new TextDecoder().decode(buffer.slice(0, 4));
    if (riff !== 'RIFF') return null;
    
    // Check WAVE format
    const wave = new TextDecoder().decode(buffer.slice(8, 12));
    if (wave !== 'WAVE') return null;
    
    // Find fmt chunk
    let offset = 12;
    while (offset < buffer.length - 8) {
      const chunkId = new TextDecoder().decode(buffer.slice(offset, offset + 4));
      const chunkSize = view.getUint32(offset + 4, true);
      
      if (chunkId === 'fmt ') {
        const audioFormat = view.getUint16(offset + 8, true);
        const channels = view.getUint16(offset + 10, true);
        const sampleRate = view.getUint32(offset + 12, true);
        const bitsPerSample = view.getUint16(offset + 22, true);
        
        // Find data chunk
        let dataOffset = offset + 8 + chunkSize;
        while (dataOffset < buffer.length - 8) {
          const dataChunkId = new TextDecoder().decode(buffer.slice(dataOffset, dataOffset + 4));
          if (dataChunkId === 'data') {
            return {
              headerSize: dataOffset + 8,
              dataStart: dataOffset + 8,
              audioFormat,
              channels,
              sampleRate,
              bitsPerSample
            };
          }
          const dataChunkSize = view.getUint32(dataOffset + 4, true);
          dataOffset += 8 + dataChunkSize;
        }
        break;
      }
      
      offset += 8 + chunkSize;
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Create a complete WAV file with header for a chunk of audio data
 */
function createWAVChunkWithHeader(audioData, audioFormat, channels, sampleRate, bitsPerSample) {
  const dataSize = audioData.length;
  const fileSize = 36 + dataSize;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  
  // Create header buffer
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const headerBytes = new Uint8Array(header);
  
  // RIFF header
  headerBytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, fileSize, true);
  headerBytes.set(new TextEncoder().encode('WAVE'), 8);
  
  // fmt chunk
  headerBytes.set(new TextEncoder().encode('fmt '), 12);
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  
  // data chunk
  headerBytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, dataSize, true);
  
  // Combine header and audio data
  const result = new Uint8Array(44 + dataSize);
  result.set(headerBytes, 0);
  result.set(audioData, 44);
  
  return result;
}

/**
 * Simple LLM correction using Groq (for post-processing)
 * This is used by the non-streaming processing engine
 */
async function applyLLMCorrection(text, apiKey) {
  try {
    return await withLLMLimits(async () => {
      const result = await withExponentialRetry(async () => {
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
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const error = new Error(`LLM API error: ${response.status} ${response.statusText}`);
          error.status = response.status;
          error.response = { status: response.status };
          error.details = errorData;
          throw error;
        }
        
        return await response.json();
      }, {
        maxRetries: 4, // Good balance for post-processing
        baseDelay: 1000,
        maxDelay: 20000
      });
      
      return result.choices[0].message.content;
    }, {
      text_length: text.length,
      operation: 'batch_llm_correction'
    });
  } catch (error) {
    processingLogger.error('LLM correction failed after retries', error, { 
      original_length: text?.length || 0 
    });
    return text; // Return original if correction fails
  }
}

/**
 * Rate limit status endpoint for monitoring and debugging
 * curl http://localhost:8787/rate-limit-status
 */
async function handleRateLimitStatus(request, env) {
  try {
    const status = getRateLimitStatus();
    
    return new Response(JSON.stringify({
      timestamp: new Date().toISOString(),
      service: 'groq-whisper-xl',
      rate_limits: status,
      recommendations: {
        transcription: status.transcription.waiting > 5 
          ? 'Consider increasing TRANSCRIPTION_CONCURRENCY or reducing request rate'
          : 'Rate limiting appears healthy',
        llm: status.llm.waiting > 3
          ? 'Consider increasing LLM_CONCURRENCY or reducing LLM correction usage'
          : 'LLM rate limiting appears healthy',
        job_spawn: status.job_spawn.waiting > 2
          ? 'Job spawning is queued - large chunked uploads may be delayed'
          : 'Job spawning appears healthy',
        chunk_processing: status.chunk_processing.waiting > 5
          ? 'Chunk processing is heavily queued - consider reducing concurrent uploads'
          : 'Chunk processing appears healthy'
      }
    }, null, 2), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to get rate limit status',
      message: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
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
              model: job.model || null,
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
            
            // Include transcript data for completed chunked upload streaming jobs
            if (job.type === 'chunked_upload_streaming' && job.status === 'done') {
              jobSummary.final_transcript = job.final_transcript || '';
              jobSummary.raw_transcript = job.raw_transcript || '';
              jobSummary.corrected_transcript = job.corrected_transcript || '';
              jobSummary.transcripts = job.transcripts || [];
              jobSummary.total_chunks = job.total_chunks || 0;
              jobSummary.completed_chunks = job.completed_chunks || 0;
              jobSummary.failed_chunks = job.failed_chunks || 0;
              jobSummary.upload_progress = job.upload_progress || 0;
              jobSummary.processing_progress = job.processing_progress || 0;
            }
            
            // Enhance job summary for chunked upload streaming
            const enhancedJobSummary = enhanceJobListing(jobSummary);
            jobs.push(enhancedJobSummary);
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

/**
 * Debug endpoint: List saved debug chunks for a job
 * GET /debug/chunks?parent_job_id=uuid  (for chunked streaming)
 * GET /debug/chunks?job_id=uuid         (for direct uploads)
 */
async function handleDebugChunksList(request, env) {
  try {
    const url = new URL(request.url);
    const parent_job_id = url.searchParams.get('parent_job_id');
    const job_id = url.searchParams.get('job_id');
    const target_job_id = parent_job_id || job_id;

    if (!target_job_id) {
      return new Response(JSON.stringify({
        error: 'parent_job_id or job_id parameter is required'
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const debugChunks = [];
    
    if (parent_job_id) {
      // Chunked streaming - use KV metadata
      const keys = await env.GROQ_JOBS_KV.list({ prefix: `debug_${parent_job_id}_chunk_` });
      
      for (const key of keys.keys) {
        try {
          const debugInfoData = await env.GROQ_JOBS_KV.get(key.name);
          if (debugInfoData) {
            const debugInfo = JSON.parse(debugInfoData);
            debugChunks.push({
              ...debugInfo,
              storage_type: 'r2'
            });
          }
        } catch (error) {
          console.error(`Failed to parse debug info for ${key.name}:`, error);
        }
      }
    } else {
      // Direct upload - try KV first, then R2 listing
      const keys = await env.GROQ_JOBS_KV.list({ prefix: `debug_${job_id}_chunk_` });
      
      if (keys.keys.length > 0) {
        // Found in KV
        for (const key of keys.keys) {
          try {
            const debugInfoData = await env.GROQ_JOBS_KV.get(key.name);
            if (debugInfoData) {
              const debugInfo = JSON.parse(debugInfoData);
              debugChunks.push({
                ...debugInfo,
                storage_type: 'r2'
              });
            }
          } catch (error) {
            console.error(`Failed to parse debug info for ${key.name}:`, error);
          }
        }
      } else {
        // Fall back to R2 listing
        try {
          const bucketName = env.R2_BUCKET_NAME || (env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');
          const s3Client = createS3Client(env);
          
          const listCmd = new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: `debug/${job_id}/`
          });
          
          const response = await s3Client.send(listCmd);
          if (response.Contents) {
            for (const obj of response.Contents) {
              if (obj.Key.endsWith('.mp3') || obj.Key.endsWith('.wav') || obj.Key.endsWith('.m4a')) {
                const chunkMatch = obj.Key.match(/debug_chunk_[^_]+_(\d+)\./);
                if (chunkMatch) {
                  const r2Url = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucketName}/${obj.Key}`;
                  debugChunks.push({
                    parent_job_id: job_id,
                    chunk_index: parseInt(chunkMatch[1]),
                    filename: obj.Key.split('/').pop(),
                    actual_size: obj.Size,
                    saved_at: obj.LastModified.toISOString(),
                    storage_type: 'r2',
                    debug_key: obj.Key,
                    bucket: bucketName,
                    r2_url: r2Url,
                    download_url: `/debug/chunk?job_id=${job_id}&chunk_index=${chunkMatch[1]}`
                  });
                }
              }
            }
          }
        } catch (r2Error) {
          apiLogger.warn('Failed to list R2 debug chunks', r2Error);
        }
      }
    }

    // Sort by chunk index
    debugChunks.sort((a, b) => a.chunk_index - b.chunk_index);

    return new Response(JSON.stringify({
      job_id: target_job_id,
      debug_chunks: debugChunks,
      count: debugChunks.length,
      storage_type: 'r2',
      environment: env.ENVIRONMENT || 'production'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    apiLogger.error('Failed to list debug chunks', error);
    return new Response(JSON.stringify({
      error: 'Failed to list debug chunks',
      message: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Debug endpoint: Download a specific debug chunk
 * GET /debug/chunk?parent_job_id=uuid&chunk_index=0  (for chunked streaming)
 * GET /debug/chunk?job_id=uuid&chunk_index=0         (for direct uploads)
 */
async function handleDebugChunkDownload(request, env) {
  try {
    const url = new URL(request.url);
    const parent_job_id = url.searchParams.get('parent_job_id');
    const job_id = url.searchParams.get('job_id');
    const target_job_id = parent_job_id || job_id;
    const chunk_index = parseInt(url.searchParams.get('chunk_index'));

    if (!target_job_id || chunk_index === undefined) {
      return new Response(JSON.stringify({
        error: 'parent_job_id or job_id, and chunk_index parameters are required'
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Read from R2 (all debug chunks are stored there)
    if (parent_job_id) {
      // Chunked streaming path - use KV metadata
      const debugInfoKey = `debug_${parent_job_id}_chunk_${chunk_index}`;
      const debugInfoData = await env.GROQ_JOBS_KV.get(debugInfoKey);
      
      if (!debugInfoData) {
        return new Response(JSON.stringify({
          error: 'Debug chunk not found'
        }), { 
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const debugInfo = JSON.parse(debugInfoData);
      
      // Download chunk from R2
      const s3Client = createS3Client(env);
      const getCmd = new GetObjectCommand({
        Bucket: debugInfo.bucket,
        Key: debugInfo.debug_key
      });

      const s3Response = await s3Client.send(getCmd);

      return new Response(s3Response.Body, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${debugInfo.filename}"`,
          'Content-Length': debugInfo.actual_size.toString(),
          'X-Debug-Info': JSON.stringify({
            job_id: debugInfo.parent_job_id,
            chunk_index: debugInfo.chunk_index,
            original_filename: debugInfo.original_filename,
            saved_at: debugInfo.saved_at,
            storage_type: 'r2',
            r2_url: debugInfo.r2_url || 'unavailable'
          })
        }
      });
    } else {
      // Direct upload path - try KV first, then construct R2 key
      const debugInfoKey = `debug_${job_id}_chunk_${chunk_index}`;
      const debugInfoData = await env.GROQ_JOBS_KV.get(debugInfoKey);
      
      if (debugInfoData) {
        // Found in KV
        const debugInfo = JSON.parse(debugInfoData);
        const s3Client = createS3Client(env);
        const getCmd = new GetObjectCommand({
          Bucket: debugInfo.bucket,
          Key: debugInfo.debug_key
        });

        const s3Response = await s3Client.send(getCmd);

        return new Response(s3Response.Body, {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${debugInfo.filename}"`,
            'Content-Length': debugInfo.actual_size.toString(),
            'X-Debug-Info': JSON.stringify({
              job_id: debugInfo.parent_job_id,
              chunk_index: debugInfo.chunk_index,
              original_filename: debugInfo.original_filename,
              saved_at: debugInfo.saved_at,
              storage_type: 'r2',
              r2_url: debugInfo.r2_url || 'unavailable'
            })
          }
        });
      } else {
        // Construct R2 key directly
        try {
          const bucketName = env.R2_BUCKET_NAME || (env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');
          const s3Client = createS3Client(env);
          
          // Try common extensions
          const extensions = ['mp3', 'wav', 'm4a', 'flac'];
          let found = false;
          let s3Response;
          let debugKey;
          
          for (const ext of extensions) {
            debugKey = `debug/${job_id}/debug_chunk_${job_id}_${chunk_index}.${ext}`;
            try {
              const getCmd = new GetObjectCommand({
                Bucket: bucketName,
                Key: debugKey
              });
              s3Response = await s3Client.send(getCmd);
              found = true;
              break;
            } catch (error) {
              // Try next extension
              continue;
            }
          }
          
          if (!found) {
            return new Response(JSON.stringify({
              error: 'Debug chunk not found'
            }), { 
              status: 404,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          const r2Url = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucketName}/${debugKey}`;
          return new Response(s3Response.Body, {
            status: 200,
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': `attachment; filename="debug_chunk_${job_id}_${chunk_index}.${debugKey.split('.').pop()}"`,
              'Content-Length': s3Response.ContentLength?.toString() || '0',
              'X-Debug-Info': JSON.stringify({
                job_id: job_id,
                chunk_index: chunk_index,
                debug_key: debugKey,
                storage_type: 'r2',
                r2_url: r2Url
              })
            }
          });
        } catch (r2Error) {
          apiLogger.error('Failed to download debug chunk from R2', r2Error);
          return new Response(JSON.stringify({
            error: 'Failed to download debug chunk',
            message: r2Error.message
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }

  } catch (error) {
    apiLogger.error('Failed to download debug chunk', error);
    return new Response(JSON.stringify({
      error: 'Failed to download debug chunk',
      message: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Create MP3 chunks aligned to frame boundaries for API compatibility
 */
function createMP3Chunks(buffer, chunkSize) {
  const chunks = [];
  const framePositions = findMP3FramePositions(buffer);
  
  if (framePositions.length === 0) {
    processingLogger.warn('No MP3 frames found, falling back to simple chunking');
    return createChunks(buffer, chunkSize);
  }
  
  const overlapFrames = Math.max(1, Math.floor(framePositions.length * 0.02)); // 2% overlap in frames
  
  let frameIndex = 0;
  while (frameIndex < framePositions.length) {
    const startPos = framePositions[frameIndex];
    let endFrameIndex = frameIndex;
    let currentSize = 0;
    
    // Find the end frame that doesn't exceed chunk size
    while (endFrameIndex < framePositions.length - 1) {
      const nextFrameStart = framePositions[endFrameIndex + 1];
      const sizeWithNextFrame = nextFrameStart - startPos;
      
      if (sizeWithNextFrame > chunkSize) break;
      
      endFrameIndex++;
      currentSize = sizeWithNextFrame;
    }
    
    // Ensure we have at least one frame
    if (endFrameIndex === frameIndex && frameIndex < framePositions.length - 1) {
      endFrameIndex = frameIndex + 1;
      currentSize = framePositions[endFrameIndex] - startPos;
    } else if (endFrameIndex === frameIndex) {
      // Last frame
      currentSize = buffer.length - startPos;
    }
    
    const endPos = endFrameIndex < framePositions.length - 1 ? 
      framePositions[endFrameIndex + 1] : buffer.length;
    
    const chunkData = buffer.slice(startPos, endPos);
    
    chunks.push({
      start: startPos,
      end: endPos,
      data: chunkData,
      hasOverlap: frameIndex > 0,
      isPlayable: true,
      frameCount: endFrameIndex - frameIndex + 1
    });
    
    // Move to next chunk with overlap
    frameIndex = Math.max(frameIndex + 1, endFrameIndex + 1 - overlapFrames);
    
    if (endPos >= buffer.length) break;
  }
  
  return chunks;
}

/**
 * Find MP3 frame positions by looking for sync words
 */
function findMP3FramePositions(buffer) {
  const positions = [];
  const view = new DataView(buffer.buffer || buffer);
  
  for (let i = 0; i < buffer.length - 4; i++) {
    // Look for MP3 sync word: 0xFF followed by 0xE0-0xFF (first 11 bits set)
    if (buffer[i] === 0xFF && (buffer[i + 1] & 0xE0) === 0xE0) {
      // Validate it's a real frame header
      const frameInfo = parseMP3FrameHeader(view, i);
      if (frameInfo && frameInfo.frameSize > 0) {
        positions.push(i);
        // Skip to next potential frame
        i += frameInfo.frameSize - 1;
      }
    }
  }
  
  return positions;
}

/**
 * Parse MP3 frame header to get frame size
 */
function parseMP3FrameHeader(view, offset) {
  try {
    if (offset + 4 > view.byteLength) return null;
    
    const header = view.getUint32(offset, false); // Big endian
    
    // Check sync word (first 11 bits)
    if ((header >>> 21) !== 0x7FF) return null;
    
    // Extract fields
    const version = (header >>> 19) & 0x3;
    const layer = (header >>> 17) & 0x3;
    const bitrateIndex = (header >>> 12) & 0xF;
    const samplingRateIndex = (header >>> 10) & 0x3;
    const padding = (header >>> 9) & 0x1;
    
    // Skip invalid combinations
    if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || samplingRateIndex === 3) {
      return null;
    }
    
    // Bitrate table (simplified for common cases)
    const bitrates = {
      // MPEG1 Layer III
      '3-1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
      // MPEG2 Layer III  
      '2-1': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
    };
    
    // Sample rates
    const sampleRates = {
      3: [44100, 48000, 32000], // MPEG1
      2: [22050, 24000, 16000], // MPEG2
      0: [11025, 12000, 8000]   // MPEG2.5
    };
    
    const versionKey = version === 3 ? 3 : 2;
    const layerKey = 4 - layer;
    const bitrateKey = `${versionKey}-${layerKey}`;
    
    const bitrate = bitrates[bitrateKey]?.[bitrateIndex];
    const sampleRate = sampleRates[versionKey]?.[samplingRateIndex];
    
    if (!bitrate || !sampleRate) return null;
    
    // Calculate frame size
    const samplesPerFrame = version === 3 ? 1152 : 576; // MPEG1 vs MPEG2
    const frameSize = Math.floor((samplesPerFrame * bitrate * 1000 / 8) / sampleRate) + padding;
    
    return { frameSize, bitrate, sampleRate };
  } catch (error) {
    return null;
  }
}

/**
 * Create MP4/M4A chunks (placeholder - complex container format)
 */
function createMP4Chunks(buffer, chunkSize) {
  // MP4 chunking is very complex as it requires parsing the container structure
  // For now, fall back to simple chunking with a warning
  processingLogger.warn('MP4/M4A chunking not yet implemented, using simple chunking (may cause API errors)');
  processingLogger.info('Consider converting MP4/M4A files to WAV or MP3 for better chunking support');
  return createChunks(buffer, chunkSize);
}

/**
 * Create FLAC chunks (placeholder)
 */
function createFLACChunks(buffer, chunkSize) {
  // FLAC chunking requires frame boundary detection
  processingLogger.warn('FLAC chunking not yet implemented, using simple chunking (may cause API errors)');
  return createChunks(buffer, chunkSize);
}

/**
 * Create OGG chunks (placeholder)
 */
function createOGGChunks(buffer, chunkSize) {
  // OGG chunking requires page boundary detection
  processingLogger.warn('OGG chunking not yet implemented, using simple chunking (may cause API errors)');
  return createChunks(buffer, chunkSize);
}