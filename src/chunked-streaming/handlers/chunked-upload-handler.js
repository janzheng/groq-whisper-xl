import { UploadCoordinator } from '../core/upload-coordinator.js';
import { apiLogger, processingLogger, formatBytes } from '../../core/logger.js';
import { withJobSpawnLimits } from '../../core/rate-limiter.js';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

/**
 * Handler for /chunked-upload-stream endpoint
 * Initializes a chunked upload streaming session
 */

/**
 * Initialize chunked upload streaming
 * POST /chunked-upload-stream
 * 
 * curl -X POST http://localhost:8787/chunked-upload-stream \
 *   -H "Content-Type: application/json" \
 *   -d '{"filename": "audio.mp3", "total_size": 50000000, "chunk_size_mb": 10, "use_llm": true, "model": "whisper-large-v3"}'
 */
export async function handleChunkedUploadStream(request, env) {
  try {
    const contentType = request.headers.get('content-type') || '';
    
    // NEW: Support full file upload mode for audio-aware chunking
    if (contentType.includes('multipart/form-data')) {
      return await handleFullFileChunkedUpload(request, env);
    }
    
    // EXISTING: JSON mode for traditional client-side chunking
    const { 
      filename, 
      total_size, 
      chunk_size_mb = 10, 
      use_llm = false, 
      llm_mode = 'per_chunk',
      model = 'whisper-large-v3',
      webhook_url = null,
      url = null, // For URL-based uploads
      debug_save_chunks = false // New debug option to save chunks to temp folder
    } = await request.json();

    if (!filename) {
      return new Response(JSON.stringify({ 
        error: 'filename is required' 
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // For URL uploads, we need to fetch the file size first
    let finalTotalSize = total_size;
    if (url && !total_size) {
      try {
        const headResponse = await fetch(url, { method: 'HEAD' });
        if (headResponse.ok) {
          const contentLength = headResponse.headers.get('content-length');
          finalTotalSize = contentLength ? parseInt(contentLength, 10) : 50 * 1024 * 1024; // 50MB fallback
        } else {
          finalTotalSize = 50 * 1024 * 1024; // 50MB fallback
        }
      } catch (error) {
        finalTotalSize = 50 * 1024 * 1024; // 50MB fallback
      }
    }

    if (!finalTotalSize) {
      return new Response(JSON.stringify({ 
        error: 'total_size is required for file uploads' 
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Create parent job
    const { ParentJobManager } = await import('../core/parent-job-manager.js');
    const parentJobManager = new ParentJobManager(env);
    
    const parentJob = await parentJobManager.createParentJob({
      filename,
      total_size: finalTotalSize,
      chunk_size_mb,
      use_llm,
      llm_mode,
      model,
      webhook_url,
      debug_save_chunks
    });

    // Calculate chunk information
    const chunk_size_bytes = chunk_size_mb * 1024 * 1024;
    const total_chunks = Math.ceil(finalTotalSize / chunk_size_bytes);

    // Create sub-jobs for each chunk with rate limiting to prevent flooding
    const { SubJobProcessor } = await import('../core/sub-job-processor.js');
    const subJobProcessor = new SubJobProcessor(env);
    
    const sub_jobs = await withJobSpawnLimits(async () => {
      const jobs = [];
      for (let i = 0; i < total_chunks; i++) {
        const start = i * chunk_size_bytes;
        const end = Math.min(start + chunk_size_bytes, finalTotalSize);
        const chunk_size = end - start;
        
        const sub_job = await subJobProcessor.createSubJob({
          parent_job_id: parentJob.job_id,
          chunk_index: i,
          chunk_range: [start, end],
          size: chunk_size,
          filename
        });
        
        jobs.push(sub_job);
      }
      return jobs;
    }, {
      parent_job_id: parentJob.job_id,
      total_chunks,
      operation: 'chunked_upload_sub_job_creation'
    });

    processingLogger.info('init', 'Chunked upload streaming initialized', {
      parent_job_id: parentJob.job_id,
      filename,
      total_size: formatBytes(finalTotalSize),
      chunk_size_mb,
      total_chunks,
      use_llm,
      llm_mode,
      model
    });

    const coordinator = new UploadCoordinator(env);
    const uploadUrls = await coordinator.generateUploadUrls(parentJob.job_id, filename, 
      sub_jobs.map(job => ({
        chunk_index: job.chunk_index,
        size: job.size,
        start: job.chunk_range[0],
        end: job.chunk_range[1]
      }))
    );

    return new Response(JSON.stringify({
      parent_job_id: parentJob.job_id,
      stream_url: `/chunked-stream/${parentJob.job_id}`,
      upload_urls: uploadUrls,
      sub_jobs: sub_jobs.map(job => job.job_id),
      chunk_info: {
        total_chunks,
        chunk_size_bytes: chunk_size_bytes,
        total_size: finalTotalSize,
        max_concurrent_uploads: 3
      },
      processing_options: {
        use_llm,
        llm_mode,
        webhook_url,
        debug_save_chunks
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    processingLogger.error('Chunked upload streaming initialization failed', error);
    
    return new Response(JSON.stringify({
      error: 'Failed to initialize chunked upload streaming',
      message: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * NEW: Handle full file upload with server-side audio-aware chunking
 * This avoids the client-side binary splitting problem that creates invalid audio chunks
 */
async function handleFullFileChunkedUpload(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const chunk_size_mb = parseFloat(formData.get('chunk_size_mb')) || 10;
    const use_llm = formData.get('use_llm') === 'true';
    const llm_mode = formData.get('llm_mode') || 'per_chunk';
    const model = formData.get('model') || 'whisper-large-v3';
    const webhook_url = formData.get('webhook_url') || null;
    const debug_save_chunks = formData.get('debug_save_chunks') === 'true';
    
    if (!file || !file.name) {
      return new Response(JSON.stringify({ 
        error: 'No file provided in FormData' 
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const filename = file.name;
    const fileData = await file.arrayBuffer();
    const fileSize = fileData.byteLength;
    
    processingLogger.info('full_file_upload', 'Starting full file chunked upload', {
      filename,
      size: formatBytes(fileSize),
      chunk_size_mb,
      use_llm,
      model,
      debug_save_chunks
    });

    // Create a temporary job ID for the full file
    const temp_job_id = crypto.randomUUID();
    
    // Store full file temporarily in R2
    const bucketName = env.R2_BUCKET_NAME || (env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');
    const s3Client = createS3Client(env);
    const fullFileKey = `temp/${temp_job_id}/${filename}`;
    
    const putCmd = new PutObjectCommand({
      Bucket: bucketName,
      Key: fullFileKey,
      Body: fileData,
      ContentType: file.type || 'audio/*',
      Metadata: {
        'original-filename': filename,
        'chunk-size-mb': chunk_size_mb.toString(),
        'use-llm': use_llm.toString(),
        'llm-mode': llm_mode,
        'model': model,
        'debug-save-chunks': debug_save_chunks.toString()
      }
    });
    
    await s3Client.send(putCmd);
    
    // Create audio-aware chunks from the file data
    const { createAudioAwareChunks } = await import('../../index.js');
    const chunkSize = chunk_size_mb * 1024 * 1024;
    const chunks = createAudioAwareChunks(new Uint8Array(fileData), chunkSize, filename);
    
    processingLogger.info('audio_chunking', 'Created audio-aware chunks', {
      filename,
      total_chunks: chunks.length,
      chunk_size_mb,
      chunking_method: filename.toLowerCase().endsWith('.wav') ? 'wav_aware' : 
                       filename.toLowerCase().endsWith('.mp3') ? 'mp3_aware' : 'format_specific'
    });

    // Create parent job
    const { ParentJobManager } = await import('../core/parent-job-manager.js');
    const parentJobManager = new ParentJobManager(env);
    
    const parentJob = await parentJobManager.createParentJob({
      filename,
      total_size: fileSize,
      chunk_size_mb,
      use_llm,
      llm_mode,
      model,
      webhook_url,
      debug_save_chunks
    });

    // Create sub-jobs and store chunks in R2
    const { SubJobProcessor } = await import('../core/sub-job-processor.js');
    const subJobProcessor = new SubJobProcessor(env);
    
    const sub_jobs = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      // Store chunk in R2
      const chunkKey = `uploads/${parentJob.job_id}/chunk.${i}.${filename.split('.').pop()}`;
      const chunkPutCmd = new PutObjectCommand({
        Bucket: bucketName,
        Key: chunkKey,
        Body: chunk.data,
        ContentType: file.type || 'audio/*',
        Metadata: {
          'chunk-index': i.toString(),
          'parent-job-id': parentJob.job_id,
          'is-playable': (chunk.isPlayable || false).toString(),
          'original-filename': filename
        }
      });
      
      await s3Client.send(chunkPutCmd);
      
      // Create sub-job
      const sub_job = await subJobProcessor.createSubJob({
        parent_job_id: parentJob.job_id,
        chunk_index: i,
        chunk_range: [chunk.start, chunk.end],
        filename,
        size: chunk.data.length
      });
      
      // Mark as uploaded and trigger processing
      await subJobProcessor.markChunkUploaded(sub_job.job_id, chunk.data.length);
      
      sub_jobs.push(sub_job);
    }
    
    // Clean up temporary full file
    try {
      const deleteCmd = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: fullFileKey
      });
      await s3Client.send(deleteCmd);
    } catch (cleanupError) {
      processingLogger.warn('Failed to cleanup temporary file', cleanupError);
    }

    processingLogger.complete('Full file chunked upload completed', {
      parent_job_id: parentJob.job_id,
      filename,
      total_chunks: chunks.length,
      playable_chunks: chunks.filter(c => c.isPlayable).length
    });

    return new Response(JSON.stringify({
      parent_job_id: parentJob.job_id,
      stream_url: `/chunked-stream/${parentJob.job_id}`,
      message: 'File uploaded and chunked with audio-aware processing',
      chunk_info: {
        total_chunks: chunks.length,
        chunk_size_bytes: chunkSize,
        total_size: fileSize,
        chunking_method: chunks[0]?.isPlayable ? 'audio_aware' : 'simple',
        playable_chunks: chunks.filter(c => c.isPlayable).length
      },
      processing_options: {
        use_llm,
        llm_mode,
        webhook_url,
        debug_save_chunks
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    processingLogger.error('Full file chunked upload failed', error);
    
    return new Response(JSON.stringify({
      error: 'Failed to process full file chunked upload',
      message: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

function createS3Client(env) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { 
      accessKeyId: env.R2_ACCESS_KEY_ID, 
      secretAccessKey: env.R2_SECRET_ACCESS_KEY 
    },
  });
}

/**
 * Get status of a chunked upload streaming session
 * 
 * curl http://localhost:8787/chunked-upload-status?parent_job_id=uuid
 */
export async function handleChunkedUploadStatus(request, env) {
  try {
    const url = new URL(request.url);
    const parent_job_id = url.searchParams.get('parent_job_id');

    if (!parent_job_id) {
      return new Response(JSON.stringify({
        error: 'parent_job_id parameter is required'
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const coordinator = new UploadCoordinator(env);
    const status = await coordinator.getUploadStatus(parent_job_id);

    return new Response(JSON.stringify(status), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    apiLogger.error('Failed to get chunked upload status', error);
    
    const statusCode = error.message.includes('not found') ? 404 : 500;
    
    return new Response(JSON.stringify({
      error: 'Failed to get chunked upload status',
      message: error.message
    }), {
      status: statusCode,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Cancel a chunked upload streaming session
 * 
 * curl -X POST http://localhost:8787/chunked-upload-cancel \
 *   -H "Content-Type: application/json" \
 *   -d '{"parent_job_id": "uuid", "reason": "user_cancelled"}'
 */
export async function handleChunkedUploadCancel(request, env) {
  try {
    const { parent_job_id, reason = 'user_cancelled' } = await request.json();

    if (!parent_job_id) {
      return new Response(JSON.stringify({
        error: 'parent_job_id is required'
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const coordinator = new UploadCoordinator(env);
    const result = await coordinator.cancelChunkedUpload(parent_job_id, reason);

    return new Response(JSON.stringify({
      message: 'Chunked upload cancelled successfully',
      ...result
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    apiLogger.error('Failed to cancel chunked upload', error);
    
    const statusCode = error.message.includes('not found') ? 404 : 500;
    
    return new Response(JSON.stringify({
      error: 'Failed to cancel chunked upload',
      message: error.message
    }), {
      status: statusCode,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Retry a failed chunk upload
 * 
 * curl -X POST http://localhost:8787/chunked-upload-retry \
 *   -H "Content-Type: application/json" \
 *   -d '{"parent_job_id": "uuid", "chunk_index": 5}'
 */
export async function handleChunkedUploadRetry(request, env) {
  try {
    const { parent_job_id, chunk_index } = await request.json();

    if (!parent_job_id) {
      return new Response(JSON.stringify({
        error: 'parent_job_id is required'
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (chunk_index === undefined || chunk_index < 0) {
      return new Response(JSON.stringify({
        error: 'valid chunk_index is required'
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const coordinator = new UploadCoordinator(env);
    const result = await coordinator.retryChunkUpload(parent_job_id, chunk_index);

    return new Response(JSON.stringify({
      message: `Retry upload URL generated for chunk ${chunk_index}`,
      ...result
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    apiLogger.error('Failed to retry chunk upload', error);
    
    const statusCode = error.message.includes('not found') ? 404 : 500;
    
    return new Response(JSON.stringify({
      error: 'Failed to generate retry upload URL',
      message: error.message
    }), {
      status: statusCode,
      headers: { 'Content-Type': 'application/json' }
    });
  }
} 