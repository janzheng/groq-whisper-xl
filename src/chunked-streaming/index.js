// Core components
export { ParentJobManager } from './core/parent-job-manager.js';
export { SubJobProcessor } from './core/sub-job-processor.js';
export { ChunkAssembler } from './core/chunk-assembly.js';
export { UploadCoordinator } from './core/upload-coordinator.js';

// HTTP handlers
export { 
  handleChunkedUploadStream,
  handleChunkedUploadStatus,
  handleChunkedUploadCancel,
  handleChunkedUploadRetry
} from './handlers/chunked-upload-handler.js';

export { 
  handleChunkedStream,
  handleChunkedStreamOptions
} from './handlers/chunk-stream-handler.js';

export { 
  handleChunkUploadComplete,
  handleBatchChunkUploadComplete,
  processChunkUpload
} from './handlers/chunk-upload-complete-handler.js';

/**
 * Chunked Upload Streaming Module
 * 
 * This module provides functionality for uploading large audio files in chunks
 * with real-time streaming transcription feedback. It combines the benefits of:
 * 
 * - Multi-part upload for large files
 * - Immediate processing of uploaded chunks
 * - Real-time SSE streaming of results
 * - Intelligent assembly of final transcripts
 * - Robust error handling and retry mechanisms
 * 
 * Key Features:
 * - Parent/child job architecture for coordinating chunks
 * - Presigned URL generation for direct chunk uploads
 * - Real-time progress tracking via Server-Sent Events
 * - Parallel chunk processing with ordered assembly
 * - LLM correction support (per-chunk or post-processing)
 * - Comprehensive error handling and recovery
 * - Automatic cleanup of temporary files
 * - Webhook notifications for job completion
 * 
 * Endpoints:
 * - POST /chunked-upload-stream - Initialize chunked upload session
 * - GET /chunked-stream/{parent_job_id} - SSE stream for real-time updates
 * - POST /chunk-upload-complete - Notify chunk upload completion
 * - GET /chunked-upload-status - Get detailed upload status
 * - POST /chunked-upload-cancel - Cancel and cleanup upload session
 * - POST /chunked-upload-retry - Retry failed chunk uploads
 * 
 * Usage Example:
 * 
 * 1. Initialize session:
 *    POST /chunked-upload-stream
 *    {
 *      "filename": "large-podcast.mp3",
 *      "total_size": 524288000,
 *      "chunk_size_mb": 10,
 *      "use_llm": true,
 *      "llm_mode": "per_chunk"
 *    }
 * 
 * 2. Open SSE stream:
 *    GET /chunked-stream/{parent_job_id}
 * 
 * 3. Upload chunks (parallel):
 *    PUT <presigned_url_1> --data-binary @chunk1.mp3
 *    PUT <presigned_url_2> --data-binary @chunk2.mp3
 *    PUT <presigned_url_3> --data-binary @chunk3.mp3
 * 
 * 4. Notify completion:
 *    POST /chunk-upload-complete
 *    {"parent_job_id": "uuid", "chunk_index": 0, "actual_size": 10485760}
 * 
 * 5. Monitor real-time results via SSE stream
 * 
 * Architecture:
 * 
 * ParentJob (coordinates overall process)
 *   ├── SubJob-0 (chunk 0: 0-10MB)
 *   ├── SubJob-1 (chunk 1: 10-20MB)
 *   ├── SubJob-2 (chunk 2: 20-30MB)
 *   └── ...
 * 
 * Processing Flow:
 * 1. Client uploads chunk → R2 storage
 * 2. Chunk upload complete → triggers processing queue
 * 3. Queue worker processes chunk → transcription + LLM
 * 4. Results stored in parent job → triggers assembly check
 * 5. When all chunks complete → final assembly
 * 6. SSE stream provides real-time updates throughout
 * 
 * Benefits:
 * - Handle very large files (hours of audio)
 * - Immediate feedback as chunks complete
 * - Parallel upload and processing
 * - Fault tolerance (individual chunk failures)
 * - Resume capability for failed uploads
 * - Real-time progress visibility
 * - Automatic resource cleanup
 */

/**
 * Queue processor for chunked upload streaming
 * This should be called from the main queue handler
 */
export async function handleChunkedUploadQueue(batch, env) {
  // Import the processor function and rate limiter dynamically
  const { processChunkUpload } = await import('./handlers/chunk-upload-complete-handler.js');
  const { withChunkProcessingLimits } = await import('../core/rate-limiter.js');
  
  for (const msg of batch.messages) {
    const { parent_job_id, sub_job_id, chunk_index } = msg.body;
    
    // Process each message with rate limiting to prevent API flooding
    await withChunkProcessingLimits(async () => {
      try {
        await processChunkUpload(parent_job_id, sub_job_id, chunk_index, env);
      } catch (error) {
        // Log error and also attempt to mark chunk as failed in parent job
        console.error(`Failed to process chunk ${chunk_index} for job ${parent_job_id}:`, error);
        
        // Try to update parent job to reflect chunk failure
        try {
          const { ParentJobManager } = await import('./core/parent-job-manager.js');
          const parentJobManager = new ParentJobManager(env);
          await parentJobManager.updateChunkFailed(parent_job_id, chunk_index, error);
        } catch (updateError) {
          console.error(`Failed to update chunk failure status for ${parent_job_id}:`, updateError);
        }
        throw error; // Re-throw to maintain error handling behavior
      }
    }, {
      parent_job_id,
      sub_job_id,
      chunk_index,
      operation: 'queue_message_processing'
    });
  }
}

/**
 * Enhanced job listing integration
 * This extends the main job listing to include chunked upload streaming jobs
 */
export function enhanceJobListing(job) {
  if (job.type === 'chunked_upload_streaming') {
    return {
      ...job,
      display_name: `${job.filename} (Chunked Upload)`,
      progress_details: {
        upload_progress: job.upload_progress || 0,
        processing_progress: job.processing_progress || 0,
        chunk_status: `${job.completed_chunks || 0}/${job.total_chunks || 0} chunks`,
        success_rate: job.success_rate ? `${job.success_rate}%` : 'N/A'
      },
      estimated_time_remaining: job.total_chunks && job.completed_chunks ? 
        estimateTimeRemaining(job.total_chunks, job.completed_chunks, job.processing_started_at) : null
    };
  }
  return job;
}

/**
 * Estimate time remaining for chunked upload
 */
function estimateTimeRemaining(totalChunks, completedChunks, processingStartedAt) {
  if (!processingStartedAt || completedChunks === 0) return null;
  
  const elapsedMs = Date.now() - new Date(processingStartedAt).getTime();
  const avgTimePerChunk = elapsedMs / completedChunks;
  const remainingChunks = totalChunks - completedChunks;
  const estimatedRemainingMs = remainingChunks * avgTimePerChunk;
  
  if (estimatedRemainingMs < 60000) {
    return `${Math.round(estimatedRemainingMs / 1000)} seconds`;
  } else if (estimatedRemainingMs < 3600000) {
    return `${Math.round(estimatedRemainingMs / 60000)} minutes`;
  } else {
    const hours = Math.floor(estimatedRemainingMs / 3600000);
    const minutes = Math.round((estimatedRemainingMs % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  }
}

/**
 * Default configuration for chunked upload streaming
 */
export const CHUNKED_UPLOAD_CONFIG = {
  // Size limits
  MIN_FILE_SIZE: 5 * 1024 * 1024, // 5MB minimum for chunked upload
  MAX_FILE_SIZE: 10 * 1024 * 1024 * 1024, // 10GB maximum
  MIN_CHUNK_SIZE: 1 * 1024 * 1024, // 1MB minimum chunk size
  MAX_CHUNK_SIZE: 100 * 1024 * 1024, // 100MB maximum chunk size
  DEFAULT_CHUNK_SIZE: 5 * 1024 * 1024, // 5MB default
  
  // Processing limits
  MAX_CONCURRENT_UPLOADS: 5,
  MAX_CONCURRENT_PROCESSING: 3,
  
  // Timeouts
  UPLOAD_URL_EXPIRY: 3600, // 1 hour for presigned URLs
  STREAM_TIMEOUT: 30 * 60 * 1000, // 30 minutes for SSE streams
  PROCESSING_TIMEOUT: 60 * 60 * 1000, // 1 hour for complete job
  
  // Retry settings
  MAX_CHUNK_RETRIES: 3,
  RETRY_DELAY_BASE: 1000, // 1 second base delay (exponential backoff)
  
  // Assembly settings
  OVERLAP_DETECTION: true,
  MAX_OVERLAP_WORDS: 5,
  
  // Cleanup
  TEMP_FILE_TTL: 86400, // 24 hours for temporary chunk files
  COMPLETED_JOB_TTL: 7 * 86400 // 7 days for completed job data
}; 