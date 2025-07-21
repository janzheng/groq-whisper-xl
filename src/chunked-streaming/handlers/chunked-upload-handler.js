import { UploadCoordinator } from '../core/upload-coordinator.js';
import { apiLogger } from '../../core/logger.js';

/**
 * Handler for /chunked-upload-stream endpoint
 * Initializes a chunked upload streaming session
 */

/**
 * Initialize a chunked upload streaming session
 * 
 * curl -X POST http://localhost:8787/chunked-upload-stream \
 *   -H "Content-Type: application/json" \
 *   -d '{
 *     "filename": "large-podcast.mp3",
 *     "total_size": 524288000,
 *     "chunk_size_mb": 10,
 *     "use_llm": true,
 *     "llm_mode": "per_chunk",
 *     "webhook_url": "https://example.com/webhook"
 *   }'
 */
export async function handleChunkedUploadStream(request, env) {
  try {
    const contentType = request.headers.get('content-type') || '';
    
    if (!contentType.includes('application/json')) {
      return new Response(JSON.stringify({
        error: 'Content-Type must be application/json'
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json();
    const {
      filename,
      total_size,
      chunk_size_mb = 10,
      use_llm = false,
      llm_mode = 'per_chunk',
      webhook_url = null,
      max_concurrent_uploads = 3
    } = body;

    // Validate required parameters
    if (!filename) {
      return new Response(JSON.stringify({
        error: 'filename is required'
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!total_size || total_size <= 0) {
      return new Response(JSON.stringify({
        error: 'total_size is required and must be greater than 0'
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate LLM mode
    if (llm_mode && !['per_chunk', 'post_process'].includes(llm_mode)) {
      return new Response(JSON.stringify({
        error: 'llm_mode must be either "per_chunk" or "post_process"'
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    apiLogger.info('request', 'Initializing chunked upload streaming', {
      filename,
      total_size,
      chunk_size_mb,
      use_llm,
      llm_mode
    });

    // Initialize chunked upload
    const coordinator = new UploadCoordinator(env);
    const result = await coordinator.initializeChunkedUpload({
      filename,
      total_size,
      chunk_size_mb,
      use_llm,
      llm_mode,
      webhook_url,
      max_concurrent_uploads
    });

    // Prepare response
    const response = {
      message: 'Chunked upload streaming initialized successfully',
      parent_job_id: result.parent_job_id,
      stream_url: result.stream_url,
      upload_urls: result.upload_urls,
      chunk_info: result.chunk_info,
      processing_options: result.processing_options,
      
      // Instructions for client implementation
      instructions: {
        step1: 'Open SSE connection to stream_url for real-time updates',
        step2: 'Upload chunks to the provided upload_urls (max ' + max_concurrent_uploads + ' concurrent uploads)',
        step3: 'Call /chunk-upload-complete after each chunk upload',
        step4: 'Processing starts automatically after each chunk upload',
        step5: 'Monitor stream for real-time transcription results',
        
        upload_example: 'curl -X PUT "<upload_url>" --data-binary @chunk_data',
        complete_example: 'curl -X POST /chunk-upload-complete -d \'{"parent_job_id": "' + result.parent_job_id + '", "chunk_index": 0, "actual_size": 12345}\'',
        stream_example: 'curl -N ' + result.stream_url
      },

      // Client implementation guidelines
      client_guidelines: {
        upload_order: 'Chunks can be uploaded in parallel but should be processed in order',
        error_handling: 'Failed chunks can be retried individually without affecting others',
        monitoring: 'Use SSE stream for real-time progress and results',
        completion: 'Job completes when all chunks are processed and assembled',
        cleanup: 'Temporary chunk files are automatically cleaned up after processing'
      }
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json'
      }
    });

  } catch (error) {
    apiLogger.error('Chunked upload stream initialization failed', error);
    
    // Return appropriate error response
    const statusCode = error.message.includes('too small') || 
                      error.message.includes('too large') || 
                      error.message.includes('must be between') ? 400 : 500;

    return new Response(JSON.stringify({
      error: 'Failed to initialize chunked upload streaming',
      message: error.message,
      type: 'initialization_error'
    }), {
      status: statusCode,
      headers: { 'Content-Type': 'application/json' }
    });
  }
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