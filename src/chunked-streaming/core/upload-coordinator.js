import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { apiLogger, formatBytes } from '../../core/logger.js';
import { ParentJobManager } from './parent-job-manager.js';
import { SubJobProcessor } from './sub-job-processor.js';
import { withJobSpawnLimits, withChunkProcessingLimits } from '../../core/rate-limiter.js';

/**
 * Upload Coordinator for Chunked Upload Streaming
 * Handles multi-part upload coordination and presigned URL generation
 */

export class UploadCoordinator {
  constructor(env) {
    this.env = env;
    this.parentJobManager = new ParentJobManager(env);
    this.subJobProcessor = new SubJobProcessor(env);
    this.s3Client = this.createS3Client();
  }

  createS3Client() {
    return new S3Client({
      region: 'auto',
      endpoint: `https://${this.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { 
        accessKeyId: this.env.R2_ACCESS_KEY_ID, 
        secretAccessKey: this.env.R2_SECRET_ACCESS_KEY 
      },
    });
  }

  /**
   * Initialize chunked upload streaming - creates parent job and generates upload URLs
   */
  async initializeChunkedUpload({
    filename,
    total_size,
    chunk_size_mb = 5,
    use_llm = false,
    llm_mode = 'per_chunk',
    webhook_url = null,
    max_concurrent_uploads = 3
  }) {
    try {
      // Validate input parameters
      this.validateUploadParams({ filename, total_size, chunk_size_mb });

      // Create parent job
      const parentJob = await this.parentJobManager.createParentJob({
        filename,
        total_size,
        chunk_size_mb,
        use_llm,
        llm_mode,
        webhook_url
      });

      // Calculate chunks and generate upload URLs
      const chunkPlan = this.calculateChunkPlan(total_size, chunk_size_mb * 1024 * 1024);
      const uploadUrls = await this.generateUploadUrls(parentJob.job_id, filename, chunkPlan);

      // Create sub-jobs for each chunk
      const subJobs = await this.createSubJobs(parentJob.job_id, filename, chunkPlan);

      apiLogger.info('init', 'Initialized chunked upload streaming', {
        parent_job_id: parentJob.job_id,
        filename,
        total_size: formatBytes(total_size),
        total_chunks: chunkPlan.length,
        chunk_size: formatBytes(chunk_size_mb * 1024 * 1024),
        use_llm,
        llm_mode
      });

      return {
        parent_job_id: parentJob.job_id,
        stream_url: `/chunked-stream/${parentJob.job_id}`,
        upload_urls: uploadUrls,
        sub_jobs: subJobs.map(job => job.job_id),
        chunk_info: {
          total_chunks: chunkPlan.length,
          chunk_size_bytes: chunk_size_mb * 1024 * 1024,
          total_size,
          max_concurrent_uploads,
          estimated_processing_time: this.estimateProcessingTime(chunkPlan.length, use_llm)
        },
        processing_options: {
          use_llm,
          llm_mode,
          webhook_url
        }
      };

    } catch (error) {
      apiLogger.error('Failed to initialize chunked upload', error, {
        filename,
        total_size: formatBytes(total_size)
      });
      throw error;
    }
  }

  /**
   * Validate upload parameters
   */
  validateUploadParams({ filename, total_size, chunk_size_mb }) {
    if (!filename || typeof filename !== 'string') {
      throw new Error('Valid filename is required');
    }

    if (!total_size || total_size <= 0) {
      throw new Error('Valid total_size is required');
    }

    if (chunk_size_mb < 1 || chunk_size_mb > 100) {
      throw new Error('chunk_size_mb must be between 1 and 100 MB');
    }

    // Check if file is large enough to warrant chunked upload
    const MIN_SIZE_FOR_CHUNKING = 5 * 1024 * 1024; // 5MB
    if (total_size < MIN_SIZE_FOR_CHUNKING) {
      throw new Error(`File too small for chunked upload. Use regular streaming for files under ${formatBytes(MIN_SIZE_FOR_CHUNKING)}`);
    }

    // Check maximum file size
    const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10GB
    if (total_size > MAX_FILE_SIZE) {
      throw new Error(`File too large. Maximum size is ${formatBytes(MAX_FILE_SIZE)}`);
    }
  }

  /**
   * Calculate chunk plan - determine byte ranges for each chunk
   */
  calculateChunkPlan(total_size, chunk_size_bytes) {
    const chunks = [];
    let start = 0;

    while (start < total_size) {
      const end = Math.min(start + chunk_size_bytes, total_size);
      chunks.push({
        chunk_index: chunks.length,
        start,
        end,
        size: end - start
      });
      start = end;
    }

    return chunks;
  }

  /**
   * Generate upload URLs for all chunks - using Worker endpoint to avoid CORS
   */
  async generateUploadUrls(parent_job_id, filename, chunkPlan) {
    const uploadUrls = [];

    for (const chunk of chunkPlan) {
      // Instead of generating presigned R2 URLs, use Worker endpoint
      const workerUploadUrl = `/chunk-upload`;
      
      uploadUrls.push({
        chunk_index: chunk.chunk_index,
        upload_url: workerUploadUrl,
        parent_job_id: parent_job_id, // Include for the Worker endpoint
        expected_size: chunk.size,
        byte_range: [chunk.start, chunk.end - 1] // Inclusive range
      });
    }

    return uploadUrls;
  }

  /**
   * Create sub-jobs for all chunks
   */
  async createSubJobs(parent_job_id, filename, chunkPlan) {
    return await withJobSpawnLimits(async () => {
      const subJobs = [];
      const subJobIds = [];

      // First, create all sub-jobs without linking them to parent yet
      for (const chunk of chunkPlan) {
        const subJob = await this.subJobProcessor.createSubJob({
          parent_job_id,
          chunk_index: chunk.chunk_index,
          chunk_range: [chunk.start, chunk.end],
          filename,
          size: chunk.size
        });

        subJobs.push(subJob);
        
        // Ensure we have the right array size and order
        while (subJobIds.length <= chunk.chunk_index) {
          subJobIds.push(null);
        }
        subJobIds[chunk.chunk_index] = subJob.job_id;
      }

      // Now atomically update parent job with all sub-job IDs at once
      const parentJob = await this.parentJobManager.getParentJob(parent_job_id);
      parentJob.sub_jobs = subJobIds;
      await this.parentJobManager.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });

      apiLogger.info('create', 'Created and linked all sub-jobs atomically', {
        parent_job_id,
        total_sub_jobs: subJobs.length,
        sub_job_ids: subJobIds.filter(id => id !== null)
      });

      return subJobs;
    }, {
      parent_job_id,
      total_chunks: chunkPlan.length,
      operation: 'upload_coordinator_sub_job_creation'
    });
  }

  /**
   * Handle chunk upload completion - trigger immediate processing
   */
  async handleChunkUploadComplete(parent_job_id, chunk_index, actual_size) {
    try {
      // Update parent job upload progress
      await this.parentJobManager.updateChunkUploaded(parent_job_id, chunk_index);

      // Get sub-job for this chunk with retry logic for race conditions
      let sub_job_id;
      let parentJob;
      let retryCount = 0;
      const maxRetries = 3;
      const retryDelay = 1000; // 1 second

      while (retryCount < maxRetries) {
        try {
          parentJob = await this.parentJobManager.getParentJob(parent_job_id);
          sub_job_id = parentJob.sub_jobs[chunk_index];

          if (!sub_job_id) {
            throw new Error(`Sub-job not found for chunk ${chunk_index}. Available sub-jobs: ${parentJob.sub_jobs.length}, chunk_index: ${chunk_index}, sub_jobs: [${parentJob.sub_jobs.map((id, i) => `${i}:${id ? 'exists' : 'null'}`).join(', ')}]`);
          }
          
          // Additional validation: verify the sub-job actually exists
          await this.subJobProcessor.getSubJob(sub_job_id);
          break; // Success, exit retry loop

        } catch (error) {
          retryCount++;
          if (retryCount >= maxRetries) {
            // Final attempt failed
            throw new Error(`Failed to find sub-job for chunk ${chunk_index} after ${maxRetries} retries. Latest error: ${error.message}`);
          }
          
          // Log retry attempt
          apiLogger.warn(`Retrying sub-job lookup for chunk ${chunk_index} (attempt ${retryCount}/${maxRetries})`, {
            parent_job_id,
            chunk_index,
            error: error.message,
            available_sub_jobs: parentJob?.sub_jobs?.length || 0
          });
          
          // Wait before retry to allow for KV propagation
          await new Promise(resolve => setTimeout(resolve, retryDelay * retryCount));
        }
      }

      // Mark sub-job as uploaded
      await this.subJobProcessor.markChunkUploaded(sub_job_id, actual_size);

      // Trigger immediate processing via queue or directly
      let processingQueued = false;
      let processingMethod = 'direct';
      
      if (this.env.CHUNK_PROCESSING_QUEUE) {
        try {
          await this.env.CHUNK_PROCESSING_QUEUE.send({ 
            parent_job_id, 
            sub_job_id,
            chunk_index,
            trigger: 'upload_complete'
          });
          processingQueued = true;
          processingMethod = 'queue';
        } catch (queueError) {
          apiLogger.warn('Queue not available, falling back to direct processing', queueError);
        }
      }
      
      // If queue failed or not available, process directly with rate limiting
      if (!processingQueued) {
        await withChunkProcessingLimits(async () => {
          try {
            // Import the processor function for direct processing
            const { processChunkUpload } = await import('../handlers/chunk-upload-complete-handler.js');
            
            // Process directly and await completion to ensure proper error handling
            await processChunkUpload(parent_job_id, sub_job_id, chunk_index, this.env);
            
            processingMethod = 'direct';
            apiLogger.info('upload', `Chunk ${chunk_index} upload completed, processing directly`, {
              parent_job_id,
              sub_job_id,
              chunk_index,
              actual_size: formatBytes(actual_size)
            });
          } catch (error) {
            apiLogger.error('Failed to start direct processing', error);
            throw new Error(`Failed to process chunk ${chunk_index}: ${error.message}`);
          }
        }, {
          parent_job_id,
          sub_job_id,
          chunk_index,
          operation: 'direct_chunk_processing'
        });
      } else {
        apiLogger.info('upload', `Chunk ${chunk_index} upload completed, processing queued`, {
          parent_job_id,
          sub_job_id,
          chunk_index,
          actual_size: formatBytes(actual_size)
        });
      }

      return {
        status: 'upload_complete',
        processing_queued: processingQueued,
        processing_method: processingMethod,
        parent_job_id,
        sub_job_id,
        chunk_index
      };

    } catch (error) {
      apiLogger.error(`Failed to handle chunk ${chunk_index} upload completion`, error, {
        parent_job_id,
        chunk_index
      });
      throw error;
    }
  }

  /**
   * Get upload status for a parent job
   */
  async getUploadStatus(parent_job_id) {
    try {
      const parentJob = await this.parentJobManager.getParentJob(parent_job_id);
      
      // Get detailed status for each chunk
      const chunkStatuses = [];
      let missingSubJobs = 0;
      let kvLookupErrors = 0;
      
      for (let i = 0; i < parentJob.total_chunks; i++) {
        const sub_job_id = parentJob.sub_jobs[i];
        if (sub_job_id) {
          try {
            const subJob = await this.subJobProcessor.getSubJob(sub_job_id);
            chunkStatuses.push({
              chunk_index: i,
              sub_job_id,
              status: subJob.status,
              uploaded_at: subJob.uploaded_at,
              processing_started_at: subJob.processing_started_at,
              completed_at: subJob.completed_at,
              error: subJob.error,
              retry_count: subJob.retry_count || 0,
              processing_time: subJob.processing_time || null,
              transcript_length: subJob.final_transcript?.length || 0
            });
          } catch (error) {
            kvLookupErrors++;
            chunkStatuses.push({
              chunk_index: i,
              sub_job_id,
              status: 'kv_error',
              error: `Sub-job lookup failed: ${error.message}`,
              timestamp: new Date().toISOString()
            });
          }
        } else {
          missingSubJobs++;
          chunkStatuses.push({
            chunk_index: i,
            sub_job_id: null,
            status: 'missing_sub_job',
            error: 'Sub-job ID not found in parent job',
            uploaded_at: null,
            processing_started_at: null,
            completed_at: null
          });
        }
      }

      // Calculate diagnostic metrics
      const statusCounts = chunkStatuses.reduce((counts, chunk) => {
        counts[chunk.status] = (counts[chunk.status] || 0) + 1;
        return counts;
      }, {});

      const completedChunks = chunkStatuses.filter(c => c.status === 'done').length;
      const processingChunks = chunkStatuses.filter(c => c.status === 'processing').length;
      const failedChunks = chunkStatuses.filter(c => c.status === 'failed' || c.status === 'kv_error').length;
      const pendingChunks = chunkStatuses.filter(c => c.status === 'pending' || c.status === 'missing_sub_job').length;

      return {
        parent_job_id,
        overall_status: parentJob.status,
        progress: parentJob.progress,
        upload_progress: parentJob.upload_progress,
        processing_progress: parentJob.processing_progress,
        total_chunks: parentJob.total_chunks,
        uploaded_chunks: parentJob.uploaded_chunks,
        completed_chunks: parentJob.completed_chunks,
        failed_chunks: parentJob.failed_chunks,
        
        // Enhanced diagnostics
        diagnostics: {
          sub_jobs_array_length: parentJob.sub_jobs?.length || 0,
          missing_sub_jobs: missingSubJobs,
          kv_lookup_errors: kvLookupErrors,
          status_breakdown: statusCounts,
          actual_completed: completedChunks,
          actual_processing: processingChunks,
          actual_failed: failedChunks,
          actual_pending: pendingChunks,
          coordination_health: {
            sub_jobs_properly_linked: (parentJob.sub_jobs?.length || 0) === parentJob.total_chunks,
            no_missing_sub_jobs: missingSubJobs === 0,
            no_kv_errors: kvLookupErrors === 0,
            counts_match: completedChunks === parentJob.completed_chunks
          },
          retry_info: {
            chunks_needing_retry: chunkStatuses.filter(c => 
              c.status === 'failed' || c.status === 'kv_error' || c.status === 'missing_sub_job'
            ).map(c => ({
              chunk_index: c.chunk_index,
              status: c.status,
              error: c.error,
              retry_count: c.retry_count || 0,
              error_type: c.error_type,
              recommended_retry_type: this.getRecommendedRetryType(c)
            })),
            total_retryable_chunks: chunkStatuses.filter(c => 
              c.status === 'failed' || c.status === 'kv_error' || c.status === 'missing_sub_job'
            ).length,
            chunks_with_high_retry_count: chunkStatuses.filter(c => 
              (c.retry_count || 0) >= 3
            ).length
          }
        },
        
        chunk_statuses: chunkStatuses,
        created_at: parentJob.created_at,
        processing_started_at: parentJob.processing_started_at,
        first_chunk_completed_at: parentJob.first_chunk_completed_at,
        
        // Timing analysis
        timing_analysis: {
          session_duration: Date.now() - new Date(parentJob.created_at).getTime(),
          processing_duration: parentJob.processing_started_at ? 
            Date.now() - new Date(parentJob.processing_started_at).getTime() : null,
          average_chunk_processing_time: chunkStatuses
            .filter(c => c.processing_time)
            .reduce((sum, c, _, arr) => sum + c.processing_time / arr.length, 0) || null
        }
      };

    } catch (error) {
      apiLogger.error('Failed to get upload status', error, { parent_job_id });
      throw error;
    }
  }

  /**
   * Cancel/cleanup a chunked upload
   */
  async cancelChunkedUpload(parent_job_id, reason = 'user_cancelled') {
    try {
      const parentJob = await this.parentJobManager.getParentJob(parent_job_id);

      // Cleanup all sub-jobs
      for (const sub_job_id of parentJob.sub_jobs) {
        try {
          await this.subJobProcessor.cleanupSubJob(sub_job_id);
        } catch (error) {
          apiLogger.warn('Failed to cleanup sub-job during cancellation', {
            sub_job_id,
            error: error.message
          });
        }
      }

      // Update parent job status
      await this.parentJobManager.updateParentJob(parent_job_id, {
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: reason
      });

      apiLogger.info('cancel', 'Chunked upload cancelled', {
        parent_job_id,
        reason,
        cleaned_sub_jobs: parentJob.sub_jobs.length
      });

      return {
        status: 'cancelled',
        parent_job_id,
        reason,
        cleaned_sub_jobs: parentJob.sub_jobs.length
      };

    } catch (error) {
      apiLogger.error('Failed to cancel chunked upload', error, { parent_job_id });
      throw error;
    }
  }

  /**
   * Estimate processing time based on chunk count and settings
   */
  estimateProcessingTime(total_chunks, use_llm) {
    // Base time per chunk (in seconds)
    const baseTimePerChunk = 15; // 15 seconds per chunk
    const llmOverhead = use_llm ? 5 : 0; // Additional 5 seconds if LLM is used
    
    const totalTime = total_chunks * (baseTimePerChunk + llmOverhead);
    
    // Format as human-readable string
    if (totalTime < 60) {
      return `${totalTime} seconds`;
    } else if (totalTime < 3600) {
      const minutes = Math.ceil(totalTime / 60);
      return `${minutes} minutes`;
    } else {
      const hours = Math.floor(totalTime / 3600);
      const minutes = Math.ceil((totalTime % 3600) / 60);
      return `${hours}h ${minutes}m`;
    }
  }

  /**
   * Get file extension from filename
   */
  getExtension(filename) {
    return filename.split('.').pop() || 'mp3';
  }

  /**
   * Validate chunk upload before processing
   */
  async validateChunkUpload(parent_job_id, chunk_index, uploaded_size) {
    const parentJob = await this.parentJobManager.getParentJob(parent_job_id);
    const expectedSize = Math.ceil(parentJob.total_size / parentJob.total_chunks);
    
    // Allow some variance in file size (compression, format differences)
    const sizeVariance = 0.1; // 10% variance allowed
    const minSize = expectedSize * (1 - sizeVariance);
    const maxSize = expectedSize * (1 + sizeVariance);

    if (uploaded_size < minSize || uploaded_size > maxSize) {
      apiLogger.warn('Chunk size validation warning', {
        parent_job_id,
        chunk_index,
        expected_size: expectedSize,
        uploaded_size,
        variance_percent: Math.abs(uploaded_size - expectedSize) / expectedSize * 100
      });
    }

    return {
      valid: true, // We'll be lenient for now
      expected_size: expectedSize,
      uploaded_size,
      size_variance: Math.abs(uploaded_size - expectedSize) / expectedSize
    };
  }

  /**
   * Retry failed chunk uploads
   */
  async retryChunkUpload(parent_job_id, chunk_index) {
    try {
      const parentJob = await this.parentJobManager.getParentJob(parent_job_id);
      const sub_job_id = parentJob.sub_jobs[chunk_index];

      if (!sub_job_id) {
        throw new Error(`Sub-job not found for chunk ${chunk_index}`);
      }

      // Reset sub-job status
      await this.subJobProcessor.updateSubJob(sub_job_id, {
        status: 'pending',
        error: null,
        retry_count: 0,
        uploaded_at: null,
        processing_started_at: null,
        completed_at: null,
        failed_at: null
      });

      // Generate new upload URL
      const filename = parentJob.filename;
      const chunkPlan = this.calculateChunkPlan(parentJob.total_size, parentJob.chunk_size_bytes);
      const chunk = chunkPlan[chunk_index];
      
      const newUploadUrls = await this.generateUploadUrls(parent_job_id, filename, [chunk]);

      apiLogger.info('retry', `Generated retry upload URL for chunk ${chunk_index}`, {
        parent_job_id,
        sub_job_id,
        chunk_index
      });

      return {
        chunk_index,
        upload_url: newUploadUrls[0].upload_url,
        sub_job_id,
        retry: true
      };

    } catch (error) {
      apiLogger.error(`Failed to retry chunk ${chunk_index} upload`, error, {
        parent_job_id,
        chunk_index
      });
      throw error;
    }
  }

  /**
   * Retry failed chunk processing (for chunks that uploaded but failed processing)
   */
  async retryChunkProcessing(parent_job_id, chunk_index) {
    try {
      const parentJob = await this.parentJobManager.getParentJob(parent_job_id);
      const sub_job_id = parentJob.sub_jobs[chunk_index];

      if (!sub_job_id) {
        throw new Error(`Sub-job not found for chunk ${chunk_index}`);
      }

      const subJob = await this.subJobProcessor.getSubJob(sub_job_id);
      
      // Ensure chunk is in a state that can be retried
      if (subJob.status !== 'failed' && subJob.status !== 'uploaded') {
        throw new Error(`Chunk ${chunk_index} is not in a retryable state (current status: ${subJob.status})`);
      }

      // Reset processing-related fields but keep upload info
      await this.subJobProcessor.updateSubJob(sub_job_id, {
        status: 'uploaded', // Reset to uploaded state
        error: null,
        retry_count: 0,
        processing_started_at: null,
        completed_at: null,
        failed_at: null,
        last_error: null,
        last_error_type: null,
        final_retry_count: null
      });

      // Trigger processing again
      let processingQueued = false;
      let processingMethod = 'direct';
      
      if (this.env.CHUNK_PROCESSING_QUEUE) {
        try {
          await this.env.CHUNK_PROCESSING_QUEUE.send({ 
            parent_job_id, 
            sub_job_id,
            chunk_index,
            trigger: 'manual_retry'
          });
          processingQueued = true;
          processingMethod = 'queue';
        } catch (queueError) {
          apiLogger.warn('Queue not available for retry, falling back to direct processing', queueError);
        }
      }
      
      if (!processingQueued) {
        try {
          const { processChunkUpload } = await import('../handlers/chunk-upload-complete-handler.js');
          
          // Process directly in background with rate limiting (don't await to avoid timeout)
          setTimeout(async () => {
            await withChunkProcessingLimits(async () => {
              try {
                await processChunkUpload(parent_job_id, sub_job_id, chunk_index, this.env);
              } catch (error) {
                apiLogger.error(`Retry processing failed for chunk ${chunk_index}`, error);
              }
            }, {
              parent_job_id,
              sub_job_id,
              chunk_index,
              operation: 'retry_chunk_processing'
            });
          }, 100);
          
          processingMethod = 'direct';
        } catch (error) {
          throw new Error(`Failed to retry processing chunk ${chunk_index}: ${error.message}`);
        }
      }

      apiLogger.info('retry', `Retrying chunk ${chunk_index} processing`, {
        parent_job_id,
        sub_job_id,
        chunk_index,
        processing_method: processingMethod
      });

      return {
        chunk_index,
        sub_job_id,
        processing_queued: processingQueued,
        processing_method: processingMethod,
        status: 'retry_initiated'
      };

    } catch (error) {
      apiLogger.error(`Failed to retry chunk ${chunk_index} processing`, error, {
        parent_job_id,
        chunk_index
      });
      throw error;
    }
  }

  /**
   * Get recommended retry type based on chunk status
   */
  getRecommendedRetryType(chunkStatus) {
    if (chunkStatus.status === 'missing_sub_job' || chunkStatus.status === 'kv_error') {
      return 'upload'; // Need to recreate and upload
    }
    
    if (chunkStatus.status === 'failed') {
      // If chunk has upload timestamp but failed, it's a processing failure
      if (chunkStatus.uploaded_at) {
        return 'processing';
      } else {
        return 'upload';
      }
    }
    
    // For other statuses, try processing first
    return 'processing';
  }

  /**
   * Retry multiple chunks at once
   */
  async retryMultipleChunks(parent_job_id, chunk_indices, retry_type = 'auto') {
    const results = [];
    const errors = [];

    for (const chunk_index of chunk_indices) {
      try {
        let result;
        
        if (retry_type === 'upload') {
          result = await this.retryChunkUpload(parent_job_id, chunk_index);
        } else if (retry_type === 'processing') {
          result = await this.retryChunkProcessing(parent_job_id, chunk_index);
        } else {
          // Auto-detect retry type based on chunk status
          const parentJob = await this.parentJobManager.getParentJob(parent_job_id);
          const sub_job_id = parentJob.sub_jobs[chunk_index];
          
          if (sub_job_id) {
            const subJob = await this.subJobProcessor.getSubJob(sub_job_id);
            
            if (subJob.status === 'failed' && subJob.uploaded_at) {
              // Chunk uploaded but processing failed
              result = await this.retryChunkProcessing(parent_job_id, chunk_index);
            } else {
              // Chunk upload failed or never uploaded
              result = await this.retryChunkUpload(parent_job_id, chunk_index);
            }
          } else {
            // No sub-job found, retry upload
            result = await this.retryChunkUpload(parent_job_id, chunk_index);
          }
        }
        
        results.push(result);
        
      } catch (error) {
        errors.push({
          chunk_index,
          error: error.message
        });
      }
    }

    return {
      successful_retries: results.length,
      failed_retries: errors.length,
      total_chunks: chunk_indices.length,
      results,
      errors: errors.length > 0 ? errors : undefined
    };
  }
} 