import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
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
    
    // Status and Management
    else if (url.pathname === '/status' && request.method === 'GET') {
      return handleStatus(request, env);
    } else if (url.pathname === '/result' && request.method === 'GET') {
      return handleResult(request, env);
    } else if (url.pathname === '/jobs' && request.method === 'GET') {
      return handleListJobs(request, env);
    } else if (url.pathname === '/delete-job' && request.method === 'POST') {
      return handleDeleteJob(request, env);
    } else if (url.pathname === '/process' && request.method === 'POST') {
      return handleManualProcess(request, env);
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
    
    // Start processing immediately
    await processFileIntelligently(job_id, env);
    
    return new Response(JSON.stringify({
      message: 'File uploaded and processing started',
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
    console.error('Direct upload error:', error);
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
    
    // Validate URL
    let parsedUrl;
    try {
      parsedUrl = new URL(audioUrl);
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: 'Invalid URL provided' 
      }), { status: 400 });
    }
    
    // Extract filename from URL if not provided
    const extractedFilename = filename || parsedUrl.pathname.split('/').pop() || 'audio.mp3';
    
    console.log(`🌐 Fetching audio from: ${audioUrl}`);
    
    // Fetch the file
    const response = await fetch(audioUrl, {
      headers: {
        'User-Agent': 'Groq-Whisper-XL/1.0'
      }
    });
    
    if (!response.ok) {
      return new Response(JSON.stringify({ 
        error: 'Failed to fetch audio from URL',
        status: response.status,
        statusText: response.statusText
      }), { status: 400 });
    }
    
    // Check content type
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('audio/') && !contentType.startsWith('video/')) {
      console.warn(`Warning: Content-Type is ${contentType}, proceeding anyway`);
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
    
    console.log(`📁 Downloaded ${extractedFilename} (${formatBytes(fileSize)})`);
    
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
    
    // Start processing immediately
    await processFileIntelligently(job_id, env);
    
    return new Response(JSON.stringify({
      message: 'File downloaded from URL and processing started',
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
    console.error('URL upload error:', error);
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
    
    // Start intelligent processing
    await processFileIntelligently(job_id, env);
    
    return new Response(JSON.stringify({ 
      message: 'File uploaded successfully, processing started',
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
    
    console.log(`🎵 Processing ${job.filename} (${formatBytes(fileSize)})`);
    
    // Decide processing strategy
    const CHUNK_THRESHOLD = 15 * 1024 * 1024; // 15MB
    const MAX_CHUNK_SIZE = 20 * 1024 * 1024;  // 20MB chunks
    
    if (fileSize <= CHUNK_THRESHOLD) {
      console.log('📄 Using direct processing (small file)');
      await processDirectly(job_id, response, env);
    } else {
      console.log('🧩 Using chunked processing (large file)');
      await processInChunks(job_id, response, fileSize, MAX_CHUNK_SIZE, env);
    }
    
  } catch (error) {
    console.error('❌ Processing failed:', error);
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
  
  console.log(`🎤 Transcribing ${job.filename} directly`);
  const transcript = await transcribeChunk(combined, ext, env.GROQ_API_KEY);
  
  // Apply LLM correction if requested
  let finalTranscript = transcript.text;
  if (job.use_llm && transcript.text) {
    console.log('🧠 Applying LLM corrections');
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
  
  console.log('✅ Direct processing completed');
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
  console.log(`📊 Created ${audioChunks.length} chunks for processing`);
  
  job.total_chunks = audioChunks.length;
  job.processed_chunks = 0;
  await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });
  
  const transcripts = [];
  const ext = job.filename.split('.').pop() || 'mp3';
  
  // Process chunks sequentially to avoid rate limits
  for (let i = 0; i < audioChunks.length; i++) {
    const chunk = audioChunks[i];
    console.log(`🔄 Processing chunk ${i + 1}/${audioChunks.length} (${formatBytes(chunk.data.length)})`);
    
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
      
      console.log(`✅ Chunk ${i + 1} completed (${job.progress}%)`);
      
      // Small delay to avoid rate limiting
      if (i < audioChunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
    } catch (error) {
      console.error(`❌ Chunk ${i + 1} failed:`, error.message);
      // Continue with other chunks
    }
  }
  
  if (transcripts.length === 0) {
    throw new Error('All chunks failed to process');
  }
  
  // Merge transcripts intelligently
  console.log('🔗 Merging transcripts');
  let mergedText = transcripts.map(t => t.text).join(' ');
  
  // Apply LLM correction if requested
  if (job.use_llm && mergedText) {
    console.log('🧠 Applying LLM corrections to merged transcript');
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
  
  console.log(`✅ Chunked processing completed (${transcripts.length}/${audioChunks.length} chunks successful)`);
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
 * Simple LLM correction using Groq
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
          content: `Please clean up this transcript by fixing obvious speech recognition errors, improving punctuation, and making it more readable while preserving the original meaning and style:\n\n${text}. Do not start with "Here is the cleaned-up transcript:", always start with the transcript.`
        }],
        temperature: 0.1,
        max_tokens: 131072
      })
    });
    
    const result = await response.json();
    return result.choices[0].message.content;
  } catch (error) {
    console.error('LLM correction failed:', error);
    return text; // Return original if correction fails
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
    console.error('Webhook failed:', error);
  }
}

/**
 * Format bytes helper
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
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
              processing_method: job.actual_size > 15 * 1024 * 1024 ? 'chunked' : 'direct',
              created_at: job.created_at,
              uploaded_at: job.uploaded_at,
              processing_started_at: job.processing_started_at,
              completed_at: job.completed_at || job.failed_at,
              error: job.error || null,
              use_llm: job.use_llm || false,
              expires_at: key.expiration ? new Date(key.expiration * 1000).toISOString() : null
            };
            
            jobs.push(jobSummary);
          }
        } catch (error) {
          console.warn(`Failed to parse job ${key.name}:`, error);
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
        console.log(`🗑️ Deleted R2 file: ${job.key}`);
      } catch (error) {
        console.warn(`Failed to delete R2 file ${job.key}:`, error.message);
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